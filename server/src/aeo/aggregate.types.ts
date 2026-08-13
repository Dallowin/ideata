/**
 * Input and output types for `aggregateMonitoring` — a port of the
 * core/aeo.py::aggregate_monitoring contract (lines 2559-2883).
 *
 * Input — rows of the aeo_answers table for a monitoring window: the
 * aggregator does NOT parse the response text, it reads fields the row
 * already has computed (`brands_found`, `citations`, `sentiment`, `judge`).
 * Output — the monitoring-tabs contract, read as-is by web; key names must
 * not change.
 *
 * "Raw" fields are typed broadly (`unknown`) because Python reads them
 * defensively (`.get`, `isinstance`, try/except) and silently skips junk —
 * the same tolerance is reproduced in aggregate.ts. The public signature is
 * still `any`-free: concrete row and aggregate shapes are exposed outward.
 */

/** A `brands_found` element: `{brand, pos}` (position order in the response). */
export interface BrandFound {
  brand?: string;
  pos?: number;
  [key: string]: unknown;
}

/** A row citation: a canonical object or a legacy string (a bare URL). */
export type CitationRaw =
  | string
  | { url?: unknown; title?: unknown; [key: string]: unknown };

/** The value of `sentiment[brand]`: `{score, themes}` (see `_sentiment` rows). */
export interface SentimentValue {
  score?: unknown;
  themes?: unknown;
  [key: string]: unknown;
}

/**
 * The minimal answer row read by answerCard/solutionHit/rowJudge: satisfied
 * by BOTH the window row (MonitoringRow) AND the snapshot row (SnapshotAnswer
 * from run.ts, which has no run_at). Lets aggregate_facts reuse the same
 * three helpers as aggregate_monitoring, without duplication
 * (aeo.py:773/2304/2321).
 */
export interface AnswerRow {
  platform: unknown;
  prompt?: string;
  text?: unknown;
  brands_found?: BrandFound[] | null;
  citations?: CitationRaw[] | null;
  judge?: unknown;
  /** only present on a monitoring (DB) row; absent on a snapshot → no answeredAt */
  run_at?: string;
  [key: string]: unknown;
}

/** One window row (aeo_answers). `run_at` is already a DB string: `str(run_at)[:10]`. */
export interface MonitoringRow extends AnswerRow {
  run_at: string;
  platform: string;
  prompt: string;
  text?: unknown;
  brands_found?: BrandFound[] | null;
  citations?: CitationRaw[] | null;
  sentiment?: Record<string, unknown> | null;
  judge?: unknown;
  [key: string]: unknown;
}

/** Options: the set of engine-columns for the matrix (default DEFAULT_PLATFORMS). */
export interface MonitoringOptions {
  platforms?: readonly string[];
}

// ── output shapes ───────────────────────────────────────────────────────────

/** A citation in an answer card: URL + title + host + category. */
export interface AnswerCitation {
  url: string;
  title: string;
  host: string;
  cat: string;
}

/** A card for one answer (prompt × engine) for UI expansion. */
export interface AnswerCard {
  platform: unknown;
  text: string;
  citations: AnswerCitation[];
  brandsFound: BrandFound[];
  self: boolean;
  /** only present if the row has a judge object */
  judge?: unknown;
  /** only present if the row has run_at */
  answeredAt?: string;
}

export interface LeaderRow {
  brand: string;
  self: boolean;
  vis: number;
  sov: number;
  pos: number | null;
  delta: number;
}

export interface VisTrendSeries {
  brand: string;
  self: boolean;
  data: number[];
}

export interface VisTrend {
  weekLabels: string[];
  granularity: 'day' | 'week';
  series: VisTrendSeries[];
}

export interface PlatMatrixRow {
  brand: string;
  self: boolean;
  vals: number[];
}

export interface PromptRow {
  prompt: string;
  execs: number;
  vis: number;
  pos: number | null;
  cshare: number;
  judgeScore: number | null;
  judgeSentiment: string | null;
  solution: boolean;
  solutionN: number;
  judgedN: number;
  mentioned: boolean;
  platforms: string[];
  answers: AnswerCard[];
  trend: number[];
  delta: number;
}

export interface CiteCat {
  label: string;
  pct: number;
}

export interface TopCiteDomain {
  d: string;
  n: number;
  own: boolean;
}

export interface WatchedPage {
  url: string;
  n: number;
  delta: number;
  title: string;
}

export interface RivalSent {
  brand: string;
  self: boolean;
  score: number;
}

export interface ChangeGainLost {
  prompt: string;
  platforms: string[];
}

export interface ChangeVisMove {
  prompt: string;
  from: number;
  to: number;
  fromEngines: number;
  toEngines: number;
  total: number;
}

export interface ChangePosMove {
  prompt: string;
  from: number;
  to: number;
}

export interface ChangeMetric {
  key: string;
  label: string;
  unit: string;
  from: number;
  to: number;
  delta: number;
  good: boolean;
}

export interface ChangeRival {
  brand: string;
  from: number;
  to: number;
  delta: number;
  passedUs: boolean;
  diverged: boolean;
}

export interface ChangeSource {
  host: string;
  n: number;
}

export interface ChangesBlock {
  prevRunAt: string | null;
  lastRunAt: string;
  gained: ChangeGainLost[];
  lost: ChangeGainLost[];
  visMoves: ChangeVisMove[];
  posMoves: ChangePosMove[];
  metrics: ChangeMetric[];
  rivals: ChangeRival[];
  newSources: ChangeSource[];
  goneSources: ChangeSource[];
}

export interface MonitoringKpi {
  visScore: number;
  visDelta: number;
  sov: number;
  avgPos: number | null;
  citeShare: number;
  solutionRate: number;
  solutionDelta: number;
  solutionJudged: number;
  solutionMinRec: number;
}

/** The full window aggregate — 16 keys of the monitoring contract. */
export interface MonitoringAgg {
  changes: ChangesBlock;
  kpi: MonitoringKpi;
  solutionTrend: number[];
  runs: number;
  promptsCount: number;
  platforms: string[];
  leaderboard: LeaderRow[];
  visTrend: VisTrend;
  citeShareTrend: number[];
  platMatrix: PlatMatrixRow[];
  promptRows: PromptRow[];
  citeCats: CiteCat[];
  topCiteDomains: TopCiteDomain[];
  watchedPages: WatchedPage[];
  rivalSent: RivalSent[];
  sentThemes: unknown[];
}

/** An empty window (`if not rows: return {}`). */
export type EmptyAgg = Record<string, never>;
