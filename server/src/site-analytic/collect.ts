/**
 * COLLECT — top-level orchestrator for gathering raw data for one domain
 * (site_analytic.py:80-214). Three branches for choosing the SEO base:
 *   1) RU domain by TLD (isRuDomain) → keys.so;
 *   2) regular → world estimate over 16 DataForSEO Labs markets (collectOverviews)
 *      + tables from the strongest locale (bestLocale);
 *   3) data-driven RU fallback (shouldTryKeysso + keyssoWins): Labs is almost
 *      empty AND Yandex sees 2x+ more → keys.so even on .com/.gg.
 * Every step goes through `safe()` (failure-isolation: a failed source = null).
 * Blocks that don't depend on the SEO base (panel/speed/crowd/ads/media) are
 * added by collectSiteSide.
 *
 * Clients and site-side collectors are injected as ports — collect() is tested
 * with mock ports (collect.spec.ts), while the service wires in live adapters.
 */
import type { Raw } from './types';
import {
  bestLocale, geoSplit, geoSplitRows, isRuDomain, keyssoWins,
  mergeOverviews, shouldTryKeysso,
} from './geo';

// Collection limits (site_analytic.py:47-50).
const KEYWORDS_LIMIT = 200;
const PAGES_LIMIT = 20;
const COMPETITORS_LIMIT = 10;
const GAP_LIMIT = 30;

export type ProgressFn = (label: string) => void;

/** Geo parameter for a Labs call. */
interface Geo { locationCode?: number; languageCode?: string }

/** Port of the DataForSEO client: exactly the methods COLLECT calls. */
export interface DfsPort {
  domainOverview(domain: string, geo?: Geo): Promise<any>;
  historicalOverview(domain: string, months?: number, geo?: Geo): Promise<any>;
  domainKeywords(domain: string, limit?: number, geo?: Geo): Promise<any>;
  domainPages(domain: string, limit?: number, geo?: Geo): Promise<any>;
  domainCompetitors(domain: string, limit?: number, geo?: Geo): Promise<any>;
  domainBacklinks(domain: string): Promise<any>;
  backlinksAnchors(domain: string, limit?: number): Promise<any>;
  backlinksHistory(domain: string, months?: number): Promise<any>;
  domainTechnologies(domain: string): Promise<any>;
  domainGapKeywords(domain: string, compare: string, limit?: number, geo?: Geo): Promise<any>;
}

/** Port of the keys.so client (RU branch). */
export interface KeyssoPort {
  domainOverview(domain: string): Promise<any>;
  domainKeywords(domain: string, limit?: number): Promise<any>;
  domainCompetitors(domain: string, top?: number): Promise<any>;
}

/**
 * Site-side collectors (don't depend on the SEO base). Best-effort: any method
 * can return null (adapter unavailable) — collect isolates that just like Python.
 */
export interface SiteSidePort {
  similarweb(domain: string): Promise<any>;
  pagespeed(domain: string): Promise<any>;
  entity(domain: string): Promise<any>;
  crawl(domain: string): Promise<any>;
  ads(brand: string): Promise<any>;
  youtube(brand: string): Promise<any>;
  yandexSerp(brand: string): Promise<any>;
  news(brand: string, domain: string): Promise<any>;
}

export interface CollectDeps {
  dfs: DfsPort;
  keysso: KeyssoPort;
  site: SiteSidePort;
}

export interface CollectOpts {
  compare?: string | null;
  geo?: string;
  progress?: ProgressFn;
}

/** One COLLECT step: a log label + failure-isolation (null on any error). */
export async function safe<T>(label: string, fn: () => Promise<T>, progress?: ProgressFn): Promise<T | null> {
  if (progress) progress(label);
  try {
    return await fn();
  } catch {
    return null;
  }
}

/**
 * domain_overview for every geoSplit market in parallel → {code: overview}
 * (site_analytic.py:216-228). Order is stable (follows the market list).
 */
export async function collectOverviews(domain: string, dfs: DfsPort): Promise<Record<string, any>> {
  const markets = geoSplit();
  const results = await Promise.all(
    markets.map(async ([code, loc, lang]) => {
      try {
        const o = await dfs.domainOverview(domain, { locationCode: loc, languageCode: lang });
        return [code, o] as const;
      } catch {
        return [code, null] as const;
      }
    }),
  );
  const out: Record<string, any> = {};
  for (const [code, o] of results) if (o) out[code] = o; // market order preserved
  return out;
}

/** Blocks that don't depend on the SEO base (site_analytic.py:179-213). */
async function collectSiteSide(domain: string, raw: Raw, deps: CollectDeps, progress?: ProgressFn): Promise<void> {
  const { site } = deps;
  raw.similarweb = await safe('Similarweb panel', () => site.similarweb(domain), progress);
  raw.pagespeed = await safe('site speed', () => site.pagespeed(domain), progress);
  raw.entity = await safe('brand in the knowledge graph', () => site.entity(domain), progress);
  raw.crawl = await safe('site audit', () => site.crawl(domain), progress);
  const brand = domain.split('.')[0];
  raw.ads = await safe('ads', () => site.ads(brand), progress);
  raw.youtube = await safe('media: video', () => site.youtube(brand), progress);
  raw.yandex_serp = await safe('media: press listing', () => site.yandexSerp(brand), progress);
  raw.news = await safe('media: news', () => site.news(brand, domain), progress);
}

/** RU branch (keys.so) — shared by TLD-based RU domains and the data-driven fallback. */
async function collectKeysso(domain: string, raw: Raw, deps: CollectDeps, progress?: ProgressFn): Promise<void> {
  const { dfs, keysso } = deps;
  raw.keywords = await safe('keywords', () => keysso.domainKeywords(domain, KEYWORDS_LIMIT), progress);
  raw.competitors = await safe('competitors', () => keysso.domainCompetitors(domain, COMPETITORS_LIMIT), progress);
  // Backlinks/technologies don't depend on the search base — work for .ru too.
  raw.backlinks = await safe('backlink profile', () => dfs.domainBacklinks(domain), progress);
  raw.anchors = await safe('anchors', () => dfs.backlinksAnchors(domain), progress);
  raw.backlinks_history = await safe('referring domain history', () => dfs.backlinksHistory(domain), progress);
  raw.technologies = await safe('technologies', () => dfs.domainTechnologies(domain), progress);
}

/**
 * Gather all raw blocks for one domain. Every block is None-tolerant.
 * Port of collect() (site_analytic.py:92-176).
 */
export async function collect(domain: string, deps: CollectDeps, opts: CollectOpts = {}): Promise<Raw> {
  const { dfs, keysso } = deps;
  const compare = opts.compare || null;
  const geo = opts.geo || 'us';
  const progress = opts.progress;
  const raw: Raw = { domain, compare, geo };

  // Branch 1: RU domain by TLD → keys.so.
  if (isRuDomain(domain)) {
    raw.seo_source = 'keysso';
    raw.overview = await safe('domain overview', () => keysso.domainOverview(domain), progress);
    await collectKeysso(domain, raw, deps, progress);
    await collectSiteSide(domain, raw, deps, progress);
    return raw;
  }

  // Branch 2: world estimate via DataForSEO Labs.
  raw.seo_source = 'dataforseo';
  const overviews = (await safe('domain overview', () => collectOverviews(domain, dfs), progress)) || {};
  raw.overviews = overviews;
  raw.overview = mergeOverviews(overviews);
  raw.geo_split = geoSplitRows(overviews);
  const [loc, lang] = bestLocale(overviews, geo);

  // Branch 3: data-driven RU fallback (not by TLD). Fetch the keys.so overview
  // once via safe and pass it into keyssoWins (Python calls it twice, here it's deduped).
  if (shouldTryKeysso(raw.overview)) {
    const ru = await safe('RU fallback', () => keysso.domainOverview(domain), progress);
    if (keyssoWins(raw.overview, ru)) {
      raw.seo_source = 'keysso';
      raw.overview = ru;
      raw.geo_split = null; // Labs' country shares don't mean anything here
      await collectKeysso(domain, raw, deps, progress);
      await collectSiteSide(domain, raw, deps, progress);
      return raw;
    }
  }

  const g: Geo = { locationCode: loc, languageCode: lang };
  raw.historical = await safe('traffic history', () => dfs.historicalOverview(domain, 12, g), progress);
  raw.keywords = await safe('keywords', () => dfs.domainKeywords(domain, KEYWORDS_LIMIT, g), progress);
  raw.pages = await safe('pages', () => dfs.domainPages(domain, PAGES_LIMIT, g), progress);
  raw.backlinks = await safe('backlink profile', () => dfs.domainBacklinks(domain), progress);
  raw.anchors = await safe('anchors', () => dfs.backlinksAnchors(domain), progress);
  raw.backlinks_history = await safe('referring domain history', () => dfs.backlinksHistory(domain), progress);
  raw.competitors = await safe('competitors', () => dfs.domainCompetitors(domain, COMPETITORS_LIMIT, g), progress);
  if (compare) {
    raw.gap = await safe('gap analysis', () => dfs.domainGapKeywords(domain, compare, GAP_LIMIT, g), progress);
  }
  raw.technologies = await safe('technologies', () => dfs.domainTechnologies(domain), progress);
  await collectSiteSide(domain, raw, deps, progress);
  return raw;
}
