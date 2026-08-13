/**
 * Port of core/aeo.py::aggregate_monitoring (lines 2559-2883) and all of its
 * nested helpers (_found, _mentioned, _vis, _sov, _avg_pos, _cites,
 * _cite_share, _sol, _judged, leaderboard, _prow, cite_cats, sentiment,
 * _prompt_state, the changes block) plus the module dependencies it calls:
 * `cite_items`, `classify_citation`, `answer_card`, `solution_hit`,
 * `row_judge`, `_host`.
 *
 * aeo_answers rows for a window → monitoring-tab aggregates. The function
 * does NOT run regexes over text: it reads fields the row ALREADY has
 * computed (brands_found, citations, sentiment, judge). So this is pure
 * arithmetic + rounding + date/ISO-week bucketing + sorting — and all the
 * parity risk lives there:
 *
 *   • Python's round() is banker's rounding (half-to-even) — we use pyRound
 *     from ./text, never Math.round (aeo.py:2606, 2619, 2623, 2633, 2639,
 *     2701, 2740, 2760, 2789, 2336);
 *   • str(run_at)[:10] — date bucketing by string slice (aeo.py:2577);
 *     date.fromisoformat(d).isocalendar() — ISO week (aeo.py:2590), computed
 *     with CPython's manual algorithm rather than JS Date, to avoid a
 *     year/week-boundary shift;
 *   • sorted(dict.items(), key=-count) and list.sort() keep dict INSERTION
 *     order on TIES (Python 3.7+) — accumulators use Map (not a plain
 *     object), and the sort is stable (Array.prototype.sort has been stable
 *     since ES2019/Node 11);
 *   • emptiness is checked BEFORE division (Python would raise
 *     ZeroDivisionError, not return 0/NaN); competitor order is [domain] +
 *     competitors[:4].
 *
 * Parity is proven by aggregate.parity.spec.ts against a golden Python dump
 * over four real windows; there must be no mismatch on any path.
 */
import { pyRound, normPrompt } from './text';
import { heuristicIntent, PROMPT_INTENT_LABELS } from './panel';
import { PyFloat } from './pyjson';
import {
  isDict,
  pyStrip,
  pyStrOrEmpty,
  cmpStr,
  host,
  citeItems,
  classifyCitation,
  type CiteItem,
} from './parse';
import type {
  AnswerCard,
  AnswerCitation,
  AnswerRow,
  BrandFound,
  ChangeMetric,
  ChangeRival,
  ChangeSource,
  ChangeVisMove,
  ChangesBlock,
  CitationRaw,
  EmptyAgg,
  LeaderRow,
  MonitoringAgg,
  MonitoringOptions,
  MonitoringRow,
  PlatMatrixRow,
  PromptRow,
  VisTrend,
} from './aggregate.types';

/** aeo.py:142-143 — default engines (platform matrix columns). */
export const DEFAULT_PLATFORMS: readonly string[] = [
  'claude',
  'gemini',
  'perplexity',
  'aio',
  'gigachat',
  'alice',
  'yandex',
  'chatgpt',
  'deepseek',
  'grok',
];

/** aeo.py:2301 — minimum judge recommendation to count as "presented as a solution". */
export const SOLUTION_MIN_REC = 60;

/** aeo.py:2189 — sentiment rank: worse = higher (negative>neutral>positive). */
const SENT_RANK: Readonly<Record<string, number>> = {
  negative: 3,
  neutral: 2,
  positive: 1,
};


// ── Python semantics helpers ─────────────────────────────────────────────────

/**
 * Python truthiness of a value: None/False/0/""/empty list/empty dict are
 * false. Needed for `if v.get("themes")` and the `... or []` around
 * sentiment themes.
 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '' || v === 0) {
    return false;
  }
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return true;
}

/**
 * `float(x)` with the same handling as the try/except (KeyError, TypeError,
 * ValueError) in aeo.py:2730-2732: a non-number/unparsable string →
 * undefined (Python's `continue`). Within a window, score is always an int,
 * but we keep the conversion honest: bool→0/1, number→itself,
 * string→parsed with strip.
 */
function pyFloatOrSkip(v: unknown): number | undefined {
  if (v instanceof PyFloat) return v.value; // Python's float(0.5) from pyParse
  if (typeof v === 'number') return v; // float(nan)/float(inf) are valid in Python
  if (typeof v === 'boolean') return v ? 1 : 0; // float(True) == 1.0
  if (typeof v === 'string') {
    const t = pyStrip(v).toLowerCase();
    if (t === '') return undefined;
    if (t === 'inf' || t === '+inf' || t === 'infinity' || t === '+infinity') {
      return Infinity;
    }
    if (t === '-inf' || t === '-infinity') return -Infinity;
    if (t === 'nan' || t === '+nan' || t === '-nan') return NaN;
    // Python's float() accepts underscore separators and a leading sign; for
    // our path (int score) that's unreachable, but we take Number after the
    // basic check, and undefined otherwise (ValueError).
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return undefined;
    return Number(t);
  }
  return undefined; // None, dict, list → TypeError/KeyError → skip
}

/**
 * `isinstance(x, int)` from aeo.py:2318 and 2330. Python's `bool` is a
 * subclass of `int` (`isinstance(True, int)` is true), while `float` is not
 * — including an integer-valued `70.0`: from pyParse it arrives as a
 * `PyFloat` (object) and doesn't pass here. In production, judge comes from
 * Prisma as a plain `number` (the driver has already erased int/float), so a
 * plain number is treated as an int here — there's no other option, the
 * fractional-ness information is already gone at the JS boundary.
 */
function isPyInt(v: unknown): boolean {
  return typeof v === 'boolean' || typeof v === 'number';
}

// ── ISO week via CPython's manual algorithm (Lib/datetime.py) ────────────────

const DAYS_IN_MONTH = [-1, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysBeforeYear(year: number): number {
  const y = year - 1;
  return y * 365 + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeap(year)) return 29;
  return DAYS_IN_MONTH[month];
}

function daysBeforeMonth(year: number, month: number): number {
  let d = 0;
  for (let m = 1; m < month; m += 1) d += daysInMonth(year, m);
  return d;
}

/** `date.toordinal()` — proleptic Gregorian ordinal (0001-01-01→1). */
function ymd2ord(year: number, month: number, day: number): number {
  return daysBeforeYear(year) + daysBeforeMonth(year, month) + day;
}

/** CPython `_isoweek1monday`: ordinal of the Monday of ISO week 1 for a given year. */
function isoWeek1Monday(year: number): number {
  const THURSDAY = 3;
  const firstday = ymd2ord(year, 1, 1);
  const firstweekday = (firstday + 6) % 7; // date.weekday(): Mon=0
  let week1monday = firstday - firstweekday;
  if (firstweekday > THURSDAY) week1monday += 7;
  return week1monday;
}

/**
 * `f"{y}-W{w:02d}"` from `date.fromisoformat(d).isocalendar()`
 * (aeo.py:2590-2591). `d` is a "YYYY-MM-DD" string (the first 10 characters
 * of run_at). Returns the ISO year and ISO week exactly as CPython's
 * isocalendar does (the year can differ from the calendar year at the
 * boundary).
 */
function isoWeekLabel(d: string): string {
  const year = Number(d.slice(0, 4));
  const month = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));
  let isoYear = year;
  let week1monday = isoWeek1Monday(year);
  const today = ymd2ord(year, month, day);
  let week = Math.floor((today - week1monday) / 7);
  if (week < 0) {
    isoYear = year - 1;
    week1monday = isoWeek1Monday(isoYear);
    week = Math.floor((today - week1monday) / 7);
  } else if (week >= 52) {
    if (today >= isoWeek1Monday(year + 1)) {
      isoYear = year + 1;
      week = 0;
    }
  }
  const w = week + 1;
  return `${isoYear}-W${String(w).padStart(2, '0')}`;
}

// ── cite_items / classify_citation / answer_card / solution_hit / row_judge ──

/** aeo.py:773-802 — an answer row → the card shown when expanded in the UI.
 *  Exported for reuse in aggregate_facts (a snapshot); accepts an AnswerRow
 *  (either a window row OR a snapshot row). */
export function answerCard(
  a: AnswerRow,
  domain: string,
  competitors: readonly string[],
): AnswerCard {
  const cites: AnswerCitation[] = [];
  const seen = new Set<string>();
  for (const c of citeItems(a.citations)) {
    const u = c.url;
    if (seen.has(u)) continue;
    seen.add(u);
    cites.push({
      url: u,
      title: c.title,
      host: host(u),
      cat: classifyCitation(u, domain, competitors),
    });
  }
  const bf = a.brands_found ?? [];
  const card: AnswerCard = {
    platform: a.platform,
    text: pyStrip(pyStrOrEmpty(a.text)),
    citations: cites,
    brandsFound: bf,
    self: bf.some((x) => x?.brand === domain),
  };
  if (isDict(a.judge)) card.judge = a.judge;
  if (pyTruthy(a.run_at)) card.answeredAt = a.run_at;
  return card;
}

/** aeo.py:2304-2318 — the brand is named AND the judge's recommendation >= threshold. */
export function solutionHit(a: AnswerRow, domain: string): boolean {
  const bf = a.brands_found ?? [];
  if (!bf.some((x) => x?.brand === domain)) return false;
  const j = a.judge;
  if (!isDict(j)) return false;
  const rec = j.recommendation;
  // aeo.py:2318 — isinstance(rec, int) and rec >= threshold. A float
  // (including 70.0 as PyFloat) doesn't pass; bool True gives 1 >= 60 →
  // false, same as Python.
  return isPyInt(rec) && Number(rec) >= SOLUTION_MIN_REC;
}

/** aeo.py:2321-2336 — (average judge score | null, worst sentiment | null). */
export function rowJudge(answers: AnswerRow[]): [number | null, string | null] {
  const scores: number[] = [];
  let worst: string | null = null;
  for (const a of answers) {
    const j = a.judge;
    if (!isDict(j)) continue;
    // aeo.py:2330 — isinstance(score, int): a float (88.0 → PyFloat) is
    // skipped, bool True counts as 1 (sum([True]) == 1). Number(true) == 1.
    if (isPyInt(j.score)) {
      scores.push(Number(j.score));
    }
    const s = j.sentiment;
    if (
      typeof s === 'string' &&
      s in SENT_RANK &&
      (worst === null || SENT_RANK[s] > SENT_RANK[worst])
    ) {
      worst = s;
    }
  }
  const score = scores.length
    ? pyRound(scores.reduce((x, y) => x + y, 0) / scores.length)
    : null;
  return [score, worst];
}

// ── public function ────────────────────────────────────────────────────────

/**
 * Port of aeo.py:2559-2883. `rows` — window rows (including `_sentiment`
 * rows), `domain`/`competitors` — the brand and its competitors,
 * `platforms` — the engine columns.
 */
export function aggregateMonitoring(
  rows: MonitoringRow[],
  domain: string,
  competitors: string[],
  { platforms = DEFAULT_PLATFORMS }: MonitoringOptions = {},
): MonitoringAgg | EmptyAgg {
  // aeo.py:2564-2567 — sentiment rows are kept separate, empty window → {}.
  const sentRows = rows.filter((r) => r.platform === '_sentiment');
  const mainRows = rows.filter((r) => r.platform !== '_sentiment');
  if (mainRows.length === 0) return {};

  // aeo.py:2568 — brand order: domain, then up to 4 non-empty competitors.
  const brands = [domain, ...competitors.filter((c) => c).slice(0, 4)];

  // aeo.py:2570-2574
  const found = (r: MonitoringRow): BrandFound[] => r.brands_found ?? [];
  const mentioned = (r: MonitoringRow, b: string): boolean =>
    found(r).some((x) => x?.brand === b);

  // aeo.py:2576-2579 — date bucket via a string slice of run_at, runs sorted.
  const dateOf = (r: MonitoringRow): string => String(r.run_at).slice(0, 10);
  const runs = [...new Set(mainRows.map(dateOf))].sort(cmpStr);
  const byRun = new Map<string, MonitoringRow[]>();
  for (const d of runs) byRun.set(d, []);
  for (const r of mainRows) byRun.get(dateOf(r))!.push(r);

  // aeo.py:2588-2593 — the ISO week of each run and the granularity choice.
  const weekOf = new Map<string, string>();
  for (const d of runs) weekOf.set(d, isoWeekLabel(d));
  const distinctWeeks = new Set(weekOf.values()).size || 1;
  const granularity: 'day' | 'week' =
    runs.length > distinctWeeks * 1.5 ? 'day' : 'week';

  // aeo.py:2595-2603 — buckets at the chosen granularity, in appearance order.
  const weeks: string[] = [];
  const byWeek = new Map<string, MonitoringRow[]>();
  for (const d of runs) {
    const key = granularity === 'day' ? d : weekOf.get(d)!;
    if (!byWeek.has(key)) {
      weeks.push(key);
      byWeek.set(key, []);
    }
    byWeek.get(key)!.push(...byRun.get(d)!);
  }

  // aeo.py:2605-2607
  const vis = (subset: MonitoringRow[], b: string): number => {
    if (subset.length === 0) return 0;
    let hit = 0;
    for (const r of subset) if (mentioned(r, b)) hit += 1;
    return pyRound((100 * hit) / subset.length);
  };

  // aeo.py:2609-2612
  const visTrend: VisTrend = {
    weekLabels: weeks,
    granularity,
    series: brands.map((b) => ({
      brand: b,
      self: b === domain,
      data: weeks.map((w) => vis(byWeek.get(w)!, b)),
    })),
  };

  // aeo.py:2614
  const last = byRun.get(runs[runs.length - 1])!;
  const prev = runs.length > 1 ? byRun.get(runs[runs.length - 2])! : null;

  // aeo.py:2616-2619
  const sov = (subset: MonitoringRow[], b: string): number => {
    let total = 0;
    let mine = 0;
    for (const r of subset) {
      total += found(r).length;
      if (mentioned(r, b)) mine += 1;
    }
    return total ? pyRound((100 * mine) / total) : 0;
  };

  // aeo.py:2621-2623
  const avgPos = (subset: MonitoringRow[], b: string): number | null => {
    const ps: number[] = [];
    for (const r of subset) {
      for (const x of found(r)) if (x?.brand === b) ps.push(x.pos as number);
    }
    return ps.length ? pyRound(ps.reduce((a, c) => a + c, 0) / ps.length, 1) : null;
  };

  // aeo.py:2625-2628
  const cites = (subset: MonitoringRow[]): CiteItem[] => {
    const out: CiteItem[] = [];
    for (const r of subset) for (const c of citeItems(r.citations)) out.push(c);
    return out;
  };

  // aeo.py:2630-2633
  const citeShare = (subset: MonitoringRow[], b: string): number => {
    const cs = cites(subset);
    if (cs.length === 0) return 0;
    let own = 0;
    for (const c of cs) if (classifyCitation(c.url, b, []) === 'Свой сайт') own += 1;
    return pyRound((100 * own) / cs.length);
  };

  // aeo.py:2635-2639
  const sol = (subset: MonitoringRow[], b: string): number => {
    if (subset.length === 0) return 0;
    let hit = 0;
    for (const r of subset) if (solutionHit(r, b)) hit += 1;
    return pyRound((100 * hit) / subset.length);
  };

  // aeo.py:2641-2642
  const judged = (subset: MonitoringRow[]): number => {
    let n = 0;
    for (const r of subset) if (isDict(r.judge)) n += 1;
    return n;
  };

  // aeo.py:2644-2649 — a stable sort by -vis keeps brand order on ties.
  const leaderboard: LeaderRow[] = brands
    .map((b) => ({
      brand: b,
      self: b === domain,
      vis: vis(last, b),
      sov: sov(last, b),
      pos: avgPos(last, b),
      delta: prev ? vis(last, b) - vis(prev, b) : 0,
    }))
    .sort((a, b) => b.vis - a.vis);

  // aeo.py:2651-2653
  const platMatrix: PlatMatrixRow[] = brands.map((b) => ({
    brand: b,
    self: b === domain,
    vals: platforms.map((p) => vis(mainRows.filter((r) => r.platform === p), b)),
  }));

  // aeo.py:2655 — unique prompts in first-appearance order.
  const prompts: string[] = [];
  const seenPrompt = new Set<string>();
  for (const r of mainRows) {
    if (!seenPrompt.has(r.prompt)) {
      seenPrompt.add(r.prompt);
      prompts.push(r.prompt);
    }
  }

  // aeo.py:2657-2689
  const prow = (pr: string): PromptRow => {
    const lastRows = last.filter((r) => r.prompt === pr);
    const [jscore, jsent] = rowJudge(lastRows);
    const trend = weeks.map((w) =>
      vis(byWeek.get(w)!.filter((r) => r.prompt === pr), domain),
    );
    const ofPr = mainRows.filter((r) => r.prompt === pr);
    let solutionN = 0;
    for (const r of lastRows) if (solutionHit(r, domain)) solutionN += 1;
    return {
      prompt: pr,
      execs: ofPr.length,
      vis: vis(ofPr, domain),
      pos: avgPos(ofPr, domain),
      cshare: citeShare(ofPr, domain),
      judgeScore: jscore,
      judgeSentiment: jsent,
      solution: lastRows.some((r) => solutionHit(r, domain)),
      solutionN,
      judgedN: judged(lastRows),
      mentioned: lastRows.some((r) => mentioned(r, domain)),
      platforms: lastRows
        .filter((r) => mentioned(r, domain))
        .map((r) => r.platform),
      answers: lastRows.map((r) => answerCard(r, domain, competitors)),
      trend,
      delta: trend.length > 1 ? trend[trend.length - 1] - trend[trend.length - 2] : 0,
    };
  };
  // aeo.py:2690 — a stable sort by -vis.
  const promptRows: PromptRow[] = prompts.map(prow).sort((a, b) => b.vis - a.vis);

  // aeo.py:2692-2706 — categories and hosts of all citations in the window (Map keeps order).
  const allCites = cites(mainRows);
  const catCounts = new Map<string, number>();
  const hostCounts = new Map<string, number>();
  for (const c of allCites) {
    const cat = classifyCitation(c.url, domain, competitors);
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
    const h = host(c.url);
    if (h) hostCounts.set(h, (hostCounts.get(h) ?? 0) + 1);
  }
  const citeCats = allCites.length
    ? [...catCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => ({ label: c, pct: pyRound((100 * n) / allCites.length) }))
    : [];
  const topCiteDomains = [...hostCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([h, n]) => ({ d: h, n, own: h === domain.toLowerCase() }));

  // aeo.py:2707-2718 — own pages and their frequency (title is empty for legacy).
  const ownPages = new Map<string, number>();
  const ownTitles = new Map<string, string>();
  for (const c of allCites) {
    if (classifyCitation(c.url, domain, []) === 'Свой сайт') {
      ownPages.set(c.url, (ownPages.get(c.url) ?? 0) + 1);
      if (c.title && !ownTitles.get(c.url)) ownTitles.set(c.url, c.title);
    }
  }
  const watchedPages = [...ownPages.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([u, n]) => ({ url: u, n, delta: 0, title: ownTitles.get(u) ?? '' }));

  // aeo.py:2726-2742 — sentiment: averaged over all judged rows in the window.
  const sentAcc = new Map<
    string,
    { sum: number; n: number; themes: unknown }
  >();
  for (const r of sentRows) {
    const sd = isDict(r.sentiment) ? r.sentiment : {};
    for (const [b, v] of Object.entries(sd)) {
      if (!isDict(v)) continue; // v["score"] on a non-dict → TypeError → skip
      const score = pyFloatOrSkip(v.score);
      if (score === undefined) continue;
      let acc = sentAcc.get(b);
      if (!acc) {
        acc = { sum: 0, n: 0, themes: [] };
        sentAcc.set(b, acc);
      }
      acc.sum += score;
      acc.n += 1;
      if (pyTruthy((v as Record<string, unknown>).themes)) {
        acc.themes = (v as Record<string, unknown>).themes;
      }
    }
  }
  const rivalSent = brands
    .filter((b) => {
      const acc = sentAcc.get(b);
      return acc !== undefined && acc.n !== 0;
    })
    .map((b) => {
      const acc = sentAcc.get(b)!;
      return { brand: b, self: b === domain, score: pyRound(acc.sum / acc.n) };
    });
  const domAcc = sentAcc.get(domain);
  const domThemes = domAcc ? domAcc.themes : undefined;
  const sentThemes = (pyTruthy(domThemes) ? domThemes : []) as unknown[];

  // aeo.py:2748-2761 — a prompt's state within a run (for the changes block).
  const promptState = (
    subset: MonitoringRow[],
    pr: string,
  ): {
    mentioned: boolean;
    pos: number | null;
    platforms: string[];
    engines: number;
    total: number;
    vis: number;
  } => {
    const rs = subset.filter((r) => r.prompt === pr);
    const hits = rs.filter((r) => mentioned(r, domain));
    return {
      mentioned: hits.length > 0,
      pos: avgPos(rs, domain),
      platforms: [...new Set(hits.map((r) => r.platform))].sort(cmpStr),
      engines: hits.length,
      total: rs.length,
      vis: rs.length ? pyRound((100 * hits.length) / rs.length) : 0,
    };
  };

  // aeo.py:2763-2857 — what changed since the previous run.
  const changes: ChangesBlock = {
    prevRunAt: runs.length > 1 ? runs[runs.length - 2] : null,
    lastRunAt: runs[runs.length - 1],
    gained: [],
    lost: [],
    visMoves: [],
    posMoves: [],
    metrics: [],
    rivals: [],
    newSources: [],
    goneSources: [],
  };

  if (prev) {
    // aeo.py:2770-2792 — the full KPI set, each with its own significance threshold.
    interface Kpis {
      vis: number;
      sov: number;
      pos: number | null;
      citeShare: number;
    }
    const kpis = (subset: MonitoringRow[]): Kpis => ({
      vis: vis(subset, domain),
      sov: sov(subset, domain),
      pos: avgPos(subset, domain),
      citeShare: citeShare(subset, domain),
    });
    const METRIC_DEFS: readonly [keyof Kpis, string, string, number, boolean][] = [
      ['vis', 'Видимость', 'pp', 3, true],
      ['sov', 'Доля голоса', 'pp', 3, true],
      ['citeShare', 'Доля цитат', 'pp', 3, true],
      ['pos', 'Средняя позиция', 'pos', 0.3, false],
    ];
    const nowK = kpis(last);
    const wasK = kpis(prev);
    for (const [key, label, unit, thr, upGood] of METRIC_DEFS) {
      const a = wasK[key];
      const b = nowK[key];
      if (a === null || b === null || Math.abs(b - a) < thr) continue;
      const metric: ChangeMetric = {
        key,
        label,
        unit,
        from: a,
        to: b,
        delta: pyRound(b - a, 2),
        good: upGood ? b > a : b < a,
      };
      changes.metrics.push(metric);
    }
    changes.metrics.sort((m1, m2) => Math.abs(m2.delta) - Math.abs(m1.delta));

    // aeo.py:2794-2810 — competitors: gains/drops and who passed us.
    const ourNow = nowK.vis;
    const ourWas = wasK.vis;
    for (const b of brands) {
      if (b === domain) continue;
      const rNow = vis(last, b);
      const rWas = vis(prev, b);
      const passedUs = rWas <= ourWas && rNow > ourNow;
      if (Math.abs(rNow - rWas) < 3 && !passedUs) continue;
      const rival: ChangeRival = {
        brand: b,
        from: rWas,
        to: rNow,
        delta: rNow - rWas,
        passedUs,
        diverged: rNow - rWas > 0 && 0 > ourNow - ourWas,
      };
      changes.rivals.push(rival);
    }
    changes.rivals.sort((r1, r2) => {
      const p = (r1.passedUs ? 0 : 1) - (r2.passedUs ? 0 : 1);
      if (p !== 0) return p;
      return r2.delta - r1.delta;
    });

    // aeo.py:2812-2836 — per prompt: gained/lost/visMoves/posMoves.
    for (const pr of prompts) {
      const now = promptState(last, pr);
      const was = promptState(prev, pr);
      if (now.mentioned && !was.mentioned) {
        changes.gained.push({ prompt: pr, platforms: now.platforms });
        continue;
      }
      if (was.mentioned && !now.mentioned) {
        changes.lost.push({ prompt: pr, platforms: was.platforms });
        continue;
      }
      if (!now.mentioned) continue;
      if (Math.abs(now.vis - was.vis) >= 15) {
        const move: ChangeVisMove = {
          prompt: pr,
          from: was.vis,
          to: now.vis,
          fromEngines: was.engines,
          toEngines: now.engines,
          total: now.total,
        };
        changes.visMoves.push(move);
      }
      if (
        now.pos !== null &&
        was.pos !== null &&
        Math.abs(now.pos - was.pos) >= 0.5
      ) {
        changes.posMoves.push({ prompt: pr, from: was.pos, to: now.pos });
      }
    }
    // aeo.py:2838, 2841 — the strongest drops/shifts first.
    changes.visMoves.sort((a, b) => a.to - a.from - (b.to - b.from));
    changes.posMoves.sort((a, b) => a.to - a.from - (b.to - b.from));

    // aeo.py:2843-2857 — new and disappeared source domains.
    const hostsOf = (subset: MonitoringRow[]): Map<string, number> => {
      const acc = new Map<string, number>();
      for (const c of cites(subset)) {
        const h = host(c.url);
        if (h) acc.set(h, (acc.get(h) ?? 0) + 1);
      }
      return acc;
    };
    const nowHosts = hostsOf(last);
    const wasHosts = hostsOf(prev);
    changes.newSources = [...nowHosts.entries()]
      .sort((a, b) => b[1] - a[1])
      .filter(([h]) => !wasHosts.has(h))
      .map(([h, n]): ChangeSource => ({ host: h, n }))
      .slice(0, 10);
    changes.goneSources = [...wasHosts.entries()]
      .sort((a, b) => b[1] - a[1])
      .filter(([h]) => !nowHosts.has(h))
      .map(([h, n]): ChangeSource => ({ host: h, n }))
      .slice(0, 10);
  }

  // aeo.py:2859-2883 — assembling the aggregate.
  const selfRow = leaderboard.find((r) => r.self)!;
  return {
    changes,
    kpi: {
      visScore: selfRow.vis,
      visDelta: selfRow.delta,
      sov: selfRow.sov,
      avgPos: selfRow.pos,
      citeShare: citeShare(last, domain),
      solutionRate: sol(last, domain),
      solutionDelta: prev ? sol(last, domain) - sol(prev, domain) : 0,
      solutionJudged: judged(last),
      solutionMinRec: SOLUTION_MIN_REC,
    },
    solutionTrend: weeks.map((w) => sol(byWeek.get(w)!, domain)),
    runs: runs.length,
    promptsCount: prompts.length,
    platforms: [...platforms],
    leaderboard,
    visTrend,
    citeShareTrend: weeks.map((w) => citeShare(byWeek.get(w)!, domain)),
    platMatrix,
    promptRows,
    citeCats,
    topCiteDomains,
    watchedPages,
    rivalSent,
    sentThemes,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// aggregate_facts (aeo.py:2386-2535) — a DIFFERENT shape than aggregateMonitoring:
// answers from ONE run (a snapshot at parse time) → the AEO facts block of the
// "AI search" tab. Reuses the same private helpers (answerCard/solutionHit/
// rowJudge) and the imported citeItems/classifyCitation/host — must not be
// duplicated.
// ────────────────────────────────────────────────────────────────────────────

/** `int(vol)` (aeo.py:2469): number → truncate toward zero; integer string → parse; else 0. */
function pyIntTrunc(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') {
    const t = v.trim();
    return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : 0;
  }
  return 0;
}

/** One snapshot row as input to aggregate_facts (the run_snapshot shape). */
export interface FactAnswer {
  platform: string;
  prompt: string;
  text?: unknown;
  brands_found?: BrandFound[] | null;
  citations?: CitationRaw[] | null;
  judge?: unknown;
  [k: string]: unknown;
}

/** Map {normalized prompt → {volume, intent, topic}} from the panel (row enrichment). */
export interface PromptMetaEntry {
  volume?: number | null;
  intent?: string | null;
  topic?: string | null;
}

export interface AggregateFactsOptions {
  platforms?: readonly string[];
  sentiment?: Record<string, { score: number; themes?: unknown }> | null;
  promptMeta?: Record<string, PromptMetaEntry> | null;
}

export interface FactPromptRow {
  solution: boolean;
  prompt: string;
  vol: number | null;
  intent: string;
  topic: string | null;
  mentioned: boolean;
  pos: number | null;
  platforms: string[];
  judgeScore: number | null;
  judgeSentiment: string | null;
  answers: AnswerCard[];
}

export interface AeoFactsBlock {
  aiPlatforms: string[];
  aiBrands: Array<{ brand: string; self: boolean; vals: number[] }>;
  sovSelf: number;
  solutionRate: number;
  solutionJudged: number;
  solutionMinRec: number;
  aiPromptsRows: FactPromptRow[];
  promptIntents: Array<{ intent: string; label: string; total: number; mentioned: number; vis: number }> | null;
  estImpressions: number | null;
  citations: Array<{ url: string; n: number; title: string }> | null;
  citedPages: Array<{ url: string; title: string; host: string; cat: string; n: number }> | null;
  citeSources: Array<{ label: string; pct: number }> | null;
  sentiment: Array<{ brand: string; self: boolean; score: number }> | null;
  sentThemes: Record<string, unknown> | null;
  foundNotCited: number;
  visTrend: null;
  /** the block is merged into facts (Record compatibility with the Partial<Facts> index). */
  [k: string]: unknown;
}

/**
 * Port of aggregate_facts (aeo.py:2386-2535). Answers from a single run →
 * the AEO facts block. Empty input → {} (Python's `if not answers: return
 * {}`). All rounds are banker's rounding (pyRound); accumulator-map order
 * is kept via Map (insertion), and sorts are stable (ties keep insertion
 * order, as in CPython 3.7+).
 */
export function aggregateFacts(
  answers: FactAnswer[],
  domain: string,
  competitors: string[],
  { platforms = DEFAULT_PLATFORMS, sentiment = null, promptMeta = null }: AggregateFactsOptions = {},
): AeoFactsBlock | Record<string, never> {
  if (!answers.length) return {};
  const metaMap = promptMeta || {};
  // up to 5 competitors: after validation these are real niche players (not top-3 SEO).
  const brands = [domain, ...competitors.filter((c) => c).slice(0, 5)];
  const mentioned = (a: FactAnswer, b: string): boolean =>
    (a.brands_found ?? []).some((x) => x?.brand === b);

  const byPl = new Map<string, FactAnswer[]>();
  for (const p of platforms) byPl.set(p, answers.filter((a) => a.platform === p));

  const aiBrands = brands.map((b, bi) => ({
    brand: b,
    self: bi === 0,
    vals: platforms.map((p) => {
      const rows = byPl.get(p) ?? [];
      const hits = rows.reduce((s, a) => s + (mentioned(a, b) ? 1 : 0), 0);
      return rows.length ? pyRound((100 * hits) / rows.length) : 0;
    }),
  }));

  const totalMentions = answers.reduce((s, a) => s + (a.brands_found ?? []).length, 0);
  const selfMentions = answers.reduce((s, a) => s + (mentioned(a, domain) ? 1 : 0), 0);
  const sovSelf = totalMentions ? pyRound((100 * selfMentions) / totalMentions) : 0;
  const solutionRate = answers.length
    ? pyRound((100 * answers.reduce((s, a) => s + (solutionHit(a as unknown as MonitoringRow, domain) ? 1 : 0), 0)) / answers.length)
    : 0;
  const solutionJudged = answers.reduce((s, a) => s + (isDict(a.judge) ? 1 : 0), 0);

  // unique prompts in first-appearance order (dict.fromkeys).
  const seenP = new Set<string>();
  const prompts: string[] = [];
  for (const a of answers) if (!seenP.has(a.prompt)) { seenP.add(a.prompt); prompts.push(a.prompt); }

  const promptRows: FactPromptRow[] = [];
  let foundNotCited = 0;
  const ownCites = new Map<string, number>();
  const ownTitles = new Map<string, string>();
  const citedPages = new Map<string, { url: string; title: string; host: string; cat: string; n: number }>();
  const catCounts = new Map<string, number>();
  let estImpressions = 0;
  const intentStats = new Map<string, [number, number]>(); // intent → [mentioned, total]

  for (const pr of prompts) {
    const rows = answers.filter((a) => a.prompt === pr);
    const mRows = rows.filter((a) => mentioned(a, domain));
    const positions: number[] = [];
    for (const a of mRows) for (const x of a.brands_found ?? []) if (x?.brand === domain && typeof x.pos === 'number') positions.push(x.pos);
    let cited = false;
    for (const a of rows) {
      for (const c of citeItems(a.citations)) {
        const u = c.url;
        const cat = classifyCitation(u, domain, competitors);
        catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
        if (cat === 'Свой сайт') {
          cited = true;
          ownCites.set(u, (ownCites.get(u) ?? 0) + 1);
          if (c.title && !ownTitles.get(u)) ownTitles.set(u, c.title);
        } else {
          let pg = citedPages.get(u);
          if (!pg) { pg = { url: u, title: '', host: host(u), cat, n: 0 }; citedPages.set(u, pg); }
          pg.n += 1;
          if (c.title && !pg.title) pg.title = c.title;
        }
      }
    }
    if (mRows.length && !cited) foundNotCited += 1;
    const meta = metaMap[normPrompt(pr)] || {};
    const vol = meta.volume ?? null;
    const intent = meta.intent || heuristicIntent(pr);
    const isMentioned = mRows.length > 0;
    if (isMentioned && vol) estImpressions += pyIntTrunc(vol);
    const st = intentStats.get(intent) ?? [0, 0];
    st[1] += 1;
    if (isMentioned) st[0] += 1;
    intentStats.set(intent, st);
    const [jscore, jsent] = rowJudge(rows as unknown as MonitoringRow[]);
    promptRows.push({
      solution: rows.some((a) => solutionHit(a as unknown as MonitoringRow, domain)),
      prompt: pr,
      vol,
      intent,
      topic: (meta.topic ?? null) as string | null,
      mentioned: isMentioned,
      pos: positions.length ? Math.min(...positions) : null,
      platforms: mRows.map((a) => a.platform),
      judgeScore: jscore,
      judgeSentiment: jsent,
      answers: rows.map((a) => answerCard(a as unknown as MonitoringRow, domain, competitors)),
    });
  }
  // sort key (not mentioned, pos or 99): mentioned first, then by position.
  promptRows.sort((a, b) =>
    (a.mentioned ? 0 : 1) - (b.mentioned ? 0 : 1) || ((a.pos || 99) - (b.pos || 99)));

  const promptIntents = [...intentStats.entries()]
    .sort((a, b) => b[1][1] - a[1][1]) // -total, stable
    .map(([k, v]) => ({
      intent: k,
      label: PROMPT_INTENT_LABELS[k] ?? k,
      total: v[1],
      mentioned: v[0],
      vis: v[1] ? pyRound((100 * v[0]) / v[1]) : 0,
    }));

  const totalCites = [...catCounts.values()].reduce((s, n) => s + n, 0);
  const citeSources = totalCites
    ? [...catCounts.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => ({ label: c, pct: pyRound((100 * n) / totalCites) }))
    : null;
  const citations = [...ownCites.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([u, n]) => ({ url: u, n, title: ownTitles.get(u) ?? '' }));
  const citedPagesRows = [...citedPages.values()].sort((a, b) => b.n - a.n || cmpStr(a.url, b.url)).slice(0, 15);

  let sentRows: Array<{ brand: string; self: boolean; score: number }> | null = null;
  if (sentiment) {
    const rows = brands.filter((b) => b in sentiment).map((b) => ({ brand: b, self: b === domain, score: sentiment[b].score }));
    sentRows = rows.length ? rows : null;
  }
  const sentThemes = sentiment
    ? Object.fromEntries(Object.entries(sentiment).map(([b, v]) => [b, (v as { themes?: unknown }).themes]))
    : null;

  return {
    aiPlatforms: [...platforms],
    aiBrands,
    sovSelf,
    solutionRate,
    solutionJudged,
    solutionMinRec: SOLUTION_MIN_REC,
    aiPromptsRows: promptRows,
    promptIntents: promptIntents.length ? promptIntents : null,
    estImpressions: estImpressions || null,
    citations: citations.length ? citations : null,
    citedPages: citedPagesRows.length ? citedPagesRows : null,
    citeSources,
    sentiment: sentRows,
    sentThemes,
    foundNotCited,
    visTrend: null,
  };
}

/**
 * A panel row for panel_only_block (fail-soft: the engines didn't respond).
 * No index signature — so the canonical PanelEntry (with status/suggested_at)
 * can be freely passed in (extra fields on a non-literal are allowed).
 */
export interface PanelLike {
  prompt?: unknown;
  volume?: number | null;
  intent?: string | null;
  topic?: string | null;
}

/**
 * Port of panel_only_block (aeo.py:2538-2555). The engines returned no
 * answers — instead of silently falling back to zeros, we return the
 * generated prompts plus a status/reason so the tab can explain what
 * happened. The shape matches aggregate_facts (with zeroed metrics).
 */
export function panelOnlyBlock(
  panel: PanelLike[] | null | undefined,
  platforms: readonly string[],
  opts: { note: string; status?: string },
): Record<string, unknown> {
  const rows = (panel || [])
    .filter((p) => pyStrOrEmpty(p.prompt))
    .map((p) => ({
      prompt: p.prompt,
      vol: p.volume ?? null,
      intent: p.intent ?? null,
      topic: p.topic ?? null,
      mentioned: false,
      pos: null,
      platforms: [] as string[],
      answers: [] as unknown[],
    }));
  return {
    aiPlatforms: [...platforms],
    aiBrands: [],
    sovSelf: 0,
    aiPromptsRows: rows,
    promptIntents: null,
    estImpressions: null,
    citations: null,
    citedPages: null,
    citeSources: null,
    sentiment: null,
    sentThemes: null,
    foundNotCited: 0,
    visTrend: null,
    aeoStatus: opts.status ?? 'engines_unavailable',
    aeoStatusNote: opts.note,
  };
}
