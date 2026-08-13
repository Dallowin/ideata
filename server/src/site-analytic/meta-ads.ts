/**
 * Port of core/meta_ads.py - a brand's active ad creatives via the official
 * Meta Ad Library (graph.facebook.com/ads_archive). The «Реклама» (Ads) block of
 * the report.
 *
 * The layering is the same as everywhere else in the port:
 *   • PURE CORE - `sinceRu` (ISO -> 'апр 2026') and `parseAds` (raw items ->
 *     render rows {pl,h,t,since}); both deterministic, with parity against the
 *     oracle (meta-ads.parity.spec.ts) on synthetic data - we never burn the paid
 *     token.
 *   • NETWORK SHELL - `ads(brand)`: the META_ADS_TOKEN env gate (no token ->
 *     null, UI shows "n/a"), a GET through the injectable transport, failure
 *     isolated exactly like the Python httpx branch (request failed / HTTP != 200
 *     / non-JSON body -> null).
 *
 * Footguns verified against CPython:
 *   • `_since_ru`: str(iso)[:7].split("-") expects EXACTLY 2 parts, int(m) is
 *     strict, and the month is indexed like a list (m=00 -> months[-1]='дек',
 *     m=13 -> None);
 *   • `p.title()` for publisher_platforms (pyTitle): 'audience_network' ->
 *     'Audience_Network';
 *   • the h[:120]/t[:200] slices are by code points; `h[:120] or "—"`.
 */
import { pyStrip } from '../aeo/parse';
import { cpSlice, pyTitle, isDict, pyFalsy } from './pyutil';
import { makeFetchGet, type HttpGet } from './http';

const URL = 'https://graph.facebook.com/v19.0/ads_archive';
const TIMEOUT_MS = 30_000;
const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export interface AdRow {
  pl: string;
  h: string;
  t: string;
  since: string | null;
}

/** Strict Python `int(str)`: an integer only (optional sign), otherwise NaN. */
function pyIntStrict(s: string): number {
  return /^[+-]?\d+$/.test(s.trim()) ? parseInt(s.trim(), 10) : NaN;
}

/** '2026-04-17T…' -> 'апр 2026'. Port of `_since_ru` (any failure -> null). */
export function sinceRu(iso: unknown): string | null {
  const parts = String(iso).slice(0, 7).split('-');
  if (parts.length !== 2) return null; // Python `y, m = …` requires exactly 2
  const [y, m] = parts;
  const mi = pyIntStrict(m);
  if (!Number.isFinite(mi)) return null; // int(m) would raise ValueError
  const idx = mi - 1;
  // months[int(m)-1] - list indexing: -12..11 are valid, otherwise IndexError->null.
  if (idx > 11 || idx < -12) return null;
  return `${MONTHS_RU[(idx + 12) % 12]} ${y}`;
}

/** The first list element as a string (Python `titles[0] if titles else ""`). */
function first(arr: unknown): string {
  if (Array.isArray(arr) && arr.length) {
    const v = arr[0];
    return typeof v === 'string' ? v : String(v ?? '');
  }
  return '';
}

/** Raw Ad Library items -> rows of the «Реклама» (Ads) block (deterministic). */
export function parseAds(items: unknown[], limit: number): AdRow[] | null {
  const out: AdRow[] = [];
  for (const it of items.slice(0, limit)) {
    const rec = isDict(it) ? it : {};
    const h = pyStrip(first(rec['ad_creative_link_titles']));
    const t = pyStrip(first(rec['ad_creative_bodies']));
    if (!h && !t) continue;
    const platsRaw = rec['publisher_platforms'];
    const plats = Array.isArray(platsRaw) && !pyFalsy(platsRaw) ? platsRaw : [];
    const pl =
      'Meta' +
      (plats.length
        ? ` (${plats.slice(0, 2).map((p) => pyTitle(String(p))).join(', ')})`
        : '');
    out.push({
      pl,
      h: cpSlice(h, 120) || '—',
      t: cpSlice(t, 200),
      since: sinceRu(rec['ad_delivery_start_time']),
    });
  }
  return out.length ? out : null;
}

export interface AdsOptions {
  token?: string | null;
  limit?: number;
  countries?: string;
  /** Transport injection for tests; the real fetch by default. */
  get?: HttpGet;
}

/** Active ads for a brand name (port of meta_ads.ads). No token -> null. */
export async function ads(brand: string, opts: AdsOptions = {}): Promise<AdRow[] | null> {
  const token = opts.token ?? process.env.META_ADS_TOKEN ?? null;
  const limit = opts.limit ?? 6;
  const countries = opts.countries ?? '["US","GB","DE"]';
  if (!token || !brand) return null;
  const get = opts.get ?? makeFetchGet({ timeoutMs: TIMEOUT_MS });

  const resp = await get(URL, {
    access_token: token,
    search_terms: brand,
    ad_active_status: 'ACTIVE',
    ad_reached_countries: countries,
    fields:
      'ad_creative_link_titles,ad_creative_bodies,ad_delivery_start_time,publisher_platforms',
    limit: Math.trunc(limit),
  });
  if (resp === null) return null; // httpx.get raised -> None
  if (resp.status !== 200) return null;
  if (!isDict(resp.body)) return null; // r.json().get(...) on a non-dict -> except -> None
  const data = resp.body['data'];
  const items = Array.isArray(data) ? data : [];
  return parseAds(items, limit);
}
