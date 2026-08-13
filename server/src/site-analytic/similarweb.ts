/**
 * Port of core/sources.py::similarweb_overview (sources.py:104-177) plus the
 * rapidapi_get transport (sources.py:52-84) — the Similarweb clickstream panel
 * via a configurable RapidAPI wrapper. The "panel" block of the analysis:
 * monthly visits + history, engagement (bounce/pages/time), ranks, traffic
 * channels, geo, top keywords and AI referral. This is the only source for ALL
 * channels (direct/social/referral) — no search database exposes them.
 *
 * Layers, as everywhere in this port:
 *   • PURE CORE — `parseSimilarweb(data, domain)`: raw wrapper response → the
 *     shape normalize reads. Deterministic, parity checked on synthetic data
 *     (similarweb.spec.ts) — we do not burn paid RapidAPI calls.
 *   • NETWORK SHELL — `similarwebOverview(urlOrDomain)`: host+domain gate, call
 *     to the wrapper through an injectable RapidGet (env-driven — proxy POST
 *     when RAPIDAPI_PROXY_URL is set, otherwise a direct GET with RAPIDAPI_KEY),
 *     SSRF guard/timeout in the default transport. Any failure/non-200/non-JSON
 *     → null (UI shows "n/a").
 *
 * Footguns verified against CPython:
 *   • `da` = data["domain_analytics"] if dict, else data itself if dict, else {};
 *   • a minimal wrapper (only "Visits") degrades to a visits-only block;
 *   • `_pct` = round(float(x)*100, 1) — banker's rounding (pyRound);
 *   • `int(TimeOnSite)` truncates TOWARD ZERO; EstimatedMonthlyVisits order is by
 *     month key (sorted), not by insertion.
 */
import { toIntLoose, isDict, pyFalsy } from './pyutil';
import { pyRound } from './pyhelpers';
import { makeFetchGet, makeFetchPostJson } from './http';

const TIMEOUT_MS = 30_000;

/** RapidAPI transport: (host, path, query) → parsed JSON | null. */
export type RapidGet = (
  host: string,
  path: string,
  query: Record<string, unknown>,
) => Promise<unknown | null>;

/** `float(x) or None` — the Python `_swf` (sources.py:96-101). */
export function swf(x: unknown): number | null {
  if (x === null || x === undefined) return null; // float(None) → TypeError
  if (typeof x === 'number') return Number.isNaN(x) ? NaN : x;
  if (typeof x === 'boolean') return x ? 1 : 0; // float(True) == 1.0
  if (typeof x === 'string') {
    const t = x.trim().toLowerCase();
    if (t === '') return null; // float("") → ValueError
    if (t === 'inf' || t === '+inf' || t === 'infinity') return Infinity;
    if (t === '-inf' || t === '-infinity') return -Infinity;
    if (t === 'nan') return NaN;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null;
    return Number(t);
  }
  return null; // dict/list → TypeError → None
}

/** `da.get("Key") or da.get("key") or {}` — first truthy value or {}. */
function dictOr(v: unknown): Record<string, unknown> {
  return isDict(v) && !pyFalsy(v) ? v : {};
}

const dget = (o: Record<string, unknown>, k: string): unknown => o[k];
/** The Python `a or b` applied to a JSON value. */
const or = <T>(v: unknown, fb: T): unknown | T => (pyFalsy(v) ? fb : v);

/** `round(float(x)*100, 1)` or null (port of the nested `_pct`). */
function pct(x: unknown): number | null {
  const f = swf(x);
  return f === null ? null : pyRound(f * 100, 1);
}

/** A row of the normalized Similarweb panel (what normalize reads). */
export interface SimilarwebOverview {
  domain: string;
  visits_monthly: number | null;
  visits_history?: Array<{ month: string; visits: number | null }>;
  engagement?: {
    bounce_rate: number | null;
    pages_per_visit: number | null;
    time_on_site_sec: number | null;
  };
  ranks?: {
    global: number | null;
    country: number | null;
    country_code: unknown;
    category: number | null;
    category_name: unknown;
  };
  channels?: Record<string, number>;
  geo?: Array<{ country: unknown; code: unknown; pct: number | null }>;
  top_keywords?: Array<{ keyword: unknown; volume: number | null; cpc: number | null; est_value: number | null }>;
  ai_traffic?: Array<{ name: unknown; rank: unknown }>;
  category?: unknown;
  screenshot?: unknown;
  raw?: unknown;
}

/**
 * Raw RapidAPI wrapper response → panel block (port of the similarweb_overview
 * body). Empty/non-object `data` → null (the caller already applied the
 * `if not data` gate, but we keep it here too — parse is tested off-network).
 */
export function parseSimilarweb(data: unknown, domain: string): SimilarwebOverview | null {
  if (pyFalsy(data)) return null;
  // da = data["domain_analytics"] if dict, else data if dict, else {}.
  const daRaw = isDict(data) ? data['domain_analytics'] : null;
  const da: Record<string, unknown> = isDict(daRaw) ? daRaw : isDict(data) ? data : {};

  const eng = dictOr(or(dget(da, 'Engagments'), dget(da, 'Engagements')));
  const ts = dictOr(dget(da, 'TrafficSources'));

  // Minimal wrapper (only "Visits") → visits-only block or null.
  if (!(!pyFalsy(eng) || !pyFalsy(ts) || dget(da, 'GlobalRank'))) {
    const v = toIntLoose(or(dget(da, 'Visits'), dget(da, 'visits')));
    return v ? { domain, visits_monthly: v, raw: data } : null;
  }

  const emv = dictOr(dget(da, 'EstimatedMonthlyVisits'));
  const hist = Object.entries(emv)
    .map(([month, v]) => ({ month, visits: toIntLoose(v) }))
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  const visits = toIntLoose(dget(eng, 'Visits')) ?? (hist.length ? hist[hist.length - 1].visits : null);

  const channels: Record<string, number> = {};
  for (const [k, v] of Object.entries(ts)) {
    const p = pct(v);
    if (p !== null) channels[k] = p;
  }

  const geoSrc = Array.isArray(dget(da, 'TopCountryShares')) ? (dget(da, 'TopCountryShares') as unknown[]) : [];
  const geo = geoSrc.slice(0, 8).map((c) => {
    const rec = dictOr(c);
    return { country: dget(rec, 'country'), code: dget(rec, 'countryCode'), pct: pct(dget(rec, 'Value')) };
  });

  const gr = dictOr(dget(da, 'GlobalRank'));
  const cr = dictOr(dget(da, 'CountryRank'));
  const cat = dictOr(dget(da, 'CategoryRank'));

  const kwSrc = Array.isArray(dget(da, 'TopKeywords')) ? (dget(da, 'TopKeywords') as unknown[]) : [];
  const kws = kwSrc.slice(0, 15).map((k) => {
    const rec = dictOr(k);
    return {
      keyword: dget(rec, 'Name'),
      volume: toIntLoose(dget(rec, 'Volume')),
      cpc: swf(dget(rec, 'Cpc')),
      est_value: toIntLoose(dget(rec, 'EstimatedValue')),
    };
  });

  const aiSplit = ((): unknown[] => {
    const details = dictOr(dget(da, 'AiTrafficDetails'));
    const traffic = dictOr(dget(details, 'Traffic'));
    const split = dget(traffic, 'Split');
    return Array.isArray(split) ? split : [];
  })();
  const ai = aiSplit.slice(0, 6).map((s) => {
    const rec = dictOr(s);
    return { name: dget(rec, 'Name'), rank: dget(rec, 'Rank') };
  });

  const tos = swf(dget(eng, 'TimeOnSite'));
  const ppvRaw = swf(dget(eng, 'PagePerVisit'));

  return {
    domain,
    visits_monthly: visits,
    visits_history: hist,
    engagement: {
      bounce_rate: pct(dget(eng, 'BounceRate')),
      pages_per_visit: ppvRaw === null ? null : pyRound(ppvRaw, 1),
      time_on_site_sec: tos === null ? null : Math.trunc(tos),
    },
    ranks: {
      global: toIntLoose(dget(gr, 'Rank')),
      country: toIntLoose(dget(cr, 'Rank')),
      country_code: dget(cr, 'CountryCode'),
      category: toIntLoose(dget(cat, 'Rank')),
      category_name: dget(cat, 'Category'),
    },
    channels,
    geo,
    top_keywords: kws,
    ai_traffic: ai,
    category: dget(da, 'Category'),
    screenshot: dget(da, 'LargeScreenshot'),
  };
}

/** `_domain` (sources.py:42-48): 'https://calendly.com/x' | 'Calendly' → 'calendly.com'. */
export function normDomain(urlOrDomain: unknown): string | null {
  if (pyFalsy(urlOrDomain)) return null;
  const s = String(urlOrDomain).trim().toLowerCase();
  const host = s.split('//').pop()!.split('/')[0];
  return host || null;
}

export interface SimilarwebOptions {
  host?: string | null;
  path?: string | null;
  param?: string | null;
  /** RapidAPI transport injection for tests; env-driven by default. */
  rapid?: RapidGet;
}

/**
 * Similarweb panel for a domain/URL (port of similarweb_overview). Missing host
 * (env RAPIDAPI_SIMILARWEB_HOST) or a broken domain → null. `param==='url'`
 * requires a full URL, otherwise a bare domain (the wrapper's contract).
 */
export async function similarwebOverview(
  urlOrDomain: string,
  opts: SimilarwebOptions = {},
): Promise<SimilarwebOverview | null> {
  const host = opts.host ?? process.env.RAPIDAPI_SIMILARWEB_HOST ?? null;
  const domain = normDomain(urlOrDomain);
  if (!host || !domain) return null;
  const path = opts.path ?? process.env.RAPIDAPI_SIMILARWEB_PATH ?? '/analyticsv1';
  const param = opts.param ?? process.env.RAPIDAPI_SIMILARWEB_PARAM ?? 'url';
  const value = param === 'url' ? `https://${domain}` : domain;
  const rapid = opts.rapid ?? makeDefaultRapid();

  const data = await rapid(host, path, { [param]: value });
  if (pyFalsy(data)) return null;
  return parseSimilarweb(data, domain);
}

/**
 * Default RapidAPI transport: proxy POST when RAPIDAPI_PROXY_URL is set (RU
 * 451-egress goes through a Cloudflare Worker), otherwise a direct GET with
 * X-RapidAPI-Key. Both paths go through the SSRF gate + timeout
 * (makeFetchPostJson/own fetch). Non-200/failure → null.
 */
export function makeDefaultRapid(): RapidGet {
  const postJson = makeFetchPostJson({ timeoutMs: TIMEOUT_MS });
  return async (host, path, query) => {
    const proxy = process.env.RAPIDAPI_PROXY_URL;
    if (proxy) {
      const secret = process.env.RAPIDAPI_PROXY_SECRET || '';
      const r = await postJson(proxy, { host, path, query }, { 'X-Proxy-Secret': secret });
      if (r === null || r.status !== 200) return null;
      return r.body;
    }
    const key = process.env.RAPIDAPI_KEY || '';
    if (!key) return null;
    // Direct GET with key headers: own transport (per-call headers).
    const get = makeFetchGet({
      timeoutMs: TIMEOUT_MS,
      headers: { 'X-RapidAPI-Key': key, 'X-RapidAPI-Host': host },
    });
    const r = await get(`https://${host}${path}`, query);
    if (r === null || r.status !== 200) return null;
    return r.body;
  };
}
