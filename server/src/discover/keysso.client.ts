/**
 * Keys.so — port from Python (core/keysso.py). Handles Russian domains that
 * aren't in DataForSEO Labs: there's simply no Google SERP data for RU there.
 *
 * Responses are normalized to the same shape DataForSEO returns, so the layer
 * above doesn't need to know where the data came from. Whatever Keys.so
 * doesn't have, we return null, not zero: on the frontend, zero reads as "we
 * counted and it's empty", null as "no data" — and those are different things.
 */
import { Injectable, Logger } from '@nestjs/common';
import { DiscoverSettings } from './settings';
import { bareDomain, OverviewRow } from './dataforseo.client';

const BASE = 'https://api.keys.so';
const TIMEOUT_MS = 30_000;
const DEFAULT_DB = 'msk'; // default Yandex database — Moscow SERP

// Number(null) === 0 — blanks must be filtered out before coercion, or
// "no data" turns into zero (more detail in dataforseo.client.ts).
const toInt = (v: unknown): number | null => {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};

/** The response comes back either as a list or an object with data/rows/items — normalize it. */
function rowsOf(j: any): any[] {
  if (Array.isArray(j)) return j;
  if (j && typeof j === 'object') {
    for (const k of ['data', 'rows', 'items']) {
      if (Array.isArray(j[k])) return j[k];
    }
  }
  return [];
}

/** The dashboard is a single metrics object: under data, or right at the root. */
function dashboardOf(j: any): Record<string, any> {
  if (Array.isArray(j)) return j[0] || {};
  if (j && typeof j === 'object') {
    const d = j.data;
    if (Array.isArray(d)) return d[0] || {};
    if (d && typeof d === 'object') return d;
    return j;
  }
  return {};
}

@Injectable()
export class KeysSoClient {
  private readonly log = new Logger('KeysSo');

  constructor(private readonly settings: DiscoverSettings) {}

  private async get(path: string, params: Record<string, string | number>): Promise<any | null> {
    const token = await this.settings.get('KEYSSO_API_KEY');
    if (!token) return null;

    const qs = new URLSearchParams({ ...params, 'auth-token': token } as any);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${BASE}${path}?${qs}`, { signal: ac.signal });
      if (!res.ok) {
        this.log.debug(`${path} HTTP ${res.status}`);
        return null;
      }
      return await res.json();
    } catch (e) {
      this.log.debug(`${path} request failed to send: ${e}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async domainOverview(domain: string, base = DEFAULT_DB): Promise<OverviewRow | null> {
    const target = bareDomain(domain);
    if (!target) return null;
    const j = await this.get('/report/simple/domain_dashboard', { base, domain: target });
    const d = dashboardOf(j);
    if (!j || !Object.keys(d).length) return null;

    const traf = toInt(d.traf);
    return {
      // No zero fallback here: Python returns None here, and the frontend
      // distinguishes "no traffic data" from "traffic is zero".
      organic_etv: traf,
      paid_etv: toInt(d.adtraf),
      total_traffic: traf,
      organic_keywords: toInt(d.topkeys),
      paid_keywords: toInt(d.adkeyscnt),
      // Top-3 isn't returned directly: we sum top-1 and top-5 as the closest proxy.
      top3_rankings: (toInt(d.it1) ?? 0) + (toInt(d.it5) ?? 0),
      cpc_spend_usd: toInt(d.adcost),
      source: 'keysso',
    };
  }

  async domainKeywords(domain: string, limit = 25, base = DEFAULT_DB) {
    const target = bareDomain(domain);
    if (!target) return null;
    const j = await this.get('/report/simple/organic/keywords', {
      base, domain: target, per_page: limit, sort: 'pos|asc',
    });
    if (!j) return null;
    return rowsOf(j).map((it: any) => ({
      keyword: it.word,
      clicks: null,                 // Keys.so returns positions, not clicks
      volume: toInt(it.ws),         // Wordstat frequency
      kd: null,
      intent: it.isquest ? 'INFO' : '-',
      cpc: null,
      url: it.url,
      rank: toInt(it.pos),
      change: '—',
    }));
  }

  async domainCompetitors(domain: string, top = 10, base = DEFAULT_DB) {
    const target = bareDomain(domain);
    if (!target) return null;
    const j = await this.get('/report/simple/organic/concurents', { base, domain: target, top });
    if (!j) return null;
    return rowsOf(j).map((it: any) => ({
      name: it.name,
      common_keywords: toInt(it.cnt),
      visibility: toInt(it.vis),
    }));
  }
}
