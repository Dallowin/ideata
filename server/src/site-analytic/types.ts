/**
 * site_analytic contracts: `Raw` is the raw COLLECT output
 * (site_analytic.py:collect), `Facts` is the normalized layer the UI consumes
 * (useAaMock). Raw blocks are read by the normalizer through a Python-style
 * `.get()` (loose), so the block field types are deliberately wide — the source
 * (DataForSEO/keys.so/site-side) returns different shapes and the parsing is
 * None-tolerant.
 */

/** Raw data for a single domain: every COLLECT block (each one None-tolerant). */
export interface Raw {
  domain?: string | null;
  compare?: string | null;
  geo?: string | null;
  seo_source?: 'dataforseo' | 'keysso' | string | null;

  overview?: Record<string, any> | null;
  overviews?: Record<string, any> | null; // {code: overview} per market (worldwide estimate)
  geo_split?: Array<{ code: string; etv: number }> | null;
  historical?: any[] | null;
  keywords?: any[] | null;
  pages?: any[] | null;
  competitors?: any[] | null;
  backlinks?: Record<string, any> | null;
  anchors?: any[] | null;
  backlinks_history?: any[] | null;
  technologies?: Record<string, any> | null;
  gap?: any[] | null;

  // site-side blocks (independent of the SEO database)
  similarweb?: Record<string, any> | null;
  pagespeed?: Record<string, any> | null;
  entity?: Record<string, any> | null;
  crawl?: Record<string, any> | null;
  ads?: any[] | null;
  youtube?: Record<string, any> | null;
  yandex_serp?: Record<string, any> | null;
  news?: any[] | null;

  [k: string]: unknown;
}

export interface FactsMeta {
  domain: string | null;
  compare: string | null;
  geo: string | null;
  seoSource: string | null;
  collectedAt: string;
  cost_usd?: number;
}

/** The normalized layer (web/composables/useAaMock.ts). Anything missing = null. */
export interface Facts {
  visits: number | null;
  visitsSource: 'similarweb' | 'search';
  searchVisits: number | null;
  growthPct: number | null;
  authority: number | null;
  kwTotal: number | null;
  refDomains: number | null;
  backlinksTotal: number | null;
  spamScore: number | null;
  bouncePct: number | null;
  pagesPerVisit: number | null;
  avgSessionSec: number | null;

  monthLabels: string[] | null;
  trafficByChannel: any[] | null;
  totalSeries: number[] | null;
  sources: any[] | null;
  geo: any[] | null;

  keywords: any[] | null;
  intents: any[] | null;
  posDist: any[] | null;
  clusters: any[] | null;
  thinCluster: any | null;
  topPages: any[] | null;

  anchors: any[] | null;
  refDomainsTrend: number[] | null;
  dofollowPct: number | null;

  tech: Record<string, string[]> | null;
  perfScore: number | null;
  lcp: number | null;
  cls: number | null;
  inp: number | null;
  ads: any[] | null;
  crawl: Record<string, any> | null;
  entity: Record<string, any> | null;
  mediaMentions: any[] | null;

  competitors: any[] | null;
  gapRows: any[] | null;

  // AEO / plan — filled in by the LLM layer and the AEO snapshot
  aiBrands: any | null;
  sovSelf: any | null;
  visTrend: any | null;
  solutionRate: any | null;
  solutionJudged: any | null;
  aiPromptsRows: any | null;
  citations: any | null;
  citedPages: any | null;
  citeSources: any | null;
  sentiment: any | null;
  foundNotCited: any | null;
  plan: any | null;
  priorities: any | null;
  aeoGuide?: any | null;

  meta: FactsMeta;
  [k: string]: unknown;
}
