/**
 * DataForSEO Labs — port of the calls we need from Python (core/dataforseo.py).
 *
 * Exactly the seven methods the "Monitoring" tabs run on have been moved
 * over; the rest of the Python module (keyword gaps, anchors, backlink
 * history) stays where it was for now.
 *
 * Two things that are easy to lose in the port and that break the output
 * silently:
 *   • Labs doesn't cover Russia — Google left the RU SERP, and location_code
 *     2643 returns error 40501. Such domains must never be routed here at
 *     all; they're served by Keys.so (see supportsDataForSeo);
 *   • the error arrives inside an HTTP 200 response — the status lives in the
 *     body, both at the top level and inside the task. We check both, or
 *     "no data" can't be told apart from "ran out of account balance".
 */
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DiscoverSettings } from './settings';
import { dfsCostCtx } from './cost-context';

const BASE = 'https://api.dataforseo.com';
const TIMEOUT_MS = 30_000;
const DEFAULT_LOCATION = 2840; // United States — has the most complete etv
const DEFAULT_LANGUAGE = 'en';

// Zones where Labs is empty: Google doesn't operate in these markets, or there's no data.
const NO_DATAFORSEO_TLD = new Set(['ru', 'su', 'by', 'moscow', 'tatar']);

// Fixed request price in rubles when the response has no cost field (same as in Python).
const FIXED_COST_RUB = 0.18;

export function supportsDataForSeo(domain?: string | null): boolean {
  const tld = String(domain || '').split('.').pop()?.toLowerCase() || '';
  return !NO_DATAFORSEO_TLD.has(tld);
}

export function bareDomain(input?: string | null): string | null {
  if (!input) return null;
  const s = String(input).trim().toLowerCase().split('//').pop()?.split('/')[0];
  return s || null;
}

// Number(null) === 0 and Number('') === 0 — if blanks aren't filtered out up
// front, "no data" turns into "we computed it and got zero". In Python, this
// is where float(None) raises and the field becomes None; the behavior must
// match, or the frontend shows 0 keywords instead of "n/a".
const isBlank = (v: unknown): boolean =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

const toInt = (v: unknown): number | null => {
  if (isBlank(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};
const toFloat = (v: unknown): number | null => {
  if (isBlank(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Banker's rounding (half-to-even) for anchor share — matches Python `round()`.
 * Local (not imported from aeo/text): discover is the lower layer, aeo already
 * depends on it, and importing back would create a cycle. Precision here is
 * only for display (anchors are a passthrough in normalize), so the simple
 * version is enough.
 */
function bankersRound(x: number): number {
  const f = Math.floor(x);
  const diff = x - f;
  if (diff < 0.5) return f;
  if (diff > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

const INTENT: Record<string, string> = {
  informational: 'INFO',
  navigational: 'NAV',
  commercial: 'COMM',
  transactional: 'TX',
};

/** Position change as a single string — the shape the table frontend expects. */
function changeOf(d: Record<string, any>): string {
  if (d?.is_new) return 'NEW';
  if (d?.is_up) return 'up';
  if (d?.is_down) return 'down';
  return '—';
}

/** keyword_info.monthly_searches → the last n demand values for the sparkline. */
function monthlyTrend(ki: Record<string, any>, n = 12): number[] | null {
  const ms = ki?.monthly_searches;
  if (!Array.isArray(ms) || !ms.length) return null;
  const rows = ms
    .map((m: any) => ({
      y: toInt(m?.year) ?? 0,
      m: toInt(m?.month) ?? 0,
      v: toInt(m?.search_volume) ?? 0,
    }))
    .sort((a, b) => a.y - b.y || a.m - b.m);
  const out = rows.map((r) => r.v).slice(-n);
  return out.length ? out : null;
}

export interface OverviewRow {
  // null is intentional here: with Keys.so, traffic can be missing, and "no
  // data" shouldn't turn into zero. The DataForSEO branch always gives a number.
  organic_etv: number | null;
  paid_etv: number | null;
  total_traffic: number | null;
  organic_keywords: number | null;
  paid_keywords: number | null;
  top3_rankings: number;
  cpc_spend_usd: number | null;
  // Position buckets for the "Position distribution" histogram
  // (dataforseo.py:227-234). Absent from the keys.so overview.
  pos_dist?: Record<string, number> | null;
  source?: string;
}

/** Geo params for the Labs call (site_analytic sends these per-market). */
export interface GeoOpts {
  locationCode?: number;
  languageCode?: string;
}

@Injectable()
export class DataForSeoClient {
  private readonly log = new Logger('DataForSEO');

  constructor(
    private readonly settings: DiscoverSettings,
    private readonly prisma: PrismaService,
  ) {}

  private async auth(): Promise<string | null> {
    const login = await this.settings.get('DATAFORSEO_LOGIN');
    const password = await this.settings.get('DATAFORSEO_PASSWORD');
    if (!login || !password) return null;
    return Buffer.from(`${login}:${password}`).toString('base64');
  }

  /** Spend is recorded in the same llm_usage table as Python, or the accounting drifts. */
  private async recordUsage(path: string, status: string, latencyMs: number,
                            costRub: number | null, error?: string) {
    try {
      await this.prisma.llmUsage.create({
        data: {
          provider: 'dataforseo',
          model: path,
          purpose: 'discover',
          status,
          error: error ?? null,
          latencyMs: Math.round(latencyMs),
          costRub: costRub ?? null,
        },
      });
    } catch {
      // Cost tracking isn't more important than the response itself: continue silently.
    }
  }

  /**
   * POST to the Labs live endpoint. Returns the first task's `result` or
   * null — on any failure: no keys, wrong HTTP, envelope error, task error.
   */
  private async post(path: string, payload: unknown[]): Promise<any[] | null> {
    const auth = await this.auth();
    if (!auth) return null;

    const started = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(BASE + path, {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
    } catch (e: any) {
      await this.recordUsage(path, 'error', Date.now() - started, null, String(e?.message || e));
      this.log.debug(`${path} request failed to send: ${e}`);
      return null;
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      await this.recordUsage(path, 'error', Date.now() - started, null, String(res.status));
      this.log.debug(`${path} HTTP ${res.status}`);
      return null;
    }

    let data: any;
    try {
      data = await res.json();
    } catch {
      await this.recordUsage(path, 'error', Date.now() - started, null, 'non_json');
      return null;
    }

    const usdRub = Number(process.env.USD_RUB || 90) || 90;
    const cost = Number(data?.cost || 0);
    const costRub = cost > 0 ? Number((cost * usdRub).toFixed(4)) : FIXED_COST_RUB;

    // The error arrives with HTTP 200 — check the envelope first, then the task itself.
    if (data?.status_code !== 20000) {
      await this.recordUsage(path, 'error', Date.now() - started, costRub, String(data?.status_code));
      this.log.debug(`${path} api ${data?.status_code}: ${data?.status_message}`);
      return null;
    }
    // Cost (USD) — added to the per-run counter, if one is active (site_analytic).
    // The exact spot as _add_cost(data) in Python (dataforseo.py:171): after
    // checking the 20000 envelope, regardless of the task status. Outside the
    // context — no-op.
    if (cost > 0) dfsCostCtx.getStore()?.addUsd(cost);
    const task = (data?.tasks || [])[0];
    if (!task) {
      await this.recordUsage(path, 'error', Date.now() - started, costRub, 'no_tasks');
      return null;
    }
    if (task.status_code !== 20000) {
      // Out of balance / no data for the target — degrade silently, like Python.
      await this.recordUsage(path, 'error', Date.now() - started, costRub, String(task.status_code));
      this.log.debug(`${path} task ${task.status_code}: ${task.status_message}`);
      return null;
    }
    await this.recordUsage(path, 'ok', Date.now() - started, costRub);
    return task.result || [];
  }

  /** Traffic and keyword counts by domain. */
  async domainOverview(domain: string, geo?: GeoOpts): Promise<OverviewRow | null> {
    const target = bareDomain(domain);
    if (!target) return null;
    const res = await this.post('/v3/dataforseo_labs/google/domain_rank_overview/live', [
      {
        target,
        location_code: geo?.locationCode ?? DEFAULT_LOCATION,
        language_code: geo?.languageCode ?? DEFAULT_LANGUAGE,
      },
    ]);
    const items = res?.[0]?.items || [];
    if (!items.length) return null;

    const m = items[0]?.metrics || {};
    const org = m.organic || {};
    const paid = m.paid || {};
    const bucket = (d: any, ...keys: string[]) =>
      keys.reduce((sum, k) => sum + (toInt(d?.[k]) ?? 0), 0);

    const orgEtv = toInt(org.etv) ?? 0;
    const paidEtv = toInt(paid.etv) ?? 0;
    return {
      organic_etv: orgEtv,
      paid_etv: paidEtv,
      total_traffic: orgEtv + paidEtv,
      organic_keywords: toInt(org.count),
      paid_keywords: toInt(paid.count),
      top3_rankings: bucket(org, 'pos_1', 'pos_2_3'),
      cpc_spend_usd: toInt(paid.estimated_paid_traffic_cost),
      // Port of domain_overview pos_dist (dataforseo.py:227-234): position buckets.
      pos_dist: {
        '1-3': bucket(org, 'pos_1', 'pos_2_3'),
        '4-10': bucket(org, 'pos_4_10'),
        '11-20': bucket(org, 'pos_11_20'),
        '21-50': bucket(org, 'pos_21_30', 'pos_31_40', 'pos_41_50'),
        '51-100': bucket(org, 'pos_51_60', 'pos_61_70', 'pos_71_80', 'pos_81_90', 'pos_91_100'),
      },
    };
  }

  /** Monthly organic/paid traffic — a series for the chart. */
  async historicalOverview(domain: string, months = 12, geo?: GeoOpts) {
    const target = bareDomain(domain);
    if (!target) return null;
    const res = await this.post('/v3/dataforseo_labs/google/historical_rank_overview/live', [
      {
        target,
        location_code: geo?.locationCode ?? DEFAULT_LOCATION,
        language_code: geo?.languageCode ?? DEFAULT_LANGUAGE,
      },
    ]);
    const items = res?.[0]?.items || [];
    const rows = items
      .map((it: any) => {
        const m = it?.metrics || {};
        const org = m.organic || {};
        const paid = m.paid || {};
        const year = toInt(it?.year);
        const month = toInt(it?.month);
        if (year === null || month === null) return null;
        const orgEtv = toInt(org.etv) ?? 0;
        const paidEtv = toInt(paid.etv) ?? 0;
        return {
          year, month,
          organic_etv: orgEtv,
          paid_etv: paidEtv,
          total_traffic: orgEtv + paidEtv,
          organic_keywords: toInt(org.count),
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => a.year - b.year || a.month - b.month);
    return rows.length ? rows.slice(-months) : null;
  }

  /** Keywords the domain already ranks for. */
  async domainKeywords(domain: string, limit = 25, geo?: GeoOpts) {
    const target = bareDomain(domain);
    if (!target) return null;
    const res = await this.post('/v3/dataforseo_labs/google/ranked_keywords/live', [
      {
        target,
        location_code: geo?.locationCode ?? DEFAULT_LOCATION,
        language_code: geo?.languageCode ?? DEFAULT_LANGUAGE,
        limit, order_by: ['ranked_serp_element.serp_item.etv,desc'],
      },
    ]);
    const items = res?.[0]?.items || [];
    return items.map((it: any) => {
      const kd = it?.keyword_data || {};
      const ki = kd.keyword_info || {};
      const kp = kd.keyword_properties || {};
      const si = kd.search_intent_info || {};
      const serp = it?.ranked_serp_element?.serp_item || {};
      const cpc = toFloat(ki.cpc);
      return {
        keyword: kd.keyword,
        clicks: toInt(serp.etv),
        volume: toInt(ki.search_volume),
        kd: toInt(kp.keyword_difficulty),
        intent: INTENT[String(si.main_intent || '').toLowerCase()] || '-',
        cpc: cpc === null ? null : Number(cpc.toFixed(2)),
        url: serp.relative_url || serp.url,
        rank: toInt(serp.rank_absolute),
        // prev_rank is needed by the keyword table's normalize (dataforseo.py:297-298).
        prev_rank: toInt(serp?.rank_changes?.previous_rank_absolute),
        change: changeOf(serp),
        trend: monthlyTrend(ki),
      };
    });
  }

  /** Keyword ideas from a seed phrase. */
  async keywordIdeas(seed: string, limit = 30) {
    const s = String(seed || '').trim();
    if (!s) return null;
    const res = await this.post('/v3/dataforseo_labs/google/keyword_ideas/live', [
      {
        keywords: [s], location_code: DEFAULT_LOCATION, language_code: DEFAULT_LANGUAGE,
        limit, order_by: ['keyword_info.search_volume,desc'],
      },
    ]);
    const items = res?.[0]?.items || [];
    const out = items
      .filter((it: any) => it?.keyword)
      .map((it: any) => {
        const ki = it.keyword_info || {};
        const kp = it.keyword_properties || {};
        const si = it.search_intent_info || {};
        const cpc = toFloat(ki.cpc);
        return {
          keyword: it.keyword,
          volume: toInt(ki.search_volume),
          kd: toInt(kp.keyword_difficulty),
          cpc: cpc === null ? null : Number(cpc.toFixed(2)),
          intent: INTENT[String(si.main_intent || '').toLowerCase()] || '-',
          trend: monthlyTrend(ki),
        };
      });
    return out.length ? out : null;
  }

  /**
   * Long-tail full-text suggestions from a seed phrase (port of
   * keyword_suggestions, core/dataforseo.py:373) — real audience query
   * wordings + volume. Unlike keywordIdeas (related keywords), this is
   * literal occurrences of the seed phrase in real queries. Row:
   * {keyword, volume, trend}. Empty → null.
   */
  async keywordSuggestions(seed: string, limit = 30) {
    const s = String(seed || '').trim();
    if (!s) return null;
    const res = await this.post('/v3/dataforseo_labs/google/keyword_suggestions/live', [
      {
        keyword: s, location_code: DEFAULT_LOCATION, language_code: DEFAULT_LANGUAGE,
        limit, order_by: ['keyword_info.search_volume,desc'],
      },
    ]);
    const items = res?.[0]?.items || [];
    const out = items
      .filter((it: any) => it?.keyword)
      .map((it: any) => {
        const ki = it.keyword_info || {};
        return { keyword: it.keyword, volume: toInt(ki.search_volume), trend: monthlyTrend(ki) };
      });
    return out.length ? out : null;
  }

  /** Pages that bring the domain organic traffic. */
  async domainPages(domain: string, limit = 20, geo?: GeoOpts) {
    const target = bareDomain(domain);
    if (!target) return null;
    const res = await this.post('/v3/dataforseo_labs/google/relevant_pages/live', [
      {
        target,
        location_code: geo?.locationCode ?? DEFAULT_LOCATION,
        language_code: geo?.languageCode ?? DEFAULT_LANGUAGE,
        limit, order_by: ['metrics.organic.etv,desc'],
      },
    ]);
    const items = res?.[0]?.items || [];
    return items.map((it: any) => {
      const org = it?.metrics?.organic || {};
      return {
        url: it?.page_address,
        clicks: toInt(org.etv),
        keywords: toInt(org.count),
        change: changeOf(org),
      };
    });
  }

  /** Domains competing for the same keywords. */
  async domainCompetitors(domain: string, limit = 10, geo?: GeoOpts) {
    const target = bareDomain(domain);
    if (!target) return null;
    const res = await this.post('/v3/dataforseo_labs/google/competitors_domain/live', [
      {
        target,
        location_code: geo?.locationCode ?? DEFAULT_LOCATION,
        language_code: geo?.languageCode ?? DEFAULT_LANGUAGE,
        limit, exclude_top_domains: true,
      },
    ]);
    const items = res?.[0]?.items || [];
    const out = items
      .filter((it: any) => it?.domain && it.domain !== target)
      .map((it: any) => {
        const org = it?.metrics?.organic || {};
        return {
          domain: it.domain,
          shared_keywords: toInt(it.intersections),
          traffic: toInt(org.etv),
          keywords: toInt(org.count),
        };
      });
    return out.length ? out : null;
  }

  /**
   * Backlink profile. In Python, an in-house n8n webhook is tried first (it
   * works around the Backlinks API's $100/mo minimum plan), and only then the
   * direct call. Here it's direct-only for now: porting the webhook is a
   * separate step, and without a subscription the response is 40204 → null,
   * so the "Authority" block just stays empty.
   */
  async domainBacklinks(domain: string) {
    const target = bareDomain(domain);
    if (!target) return null;
    const res = await this.post('/v3/backlinks/summary/live', [
      { target, internal_list_limit: 10, backlinks_status_type: 'live' },
    ]);
    const r = res?.[0];
    if (!r) return null;

    const total = toInt(r.backlinks) ?? 0;
    const nofollow = toInt(r.referring_links_attributes?.nofollow) ?? 0;
    const rank = toInt(r.rank);
    return {
      backlinks: total,
      referring_domains: toInt(r.referring_domains),
      referring_main_domains: toInt(r.referring_main_domains),
      authority: rank === null ? null : Math.round(rank / 10), // 0-1000 → 0-100
      dofollow_pct: total ? Number((((total - nofollow) / total) * 100).toFixed(1)) : null,
      broken_backlinks: toInt(r.broken_backlinks),
      spam_score: toInt(r.backlinks_spam_score),
      referring_types: r.referring_links_types || {},
      source: 'dataforseo',
    };
  }

  /**
   * Top anchors of the backlink profile (port of backlinks_anchors,
   * dataforseo.py:519-537) → [{a, pct}] (pct — share of referring_domains
   * among the top-N). Without a subscription, the Backlinks API returns
   * 40204 → null.
   */
  async backlinksAnchors(domain: string, limit = 6): Promise<Array<{ a: string; pct: number }> | null> {
    const target = bareDomain(domain);
    if (!target) return null;
    const res = await this.post('/v3/backlinks/anchors/live', [
      { target, limit, order_by: ['referring_domains,desc'], backlinks_status_type: 'live' },
    ]);
    const items = res?.[0]?.items || [];
    const rows = items.map((it: any) => {
      const a = String(it?.anchor ?? '').trim().slice(0, 60) || '(пустой)';
      return { a, w: toInt(it?.referring_domains) ?? 0 };
    });
    const total = rows.reduce((s: number, r: any) => s + r.w, 0);
    if (!total) return null;
    return rows
      .filter((r: any) => r.w > 0)
      .map((r: any) => ({ a: r.a, pct: bankersRound((r.w / total) * 100) }));
  }

  /**
   * Monthly referring-domain history (port of backlinks_history,
   * dataforseo.py:540-557) → [{date:'YYYY-MM', referring_domains}] for the
   * last N months, sorted ascending by date.
   */
  async backlinksHistory(domain: string, months = 12): Promise<Array<{ date: string; referring_domains: number }> | null> {
    const target = bareDomain(domain);
    if (!target) return null;
    const res = await this.post('/v3/backlinks/history/live', [{ target }]);
    const items = res?.[0]?.items || [];
    const rows: Array<{ date: string; referring_domains: number }> = [];
    for (const it of items) {
      const d = String(it?.date ?? '').slice(0, 7);
      const rd = toInt(it?.referring_domains);
      if (d && rd !== null) rows.push({ date: d, referring_domains: rd });
    }
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const out = rows.slice(-months);
    return out.length ? out : null;
  }

  /**
   * Tech stack (port of domain_technologies, dataforseo.py:680-706) →
   * {group: [tech, ...]}. Flattens the group→category→[names] tree into one
   * level (categories under a group are merged, order preserved, deduped).
   */
  async domainTechnologies(domain: string): Promise<Record<string, string[]> | null> {
    const target = bareDomain(domain);
    if (!target) return null;
    const res = await this.post('/v3/domain_analytics/technologies/domain_technologies/live', [
      { target },
    ]);
    const tech = res?.[0]?.technologies;
    if (!tech || typeof tech !== 'object' || Array.isArray(tech)) return null;
    const out: Record<string, string[]> = {};
    for (const [group, cats] of Object.entries(tech as Record<string, any>)) {
      let names: string[] = [];
      if (cats && typeof cats === 'object' && !Array.isArray(cats)) {
        for (const vals of Object.values(cats as Record<string, any>)) {
          for (const v of Array.isArray(vals) ? vals : [vals]) {
            if (v && !names.includes(v)) names.push(v);
          }
        }
      } else if (Array.isArray(cats)) {
        names = cats.filter((v) => v);
      }
      if (names.length) out[group] = names;
    }
    return Object.keys(out).length ? out : null;
  }

  /**
   * Keyword gap (port of domain_gap_keywords, dataforseo.py:645-676):
   * keywords DOMAIN (the competitor) ranks for but COMPARE (your own site)
   * doesn't (intersections=false). Rows: {kw, vol, kd, pos, etv}, sorted by
   * etv desc.
   */
  async domainGapKeywords(domain: string, compare: string, limit = 30, geo?: GeoOpts) {
    const t1 = bareDomain(domain);
    const t2 = bareDomain(compare);
    if (!t1 || !t2) return null;
    const res = await this.post('/v3/dataforseo_labs/google/domain_intersection/live', [
      {
        target1: t1, target2: t2,
        location_code: geo?.locationCode ?? DEFAULT_LOCATION,
        language_code: geo?.languageCode ?? DEFAULT_LANGUAGE,
        intersections: false, limit,
        order_by: ['first_domain_serp_element.serp_item.etv,desc'],
      },
    ]);
    const items = res?.[0]?.items || [];
    const out = items.map((it: any) => {
      const kd = it?.keyword_data || {};
      const ki = kd.keyword_info || {};
      const kp = kd.keyword_properties || {};
      const serp = it?.first_domain_serp_element?.serp_item || {};
      return {
        kw: kd.keyword,
        vol: toInt(ki.search_volume),
        kd: toInt(kp.keyword_difficulty),
        pos: toInt(serp.rank_absolute),
        etv: toInt(serp.etv),
      };
    });
    return out.length ? out : null;
  }
}
