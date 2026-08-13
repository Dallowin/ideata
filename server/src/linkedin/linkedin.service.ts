/**
 * LinkedIn OAuth 2.0 connection and post publishing.
 *
 * The flow is standard authorization_code, but three things set it apart
 * from Threads:
 *
 *  1. A real refresh_token. Threads doesn't have one at all — there, the
 *     long-lived token itself gets refreshed. Here access lives ~60 days,
 *     refresh ~365, and both expiries need to be stored: otherwise, once
 *     access expires, there's no way to tell "can be refreshed" from
 *     "account needs reconnecting".
 *  2. Scopes are granted not by the user but by LinkedIn — after an app
 *     review. `w_member_social` comes with the "Share on LinkedIn" product;
 *     company page rights come with the Community Management API. authUrl
 *     can request anything, but LinkedIn simply strips out any unapproved
 *     scope from the grant.
 *  3. The post author is a URN, not an id: `urn:li:person:…` for a person
 *     and `urn:li:organization:…` for a company page.
 *
 * Keys come from runtime settings (app_settings, editable in the admin
 * Settings UI, falling back to env): LINKEDIN_CLIENT_ID / LINKEDIN_CLIENT_SECRET /
 * LINKEDIN_REDIRECT_URI. If empty, the channel considers itself disabled and
 * honestly tells the UI it isn't connected.
 */
import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { type MediaFile } from '../blogwriter/server/utils/crosspostMedia';
import { linkedinImageContent } from './linkedin.media';
import { getSettingKey } from '../aeo/providers/settings';

const AUTH = 'https://www.linkedin.com/oauth/v2/authorization';
const TOKEN = 'https://www.linkedin.com/oauth/v2/accessToken';
const API = 'https://api.linkedin.com';
/**
 * LinkedIn REST API version: a required header, otherwise 426.
 *
 * Their versions are month-based (YYYYMM) and live for about a year — a
 * hardcoded constant eventually just stops working, which is what happened
 * with '202405': "NONEXISTENT_VERSION: Requested version 20240501 is not
 * active".
 *
 * So we compute it from the current date, offset two months back: the
 * current month may not be released yet, while a two-month-old one is
 * definitely released and definitely inside the year-long window. An
 * explicit value can be set via LINKEDIN_API_VERSION in case LinkedIn
 * changes the rules.
 */
export function apiVersion(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
const VERSION = (process.env.LINKEDIN_API_VERSION ?? '').trim() || apiVersion();
const TIMEOUT_MS = 20_000;

/**
 * Scopes. Requesting them "just in case" is NOT ALLOWED: if the app isn't
 * approved for even one of the listed scopes, LinkedIn rejects the whole
 * request and shows its own "Bummer, something went wrong" page — before
 * the consent screen even loads. Verified in practice.
 *
 * So by default we only request what the "Share on LinkedIn" product
 * grants: publishing on behalf of a person. Organization scopes come with
 * the Community Management API, and should be enabled ONLY once it's
 * actually approved — via LINKEDIN_SCOPES, without touching the code:
 *
 *   LINKEDIN_SCOPES="openid profile w_member_social w_organization_social r_organization_social rw_organization_admin"
 */
const DEFAULT_SCOPES = 'openid profile w_member_social';

export interface LinkedinTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  refreshExpiresAt: Date | null;
}

@Injectable()
export class LinkedinService {
  private prisma = new PrismaClient();
  private scopes = (process.env.LINKEDIN_SCOPES ?? DEFAULT_SCOPES).trim() || DEFAULT_SCOPES;

  /** Instance OAuth credentials: app_settings → env → default (edited in the dashboard). */
  private async creds() {
    const clientId = (await getSettingKey('LINKEDIN_CLIENT_ID')).trim();
    const clientSecret = (await getSettingKey('LINKEDIN_CLIENT_SECRET')).trim();
    const redirectUri =
      (await getSettingKey('LINKEDIN_REDIRECT_URI')).trim() || 'http://localhost:8080/linkedin/callback';
    return { clientId, clientSecret, redirectUri };
  }

  /** The channel is only available once the app keys are set. */
  async enabled(): Promise<boolean> {
    const c = await this.creds();
    return !!(c.clientId && c.clientSecret && c.redirectUri);
  }

  async authUrl(state: string): Promise<string> {
    const c = await this.creds();
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      state,
      scope: this.scopes,
    });
    return `${AUTH}?${q}`;
  }

  private async post(url: string, body: URLSearchParams) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: ctrl.signal,
      });
      const data = (await r.json().catch(() => ({}))) as Record<string, any>;
      if (!r.ok) throw new Error(data?.error_description || `LinkedIn HTTP ${r.status}`);
      return data;
    } finally {
      clearTimeout(t);
    }
  }

  /** Lifetime in seconds → date. LinkedIn returns a duration, not a timestamp. */
  private expiry(seconds: unknown): Date | null {
    const s = Number(seconds);
    return Number.isFinite(s) && s > 0 ? new Date(Date.now() + s * 1000) : null;
  }

  async exchangeCode(code: string): Promise<LinkedinTokens> {
    const c = await this.creds();
    const data = await this.post(
      TOKEN,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: c.clientId,
        client_secret: c.clientSecret,
        redirect_uri: c.redirectUri,
      }),
    );
    return {
      accessToken: String(data.access_token || ''),
      refreshToken: data.refresh_token ? String(data.refresh_token) : null,
      expiresAt: this.expiry(data.expires_in),
      refreshExpiresAt: this.expiry(data.refresh_token_expires_in),
    };
  }

  async refresh(refreshToken: string): Promise<LinkedinTokens> {
    const c = await this.creds();
    const data = await this.post(
      TOKEN,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: c.clientId,
        client_secret: c.clientSecret,
      }),
    );
    return {
      accessToken: String(data.access_token || ''),
      // on refresh, a new refresh token may not come back — then the old one stays
      refreshToken: data.refresh_token ? String(data.refresh_token) : refreshToken,
      expiresAt: this.expiry(data.expires_in),
      refreshExpiresAt: this.expiry(data.refresh_token_expires_in),
    };
  }

  /** Who connected. The OpenID endpoint returns sub — we build the URN from it. */
  async me(accessToken: string): Promise<{ urn: string; name: string }> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(`${API}/v2/userinfo`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: ctrl.signal,
      });
      const b = (await r.json().catch(() => ({}))) as Record<string, any>;
      if (!r.ok || !b.sub) throw new Error('LinkedIn did not return a profile');
      return { urn: `urn:li:person:${b.sub}`, name: String(b.name || '') };
    } finally {
      clearTimeout(t);
    }
  }

  getConnection(brandId: number) {
    return this.prisma.linkedinConnection.findUnique({ where: { brandId } });
  }

  async upsertConnection(data: {
    brandId: number;
    userId: number;
    memberUrn: string;
    name: string | null;
    tokens: LinkedinTokens;
  }) {
    const payload = {
      userId: data.userId,
      memberUrn: data.memberUrn,
      name: data.name,
      accessToken: data.tokens.accessToken,
      refreshToken: data.tokens.refreshToken,
      expiresAt: data.tokens.expiresAt,
      refreshExpiresAt: data.tokens.refreshExpiresAt,
    };
    return this.prisma.linkedinConnection.upsert({
      where: { brandId: data.brandId },
      create: { brandId: data.brandId, ...payload },
      update: payload,
    });
  }

  async disconnect(brandId: number) {
    await this.prisma.linkedinConnection.deleteMany({ where: { brandId } });
  }

  /**
   * Fresh token: refreshed a day before it expires. Not earlier — LinkedIn
   * doesn't allow refreshing endlessly; not later either — an expired
   * refresh token won't help anymore.
   */
  private async freshToken(brandId: number): Promise<{ token: string; urn: string } | { error: string }> {
    const conn = await this.getConnection(brandId);
    if (!conn) return { error: 'LinkedIn account is not connected' };

    const soon = Date.now() + 24 * 60 * 60 * 1000;
    const expired = conn.expiresAt ? conn.expiresAt.getTime() < soon : false;
    if (!expired) return { token: conn.accessToken, urn: conn.orgUrn || conn.memberUrn };

    if (!conn.refreshToken || (conn.refreshExpiresAt && conn.refreshExpiresAt.getTime() < Date.now())) {
      return { error: 'access expired — reconnect your LinkedIn account' };
    }
    try {
      const tokens = await this.refresh(conn.refreshToken);
      await this.prisma.linkedinConnection.update({
        where: { brandId },
        data: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          expiresAt: tokens.expiresAt,
          refreshExpiresAt: tokens.refreshExpiresAt,
        },
      });
      return { token: tokens.accessToken, urn: conn.orgUrn || conn.memberUrn };
    } catch {
      return { error: 'failed to refresh access — reconnect your LinkedIn account' };
    }
  }

  /** Human-readable error text: LinkedIn's status codes alone say nothing. */
  private messageFor(status: number, detail: string): string {
    if (status === 401) return 'access revoked — reconnect your LinkedIn account';
    if (status === 403) {
      return 'LinkedIn rejected the publish (403): the app lacks w_member_social — it is granted after review';
    }
    if (status === 422) return `LinkedIn rejected the post (422)${detail ? ': ' + detail : ''}`;
    if (status === 429) return 'too frequent (429) — LinkedIn is throttling publish rate';
    return detail ? `LinkedIn: ${detail} (HTTP ${status})` : `LinkedIn responded with HTTP ${status}`;
  }

  /**
   * Delete a post. LinkedIn accepts the URN in the path, but URL-encoded: a
   * raw colon in urn:li:share:… breaks their gateway's routing.
   */
  async remove(brandId: number, postUrn: string): Promise<{ ok: boolean; error?: string }> {
    if (!postUrn) return { ok: true };
    const auth = await this.freshToken(brandId);
    if ('error' in auth) return { ok: false, error: auth.error };

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(`${API}/rest/posts/${encodeURIComponent(postUrn)}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'LinkedIn-Version': VERSION,
          'X-Restli-Protocol-Version': '2.0.0',
        },
        signal: ctrl.signal,
      });
      // 404 = post is already gone: goal achieved
      if (!r.ok && r.status !== 404) {
        return { ok: false, error: this.messageFor(r.status, '') };
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.name === 'AbortError' ? 'timeout (20s)' : (e?.message || 'network error') };
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Publish a post. LinkedIn returns the id of the created post as a header,
   * not in the body — we build the link from it.
   *
   * Images are uploaded BEFORE the post is created: their URNs are already
   * needed in its body. A failed upload isn't fatal — the text still goes
   * out without attachments, and the reason lands in mediaError (same policy
   * as Bluesky/Mastodon/X).
   */
  async publish(
    brandId: number,
    text: string,
    media: MediaFile[] = [],
  ): Promise<{ ok: boolean; id?: string; url?: string; error?: string; mediaError?: string }> {
    if (!(await this.enabled())) return { ok: false, error: 'LinkedIn channel is not configured' };
    const body = String(text || '').trim();
    if (!body) return { ok: false, error: 'empty post' };

    const auth = await this.freshToken(brandId);
    if ('error' in auth) return { ok: false, error: auth.error };

    const built: { content?: Record<string, unknown>; error?: string } = media.length
      ? await linkedinImageContent(media, { token: auth.token, version: VERSION, owner: auth.urn })
      : {};
    const mediaError = built.error;

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(`${API}/rest/posts`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${auth.token}`,
          'Content-Type': 'application/json',
          'LinkedIn-Version': VERSION,
          'X-Restli-Protocol-Version': '2.0.0',
        },
        body: JSON.stringify({
          author: auth.urn,
          commentary: body,
          visibility: 'PUBLIC',
          distribution: {
            feedDistribution: 'MAIN_FEED',
            targetEntities: [],
            thirdPartyDistributionChannels: [],
          },
          ...(built.content ? { content: built.content } : {}),
          lifecycleState: 'PUBLISHED',
          isReshareDisabledByAuthor: false,
        }),
        signal: ctrl.signal,
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => '');
        return { ok: false, error: this.messageFor(r.status, detail.slice(0, 200)), mediaError };
      }
      const id = r.headers.get('x-restli-id') || '';
      return {
        ok: true, id: id || undefined,
        url: id ? `https://www.linkedin.com/feed/update/${id}` : undefined,
        mediaError,
      };
    } catch (e: any) {
      return {
        ok: false,
        error: e?.name === 'AbortError' ? 'timeout (20s)' : (e?.message || 'network error'),
        mediaError,
      };
    } finally {
      clearTimeout(t);
    }
  }
}
