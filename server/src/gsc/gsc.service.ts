import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getSettingKey } from '../aeo/providers/settings';

// ── Google OAuth + Search Console API ──────────────────────────────────────
// "Google Search Console" connector: connects a GSC resource via OAuth code
// (reuses the login's GOOGLE_CLIENT_ID/SECRET, but with the
// webmasters.readonly scope and offline access for the refresh token), stores
// the token per brand, and pulls search analytics: clicks, impressions, CTR,
// position + top queries and top pages.

const OAUTH_AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';
const WMT_BASE = 'https://www.googleapis.com/webmasters/v3';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';

export interface GscTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface GscSite {
  siteUrl: string;
  permissionLevel?: string;
}

export interface GscReport {
  period: string;
  kpi: {
    clicks: number;
    impressions: number;
    ctr: number;
    position: number;
    deltaClicks: number | null;
    deltaImpressions: number | null;
  };
  series: { labels: string[]; clicks: number[]; impressions: number[] };
  queries: { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
  pages: { page: string; clicks: number; impressions: number; ctr: number; position: number }[];
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function periodDays(period: string): number {
  return period === '7d' ? 7 : period === '90d' ? 90 : period === '28d' ? 28 : 30;
}
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
}

@Injectable()
export class GscService {
  private readonly log = new Logger('GscService');
  constructor(private prisma: PrismaService) {}

  /** Instance OAuth credentials: app_settings → env → default (edited in the dashboard). */
  private async creds() {
    const clientId = (await getSettingKey('GOOGLE_CLIENT_ID')).trim();
    const clientSecret = (await getSettingKey('GOOGLE_CLIENT_SECRET')).trim();
    const redirectUri =
      (await getSettingKey('GSC_REDIRECT_URI')).trim() || 'http://localhost:8080/gsc/callback';
    return { clientId, clientSecret, redirectUri };
  }

  async enabled(): Promise<boolean> {
    const c = await this.creds();
    return !!(c.clientId && c.clientSecret && c.redirectUri);
  }

  // ── OAuth ────────────────────────────────────────────────────────────────
  async authUrl(state: string): Promise<string> {
    const c = await this.creds();
    const params = new URLSearchParams({
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      response_type: 'code',
      scope: SCOPE,
      state,
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent', // consent → refresh_token is guaranteed to be returned
    });
    return `${OAUTH_AUTHORIZE}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<GscTokens> {
    const c = await this.creds();
    const res = await fetch(OAUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: c.clientId,
        client_secret: c.clientSecret,
        redirect_uri: c.redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!res.ok) throw new Error(`Google token exchange failed (${res.status})`);
    return (await res.json()) as GscTokens;
  }

  async refreshTokens(refreshToken: string): Promise<GscTokens> {
    const c = await this.creds();
    const res = await fetch(OAUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: refreshToken,
        client_id: c.clientId,
        client_secret: c.clientSecret,
        grant_type: 'refresh_token',
      }),
    });
    if (!res.ok) throw new Error(`Google token refresh failed (${res.status})`);
    return (await res.json()) as GscTokens;
  }

  async listSites(accessToken: string): Promise<GscSite[]> {
    const res = await fetch(`${WMT_BASE}/sites`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) throw new Error(`GSC sites failed (${res.status})`);
    const data: any = await res.json();
    return (data?.siteEntry ?? []).map((s: any) => ({
      siteUrl: s.siteUrl,
      permissionLevel: s.permissionLevel,
    }));
  }

  // ── Connection storage (per-brand) ────────────────────────────────────────
  async getConnection(brandId: number) {
    return this.prisma.gscConnection.findUnique({ where: { brandId } });
  }

  async upsertConnection(input: {
    brandId: number;
    userId: number;
    siteUrl: string;
    tokens: GscTokens;
  }) {
    const { brandId, userId, siteUrl, tokens } = input;
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null;
    const data = {
      userId,
      siteUrl,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresAt,
    };
    return this.prisma.gscConnection.upsert({
      where: { brandId },
      create: { brandId, ...data },
      // refresh_token only arrives on the first consent — don't overwrite it with null
      update: {
        ...data,
        refreshToken: tokens.refresh_token || undefined,
      },
    });
  }

  async setSite(brandId: number, siteUrl: string) {
    return this.prisma.gscConnection.update({ where: { brandId }, data: { siteUrl } });
  }

  async disconnect(brandId: number) {
    await this.prisma.gscConnection.deleteMany({ where: { brandId } });
    return true;
  }

  private async freshToken(conn: {
    brandId: number;
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date | null;
  }): Promise<string> {
    const expSoon = conn.expiresAt && conn.expiresAt.getTime() - Date.now() < 60_000;
    if (!expSoon || !conn.refreshToken) return conn.accessToken;
    try {
      const t = await this.refreshTokens(conn.refreshToken);
      const expiresAt = t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null;
      await this.prisma.gscConnection.update({
        where: { brandId: conn.brandId },
        data: { accessToken: t.access_token, expiresAt },
      });
      return t.access_token;
    } catch (e) {
      this.log.warn(`refresh failed, using stale token: ${(e as Error).message}`);
      return conn.accessToken;
    }
  }

  // ── Search Analytics API ─────────────────────────────────────────────────
  private async query(token: string, siteUrl: string, body: any): Promise<any[]> {
    const res = await fetch(
      `${WMT_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`GSC query ${res.status}: ${t.slice(0, 200)}`);
    }
    const data: any = await res.json();
    return data?.rows ?? [];
  }

  async getReport(
    conn: {
      brandId: number;
      siteUrl: string;
      accessToken: string;
      refreshToken: string | null;
      expiresAt: Date | null;
    },
    period: string,
  ): Promise<GscReport> {
    const token = await this.freshToken(conn);
    const site = conn.siteUrl;
    const days = periodDays(period);
    // GSC data has a ~2-3 day delay — we don't pull "today"
    const endDate = isoDaysAgo(2);
    const startDate = isoDaysAgo(days + 2);
    const prevEnd = isoDaysAgo(days + 3);
    const prevStart = isoDaysAgo(days * 2 + 3);

    const [byDate, byQuery, byPage, prevTot] = await Promise.all([
      this.query(token, site, { startDate, endDate, dimensions: ['date'], rowLimit: 1000 }),
      this.query(token, site, { startDate, endDate, dimensions: ['query'], rowLimit: 25 }),
      this.query(token, site, { startDate, endDate, dimensions: ['page'], rowLimit: 15 }),
      this.query(token, site, { startDate: prevStart, endDate: prevEnd, rowLimit: 1 }),
    ]);

    let clicks = 0, impressions = 0, ctrW = 0, posW = 0;
    const labels: string[] = [], sClicks: number[] = [], sImpr: number[] = [];
    for (const r of byDate) {
      const c = num(r.clicks), i = num(r.impressions);
      clicks += c; impressions += i; ctrW += num(r.ctr) * i; posW += num(r.position) * i;
      labels.push(r.keys?.[0] ?? '');
      sClicks.push(c); sImpr.push(i);
    }
    const ctr = impressions ? (clicks / impressions) * 100 : 0;
    const position = impressions ? posW / impressions : 0;

    const pv = prevTot?.[0] || {};
    const delta = (cur: number, before: number): number | null =>
      before > 0 ? ((cur - before) / before) * 100 : null;

    const queries = byQuery.map((r: any) => ({
      query: r.keys?.[0] ?? '',
      clicks: num(r.clicks),
      impressions: num(r.impressions),
      ctr: num(r.ctr) * 100,
      position: num(r.position),
    }));
    const pages = byPage.map((r: any) => ({
      page: r.keys?.[0] ?? '',
      clicks: num(r.clicks),
      impressions: num(r.impressions),
      ctr: num(r.ctr) * 100,
      position: num(r.position),
    }));

    return {
      period,
      kpi: {
        clicks,
        impressions,
        ctr,
        position,
        deltaClicks: delta(clicks, num(pv.clicks)),
        deltaImpressions: delta(impressions, num(pv.impressions)),
      },
      series: { labels, clicks: sClicks, impressions: sImpr },
      queries,
      pages,
    };
  }
}
