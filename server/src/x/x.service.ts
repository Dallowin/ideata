/**
 * X (Twitter) OAuth 2.0 connection and thread publishing.
 *
 * Three things neither LinkedIn nor Threads have:
 *
 *  1. PKCE is required even for a confidential client. That means the verifier
 *     has to be carried between the start of authorization and the callback —
 *     we put it in the same short-lived cookie as state (see XController).
 *  2. The access token lives for TWO HOURS. Without the offline.access scope
 *     the channel dies two hours after connecting, with nothing to refresh it,
 *     so offline.access isn't optional — it's a condition for the channel to work.
 *  3. The refresh token is SINGLE-USE: on every refresh X issues a new one and
 *     invalidates the old one. Failing to save the new one means losing access
 *     on the next cycle.
 *
 * Separately, about permissions: OAuth grants authorization, but not the right
 * to write. POST /2/tweets is gated by the X API tier, and a free key returns
 * 403 with an access-level message — that case is handled in messageFor().
 */
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import { groupMediaByPost, type MediaFile } from '../blogwriter/server/utils/crosspostMedia';
import { xMediaIds } from './x.media';
import { getSettingKey } from '../aeo/providers/settings';

const AUTH = 'https://x.com/i/oauth2/authorize';
const TOKEN = 'https://api.x.com/2/oauth2/token';
const API = 'https://api.x.com/2';
const TIMEOUT_MS = 20_000;
/** Hard character limit for a post. */
const LIMIT = 280;

/**
 * offline.access is required: without it there's no refresh token, and access
 * only lives two hours. tweet.write is only granted when the app's access
 * level is set to "Read and write" — the default is "Read only".
 *
 * media.write is needed SEPARATELY from tweet.write: without it POST
 * /2/media/upload returns 403, even though the tweet text still posts fine.
 * The scope was added after the channel itself, so tokens issued earlier
 * don't have it — those connections will see a "reconnect your account"
 * hint (see x.media.ts) instead of silently losing the image.
 */
const SCOPES = 'tweet.read tweet.write users.read media.write offline.access';

/** PKCE: the verifier and its S256 hash. Both are needed, the verifier until callback. */
export function makePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export interface XTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

@Injectable()
export class XService {
  private prisma = new PrismaClient();

  /** Instance OAuth credentials: app_settings → env → default (edited in the dashboard). */
  private async creds() {
    const clientId = (await getSettingKey('X_CLIENT_ID')).trim();
    const clientSecret = (await getSettingKey('X_CLIENT_SECRET')).trim();
    const redirectUri = (await getSettingKey('X_REDIRECT_URI')).trim() || 'http://localhost:8080/x/callback';
    return { clientId, clientSecret, redirectUri };
  }

  async enabled(): Promise<boolean> {
    const c = await this.creds();
    return !!(c.clientId && c.clientSecret && c.redirectUri);
  }

  async authUrl(state: string, challenge: string): Promise<string> {
    const c = await this.creds();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      scope: SCOPES,
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return `${AUTH}?${q}`;
  }

  /** Confidential client: X expects client_id:secret in Basic auth, not in the body. */
  private async basic(): Promise<string> {
    const c = await this.creds();
    return 'Basic ' + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
  }

  private async token(body: URLSearchParams): Promise<XTokens> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(TOKEN, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: await this.basic(),
        },
        body,
        signal: ctrl.signal,
      });
      const data = (await r.json().catch(() => ({}))) as Record<string, any>;
      if (!r.ok) throw new Error(data?.error_description || data?.error || `X HTTP ${r.status}`);
      const secs = Number(data.expires_in);
      return {
        accessToken: String(data.access_token || ''),
        refreshToken: data.refresh_token ? String(data.refresh_token) : null,
        expiresAt: Number.isFinite(secs) && secs > 0 ? new Date(Date.now() + secs * 1000) : null,
      };
    } finally {
      clearTimeout(t);
    }
  }

  async exchangeCode(code: string, verifier: string): Promise<XTokens> {
    const c = await this.creds();
    return this.token(
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: c.redirectUri,
        code_verifier: verifier,
        client_id: c.clientId,
      }),
    );
  }

  async refresh(refreshToken: string): Promise<XTokens> {
    const c = await this.creds();
    return this.token(
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: c.clientId,
      }),
    );
  }

  /** Who connected — also serves as a token check. */
  async me(accessToken: string): Promise<{ id: string; username: string }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(`${API}/users/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: ctrl.signal,
      });
      const b = (await r.json().catch(() => ({}))) as Record<string, any>;
      if (!r.ok || !b?.data?.id) throw new Error('X did not return a profile');
      return { id: String(b.data.id), username: String(b.data.username || '') };
    } finally {
      clearTimeout(t);
    }
  }

  getConnection(brandId: number) {
    return this.prisma.xConnection.findUnique({ where: { brandId } });
  }

  async upsertConnection(data: {
    brandId: number;
    userId: number;
    xUserId: string;
    username: string | null;
    tokens: XTokens;
  }) {
    const payload = {
      userId: data.userId,
      xUserId: data.xUserId,
      username: data.username,
      accessToken: data.tokens.accessToken,
      refreshToken: data.tokens.refreshToken,
      expiresAt: data.tokens.expiresAt,
    };
    return this.prisma.xConnection.upsert({
      where: { brandId: data.brandId },
      create: { brandId: data.brandId, ...payload },
      update: payload,
    });
  }

  async disconnect(brandId: number) {
    await this.prisma.xConnection.deleteMany({ where: { brandId } });
  }

  /**
   * Fresh token. We refresh five minutes before expiry: the lifetime is only
   * two hours, and a day of buffer like LinkedIn's would mean refreshing on
   * every request.
   *
   * Saving the new refresh token is mandatory: X invalidates the previous one
   * on exchange, and losing the new one means losing access.
   */
  private async freshToken(brandId: number): Promise<{ token: string } | { error: string }> {
    const conn = await this.getConnection(brandId);
    if (!conn) return { error: 'X account is not connected' };

    const soon = Date.now() + 5 * 60 * 1000;
    if (!conn.expiresAt || conn.expiresAt.getTime() > soon) return { token: conn.accessToken };
    if (!conn.refreshToken) return { error: 'access expired — reconnect your X account' };

    try {
      const tokens = await this.refresh(conn.refreshToken);
      await this.prisma.xConnection.update({
        where: { brandId },
        data: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? conn.refreshToken,
          expiresAt: tokens.expiresAt,
        },
      });
      return { token: tokens.accessToken };
    } catch {
      return { error: 'failed to refresh access — reconnect your X account' };
    }
  }

  /** Human-readable error text: X's status codes alone don't explain anything. */
  private messageFor(status: number, body: unknown): string {
    const detail = (() => {
      const b = body as { detail?: string; title?: string } | null;
      return b?.detail || b?.title || '';
    })();
    if (status === 401) return 'access revoked — reconnect your X account';
    if (status === 403) {
      return /access level|not permitted/i.test(detail)
        ? 'X rejected the write (403): the app tier lacks publishing rights — X API Basic or higher is required'
        : `X rejected the write (403)${detail ? ': ' + detail : ''}`;
    }
    if (status === 429) return 'X rate limit exceeded (429) — try again later';
    return detail ? `X: ${detail} (HTTP ${status})` : `X responded with HTTP ${status}`;
  }

  /**
   * Publish a thread. Posts go out one by one and are stitched together via
   * replies: X doesn't accept a thread in a single request. If it breaks off
   * midway, we return the ids already created so the caller can remove them.
   *
   * Media is grouped by thread post (media.postIndex): media_ids live ON THE
   * TWEET, so an attachment "for the second item" must go out with the second
   * tweet. Bytes are uploaded right before their own tweet; a failed upload
   * isn't fatal — the text still goes out without the image, and the reason
   * accumulates in mediaError (same as Bluesky/Mastodon).
   */
  async publishThread(
    brandId: number,
    posts: string[],
    media: MediaFile[] = [],
  ): Promise<{ ok: boolean; ids: string[]; url?: string; error?: string; mediaError?: string }> {
    if (!(await this.enabled())) return { ok: false, ids: [], error: 'X channel is not configured' };
    const list = (posts || []).map((x) => String(x || '').trim()).filter(Boolean);
    if (!list.length) return { ok: false, ids: [], error: 'empty thread' };
    const tooLong = list.findIndex((x) => [...x].length > LIMIT);
    if (tooLong >= 0) {
      return { ok: false, ids: [], error: `post ${tooLong + 1} is longer than ${LIMIT} characters — X will reject it` };
    }

    const auth = await this.freshToken(brandId);
    if ('error' in auth) return { ok: false, ids: [], error: auth.error };

    const byPost = groupMediaByPost(media, list.length);
    const mediaNotes: string[] = [];

    const ids: string[] = [];
    let replyTo = '';
    for (let i = 0; i < list.length; i++) {
      const payload: Record<string, unknown> = { text: list[i] };
      if (replyTo) payload.reply = { in_reply_to_tweet_id: replyTo };
      if (byPost[i]!.length) {
        const up = await xMediaIds(byPost[i]!, auth.token, i + 1);
        if (up.error) mediaNotes.push(up.error);
        if (up.ids.length) payload.media = { media_ids: up.ids };
      }
      const mediaError = mediaNotes.length ? mediaNotes.join('; ') : undefined;

      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetch(`${API}/tweets`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${auth.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
      } catch (e: any) {
        // We don't retry a broken POST: the post may have been created, and a
        // duplicate in someone's feed is worse than an honest error (same
        // policy as retryFetch).
        const err = e?.name === 'AbortError' ? 'timeout (20s)' : (e?.message || 'network error');
        return { ok: false, ids, url: ids[0] ? tweetUrl(ids[0]) : undefined, error: err, mediaError };
      } finally {
        clearTimeout(t);
      }

      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const err = this.messageFor(res.status, body);
        return {
          ok: false, ids, url: ids[0] ? tweetUrl(ids[0]) : undefined,
          error: ids.length ? `${err} — thread broke off at post ${i + 1} of ${list.length}` : err,
          mediaError,
        };
      }
      const id = (body as { data?: { id?: string } } | null)?.data?.id || '';
      if (!id) return { ok: false, ids, error: 'X did not return a post id', mediaError };
      ids.push(id);
      replyTo = id;
    }
    return {
      ok: true, ids, url: tweetUrl(ids[0]!),
      mediaError: mediaNotes.length ? mediaNotes.join('; ') : undefined,
    };
  }

  /** Delete thread posts. From the end: otherwise replies would be left dangling. */
  async deleteMany(brandId: number, ids: string[]): Promise<{ ok: boolean; removed: number; leftover: string[] }> {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return { ok: true, removed: 0, leftover: [] };
    const auth = await this.freshToken(brandId);
    if ('error' in auth) return { ok: false, removed: 0, leftover: list };

    const leftover: string[] = [];
    for (const id of [...list].reverse()) {
      try {
        const r = await fetch(`${API}/tweets/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${auth.token}` },
        });
        // 404 = post is already gone: goal achieved
        if (!r.ok && r.status !== 404) leftover.push(id);
      } catch {
        leftover.push(id);
      }
    }
    return { ok: leftover.length === 0, removed: list.length - leftover.length, leftover };
  }
}

/** Link to the post. No handle needed — X resolves the author by id. */
export const tweetUrl = (id: string) => `https://x.com/i/status/${id}`;
