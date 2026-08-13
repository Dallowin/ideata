/**
 * Port of scrapper/core/aeo.py::generate_prompts (aeo.py:2027) — generation
 * of the ranked target-audience prompt panel + all its deterministic filters/rankers.
 *
 * Orchestration (port of generate_prompts verbatim, in order):
 *   1. candidate sources:
 *        • _prompts_from_keywords  — live questions for the site's RELEVANT keywords;
 *        • dataforseo.keyword_suggestions + _is_question — external long-tail
 *          question suggestions for the seed topic;
 *        • _competitor_prompts     — competitor INTERCEPT (COMPETITOR_SHARE quota);
 *        • _generate_llm_prompts   — persona top-up to n across product sections.
 *   2. filters in the STRICT Python order:
 *        _looks_human (looksHuman) → _drop_near_duplicates → _rank_panel(2n) →
 *        _drop_near_duplicates → _assign_sections/_spread_by_topic →
 *        _cap_competitor_mentions → _ensure_competitor_floor → clamp to n.
 *   3. deterministic template fallback if live prompts < 4.
 *
 * WHAT IS REUSED (NOT duplicated):
 *   • text.ts:  normPrompt (_norm_prompt), contentWords (_content_words),
 *               contentTokens (\w{3,}), looksHuman (_looks_human), cpLength,
 *               pyRound (banker's round for competitor quotas).
 *   • panel.ts: heuristicIntent (_heuristic_intent), normalizePanel,
 *               PROMPT_INTENTS.
 *   • parse.ts: isDict, pyStrip, pyStrOrEmpty (str(x or "")).
 *
 * TWO-LAYER ACCEPTANCE (see generate.parity.spec / generate.structural.spec):
 *   (a) DETERMINISTIC filters (rankPanel, dropNearDuplicates, keywordsAboutSite,
 *       siteVocabulary, capCompetitorMentions/ensureCompetitorFloor, assignSections,
 *       spreadByTopic, productBrief, competitorBrands, relevantKeywords, seedFor) —
 *       strict byte-for-byte parity against LIVE Python on fixed input.
 *   (b) LLM part — the output is non-deterministic (model text + set randomization
 *       in Python), so it is NOT checked with a golden "panel==panel" comparison.
 *       Acceptance is STRUCTURAL on mock generation: 0 near-duplicates, ≥90%
 *       looksHuman, competitor-name share within [floor,cap], n clamp, high
 *       Cyrillic share for an ru project.
 *
 * DI seam `deps`: in Python, the LLM branches are enabled by the presence of `az`
 * (Analyzer). Here it's `deps.ask` (flash-JSON, port of _ask_json via askFlashJson)
 * + the `deps.keywordSuggestions` key source. `deps.sources.*` is a test/override
 * seam: lets you feed in fixed candidate lists instead of the live LLM (a mock
 * "panel before filters"), like the mock-Analyzer in the Python tests. Unset →
 * live LLM port.
 */
import {
  normPrompt,
  contentWords,
  contentTokens,
  looksHuman,
  cpLength,
  pyRound,
  type PyText,
} from './text';
import {
  heuristicIntent,
  normalizePanel,
  PROMPT_INTENTS,
  type PanelEntry,
} from './panel';
import { isDict, pyStrip, pyStrOrEmpty } from './parse';

// ── types ────────────────────────────────────────────────────────────────────

/**
 * A panel row "in flight". Deterministic filters pass the OBJECT through
 * as-is (reference identity is preserved, as in Python), so arbitrary extra
 * keys survive the pipeline — the type is deliberately extensible. Only
 * `prompt` is required.
 */
export interface PromptRow {
  prompt: string;
  topic?: string | null;
  volume?: number | null;
  intent?: string | null;
  source?: string;
  status?: string;
  suggested_at?: string;
  [k: string]: unknown;
}

/** Homepage crawl context (for productBrief/siteVocabulary/siteSections). */
export interface GenerateContext {
  title?: unknown;
  description?: unknown;
  h1?: unknown;
  hero_text?: unknown;
  headings?: { h1?: unknown[]; h2?: unknown[]; h3?: unknown[] } | Record<string, unknown>;
  [k: string]: unknown;
}

/** One source keyword ({keyword, volume, ...}) — shape of the discover clients. */
export interface KeywordRow {
  keyword?: unknown;
  volume?: number | null;
  rank?: number | null;
  pos?: number | null;
  clicks?: number | null;
  etv?: number | null;
  [k: string]: unknown;
}

/** A long-tail suggestion row (dataforseo.keyword_suggestions). */
export interface KwSuggestionRow {
  keyword?: unknown;
  volume?: number | null;
  trend?: unknown;
}

/** Cheap flash-JSON (_ask_json via FLASH_MODELS) — port of the passed-in `az`. */
export type AskJson = (prompt: string) => Promise<Record<string, unknown> | null>;

/**
 * Test/override seam for candidate sources. When a function is set it REPLACES
 * the corresponding LLM branch (a mock of a fixed candidate list). Unset →
 * live LLM port when `deps.ask` is present (otherwise the branch is empty,
 * as with az=None).
 */
export interface GenerateSources {
  siteSections?: (a: {
    domain: string;
    about: string;
    context: GenerateContext | null | undefined;
    keywords: KeywordRow[];
    lang: string;
  }) => Promise<string[]>;
  fromKeywords?: (a: {
    keywords: KeywordRow[];
    about: string;
    domain: string;
    lang: string;
    target: number;
    excludeBrands: Set<string>;
  }) => Promise<PromptRow[]>;
  competitor?: (a: {
    keywords: KeywordRow[];
    about: string;
    domain: string;
    competitors: unknown[];
    compBrands: Set<string>;
    lang: string;
    target: number;
  }) => Promise<PromptRow[]>;
  generated?: (a: {
    domain: string;
    keywords: KeywordRow[];
    about: string;
    lang: string;
    target: number;
    sections: string[];
  }) => Promise<PromptRow[]>;
}

export interface GenerateDeps {
  /** flash LLM for JSON responses (askFlashJson). null/undefined = az None. */
  ask?: AskJson | null;
  /** dataforseo.keyword_suggestions(seed, limit) — external question suggestions. */
  keywordSuggestions?: (seed: string, limit: number) => Promise<KwSuggestionRow[] | null>;
  /** core/suggest.questions(topic, lang, limit) — live phrasings (best-effort). */
  liveQuestions?: (topic: string, lang: string, limit: number) => Promise<string[]>;
  /** core/demand.wordstat_top(topic, n) — topic demand for RU (best-effort). */
  wordstatTop?: (topic: string, n: number) => Promise<KeywordRow[]>;
  /** test/override seam for sources (see GenerateSources). */
  sources?: GenerateSources;
}

export interface GenerateOptions {
  n?: number;
  lang?: string;
  context?: GenerateContext | null;
  competitors?: unknown[];
  deps?: GenerateDeps;
}

// ── constants (aeo.py) ───────────────────────────────────────────────────────

/** aeo.py:1863 — share of the panel reserved for competitor intercept (cap). */
export const COMPETITOR_SHARE = 0.2;
/** aeo.py:1868 — lower bound of that same share (intercept must not be zero). */
export const COMPETITOR_FLOOR = 0.1;
/** aeo.py:1869 — cap on the comp quota share for ONE competitor. */
export const COMPETITOR_MAX_PER = 0.5;
/** aeo.py:982 — share of shared significant words at which a second question counts as a duplicate. */
export const SIMILARITY_MAX = 0.6;
/** aeo.py:985 — shorter than this — any similarity measure fires at random, so leave it alone. */
export const DUP_MIN_WORDS = 3;

/** aeo.py:1176-1178 — generic domain/name tokens: not a brand, must not be matched. */
const BRAND_STOP: ReadonlySet<string> = new Set([
  'gg', 'io', 'com', 'net', 'org', 'app', 'co', 'ai', 'ru', 'me',
  'dev', 'shop', 'store', 'online', 'site', 'team', 'pro',
  'the', 'and', 'for',
]);

/**
 * aeo.py:273-282 — intent buckets with descriptions (needed by the LLM generator instructions).
 * Used ONLY to build LLM prompt text (see intentsDescBlock) — never in a
 * deterministic/parity-tested path — so it is bilingual by project `lang`.
 * RU is byte-identical to the Python original; EN is a faithful translation.
 */
const PROMPT_INTENTS_DESC_RU: ReadonlyArray<[string, string]> = [
  ['best', '«лучший сервис/инструмент для задачи» (топ-подборка)'],
  ['alternatives', 'альтернативы/замена конкретному сервису'],
  ['comparison', 'сравнение двух решений (X vs Y)'],
  ['how_to_choose', 'как выбрать решение под свои требования'],
  ['reviews', 'отзывы, надёжность, «стоит ли пользоваться»'],
  ['pricing', 'цены, тарифы, «сколько стоит»'],
  ['use_case', 'как решить конкретную задачу ниши этим классом продукта'],
  ['definition', 'что это такое / базовое объяснение категории'],
];
const PROMPT_INTENTS_DESC_EN: ReadonlyArray<[string, string]> = [
  ['best', '"best service/tool for the job" (top pick)'],
  ['alternatives', 'alternatives to / a replacement for a specific service'],
  ['comparison', 'comparing two solutions (X vs Y)'],
  ['how_to_choose', 'how to choose a solution that fits your requirements'],
  ['reviews', 'reviews, reliability, "is it worth using"'],
  ['pricing', 'prices, plans, "how much does it cost"'],
  ['use_case', 'how to solve a specific niche task with this product category'],
  ['definition', 'what it is / a basic explanation of the category'],
];

/**
 * aeo.py:1415-1423 — personas for the generator. Same bilingual rule as
 * PROMPT_INTENTS_DESC above: LLM-prompt-only content, RU byte-identical, EN a
 * faithful translation.
 */
const PROMPT_PERSONAS_RU: readonly string[] = [
  'новичок, только присматривается',
  'опытный, ищет продвинутое',
  'экономный — считает каждый рубль',
  'скептик — боится обмана/развода',
  'сравнивает два конкретных варианта',
  'столкнулся с проблемой и ищет решение',
  'готов платить, хочет лучшее',
];
const PROMPT_PERSONAS_EN: readonly string[] = [
  'a beginner, just browsing',
  'experienced, looking for advanced options',
  'budget-conscious — counts every dollar',
  'a skeptic — afraid of getting scammed',
  'comparing two specific options',
  'ran into a problem and is looking for a fix',
  'ready to pay, wants the best',
];

/** aeo.py:348-357 — question/long-tail markers (RU+EN), WITHOUT years. */
const QUESTION_MARKERS_RU: readonly string[] = [
  'какой', 'какая', 'какие', 'лучший', 'лучшая', 'лучшие', 'лучш',
  'отзыв', 'стоит ли', 'как выбрать', 'что такое', 'сравнен', 'аналог',
  'альтернатив', 'цена', 'цены', 'тариф', 'топ', 'vs', 'или ', ' ли ',
];
const QUESTION_MARKERS_EN: readonly string[] = [
  'best', 'how', 'what', 'which', 'top', 'review', 'alternative',
  'worth', 'compare', 'vs ', 'pricing', 'cost', 'should',
];

// ── Python-isms (local) ──────────────────────────────────────────────────────

/** Python truthiness `if x`: None/False/0/-0/""/[]/{} — falsy. */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '') return false;
  if (typeof v === 'number') return v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return true;
}

/** Python's `s[:n]` — slices by CODE POINTS (not UTF-16 units). */
function cpSlice(s: string, n: number): string {
  if (n <= 0) return '';
  return Array.from(s).slice(0, n).join('');
}

/**
 * `_norm_prompt(text).split()` already yields words with no empty strings or
 * repeated spaces, so splitting on a single space here is equivalent to
 * Python's `.split()`. A separate helper so we don't have to pull the
 * private pySplit out of text.ts.
 */
function normWords(text: PyText): string[] {
  const s = normPrompt(text);
  return s ? s.split(' ') : [];
}

/** `int(v or 0)` semantics for volume in comparators: None/0 → 0, a number → itself. */
function volNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Do the sets intersect (Python `a & b` truthy)? */
function intersects(a: Set<string>, b: Set<string>): boolean {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) return true;
  return false;
}

// ══════════════════════════════════════════════════════════════════════════════
//  DETERMINISTIC FILTERS/RANKERS (strict parity with Python)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * `_rank_panel` (aeo.py:959-969) — dedup by normalized text (first one wins),
 * sort by volume descending (None → to the end), truncate to n. Objects pass
 * through unchanged (extra keys are preserved).
 */
export function rankPanel<T extends PromptRow>(panel: readonly T[], n: number): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const p of panel) {
    const k = normPrompt(p.prompt as PyText);
    // `not p["prompt"].strip() or k in seen` — skip empty text/duplicates.
    if (!pyStrip(pyStrOrEmpty(p.prompt)) || seen.has(k)) continue;
    seen.add(k);
    deduped.push(p);
  }
  // key = (volume is None, -(volume or 0)); stable sort (Timsort/ES).
  deduped.sort((a, b) => {
    const an = a.volume === null || a.volume === undefined ? 1 : 0;
    const bn = b.volume === null || b.volume === undefined ? 1 : 0;
    if (an !== bn) return an - bn;
    const av = -volNum(a.volume);
    const bv = -volNum(b.volume);
    return av < bv ? -1 : av > bv ? 1 : 0;
  });
  return deduped.slice(0, n);
}

/**
 * `_drop_near_duplicates` (aeo.py:1001-1048) — remove REPHRASINGS. An exact
 * match of the normalized text is always a duplicate; a fuzzy match only
 * when the intent MATCHES and the overlap of significant stems ≥ SIMILARITY_MAX
 * (relative to the shorter prompt, base ≥ DUP_MIN_WORDS). Missing intent →
 * _heuristic_intent.
 */
export function dropNearDuplicates<T extends PromptRow>(panel: readonly T[]): T[] {
  const kept: T[] = [];
  const seen: Array<[string, Set<string>]> = [];
  const exact = new Set<string>();
  for (const p of panel) {
    const text = p.prompt as PyText;
    const key = normPrompt(text);
    if (exact.has(key)) continue;
    exact.add(key);
    const words = contentWords(text);
    const intent = pyTruthy(p.intent) ? String(p.intent) : heuristicIntent(text);
    let dup = false;
    for (const [prevIntent, prev] of seen) {
      const base = Math.min(words.size, prev.size);
      if (base < DUP_MIN_WORDS || prevIntent !== intent) continue;
      let inter = 0;
      for (const w of words) if (prev.has(w)) inter += 1;
      if (inter / base >= SIMILARITY_MAX) {
        dup = true;
        break;
      }
    }
    if (dup) continue;
    kept.push(p);
    seen.push([intent, words]);
  }
  return kept;
}

/**
 * `_site_vocabulary` (aeo.py:1200-1222) — words the site uses to describe
 * ITSELF (title/description/h1/hero_text + h2/h3), coarsened to a 5-letter
 * stem + the brand name. Empty crawl → empty set (the brand name alone does
 * not count as a vocabulary).
 */
export function siteVocabulary(
  context: GenerateContext | null | undefined,
  domain: string,
): Set<string> {
  if (!isDict(context)) return new Set();
  const parts: string[] = [];
  for (const k of ['title', 'description', 'h1', 'hero_text']) {
    parts.push(pyStrOrEmpty((context as Record<string, unknown>)[k]));
  }
  const heads = isDict(context.headings) ? context.headings : {};
  for (const lvl of ['h2', 'h3']) {
    const arr = Array.isArray((heads as Record<string, unknown>)[lvl])
      ? ((heads as Record<string, unknown>)[lvl] as unknown[])
      : [];
    for (const x of arr) parts.push(pyStrOrEmpty(x));
  }
  const words = contentTokens(parts.join(' '));
  if (!words.length) return new Set();
  const vocab = new Set<string>();
  for (const w of words) vocab.add(cpSlice(w, 5));
  vocab.add(cpSlice(domain.split('.')[0].toLowerCase(), 5));
  return vocab;
}

/**
 * `_keywords_about_site` (aeo.py:1225-1253) — drop keywords from a FOREIGN
 * industry: a keyword is kept if at least one of its words (5-letter stem)
 * intersects the site's vocabulary. No vocabulary (crawl didn't reach) → no
 * filtering (returned as-is).
 */
export function keywordsAboutSite<T extends KeywordRow>(
  keywords: readonly T[] | null | undefined,
  context: GenerateContext | null | undefined,
  domain: string,
): T[] {
  const vocab = siteVocabulary(context, domain);
  const list = keywords ? [...keywords] : [];
  if (vocab.size === 0) return list;
  const out: T[] = [];
  for (const k of list) {
    const words = contentTokens(pyStrOrEmpty(k.keyword));
    if (words.some((w) => vocab.has(cpSlice(w, 5)))) out.push(k);
  }
  return out;
}

/**
 * `_product_brief` (aeo.py:1344-1353) — a short "what this product is" digest
 * from the homepage crawl (grounding for the generator). Not a dict / empty → "".
 */
export function productBrief(
  context: GenerateContext | null | undefined,
  domain: string,
): string {
  if (!isDict(context)) return '';
  const bits: string[] = [];
  for (const k of ['title', 'description', 'h1', 'hero_text']) {
    bits.push(pyStrip(pyStrOrEmpty((context as Record<string, unknown>)[k])));
  }
  const text = cpSlice(bits.filter((b) => b).join(' • '), 600);
  return text ? `О продукте ${domain} (текст с главной страницы): ${text}` : '';
}

/**
 * `_brand_tokens` (aeo.py:1181-1189) — significant tokens (≥3, not
 * BRAND_STOP) from a competitor's domain/name.
 */
export function brandTokens(name: unknown): Set<string> {
  const out = new Set<string>();
  for (const w of normWords(name as PyText)) {
    if (cpLength(w) >= 3 && !BRAND_STOP.has(w)) out.add(w);
  }
  return out;
}

/** `_competitor_brands` (aeo.py:1192-1197) — union of brand tokens across all competitors. */
export function competitorBrands(competitors: unknown[] | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const c of competitors || []) {
    for (const t of brandTokens(c)) out.add(t);
  }
  return out;
}

/** `_has_competitor` (aeo.py:1872-1874) — a competitor name as a SUBSTRING of the prompt text. */
export function hasCompetitor(p: PromptRow, compBrands: Set<string>): boolean {
  const low = pyStrOrEmpty(p.prompt).toLowerCase();
  for (const b of compBrands) if (low.includes(b)) return true;
  return false;
}

/** Upper bound on the number of comp prompts in a panel of n: max(1, round(n·SHARE)). */
export function competitorCap(n: number): number {
  return Math.max(1, pyRound(n * COMPETITOR_SHARE));
}

/** Lower bound: min(cap, max(1, round(n·FLOOR))). round is banker's rounding (pyRound). */
export function competitorFloor(n: number): number {
  return Math.min(competitorCap(n), Math.max(1, pyRound(n * COMPETITOR_FLOOR)));
}

/**
 * `_cap_competitor_mentions` (aeo.py:1905-1930) — cap the share of prompts
 * with competitor names across the WHOLE panel at competitorCap(n); the
 * excess is NOT discarded, just pushed to the tail.
 */
export function capCompetitorMentions<T extends PromptRow>(
  panel: readonly T[],
  compBrands: Set<string>,
  n: number,
): T[] {
  if (!compBrands.size || !panel.length) return panel as T[];
  const cap = competitorCap(n);
  const kept: T[] = [];
  const extra: T[] = [];
  let used = 0;
  for (const p of panel) {
    if (hasCompetitor(p, compBrands)) {
      if (used < cap) {
        used += 1;
        kept.push(p);
      } else {
        extra.push(p);
      }
    } else {
      kept.push(p);
    }
  }
  return kept.concat(extra);
}

/**
 * `_ensure_competitor_floor` (aeo.py:1877-1902) — raise competitor prompts
 * into the panel head up to competitorFloor(n) if there aren't enough there:
 * swap with the LAST non-competitor prompts in the head (the rest of the
 * order is preserved).
 */
export function ensureCompetitorFloor<T extends PromptRow>(
  ordered: readonly T[],
  compBrands: Set<string>,
  n: number,
): T[] {
  if (!compBrands.size || ordered.length <= n) return ordered as T[];
  const floor = competitorFloor(n);
  const head = ordered.slice(0, n);
  const tail = ordered.slice(n);
  let have = head.filter((p) => hasCompetitor(p, compBrands)).length;
  for (let i = 0; i < tail.length; i += 1) {
    if (have >= floor) break;
    if (!hasCompetitor(tail[i], compBrands)) continue;
    // idx = last non-competitor in the head (scan from the end), else None → stop.
    let idx = -1;
    for (let j = head.length - 1; j >= 0; j -= 1) {
      if (!hasCompetitor(head[j], compBrands)) {
        idx = j;
        break;
      }
    }
    if (idx === -1) break;
    const tmp = head[idx];
    head[idx] = tail[i];
    tail[i] = tmp;
    have += 1;
  }
  return head.concat(tail);
}

/**
 * Section/prompt stems for _assign_sections (aeo.py:1127/1131): {w[:4]} over
 * _norm_prompt words with length ≥3. WITHOUT a stop-word filter — so this is
 * NOT contentWords (which strips DUP_STOP).
 */
function sectionStems(text: PyText): Set<string> {
  const out = new Set<string>();
  for (const w of normWords(text)) {
    if (cpLength(w) >= 3) out.add(cpSlice(w, 4));
  }
  return out;
}

/**
 * `_assign_sections` (aeo.py:1117-1139) — set each prompt's topic from
 * sections by the best stem-match count. No sections → panel unchanged. 0
 * matches → the prompt stays without a topic (object left untouched).
 */
export function assignSections<T extends PromptRow>(
  panel: readonly T[],
  sections: readonly string[],
): T[] {
  if (!sections.length) return panel as T[];
  const stems = sections.map((s) => [s, sectionStems(s)] as const);
  const out: T[] = [];
  for (const p of panel) {
    const words = sectionStems(p.prompt as PyText);
    let best: string | null = null;
    let score = 0;
    for (const [name, st] of stems) {
      let hit = 0;
      for (const w of words) if (st.has(w)) hit += 1;
      if (hit > score) {
        best = name;
        score = hit;
      }
    }
    out.push(best ? ({ ...p, topic: best } as T) : p);
  }
  return out;
}

/**
 * `_spread_by_topic` (aeo.py:1142-1166) — round-robin selection by topic: the
 * head gets one prompt from each topic (topic order = first appearance), the
 * tail fills the rest. Nothing is discarded.
 */
export function spreadByTopic<T extends PromptRow>(panel: readonly T[], n: number): T[] {
  if (!panel.length) return panel as T[];
  const buckets = new Map<string, T[]>();
  for (const p of panel) {
    const k = normPrompt(pyStrOrEmpty(p.topic));
    const bucket = buckets.get(k);
    if (bucket) bucket.push(p);
    else buckets.set(k, [p]);
  }
  const head: T[] = [];
  const bucketList = [...buckets.values()];
  // Round-robin: keep going while we're under n and some bucket still has an item.
  while (head.length < n) {
    let moved = false;
    for (const rows of bucketList) {
      if (!rows.length) continue;
      head.push(rows.shift() as T);
      moved = true;
      if (head.length >= n) break;
    }
    if (!moved) break;
  }
  const rest: T[] = [];
  for (const rows of bucketList) for (const p of rows) rest.push(p);
  return head.concat(rest);
}

// ── keyword sources (deterministic helpers) ───────────────────────────────────

/** `_kw_signature` (aeo.py:1721-1728) — near-duplicate signature: word stems (ignoring plural/order). */
function kwSignature(kw: string): string {
  const toks: string[] = [];
  for (const w of normWords(kw)) {
    if (cpLength(w) >= 2) {
      toks.push(cpLength(w) >= 5 && w.endsWith('s') ? cpSlice(w, cpLength(w) - 1) : w);
    }
  }
  // frozenset: order/duplicates don't matter → canonical key.
  return Array.from(new Set(toks)).sort().join('|');
}

/** `_is_brand_word` (aeo.py:1731-1739) — word looks like a brand/nav term (plural accounted for). */
function isBrandWord(word: string, brand: string): boolean {
  if (!brand || cpLength(word) < 4) return false;
  const stem = cpLength(word) >= 5 && word.endsWith('s') ? cpSlice(word, cpLength(word) - 1) : word;
  return word === brand || word.startsWith(brand) || brand.startsWith(word) || brand.startsWith(stem);
}

/**
 * `_relevant_keywords` (aeo.py:1742-1787) — keywords the site ACTUALLY ranks
 * for (position ≤ maxRank), sorted by etv descending, excluding brand
 * navigation, competitor keywords, and near-duplicates. Weak site (pool <8)
 * — relax the position threshold to ≤40 → everything.
 */
export function relevantKeywords(
  keywords: readonly KeywordRow[] | null | undefined,
  domain = '',
  opts: { limit?: number; maxRank?: number; excludeBrands?: Set<string> } = {},
): Array<{ kw: string; volume: number | null }> {
  const { limit = 40, maxRank = 20, excludeBrands } = opts;
  const brand = domain ? domain.split('.')[0].toLowerCase() : '';
  const rankOf = (k: KeywordRow): number => {
    const r = pyTruthy(k.rank) ? k.rank : k.pos;
    return typeof r === 'number' && Number.isInteger(r) && r > 0 ? r : 999;
  };
  const etvOf = (k: KeywordRow): number =>
    volNum(pyTruthy(k.clicks) ? k.clicks : pyTruthy(k.etv) ? k.etv : 0);

  const rows = (keywords || []).filter((k) => pyTruthy(k.keyword));
  let pool = rows.filter((k) => rankOf(k) <= maxRank);
  if (pool.length < 8) {
    const relaxed = rows.filter((k) => rankOf(k) <= 40);
    pool = relaxed.length ? relaxed : rows;
  }
  pool = [...pool].sort((a, b) => {
    const ea = -etvOf(a);
    const eb = -etvOf(b);
    if (ea !== eb) return ea - eb;
    if (rankOf(a) !== rankOf(b)) return rankOf(a) - rankOf(b);
    return -volNum(a.volume) - -volNum(b.volume);
  });

  const out: Array<{ kw: string; volume: number | null }> = [];
  const sigs = new Set<string>();
  const txts = new Set<string>();
  for (const k of pool) {
    const kw = pyStrip(pyStrOrEmpty(k.keyword));
    const txt = normPrompt(kw);
    if (!txt || cpLength(kw) < 3 || txts.has(txt)) continue;
    const words = txt.split(' ');
    if (brand && words.some((w) => isBrandWord(w, brand))) continue;
    if (excludeBrands && excludeBrands.size && intersects(excludeBrands, new Set(words))) continue;
    const sig = kwSignature(kw);
    if (sigs.has(sig)) continue;
    sigs.add(sig);
    txts.add(txt);
    out.push({ kw, volume: (k.volume ?? null) as number | null });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * `_seed_for` (aeo.py:1295-1313) — seed for keyword_suggestions: top RELEVANT
 * keyword (position+etv, not a brand); else top by volume; else "" (we do NOT
 * take the brand — that used to pull homonyms into the panel).
 */
export function seedFor(domain: string, keywords: readonly KeywordRow[] | null | undefined): string {
  const rel = relevantKeywords(keywords, domain, { limit: 1 });
  if (rel.length) return rel[0].kw;
  const sorted = [...(keywords || [])].sort((a, b) => -volNum(a.volume) - -volNum(b.volume));
  for (const k of sorted) {
    const kw = pyStrip(pyStrOrEmpty(k.keyword));
    if (kw) return kw;
  }
  return '';
}

/**
 * `_is_question` (aeo.py:359-370) — long-tail/question form of a keyword: "?",
 * a marker from the list (years counted from the current one), or ≥4 words.
 */
export function isQuestion(kw: unknown): boolean {
  const s = pyStrip(pyStrOrEmpty(kw).toLowerCase());
  if (!s) return false;
  if (s.includes('?')) return true;
  const yr = new Date().getFullYear();
  const markers = [
    ...QUESTION_MARKERS_RU,
    String(yr),
    String(yr + 1),
    ...QUESTION_MARKERS_EN,
  ];
  if (markers.some((m) => s.includes(m))) return true;
  return s.split(/\s+/).filter(Boolean).length >= 4;
}

// ══════════════════════════════════════════════════════════════════════════════
//  LLM BRANCHES (structural acceptance on mock generation; in prod — deps.ask)
// ══════════════════════════════════════════════════════════════════════════════

/** Word count via a Python `.split()`-equivalent (for section-name length). */
function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/** re.sub(r"\s+", " ", str(x or "")).strip() — for cleaning up section names. */
function collapseWs(x: unknown): string {
  return pyStrOrEmpty(x).replace(/\s+/g, ' ').replace(/^ | $/g, '');
}

/**
 * Bilingual-by-project-language picker for LLM instruction text, mirroring
 * the file's existing `langWord` convention. RU branch must stay
 * byte-identical to what was there before; EN is a faithful translation —
 * this is safe ONLY for the LLM instruction strings (see file header: the
 * LLM prompt branch is structurally tested, not byte-for-byte).
 */
const L = (lang: string, ru: string, en: string): string => (lang === 'ru' ? ru : en);

const intentsDescBlock = (lang: string): string =>
  (lang === 'ru' ? PROMPT_INTENTS_DESC_RU : PROMPT_INTENTS_DESC_EN)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');

/** `_site_sections` (aeo.py:1051-1114) — the site's product sections (LLM, 1 retry). */
async function llmSiteSections(
  deps: GenerateDeps,
  a: { domain: string; about: string; context: GenerateContext | null | undefined; keywords: KeywordRow[]; lang: string },
  limit = 8,
): Promise<string[]> {
  if (!deps.ask) return [];
  const heads = isDict(a.context) && isDict(a.context.headings) ? a.context.headings : null;
  const parts: string[] = [];
  if (isDict(a.context)) {
    for (const k of ['title', 'description', 'h1', 'hero_text']) {
      const v = pyStrip(pyStrOrEmpty((a.context as Record<string, unknown>)[k]));
      if (v) parts.push(cpSlice(v, 200));
    }
  }
  for (const lvl of ['h1', 'h2', 'h3']) {
    const arr = heads && Array.isArray((heads as Record<string, unknown>)[lvl])
      ? ((heads as Record<string, unknown>)[lvl] as unknown[])
      : [];
    for (const x of arr) {
      const s = pyStrip(pyStrOrEmpty(x));
      if (s) parts.push(s);
    }
  }
  const topKw = (a.keywords || [])
    .slice(0, 30)
    .filter((k) => pyTruthy(k.keyword))
    .map((k) => pyStrOrEmpty(k.keyword));
  if (!parts.length && !topKw.length) return [];
  const instr =
    (a.about ? `${a.about}\n\n` : '') +
    (parts.length
      ? L(a.lang, 'Заголовки главной страницы:\n', 'Homepage headings:\n') +
        parts.slice(0, 30).map((p) => `- ${p}`).join('\n') +
        '\n\n'
      : '') +
    (topKw.length
      ? L(a.lang, 'Верх семантики:\n', 'Top keywords:\n') + topKw.join(', ') + '\n\n'
      : '') +
    L(
      a.lang,
      `Выдели до ${limit} ПРОДУКТОВЫХ разделов сайта ${a.domain} — направлений, по ` +
        'которым у людей разные вопросы. Не служебные страницы. Название на ' +
        'русском языке, 1–3 слова. Ответь СТРОГО JSON: {"sections":["..."]}',
      `Identify up to ${limit} PRODUCT sections of the ${a.domain} website — areas ` +
        'people ask different kinds of questions about. Skip utility/service pages. ' +
        'Name each in English, 1-3 words. Respond STRICTLY as JSON: {"sections":["..."]}',
    );
  let rows: unknown = null;
  for (let i = 0; i < 2; i += 1) {
    const data = await deps.ask(instr);
    const r = data?.sections;
    if (Array.isArray(r) && r.length) {
      rows = r;
      break;
    }
  }
  if (!Array.isArray(rows) || !rows.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of rows) {
    const s = collapseWs(x);
    const k = s.toLowerCase();
    if (!s || seen.has(k) || wordCount(s) > 4) continue;
    seen.add(k);
    out.push(s);
  }
  return out.slice(0, limit);
}

/** `_prompts_from_keywords` (aeo.py:1790-1852) — live questions for relevant keywords (source='real'). */
async function llmPromptsFromKeywords(
  deps: GenerateDeps,
  a: { keywords: KeywordRow[]; about: string; domain: string; lang: string; target: number; excludeBrands: Set<string> },
): Promise<PromptRow[]> {
  const seeds = relevantKeywords(a.keywords, a.domain, {
    limit: Math.max(a.target, 40),
    excludeBrands: a.excludeBrands,
  });
  if (!deps.ask || !seeds.length) return [];
  const yr = new Date().getFullYear();
  const out: PromptRow[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < seeds.length; i += 20) {
    if (out.length >= a.target) break;
    const chunk = seeds.slice(i, i + 20);
    const listing = chunk.map((s) => `${s.kw} — ${s.volume ?? '?'}`).join('\n');
    const volByKw = new Map(chunk.map((s) => [normPrompt(s.kw), s.volume]));
    const instr =
      (a.about ? `${a.about}\n\n` : '') +
      L(
        a.lang,
        'Ниже РЕАЛЬНЫЕ поисковые запросы людей в этой нише (запрос — частотность):\n',
        'Below are REAL search queries people use in this niche (query — volume):\n',
      ) +
      listing +
      '\n\n' +
      L(
        a.lang,
        `Сейчас ${yr} год. Для КАЖДОГО запроса сформулируй на русском языке живой ` +
          'вопрос по ЭТОЙ ЖЕ теме — от первого лица, разговорно. НЕ копируй ключ ' +
          'дословно. Верни СТРОГО JSON: {"prompts":[{"q":"...","kw":"исходный запрос","intent":"best"}]}',
        `It's currently ${yr}. For EACH query, phrase a live question in English on ` +
          'the SAME topic — first person, conversational. Do NOT copy the keyword ' +
          'verbatim. Respond STRICTLY as JSON: {"prompts":[{"q":"...","kw":"original query","intent":"best"}]}',
      );
    let data: Record<string, unknown> | null = null;
    try {
      data = await deps.ask(instr);
    } catch {
      data = null;
    }
    const rows = data?.prompts;
    if (!Array.isArray(rows)) continue;
    for (const x of rows) {
      if (!isDict(x)) continue;
      const t = pyStrip(pyStrOrEmpty(x.q ?? x.prompt));
      const key = normPrompt(t);
      if (!t || seen.has(key)) continue;
      seen.add(key);
      const src = normPrompt(pyStrOrEmpty(x.kw));
      let vol = volByKw.get(src);
      if (vol === undefined || vol === null) {
        const low = t.toLowerCase();
        vol = null;
        for (const s of chunk) {
          if (s.kw.toLowerCase() && low.includes(s.kw.toLowerCase())) {
            vol = s.volume;
            break;
          }
        }
      }
      out.push({
        prompt: t,
        topic: null,
        volume: (vol ?? null) as number | null,
        intent: typeof x.intent === 'string' && PROMPT_INTENTS.has(x.intent) ? x.intent : heuristicIntent(t),
        source: 'real',
      });
      if (out.length >= a.target) break;
    }
  }
  return out;
}

/** `_competitor_prompts` (aeo.py:1933-2023) — competitor intercept (per-competitor quota — COMPETITOR_MAX_PER). */
async function llmCompetitorPrompts(
  deps: GenerateDeps,
  a: {
    keywords: KeywordRow[];
    about: string;
    domain: string;
    competitors: unknown[];
    compBrands: Set<string>;
    lang: string;
    target: number;
  },
): Promise<PromptRow[]> {
  if (!deps.ask || a.target <= 0 || !a.compBrands.size || !(a.competitors && a.competitors.length)) {
    return [];
  }
  const own = a.domain ? a.domain.split('.')[0].toLowerCase() : '';
  const buckets = new Map<string, Array<{ kw: string; volume: number }>>();
  const compTok = a.competitors.map((c) => [String(c), brandTokens(c)] as const);
  for (const k of a.keywords || []) {
    const kw = pyStrip(pyStrOrEmpty(k.keyword));
    if (!kw) continue;
    const words = new Set(normWords(kw));
    for (const [cname, toks] of compTok) {
      if (toks.size && intersects(toks, words)) {
        const bucket = buckets.get(cname);
        const row = { kw, volume: volNum(k.volume) };
        if (bucket) bucket.push(row);
        else buckets.set(cname, [row]);
        break;
      }
    }
  }
  const grounded = buckets.size > 0;
  if (!buckets.size) {
    for (const c of a.competitors.slice(0, 4)) buckets.set(String(c), []);
  }
  const sumVol = (rows: Array<{ volume: number }>): number => rows.reduce((s, r) => s + volNum(r.volume), 0);
  const ranked = [...buckets.entries()].sort((x, y) => sumVol(y[1]) - sumVol(x[1]));
  const perCap = Math.max(2, Math.trunc(a.target * COMPETITOR_MAX_PER));
  const yr = new Date().getFullYear();
  const out: PromptRow[] = [];
  const seen = new Set<string>();
  for (const [cname, rows] of ranked) {
    if (out.length >= a.target) break;
    rows.sort((x, y) => volNum(y.volume) - volNum(x.volume));
    const take = Math.min(perCap, a.target - out.length);
    const sample = rows.slice(0, 12).map((r) => `${r.kw} — ${r.volume || '?'}`).join('\n');
    const demand = sample
      ? L(
          a.lang,
          `Реальные запросы людей вокруг него (запрос — частотность):\n${sample}\n\n`,
          `Real queries people use around it (query — volume):\n${sample}\n\n`,
        )
      : '';
    const cb = [...brandTokens(cname)].sort((x, y) => cpLength(y) - cpLength(x));
    const cbrand = cb.length ? cb[0] : cname;
    const instr =
      (a.about ? `${a.about}\n\n` : '') +
      L(a.lang, `Конкурент: ${cbrand}. `, `Competitor: ${cbrand}. `) +
      demand +
      L(
        a.lang,
        `Сейчас ${yr} год. Сгенерируй ${take} живых вопросов на русском языке, ` +
          `которые задал бы ИИ человек, ВЫБИРАЮЩИЙ между вариантами — так, чтобы ` +
          `${own || 'наш продукт'} мог всплыть как альтернатива: сравнения, ` +
          `«альтернативы ${cbrand}», «стоит ли ${cbrand}». Ответь СТРОГО JSON: ` +
          '{"prompts":[{"q":"...","intent":"comparison"}]}',
        `It's currently ${yr}. Generate ${take} live questions in English that a ` +
          `person CHOOSING between options would ask an AI — so that ` +
          `${own || 'our product'} could surface as an alternative: comparisons, ` +
          `"alternatives to ${cbrand}", "is ${cbrand} worth it". Respond STRICTLY as JSON: ` +
          '{"prompts":[{"q":"...","intent":"comparison"}]}',
      );
    let data: Record<string, unknown> | null = null;
    try {
      data = await deps.ask(instr);
    } catch {
      data = null;
    }
    const rowsOut = data?.prompts;
    if (!Array.isArray(rowsOut)) continue;
    const volHint = rows.length ? rows[0].volume : null;
    let added = 0;
    for (const x of rowsOut) {
      const t = isDict(x) ? pyStrip(pyStrOrEmpty(x.q ?? x.prompt)) : pyStrip(pyStrOrEmpty(x));
      if (!t) continue;
      const key = normPrompt(t);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!looksHuman(t)) continue;
      const intent = isDict(x) ? x.intent : null;
      out.push({
        prompt: t,
        topic: cbrand,
        volume: (volHint ?? null) as number | null,
        intent: typeof intent === 'string' && PROMPT_INTENTS.has(intent) ? intent : heuristicIntent(t),
        source: grounded ? 'real' : 'generated',
      });
      added += 1;
      if (added >= take || out.length >= a.target) break;
    }
  }
  return out.slice(0, a.target);
}

/** `_human_prompt_instruction` (aeo.py:1517-1607) — instruction for the generator (compact but faithful). */
function humanPromptInstruction(
  domain: string,
  about: string,
  sample: string,
  lang: string,
  batch: number,
  live: string[] | null,
  sections?: string[] | null,
): string {
  const personas = (lang === 'ru' ? PROMPT_PERSONAS_RU : PROMPT_PERSONAS_EN).join('; ');
  const liveBlock =
    live && live.length
      ? L(lang, 'Как люди РЕАЛЬНО спрашивают (подсказки поиска):\n', 'How people REALLY ask (search suggestions):\n') +
        live.slice(0, 20).map((q) => `- ${q}`).join('\n') +
        '\n\n'
      : '';
  const sectionsBlock =
    sections && sections.length
      ? L(
          lang,
          'РАЗДЕЛЫ ПРОДУКТА — покрой их ВСЕ, не больше трети на один:\n',
          'PRODUCT SECTIONS — cover ALL of them, no more than a third on any one:\n',
        ) +
        sections.map((s) => `- ${s}`).join('\n') +
        L(
          lang,
          '\nВ поле topic ставь название раздела ИЗ ЭТОГО СПИСКА дословно.\n\n',
          '\nIn the topic field, use the section name from this list verbatim.\n\n',
        )
      : '';
  void domain;
  return (
    (about ? `${about}\n\n` : '') +
    (sample ? L(lang, `Семантика (ключ — частотность):\n${sample}\n\n`, `Keywords (keyword — volume):\n${sample}\n\n`) : '') +
    liveBlock +
    L(lang, `Сейчас ${new Date().getFullYear()} год.\n\n`, `It's currently ${new Date().getFullYear()}.\n\n`) +
    L(
      lang,
      'Ты — РАЗНЫЕ реальные люди, выбирающие продукт этой категории и спрашивающие ' +
        `ИИ-ассистента. Роли для вдохновения: ${personas}.\n\n` +
        `Сгенерируй ${batch} РАЗНЫХ живых вопросов на русском языке — от первого ` +
        'лица, разговорно, конкретно. Строго про реальную нишу продукта из описания.\n' +
        'ДЛИНА И ФОРМА: 5–14 слов, ОДНА мысль. Без двух вопросов подряд, без вводных.\n' +
        'ФОРМЫ ЧЕРЕДУЙ: половина — вопрос, половина — просьба-команда ассистенту.\n' +
        'УТОЧНЕНИЕ ОБЯЗАТЕЛЬНО: в каждом втором вопросе — КОМУ или ПРИ КАКОМ УСЛОВИИ.\n',
      'You are DIFFERENT real people choosing a product in this category and asking ' +
        `an AI assistant. Roles for inspiration: ${personas}.\n\n` +
        `Generate ${batch} DIFFERENT live questions in English — first person, ` +
        'conversational, specific. Strictly about the real product niche from the description.\n' +
        'LENGTH AND FORM: 5-14 words, ONE thought. No two questions in a row, no filler intros.\n' +
        'ALTERNATE FORMS: half — a question, half — a request/command to the assistant.\n' +
        'QUALIFIER REQUIRED: in every other question — WHO FOR or UNDER WHAT CONDITION.\n',
    ) +
    sectionsBlock +
    L(
      lang,
      `Распредели вопросы ПО РАЗНЫМ интентам примерно поровну:\n${intentsDescBlock(lang)}\n\n` +
        'Для каждого укажи intent (ключ из списка) и topic (1–3 слова). Ответь СТРОГО ' +
        'JSON: {"prompts":[{"q":"...","intent":"best","topic":"..."}]}',
      `Distribute the questions across DIFFERENT intents roughly evenly:\n${intentsDescBlock(lang)}\n\n` +
        'For each, specify intent (a key from the list) and topic (1-3 words). Respond ' +
        'STRICTLY as JSON: {"prompts":[{"q":"...","intent":"best","topic":"..."}]}',
    )
  );
}

/** `_generate_llm_prompts` (aeo.py:1610-1718) — persona generation in batches with a dedup top-up. */
async function llmGeneratePrompts(
  deps: GenerateDeps,
  a: { domain: string; keywords: KeywordRow[]; about: string; lang: string; target: number; sections: string[] },
  maxPasses = 5,
): Promise<PromptRow[]> {
  if (!deps.ask) return [];
  let sample = (a.keywords || [])
    .slice(0, 80)
    .map((k) => `${pyStrOrEmpty(k.keyword)} — ${pyTruthy(k.volume) ? k.volume : '?'}`)
    .join('\n');
  let seeds: Array<[string, number | null]> = (a.keywords || [])
    .filter((k) => pyTruthy(k.keyword))
    .map((k): [string, number | null] => [
      pyStrip(pyStrOrEmpty(k.keyword).toLowerCase()),
      (k.volume ?? null) as number | null,
    ])
    .sort((x, y) => -volNum(x[1]) - -volNum(y[1]));

  let live: string[] = [];
  try {
    if (deps.liveQuestions && seeds.length) live = (await deps.liveQuestions(seeds[0][0], a.lang, 20)) || [];
  } catch {
    live = [];
  }

  const out: PromptRow[] = [];
  const seen = new Set<string>();
  for (let pass = 0; pass < maxPasses; pass += 1) {
    if (out.length >= a.target) break;
    // Topic grounding (best-effort): derive the top topic from what's already
    // collected, then top it up with live phrasing / demand for it. Both
    // sources are optional deps.
    if ((!live.length || !sample) && out.length) {
      const topics = out
        .map((p) => pyStrip(pyStrOrEmpty(p.topic)))
        .filter((t) => {
          const n = t ? t.split(/\s+/).length : 0;
          return n >= 2 && n <= 4;
        });
      if (topics.length) {
        const counts = new Map<string, number>();
        for (const t of topics) {
          const key = t.toLowerCase();
          counts.set(key, (counts.get(key) || 0) + 1);
        }
        let top = '';
        let bestC = -1;
        for (const [key, c] of counts) if (c > bestC) { bestC = c; top = key; }
        if (!live.length && deps.liveQuestions) {
          try {
            live = (await deps.liveQuestions(top, a.lang, 20)) || [];
          } catch {
            /* best-effort */
          }
        }
        if (!sample && a.lang === 'ru' && deps.wordstatTop) {
          let ws: KeywordRow[] = [];
          try {
            ws = (await deps.wordstatTop(top, 30)) || [];
          } catch {
            ws = [];
          }
          if (ws.length) {
            sample = ws.map((r) => `${pyStrOrEmpty(r.keyword)} — ${r.volume}`).join('\n');
            seeds = ws
              .map((r) => [pyStrOrEmpty(r.keyword), (r.volume ?? null) as number | null] as [string, number | null])
              .sort((x, y) => -volNum(x[1]) - -volNum(y[1]));
          }
        }
      }
    }
    const batch = Math.min(a.target - out.length + 4, 25);
    let instr = humanPromptInstruction(a.domain, a.about, sample, a.lang, batch, live, a.sections);
    if (out.length) {
      instr += '\n\nУЖЕ ЕСТЬ (НЕ повторяй):\n' + out.slice(-40).map((p) => `- ${p.prompt}`).join('\n');
    }
    let data: Record<string, unknown> | null = null;
    try {
      data = await deps.ask(instr);
    } catch {
      data = null;
    }
    const rows = data?.prompts;
    if (!Array.isArray(rows)) break;
    let added = 0;
    for (const x of rows) {
      let t: string;
      let intent: unknown;
      let topic: string | null;
      if (isDict(x)) {
        t = pyStrip(pyStrOrEmpty(x.q ?? x.prompt));
        intent = x.intent;
        topic = pyStrip(pyStrOrEmpty(x.topic)) || null;
      } else {
        t = pyStrip(pyStrOrEmpty(x));
        intent = null;
        topic = null;
      }
      if (!t) continue;
      const key = normPrompt(t);
      if (seen.has(key)) continue;
      seen.add(key);
      if (!looksHuman(t)) continue;
      const low = t.toLowerCase();
      let vol: number | null = null;
      for (const [kw, v] of seeds) {
        if (kw && low.includes(kw)) {
          vol = v;
          break;
        }
      }
      out.push({
        prompt: t,
        topic,
        volume: vol,
        intent: typeof intent === 'string' && PROMPT_INTENTS.has(intent) ? intent : heuristicIntent(t),
        source: 'generated',
      });
      added += 1;
    }
    if (added === 0) break;
  }
  return out;
}

// ══════════════════════════════════════════════════════════════════════════════
//  ORCHESTRATOR
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Port of `generate_prompts` (aeo.py:2027-2150). The ranked target-audience
 * prompt panel, grounded in real demand. Returns up to `n` rows {prompt,
 * topic, volume, intent, source}. LLM branches are enabled by
 * `deps.ask`/`deps.sources` (in Python — `az`).
 */
export async function generatePrompts(
  domain: string,
  keywords: KeywordRow[],
  options: GenerateOptions = {},
): Promise<PromptRow[]> {
  const { n = 12, lang = 'ru', context = null, competitors = [], deps = {} } = options;
  const brand = domain.split('.')[0];

  const fallbackRu = [
    `лучший сервис вроде ${brand}`,
    `альтернативы ${brand}`,
    `${brand} отзывы стоит ли пользоваться`,
    `сравнение ${brand} и конкурентов`,
    `что такое ${brand}`,
    `${brand} цены и тарифы`,
  ];
  const fallbackEn = [
    `best ${brand} alternatives`,
    `is ${brand} worth it`,
    `${brand} vs competitors`,
    `what is ${brand}`,
    `${brand} pricing`,
    `tools like ${brand}`,
  ];
  const fallback = normalizePanel((lang === 'ru' ? fallbackRu : fallbackEn).slice(0, n), {
    defaultSource: 'fallback',
  }) as PromptRow[];

  const about = productBrief(context, domain);
  const compBrands = competitorBrands(competitors);
  const askPresent = deps.ask != null;
  const src = deps.sources || {};

  // 0. Product sections (for panel coverage): LLM or override.
  const sectionsFn = src.siteSections ?? (askPresent ? (aa: Parameters<NonNullable<GenerateSources['siteSections']>>[0]) => llmSiteSections(deps, aa) : null);
  const sections = sectionsFn ? await sectionsFn({ domain, about, context, keywords, lang }) : [];

  // 1. From keywords — the main source of visibility (source='real').
  const fromKwFn = src.fromKeywords ?? (askPresent ? (aa: Parameters<NonNullable<GenerateSources['fromKeywords']>>[0]) => llmPromptsFromKeywords(deps, aa) : null);
  const kwPrompts = fromKwFn
    ? await fromKwFn({ keywords, about, domain, lang, target: n, excludeBrands: compBrands })
    : [];

  // 2. real-suggest: external question suggestions for the seed topic (dataforseo).
  const seed = seedFor(domain, keywords);
  const realSuggest: PromptRow[] = [];
  if (seed && deps.keywordSuggestions) {
    let sugg: KwSuggestionRow[] = [];
    try {
      sugg = (await deps.keywordSuggestions(seed, Math.max(30, n * 3))) || [];
    } catch {
      sugg = [];
    }
    for (const r of sugg) {
      const kw = r?.keyword;
      if (pyTruthy(kw) && isQuestion(kw)) {
        realSuggest.push({
          prompt: pyStrip(pyStrOrEmpty(kw)),
          topic: seed,
          volume: (r.volume ?? null) as number | null,
          intent: heuristicIntent(kw),
          source: 'real',
        });
      }
    }
  }

  // 3. Competitor intercept (COMPETITOR_SHARE quota).
  const compFn = src.competitor ?? (askPresent ? (aa: Parameters<NonNullable<GenerateSources['competitor']>>[0]) => llmCompetitorPrompts(deps, aa) : null);
  const compTarget = pyRound(n * COMPETITOR_SHARE);
  const compPrompts = compFn
    ? await compFn({ keywords, about, domain, competitors, compBrands, lang, target: compTarget })
    : [];

  // 4. real = the live output from steps 1-3, filtered by form and collapsed for rephrasings.
  const real = dropNearDuplicates(
    [...kwPrompts, ...realSuggest, ...compPrompts].filter((p) => looksHuman(p.prompt)),
  );

  // Sections the keyword branch didn't cover (the top-up is computed AFTER filtering).
  const covered = new Set(assignSections(real, sections).map((p) => normPrompt(pyStrOrEmpty(p.topic))));
  const missing = sections.filter((s) => !covered.has(normPrompt(s)));

  let generated: PromptRow[] = [];
  const need = Math.max(n - real.length, missing.length * 2);
  const genFn = src.generated ?? (askPresent ? (aa: Parameters<NonNullable<GenerateSources['generated']>>[0]) => llmGeneratePrompts(deps, aa) : null);
  if (genFn && need > 0 && (keywords.length > 0 || about)) {
    generated = await genFn({
      domain,
      keywords,
      about,
      lang,
      target: need,
      sections: missing.length ? missing : sections,
    });
  }
  // The fallback below is NOT filtered (last line of defense), but the generated set is.
  generated = generated.filter((p) => looksHuman(p.prompt));

  // 5. Build the panel with headroom (n·2), then narrow it with the deterministic filters.
  let pool = dropNearDuplicates(rankPanel([...real, ...generated], n * 2));
  pool = spreadByTopic(assignSections(pool, sections), n);
  pool = capCompetitorMentions(pool, compBrands, n);
  const panel = ensureCompetitorFloor(pool, compBrands, n).slice(0, n);

  // Too few live prompts — deterministic template fallback.
  if (panel.filter((p) => pyTruthy(p.prompt)).length < 4) {
    const ranked = rankPanel([...real, ...generated, ...fallback], n);
    return ranked.length ? ranked : fallback.slice(0, n);
  }
  return panel;
}
