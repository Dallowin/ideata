/**
 * Threads API (Meta) — connecting an account via OAuth, per brand.
 *
 * Flow (docs: developers.facebook.com/docs/threads/get-started):
 *   1. authorize   GET  threads.net/oauth/authorize            → code
 *   2. short-lived POST graph.threads.net/oauth/access_token    → {access_token, user_id} (1 h)
 *   3. long-lived  GET  graph.threads.net/access_token          → 60 days
 *   4. refresh     GET  graph.threads.net/refresh_access_token  → +60 days
 *
 * Threads has NO refresh_token: the long-lived token refreshes itself, and
 * only if it's older than 24 h and hasn't expired yet. So we only store
 * accessToken + expiresAt, and refresh it ahead of time (7 days before
 * expiry) — otherwise an expired token can no longer be recovered and the
 * user would have to reconnect manually.
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getSettingKey } from '../aeo/providers/settings';

const AUTHORIZE = 'https://threads.net/oauth/authorize';
const TOKEN = 'https://graph.threads.net/oauth/access_token';
const LONG_LIVED = 'https://graph.threads.net/access_token';
const REFRESH = 'https://graph.threads.net/refresh_access_token';
const GRAPH = 'https://graph.threads.net/v1.0';

/** threads_basic is required; publish is for future auto-posting (the scope is
 *  granted upfront so the user doesn't have to re-authorize once publishing lands). */
const SCOPES = 'threads_basic,threads_content_publish';

/** Refresh ahead of time: the token lives 60 days, but an expired one can't be renewed. */
const REFRESH_BEFORE_MS = 7 * 24 * 60 * 60 * 1000;
/** Threads won't refresh a token younger than 24 h. */
const MIN_AGE_MS = 24 * 60 * 60 * 1000;

export interface ThreadsProfile {
  id: string;
  username: string;
}

@Injectable()
export class ThreadsService {
  private readonly log = new Logger('ThreadsService');

  constructor(private prisma: PrismaService) {}

  /** Instance OAuth credentials: app_settings → env → default (edited in the dashboard). */
  private async creds() {
    const appId = (await getSettingKey('THREADS_APP_ID')).trim();
    const appSecret = (await getSettingKey('THREADS_APP_SECRET')).trim();
    const redirectUri =
      (await getSettingKey('THREADS_REDIRECT_URI')).trim() || 'http://localhost:8080/threads/callback';
    return { appId, appSecret, redirectUri };
  }

  async enabled(): Promise<boolean> {
    const c = await this.creds();
    return !!(c.appId && c.appSecret && c.redirectUri);
  }

  // ── OAuth ────────────────────────────────────────────────────────────────
  async authUrl(state: string): Promise<string> {
    const c = await this.creds();
    const params = new URLSearchParams({
      client_id: c.appId,
      redirect_uri: c.redirectUri,
      scope: SCOPES,
      response_type: 'code',
      state,
    });
    return `${AUTHORIZE}?${params.toString()}`;
  }

  /** code → short-lived token (1 h) + threads user id. */
  async exchangeCode(code: string): Promise<{ accessToken: string; userId: string }> {
    const c = await this.creds();
    const res = await fetch(TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: c.appId,
        client_secret: c.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: c.redirectUri,
        code,
      }),
    });
    if (!res.ok) throw new Error(`Threads code exchange failed (${res.status})`);
    const data: any = await res.json();
    if (!data?.access_token) throw new Error('Threads code exchange: no access_token');
    return { accessToken: String(data.access_token), userId: String(data.user_id ?? '') };
  }

  /** short-lived → long-lived (60 days). */
  async exchangeLongLived(shortToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
    const c = await this.creds();
    const params = new URLSearchParams({
      grant_type: 'th_exchange_token',
      client_secret: c.appSecret,
      access_token: shortToken,
    });
    const res = await fetch(`${LONG_LIVED}?${params.toString()}`);
    if (!res.ok) throw new Error(`Threads long-lived exchange failed (${res.status})`);
    const data: any = await res.json();
    if (!data?.access_token) throw new Error('Threads long-lived: no access_token');
    return {
      accessToken: String(data.access_token),
      expiresAt: new Date(Date.now() + Number(data.expires_in ?? 5_184_000) * 1000),
    };
  }

  /** Extend a long-lived token for another 60 days. */
  async refreshToken(longToken: string): Promise<{ accessToken: string; expiresAt: Date }> {
    const params = new URLSearchParams({
      grant_type: 'th_refresh_token',
      access_token: longToken,
    });
    const res = await fetch(`${REFRESH}?${params.toString()}`);
    if (!res.ok) throw new Error(`Threads token refresh failed (${res.status})`);
    const data: any = await res.json();
    if (!data?.access_token) throw new Error('Threads refresh: no access_token');
    return {
      accessToken: String(data.access_token),
      expiresAt: new Date(Date.now() + Number(data.expires_in ?? 5_184_000) * 1000),
    };
  }

  /** Token owner's profile — needed to show "@username" in Integrations. */
  async me(accessToken: string): Promise<ThreadsProfile> {
    const params = new URLSearchParams({ fields: 'id,username', access_token: accessToken });
    const res = await fetch(`${GRAPH}/me?${params.toString()}`);
    if (!res.ok) throw new Error(`Threads profile failed (${res.status})`);
    const data: any = await res.json();
    return { id: String(data?.id ?? ''), username: String(data?.username ?? '') };
  }

  // ── Connection storage (per-brand) ────────────────────────────────────────
  async getConnection(brandId: number) {
    return this.prisma.threadsConnection.findUnique({ where: { brandId } });
  }

  async upsertConnection(input: {
    brandId: number;
    userId: number;
    threadsUserId: string;
    username: string | null;
    accessToken: string;
    expiresAt: Date;
  }) {
    const { brandId, ...rest } = input;
    return this.prisma.threadsConnection.upsert({
      where: { brandId },
      create: { brandId, ...rest },
      update: rest,
    });
  }

  // ── Publishing ─────────────────────────────────────────────────────────────
  /**
   * Publishing to Threads takes TWO steps, and that's not an API quirk: a
   * "container" with the text is created first, then it's published in a
   * separate request. That's how Meta separates media preparation from the
   * actual send.
   *
   * A thread is built as a chain: each next post's container has the
   * previous post's reply_to_id. The first post is the root.
   *
   * The error isn't swallowed, but it isn't rethrown either: publishing an
   * article shouldn't fail just because of a social network — the caller
   * gets the result in the response, same as tg/dev.to.
   */
  async publishThread(
    conn: { brandId: number; threadsUserId: string; accessToken: string; expiresAt: Date | null; updatedAt: Date },
    posts: string[],
  ): Promise<{ ok: boolean; ids: string[]; error?: string }> {
    const texts = posts.map((p) => (p || '').trim()).filter(Boolean);
    if (!texts.length) return { ok: false, ids: [], error: 'empty text' };

    let token: string;
    try {
      token = await this.freshToken(conn);
    } catch (e) {
      return { ok: false, ids: [], error: `token: ${(e as Error).message}` };
    }

    const ids: string[] = [];
    let replyTo: string | undefined;
    for (const [i, text] of texts.entries()) {
      try {
        const containerId = await this.createContainer(conn.threadsUserId, token, text, replyTo);
        const postId = await this.publishContainer(conn.threadsUserId, token, containerId);
        ids.push(postId);
        replyTo = postId;
      } catch (e) {
        // Part of the thread is already live in the feed — report which post it
        // stopped at instead of silently returning "failed": the leftover will
        // need to be fixed up by hand.
        return {
          ok: false,
          ids,
          error: ids.length
            ? `thread broke off at post ${i + 1} of ${texts.length}: ${(e as Error).message}`
            : (e as Error).message,
        };
      }
    }
    return { ok: true, ids };
  }

  /** Step 1: a container with the text (and a link to the previous post, if it's a thread). */
  private async createContainer(userId: string, token: string, text: string, replyToId?: string): Promise<string> {
    const params = new URLSearchParams({ media_type: 'TEXT', text, access_token: token });
    if (replyToId) params.set('reply_to_id', replyToId);
    const res = await fetch(`${GRAPH}/${userId}/threads`, { method: 'POST', body: params });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.id) {
      throw new Error(this.graphError(res.status, data));
    }
    return String(data.id);
  }

  /** Step 2: publish the container. */
  private async publishContainer(userId: string, token: string, containerId: string): Promise<string> {
    const params = new URLSearchParams({ creation_id: containerId, access_token: token });
    const res = await fetch(`${GRAPH}/${userId}/threads_publish`, { method: 'POST', body: params });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.id) {
      throw new Error(this.graphError(res.status, data));
    }
    return String(data.id);
  }

  /** Graph API error text: Meta puts it in error.message, not in the response body. */
  private graphError(status: number, data: any): string {
    const msg = data?.error?.message || data?.error_message || '';
    if (status === 401 || status === 403) {
      return msg || 'access revoked — reconnect your Threads account';
    }
    if (status === 429) return 'Threads publish rate limit exceeded, try again later';
    return msg || `HTTP ${status}`;
  }

  async disconnect(brandId: number) {
    await this.prisma.threadsConnection.deleteMany({ where: { brandId } });
    return true;
  }

  /**
   * Fresh token: refreshed if less than 7 days remain (and the token is
   * already a day old — Threads won't accept a refresh before that). A
   * refresh error isn't rethrown: the old token is still valid, we'll try
   * again next time.
   */
  async freshToken(conn: {
    brandId: number;
    accessToken: string;
    expiresAt: Date | null;
    updatedAt: Date;
  }): Promise<string> {
    const expSoon = conn.expiresAt && conn.expiresAt.getTime() - Date.now() < REFRESH_BEFORE_MS;
    const oldEnough = Date.now() - conn.updatedAt.getTime() > MIN_AGE_MS;
    if (!expSoon || !oldEnough) return conn.accessToken;
    try {
      const t = await this.refreshToken(conn.accessToken);
      await this.prisma.threadsConnection.update({
        where: { brandId: conn.brandId },
        data: { accessToken: t.accessToken, expiresAt: t.expiresAt },
      });
      return t.accessToken;
    } catch (e) {
      this.log.warn(`refresh failed, using stale token: ${(e as Error).message}`);
      return conn.accessToken;
    }
  }
}
