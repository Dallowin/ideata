import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { getSettingKey } from '../aeo/providers/settings';

// ── Yandex OAuth + Metrika Stat API ────────────────────────────────────────
// "AI traffic" tab: connects a Metrika counter via OAuth code, stores the
// token per brand, and pulls visits filtered by AI assistant referrers
// (chatgpt.com, perplexity.ai, gemini, copilot, claude.ai …). This is what
// makes it an AI-traffic tab rather than just a Metrika mirror.

const OAUTH_AUTHORIZE = 'https://oauth.yandex.ru/authorize';
const OAUTH_TOKEN = 'https://oauth.yandex.ru/token';
const API_BASE = 'https://api-metrika.yandex.net';

// Assistant → referrer hosts. Hosts go flat into the Stat API filter (referer
// contains host), and when parsing rows we group them back by assistant.
export const AI_SOURCES: { assistant: string; hosts: string[] }[] = [
  { assistant: 'ChatGPT', hosts: ['chatgpt.com', 'chat.openai.com', 'openai.com'] },
  { assistant: 'Perplexity', hosts: ['perplexity.ai'] },
  { assistant: 'Gemini', hosts: ['gemini.google.com', 'bard.google.com'] },
  { assistant: 'Copilot', hosts: ['copilot.microsoft.com', 'copilot.cloud.microsoft'] },
  { assistant: 'Claude', hosts: ['claude.ai'] },
  { assistant: 'DeepSeek', hosts: ['deepseek.com', 'chat.deepseek.com'] },
  { assistant: 'Grok', hosts: ['grok.com', 'x.ai'] },
  { assistant: 'Mistral', hosts: ['chat.mistral.ai', 'mistral.ai'] },
  { assistant: 'You.com', hosts: ['you.com'] },
  { assistant: 'Poe', hosts: ['poe.com'] },
  { assistant: 'Phind', hosts: ['phind.com'] },
];

const AI_HOSTS = AI_SOURCES.flatMap((s) => s.hosts);

function assistantForReferer(referer: string): string {
  const r = (referer || '').toLowerCase();
  for (const s of AI_SOURCES) if (s.hosts.some((h) => r.includes(h))) return s.assistant;
  return 'Другие AI';
}

// tab period → Metrika relative dates
export function periodToDates(period: string): { date1: string; date2: string; days: number } {
  const days = period === '7d' ? 7 : period === '90d' ? 90 : period === '28d' ? 28 : 30;
  return { date1: `${days}daysAgo`, date2: 'today', days };
}

export interface MetrikaTokens {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface MetrikaCounter {
  id: string;
  name: string;
  site: string;
}

export interface ReportBundle {
  period: string;
  scope: 'ai' | 'all';
  kpi: {
    pageviews: number;
    visits: number;
    users: number;
    bounceRate: number;
    avgDuration: number;
    pageDepth: number;
    goals: number;
    conversionRate: number;
    deltaPageviews: number | null;
    deltaVisits: number | null;
    deltaUsers: number | null;
    deltaDuration: number | null;
    deltaDepth: number | null;
    deltaBounce: number | null;
    deltaGoals: number | null;
    aiVisits: number;
    totalVisits: number;
    aiShare: number;
  };
  // total daily per metric (for the Metrika-style "by source" widget)
  series: {
    labels: string[];
    views: number[];
    visits: number[];
    users: number[];
    duration: number[];
    depth: number[];
    bounce: number[];
  };
  // per-source daily (checkbox legend: toggling a source's line on/off)
  sourceSeries: {
    name: string;
    total: number;
    views: number[];
    visits: number[];
    users: number[];
    duration: number[];
    depth: number[];
    bounce: number[];
  }[];
  sources: {
    assistant: string;
    visits: number;
    users: number;
    bounceRate: number;
    avgDuration: number;
    goals: number;
    pct: number;
  }[];
  devices: { label: string; visits: number; pct: number }[];
  geo: { country: string; visits: number; pct: number }[];
  /** entry pages (ym:s:startURL): exactly where people land */
  pages: { url: string; visits: number; pct: number }[];
}

@Injectable()
export class MetrikaService {
  private readonly log = new Logger('MetrikaService');
  constructor(private prisma: PrismaService) {}

  /** Instance OAuth credentials: app_settings → env → default (edited in the dashboard). */
  private async creds() {
    const clientId = (await getSettingKey('YANDEX_CLIENT_ID')).trim();
    const clientSecret = (await getSettingKey('YANDEX_CLIENT_SECRET')).trim();
    const redirectUri =
      (await getSettingKey('YANDEX_REDIRECT_URI')).trim() || 'http://localhost:8080/metrika/callback';
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
      response_type: 'code',
      client_id: c.clientId,
      redirect_uri: c.redirectUri,
      state,
      // scope is set on the app at registration (metrika:read); force_confirm
      // guarantees a confirmation screen when reconnecting a different account.
      force_confirm: 'yes',
    });
    return `${OAUTH_AUTHORIZE}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<MetrikaTokens> {
    const c = await this.creds();
    const res = await fetch(OAUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: c.clientId,
        client_secret: c.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Yandex token exchange failed (${res.status})`);
    return (await res.json()) as MetrikaTokens;
  }

  async refreshTokens(refreshToken: string): Promise<MetrikaTokens> {
    const c = await this.creds();
    const res = await fetch(OAUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: c.clientId,
        client_secret: c.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Yandex token refresh failed (${res.status})`);
    return (await res.json()) as MetrikaTokens;
  }

  // ── Management API: list of account counters ──────────────────────────────
  async listCounters(accessToken: string): Promise<MetrikaCounter[]> {
    const res = await fetch(`${API_BASE}/management/v1/counters?per_page=1000`, {
      headers: { Authorization: `OAuth ${accessToken}` },
    });
    if (!res.ok) throw new Error(`Metrika counters failed (${res.status})`);
    const data: any = await res.json();
    return (data?.counters ?? []).map((c: any) => ({
      id: String(c.id),
      name: c.name ?? '',
      site: (c.site2?.site || c.site || '').replace(/^https?:\/\//, '').replace(/^www\./, ''),
    }));
  }

  // ── Connection storage (per-brand) ────────────────────────────────────────
  async getConnection(brandId: number) {
    return this.prisma.metrikaConnection.findUnique({ where: { brandId } });
  }

  async upsertConnection(input: {
    brandId: number;
    userId: number;
    counter: MetrikaCounter;
    tokens: MetrikaTokens;
  }) {
    const { brandId, userId, counter, tokens } = input;
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null;
    const data = {
      userId,
      counterId: counter.id,
      counterName: counter.name || null,
      siteUrl: counter.site || null,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || null,
      expiresAt,
    };
    return this.prisma.metrikaConnection.upsert({
      where: { brandId },
      create: { brandId, ...data },
      update: data,
    });
  }

  async setCounter(brandId: number, counter: MetrikaCounter) {
    return this.prisma.metrikaConnection.update({
      where: { brandId },
      data: {
        counterId: counter.id,
        counterName: counter.name || null,
        siteUrl: counter.site || null,
      },
    });
  }

  async disconnect(brandId: number) {
    await this.prisma.metrikaConnection.deleteMany({ where: { brandId } });
    return true;
  }

  /** Fresh access token: refreshed if it expires within the next minute. */
  private async freshToken(conn: {
    brandId: number;
    accessToken: string;
    refreshToken: string | null;
    expiresAt: Date | null;
  }): Promise<string> {
    const expSoon =
      conn.expiresAt && conn.expiresAt.getTime() - Date.now() < 60_000;
    if (!expSoon || !conn.refreshToken) return conn.accessToken;
    try {
      const t = await this.refreshTokens(conn.refreshToken);
      const expiresAt = t.expires_in
        ? new Date(Date.now() + t.expires_in * 1000)
        : null;
      await this.prisma.metrikaConnection.update({
        where: { brandId: conn.brandId },
        data: {
          accessToken: t.access_token,
          refreshToken: t.refresh_token || conn.refreshToken,
          expiresAt,
        },
      });
      return t.access_token;
    } catch (e) {
      this.log.warn(`refresh failed, using stale token: ${(e as Error).message}`);
      return conn.accessToken;
    }
  }

  // ── Stat API ─────────────────────────────────────────────────────────────
  private aiFilter(): string {
    return AI_HOSTS.map((h) => `ym:s:referer=@'${h}'`).join(' OR ');
  }

  private async stat(
    token: string,
    counterId: string,
    params: Record<string, string | undefined>,
  ): Promise<{ rows: any[]; totals: number[] }> {
    const clean: Record<string, string> = { ids: counterId, accuracy: 'full' };
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') clean[k] = v;
    }
    const qs = new URLSearchParams(clean);
    const url = `${API_BASE}/stat/v1/data?${qs.toString()}`;
    // Metrika rate-limits parallel requests per user (429
    // quota_parallel_requests_by_uid). getReport already keeps concurrency
    // low, but we retry 429 with backoff just in case.
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { Authorization: `OAuth ${token}` } });
      if (res.ok) {
        const data: any = await res.json();
        // Metrika returns totals as a FLAT array [m1, m2, …] (one number per
        // metric), NOT nested. Taken as-is — otherwise the KPI totals read as 0.
        return { rows: data?.data ?? [], totals: Array.isArray(data?.totals) ? data.totals : [] };
      }
      const body = await res.text().catch(() => '');
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      throw new Error(`Metrika stat ${res.status}: ${body.slice(0, 200)}`);
    }
  }

  // Runs tasks with limited concurrency (Metrika's quota is ~5-7 parallel
  // requests per user; we keep 3 so two overlapping reports don't blow the
  // limit). Result order matches task order.
  private async runLimited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
    const results = new Array<T>(tasks.length);
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(limit, tasks.length) }, () => worker()),
    );
    return results;
  }

  async getReport(
    conn: {
      brandId: number;
      counterId: string;
      accessToken: string;
      refreshToken: string | null;
      expiresAt: Date | null;
    },
    period: string,
    scope: 'ai' | 'all' = 'ai',
  ): Promise<ReportBundle> {
    const token = await this.freshToken(conn);
    const id = conn.counterId;
    const aiFilter = this.aiFilter();
    // scope='ai' → filter by assistant referrers; 'all' → all traffic (no
    // filter), and "Visits" are sliced by channel (ym:s:trafficSource).
    const fBlock = scope === 'ai' ? { filters: aiFilter } : {};
    // the AI share always needs a "counterpart" total: in AI mode it's all
    // traffic, in all-traffic mode it's AI only.
    const otherFBlock = scope === 'ai' ? {} : { filters: aiFilter };
    const { date1, date2, days } = periodToDates(period);
    const common = { date1, date2, lang: 'ru', ...fBlock };

    // previous equal-length period — for deltas
    const prev1 = `${days * 2}daysAgo`;
    const prev2 = `${days + 1}daysAgo`;

    // Keep ≤3 parallel requests to Metrika (quota is ~5-7 per user).
    // 7 widget metrics: pageviews, visits, users, duration, depth, bounces, goals.
    const M =
      'ym:s:pageviews,ym:s:visits,ym:s:users,ym:s:avgVisitDurationSeconds,ym:s:pageDepth,ym:s:bounceRate,ym:s:sumGoalReachesAny';
    const srcDim = scope === 'ai' ? 'ym:s:referer' : 'ym:s:trafficSource';
    const [byDate, byDateSource, devices, geo, prev, other, pages] = await this.runLimited(
      [
        () =>
          this.stat(token, id, {
            ...common,
            metrics: M,
            dimensions: 'ym:s:date',
            sort: 'ym:s:date',
            limit: '100000',
          }),
        () =>
          this.stat(token, id, {
            ...common,
            metrics: M,
            dimensions: `ym:s:date,${srcDim}`,
            sort: 'ym:s:date',
            limit: '100000',
          }),
        () =>
          this.stat(token, id, {
            ...common,
            metrics: 'ym:s:visits',
            dimensions: 'ym:s:deviceCategory',
            sort: '-ym:s:visits',
            limit: '10',
          }),
        () =>
          this.stat(token, id, {
            ...common,
            metrics: 'ym:s:visits',
            dimensions: 'ym:s:regionCountry',
            sort: '-ym:s:visits',
            limit: '8',
          }),
        () =>
          this.stat(token, id, {
            date1: prev1,
            date2: prev2,
            lang: 'ru',
            ...fBlock,
            metrics: M,
          }),
        () =>
          this.stat(token, id, {
            date1,
            date2,
            lang: 'ru',
            ...otherFBlock,
            metrics: 'ym:s:visits',
          }),
        // entry pages: exactly where people land (in AI mode — from AI answers)
        () =>
          this.stat(token, id, {
            ...common,
            metrics: 'ym:s:visits',
            dimensions: 'ym:s:startURL',
            sort: '-ym:s:visits',
            limit: '12',
          }),
      ],
      3,
    );

    // KPI from totals (flat array in the order of metrics M)
    const t = byDate.totals || [];
    const pageviews = num(t[0]);
    const visits = num(t[1]);
    const users = num(t[2]);
    const avgDuration = num(t[3]);
    const pageDepth = num(t[4]);
    const bounceRate = num(t[5]);
    const goals = num(t[6]);
    const conversionRate = visits ? (goals / visits) * 100 : 0;

    const pv = prev.totals || [];
    const delta = (cur: number, before: number): number | null =>
      before > 0 ? ((cur - before) / before) * 100 : null;

    // total daily per metric (date order comes from byDate — authoritative)
    const labels: string[] = [];
    const dateIdx = new Map<string, number>();
    const total = {
      views: [] as number[], visits: [] as number[], users: [] as number[],
      duration: [] as number[], depth: [] as number[], bounce: [] as number[],
    };
    for (const r of byDate.rows) {
      const d = r.dimensions?.[0]?.name ?? '';
      dateIdx.set(d, labels.length);
      labels.push(d);
      const m = r.metrics || [];
      total.views.push(num(m[0])); total.visits.push(num(m[1])); total.users.push(num(m[2]));
      total.duration.push(num(m[3])); total.depth.push(num(m[4])); total.bounce.push(num(m[5]));
    }
    const N = labels.length;
    const zeros = () => new Array(N).fill(0) as number[];

    // per-source daily (rate metrics are weighted by visits). In AI mode,
    // referrer → assistant; in all mode, source = channel (ym:s:trafficSource).
    type Acc = {
      views: number[]; visits: number[]; users: number[];
      durW: number[]; depthW: number[]; bounceW: number[];
      aVisits: number; aUsers: number; aGoals: number; aDurW: number; aDepthW: number; aBounceW: number;
    };
    const bySource = new Map<string, Acc>();
    for (const r of byDateSource.rows) {
      const di = dateIdx.get(r.dimensions?.[0]?.name ?? '');
      if (di == null) continue;
      const raw = r.dimensions?.[1]?.name || '—';
      const name = scope === 'ai' ? assistantForReferer(raw) : raw;
      const m = r.metrics || [];
      const vw = num(m[0]), v = num(m[1]), u = num(m[2]);
      const dur = num(m[3]), dep = num(m[4]), bn = num(m[5]), gl = num(m[6]);
      let e = bySource.get(name);
      if (!e) {
        e = { views: zeros(), visits: zeros(), users: zeros(), durW: zeros(), depthW: zeros(), bounceW: zeros(),
          aVisits: 0, aUsers: 0, aGoals: 0, aDurW: 0, aDepthW: 0, aBounceW: 0 };
        bySource.set(name, e);
      }
      e.views[di] += vw; e.visits[di] += v; e.users[di] += u;
      e.durW[di] += dur * v; e.depthW[di] += dep * v; e.bounceW[di] += bn * v;
      e.aVisits += v; e.aUsers += u; e.aGoals += gl;
      e.aDurW += dur * v; e.aDepthW += dep * v; e.aBounceW += bn * v;
    }
    const srcEntries = [...bySource.entries()].sort((a, b) => b[1].aVisits - a[1].aVisits);
    const rate = (w: number[], v: number[]) => v.map((x, i) => (x ? w[i] / x : 0));
    const sourceSeries = srcEntries.map(([name, e]) => ({
      name, total: e.aVisits,
      views: e.views, visits: e.visits, users: e.users,
      duration: rate(e.durW, e.visits), depth: rate(e.depthW, e.visits), bounce: rate(e.bounceW, e.visits),
    }));
    const srcVisitsTotal = srcEntries.reduce((s, [, e]) => s + e.aVisits, 0) || 1;
    const sourcesOut = srcEntries.map(([name, e]) => ({
      assistant: name,
      visits: e.aVisits,
      users: e.aUsers,
      bounceRate: e.aVisits ? e.aBounceW / e.aVisits : 0,
      avgDuration: e.aVisits ? e.aDurW / e.aVisits : 0,
      goals: e.aGoals,
      pct: (e.aVisits / srcVisitsTotal) * 100,
    }));

    // AI share: current = visits in the current mode, other = counterpart total
    const otherVisits = num((other.totals || [])[0]);
    const aiVisits = scope === 'ai' ? visits : otherVisits;
    const totalVisits = scope === 'ai' ? otherVisits : visits;
    const aiShare = totalVisits ? (aiVisits / totalVisits) * 100 : 0;

    const devTotal = devices.rows.reduce((s, r) => s + num(r.metrics?.[0]), 0) || 1;
    const devicesOut = devices.rows.map((r) => ({
      label: r.dimensions?.[0]?.name || '—',
      visits: num(r.metrics?.[0]),
      pct: (num(r.metrics?.[0]) / devTotal) * 100,
    }));

    const pagesTotal = pages.rows.reduce((s, r) => s + num(r.metrics?.[0]), 0) || 1;
    const pagesOut = pages.rows.map((r) => ({
      url: r.dimensions?.[0]?.name || '—',
      visits: num(r.metrics?.[0]),
      pct: (num(r.metrics?.[0]) / pagesTotal) * 100,
    }));

    const geoTotal = geo.rows.reduce((s, r) => s + num(r.metrics?.[0]), 0) || 1;
    const geoOut = geo.rows.map((r) => ({
      country: r.dimensions?.[0]?.name || '—',
      visits: num(r.metrics?.[0]),
      pct: (num(r.metrics?.[0]) / geoTotal) * 100,
    }));

    return {
      period,
      scope,
      kpi: {
        pageviews, visits, users, bounceRate, avgDuration, pageDepth, goals, conversionRate,
        deltaPageviews: delta(pageviews, num(pv[0])),
        deltaVisits: delta(visits, num(pv[1])),
        deltaUsers: delta(users, num(pv[2])),
        deltaDuration: delta(avgDuration, num(pv[3])),
        deltaDepth: delta(pageDepth, num(pv[4])),
        deltaBounce: delta(bounceRate, num(pv[5])),
        deltaGoals: delta(goals, num(pv[6])),
        aiVisits, totalVisits, aiShare,
      },
      series: { labels, ...total },
      sourceSeries,
      sources: sourcesOut,
      devices: devicesOut,
      geo: geoOut,
      pages: pagesOut,
    };
  }
}

function num(v: any): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
