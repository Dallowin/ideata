/**
 * Worldwide geo traffic estimate (site_analytic.py:32-45, 216-282).
 *
 * DataForSEO Labs reports traffic ONLY per country, so "the whole world" =
 * a parallel query over the top 16 search markets (~85% of Google's volume)
 * followed by a merge: traffic/budget are summed across locations, keyword
 * counters take the max (per-locale keyword sets overlap heavily, so a sum would
 * overstate them), and pos_dist comes from the strongest location. `bestLocale`
 * picks the location with the highest organic_etv - that is where the keyword /
 * page / competitor tables are computed (otherwise a non-US domain shows crumbs).
 *
 * DETERMINISTIC and pure -> parity against the oracle (_merge_overviews /
 * _best_locale), see geo.parity.spec.ts. The data-driven keys.so fallback branch
 * (_keysso_beats_labs) is split into a pure threshold + an injected keys.so
 * overview.
 */
import { supportsDataForSeo } from '../discover/dataforseo.client';
import { get, pyOr, truthy } from './pyhelpers';

export type WorldLocation = [code: string, locationCode: number, language: string];

// Top 16 search markets (site_analytic.py:32-39). Labs does not cover Russia -
// RU goes through keys.so.
export const WORLD_LOCATIONS: WorldLocation[] = [
  ['US', 2840, 'en'], ['IN', 2356, 'en'], ['BR', 2076, 'pt'],
  ['GB', 2826, 'en'], ['DE', 2276, 'de'], ['FR', 2250, 'fr'],
  ['ES', 2724, 'es'], ['IT', 2380, 'it'], ['MX', 2484, 'es'],
  ['ID', 2360, 'id'], ['JP', 2392, 'ja'], ['NL', 2528, 'nl'],
  ['PL', 2616, 'pl'], ['TR', 2792, 'tr'], ['CA', 2124, 'en'],
  ['AU', 2036, 'en'],
];

/** GEO_LOCATIONS: {lower(code): [locationCode, language]} (site_analytic.py:45). */
export const GEO_LOCATIONS: Record<string, [number, string]> = Object.fromEntries(
  WORLD_LOCATIONS.map(([c, loc, lang]) => [c.toLowerCase(), [loc, lang] as [number, string]]),
);

/**
 * How many markets to query (site_analytic.py:42-44): AA_GEO_MARKETS in [3, 16].
 * A function rather than a constant: env is read at call time, like Python reads
 * it when the worker module is imported - but this is easier to override in tests.
 */
export function geoSplit(): WorldLocation[] {
  const raw = parseInt(process.env.AA_GEO_MARKETS ?? '16', 10);
  const n = Math.max(3, Math.min(WORLD_LOCATIONS.length, Number.isFinite(raw) ? raw : 16));
  return WORLD_LOCATIONS.slice(0, n);
}

/** is_ru_domain (site_analytic.py:75-77): RU/CIS -> keys.so (Labs does not cover them). */
export function isRuDomain(domain: string): boolean {
  return !supportsDataForSeo(domain);
}

type Overview = Record<string, any>;

/**
 * _merge_overviews (site_analytic.py:231-257): the "whole world" roll-up built
 * from {code: overview}. `max(vals, key=organic_etv)` -> the FIRST maximum
 * (order = dict insertion order).
 */
export function mergeOverviews(overviews: Record<string, Overview> | null | undefined): Overview | null {
  if (!overviews || !Object.keys(overviews).length) return null;
  const vals = Object.values(overviews);
  const etv = (o: Overview): number => (pyOr(get(o, 'organic_etv'), 0) as number);

  let best = vals[0];
  let bestEtv = etv(vals[0]);
  for (let i = 1; i < vals.length; i += 1) {
    const e = etv(vals[i]);
    if (e > bestEtv) { best = vals[i]; bestEtv = e; } // strict > -> the first maximum
  }

  const sum = (key: string): number | null => {
    const s = vals.reduce((acc, o) => acc + (pyOr(get(o, key), 0) as number), 0);
    return s ? s : null;
  };
  const max = (key: string): number | null => {
    const m = vals.reduce((acc, o) => Math.max(acc, pyOr(get(o, key), 0) as number), 0);
    return m ? m : null;
  };

  const org = vals.reduce((acc, o) => acc + (pyOr(get(o, 'organic_etv'), 0) as number), 0);
  const paid = vals.reduce((acc, o) => acc + (pyOr(get(o, 'paid_etv'), 0) as number), 0);
  return {
    organic_etv: org,
    paid_etv: paid,
    total_traffic: org + paid,
    organic_keywords: max('organic_keywords'),
    paid_keywords: max('paid_keywords'),
    top3_rankings: max('top3_rankings'),
    cpc_spend_usd: sum('cpc_spend_usd'),
    pos_dist: get(best, 'pos_dist'),
  };
}

/**
 * _best_locale (site_analytic.py:260-267): the location with the highest
 * organic_etv -> [locationCode, language]. Empty overviews -> the one the user
 * selected (geo).
 */
export function bestLocale(overviews: Record<string, Overview> | null | undefined, geo: string): [number, string] {
  const def = GEO_LOCATIONS[geo] ?? GEO_LOCATIONS.us;
  if (!overviews || !Object.keys(overviews).length) return def;
  const codes = Object.keys(overviews);
  const etv = (c: string): number => (pyOr(get(overviews[c], 'organic_etv'), 0) as number);
  let bestCode = codes[0];
  let bestEtv = etv(codes[0]);
  for (let i = 1; i < codes.length; i += 1) {
    const e = etv(codes[i]);
    if (e > bestEtv) { bestCode = codes[i]; bestEtv = e; } // the first maximum
  }
  return GEO_LOCATIONS[bestCode.toLowerCase()] ?? def;
}

/** geo_split rows for facts (site_analytic.py:127-129): [{code, etv}] with etv>0. */
export function geoSplitRows(overviews: Record<string, Overview>): Array<{ code: string; etv: number }> | null {
  const rows: Array<{ code: string; etv: number }> = [];
  for (const [c, o] of Object.entries(overviews)) {
    const e = (pyOr(get(o, 'organic_etv'), 0) as number);
    if (e > 0) rows.push({ code: c, etv: e });
  }
  return rows.length ? rows : null;
}

// _RU_FALLBACK_MIN (site_analytic.py:270): the "Labs is nearly empty" threshold.
export function ruFallbackMin(): number {
  const raw = parseInt(process.env.AA_RU_FALLBACK_MIN ?? '1000', 10);
  return Number.isFinite(raw) ? raw : 1000;
}

/**
 * First half of _keysso_beats_labs (site_analytic.py:273-277): is it worth going
 * to keys.so at all - Labs returns less than the threshold. The second half
 * (`keyssoWins`) compares the keys.so overview once it has been fetched, which
 * keeps the keys.so request inside the collect shell and leaves the threshold
 * purely testable.
 */
export function shouldTryKeysso(merged: Overview | null): boolean {
  const labs = (pyOr(get(merged, 'total_traffic'), 0) as number);
  return labs < ruFallbackMin();
}

/** Second half (site_analytic.py:282): keys.so sees 2x+ more than Labs. */
export function keyssoWins(merged: Overview | null, ruOverview: Overview | null): boolean {
  const labs = (pyOr(get(merged, 'total_traffic'), 0) as number);
  if (!truthy(ruOverview)) return false;
  const ru = (pyOr(get(ruOverview, 'total_traffic'), 0) as number);
  return ru > Math.max(labs * 2, 100);
}
