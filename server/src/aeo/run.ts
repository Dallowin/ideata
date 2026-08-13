/**
 * Orchestration of a single AEO snapshot — port of scrapper/core/aeo.py::run_snapshot
 * (aeo.py:2340-2382) + judge_answers (aeo.py:2232-2287) + sentiment_batch
 * (aeo.py:2153-2185). A pure "run prompts through engines and enrich the
 * answers" layer: the network is hidden behind the provider dispatcher
 * (askPlatform); DB writes and reading the tracker live in run-job.ts.
 *
 * The port's difference from Python is the concurrency model. Python runs the
 * cartesian product (prompt × platform) in a ThreadPoolExecutor and collects
 * `ex.map(...)` (order = input order, threads carry contextvars via
 * usage.ctx_worker). Node has no threads: concurrency comes from p-limit
 * (v3, CJS default — same as blogwriter), and the run's context survives
 * `await` on its own (AsyncLocalStorage in usage.ts), so the ctx_worker
 * wrapper isn't needed — it's enough to wrap the whole run in runContext once
 * (processAeoRun does this). Result order is kept by `Promise.all` on the
 * task's INDEX (not on completion time); a failed/empty task → null and gets
 * filtered out — exactly like `[r for r in results if r]` (aeo.py:2382).
 *
 * Worker limits are ported literally: snapshot max(4, min(24, AEO_MAX_WORKERS))
 * (aeo.py:2377), judge max(1, min(12, AEO_MAX_WORKERS, len(batches))) (aeo.py:2283).
 *
 * The judge/sentiment calls go to the cheap flash engine THROUGH THE SAME
 * provider layer (askPlatform('claude'|'gemini') = FLASH_MODELS aa_agents.py:36,
 * kie-haiku/gemini-flash with an OpenRouter fallback). Any judge/sentiment
 * failure does not fail the run (port of _run_safe aeo.py:2290 and general
 * failure isolation).
 */
import pLimit from 'p-limit';
import { askPlatform, DEFAULT_PLATFORMS } from './providers/dispatcher';
import {
  parseBrands,
  citeItems,
  pyStrOrEmpty,
  type CiteItem,
  type BrandHit,
  type AliasMap,
} from './parse';
import type { CitationRaw } from './aggregate.types';

// ── Python-ish helpers (local) ────────────────────────────────────────────────

/** `int(env, def)` strict (Python's int() raises ValueError on a non-integer → def). */
function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw == null) return def;
  const t = raw.trim();
  return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : def;
}

/**
 * Python's `int(v)` in try/except → null: bool→0/1, number→truncate toward zero,
 * string→strict integer parsing ("55.5"/""/"abc" → null), anything else → null.
 */
function pyInt(v: unknown): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string') {
    const t = v.trim();
    return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : null;
  }
  return null;
}

/** `_clamp100` (aeo.py:2198): int(v) clamped to [0,100], else null. */
function clamp100(v: unknown): number | null {
  const n = pyInt(v);
  return n === null ? null : Math.max(0, Math.min(100, n));
}

/** Python-style string slice `s[:n]` — by CODE POINTS (not UTF-16 units). */
function cpSlice(s: string, n: number): string {
  let out = '';
  let i = 0;
  for (const ch of s) {
    if (i >= n) break;
    out += ch;
    i += 1;
  }
  return out;
}

/** `isinstance(x, dict)` — a plain object. */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ── snapshot: cartesian prompt × platform ─────────────────────────────────────

/** A single LLM judge verdict per the fixed contract (aeo.py:2221-2229). */
export interface JudgeVerdict {
  score: number;
  /** only when the brand is actually mentioned; otherwise null */
  sentiment: 'positive' | 'neutral' | 'negative' | null;
  factuality: number;
  relevance: number;
  recommendation: number;
  hallucination: 'low' | 'med' | 'high';
  reason: string;
}

/** A single snapshot row — shape of aeo_answers (excluding the sentiment service row). */
export interface SnapshotAnswer {
  platform: string;
  prompt: string;
  text: string;
  citations: CiteItem[];
  brands_found: BrandHit[];
  /** filled in by judgeAnswers in place (like Python's a["judge"]); optional */
  judge?: JudgeVerdict;
}

export interface RunSnapshotOpts {
  platforms?: readonly string[];
  /** dual-mode engine flag (see dispatcher.askPlatform) */
  grounded?: boolean;
  /** worker count override; otherwise env AEO_MAX_WORKERS → 12 */
  maxWorkers?: number;
  locationCode?: number;
  languageCode?: string;
  /** confirmed brand spellings {domain: [spelling, …]} */
  aliases?: AliasMap;
}

/** Snapshot worker count: max(4, min(24, n)) (aeo.py:2373-2377). */
function snapshotWorkers(maxWorkers?: number): number {
  const raw = maxWorkers ?? intEnv('AEO_MAX_WORKERS', 12);
  return Math.max(4, Math.min(24, raw));
}

/**
 * Port of run_snapshot (aeo.py:2340). All (prompt × platform) pairs run in
 * parallel → a list of answers {platform, prompt, text, citations, brands_found}.
 * Task order matches Python: OUTER loop over prompts, INNER over platforms
 * (`[(pl, pr) for pr in prompts for pl in platforms]`, aeo.py:2352). Results
 * come back by task index (Promise.all); a failed/empty call → null and is
 * dropped (aeo.py:2382). `grounded` is passed through to askPlatform as the
 * execution mode. Brands for matching: domain + up to 4 competitors (aeo.py:2351).
 */
export async function runSnapshot(
  domain: string,
  competitors: string[],
  prompts: string[],
  opts: RunSnapshotOpts = {},
): Promise<SnapshotAnswer[]> {
  const {
    platforms = DEFAULT_PLATFORMS,
    grounded = true,
    locationCode = 2840,
    languageCode = 'en',
    aliases,
  } = opts;
  // aeo.py:2351 — brands = [domain] + [c for c in competitors if c][:4].
  const brands = [domain, ...competitors.filter((c) => !!c).slice(0, 4)];
  // aeo.py:2352 — cartesian: for pr in prompts (outer) for pl in platforms (inner).
  const tasks: Array<[string, string]> = [];
  for (const pr of prompts) for (const pl of platforms) tasks.push([pl, pr]);

  const limit = pLimit(snapshotWorkers(opts.maxWorkers));

  const runOne = async (task: [string, string]): Promise<SnapshotAnswer | null> => {
    const [pl, pr] = task;
    let ans: { text: string; citations: CiteItem[] } | null;
    try {
      ans = await askPlatform(pl, pr, { locationCode, languageCode, grounded });
    } catch {
      // aeo.py:2361-2363 — a failed engine call is swallowed, the run keeps going.
      return null;
    }
    if (!ans) return null; // aeo.py:2364-2365 — engine unavailable / empty response.
    return {
      platform: pl,
      prompt: pr,
      text: ans.text,
      // citeItems is idempotent on askPlatform's already-canonical citations (the
      // provider's parser returns [{url,title}]); we run it anyway to guarantee the row shape.
      citations: citeItems(ans.citations as unknown as CitationRaw[]),
      brands_found: parseBrands(ans.text, brands, aliases),
    };
  };

  // Promise.all keeps order by task INDEX regardless of completion time
  // (analogous to ex.map, where order = input order). Then filter out null.
  const results = await Promise.all(tasks.map((t) => limit(() => runOne(t))));
  return results.filter((r): r is SnapshotAnswer => r !== null);
}

// ── cheap flash-JSON via the provider layer (judge/sentiment) ─────────────────

/** FLASH_MODELS aa_agents.py:36 in terms of the dispatcher's slugs (kie-haiku, gemini-flash). */
const FLASH_SLUGS = ['claude', 'gemini'] as const;

/**
 * `Analyzer._parse_json` (analysis.py:717) — lenient JSON parsing from an LLM
 * response: strip ``` fencing, `JSON.parse`; if that fails, cut from the first
 * `{` to the last `}`. Never throws (judge/sentiment are best-effort) — null on failure.
 */
function parseJsonLoose(text: string): Record<string, unknown> | null {
  if (!text) return null;
  let t = text.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?/, '').trim();
    t = t.replace(/```$/, '').trim();
  }
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      return isPlainObject(v) ? v : null;
    } catch {
      return null;
    }
  };
  const direct = tryParse(t);
  if (direct) return direct;
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) return tryParse(t.slice(start, end + 1));
  return null;
}

/**
 * `_ask_json(az, prompt, models=FLASH_MODELS, max_tokens)` (aa_agents.py:130) via
 * the provider layer: cheap flash engine → JSON. We iterate FLASH_SLUGS, the
 * first non-empty valid JSON wins (analogous to how az.complete iterates models).
 * Each call is failure-isolated in askPlatform; if everything is null → null.
 */
export async function askFlashJson(prompt: string): Promise<Record<string, unknown> | null> {
  for (const slug of FLASH_SLUGS) {
    const ans = await askPlatform(slug, prompt, { grounded: false });
    if (ans && ans.text) {
      const j = parseJsonLoose(ans.text);
      if (j) return j;
    }
  }
  return null;
}

// ── LLM judge for each answer (aeo.py:2232) ───────────────────────────────────

const HALLU: ReadonlySet<string> = new Set(['low', 'med', 'high']);

/** `judge_enabled` (aeo.py:2193): AEO_JUDGE kill switch (0/false/no), default enabled. */
export function judgeEnabled(): boolean {
  const v = (process.env.AEO_JUDGE ?? '1').toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'no';
}

/** `_judge_one` (aeo.py:2205): sanitize the LLM verdict → judge contract | null. */
function judgeOne(verdict: unknown, mentioned: boolean): JudgeVerdict | null {
  if (!isPlainObject(verdict)) return null;
  const score = clamp100(verdict.score);
  if (score === null) return null;
  // sentiment: only when the brand is actually mentioned (brands_found is the source of truth).
  let sent = verdict.sentiment as JudgeVerdict['sentiment'];
  if (!mentioned || (sent !== 'positive' && sent !== 'neutral' && sent !== 'negative')) {
    sent = !mentioned ? null : 'neutral';
  }
  let hallu = verdict.hallucination as string;
  if (!HALLU.has(hallu)) hallu = 'med';
  return {
    score,
    sentiment: sent,
    factuality: clamp100(verdict.factuality) ?? 0,
    relevance: clamp100(verdict.relevance) ?? 0,
    recommendation: clamp100(verdict.recommendation) ?? 0,
    hallucination: hallu as JudgeVerdict['hallucination'],
    reason: cpSlice(pyStrOrEmpty(verdict.reason).trim(), 280),
  };
}

/** Judge worker count: max(1, min(12, AEO_MAX_WORKERS, len(batches))) (aeo.py:2283). */
function judgeWorkers(nBatches: number): number {
  return Math.max(1, Math.min(12, intEnv('AEO_MAX_WORKERS', 12), nBatches));
}

/**
 * Port of judge_answers (aeo.py:2232): enriches EVERY answer with non-empty text
 * with a `judge` field (in-place mutation, like Python). Batches of batch_size,
 * one cheap flash-judge call per batch, run in parallel with a limit; a failed/
 * invalid batch just leaves those answers without judge (aeo.py:2290 _run_safe).
 * Disabled via judgeEnabled().
 */
export async function judgeAnswers(
  answers: SnapshotAnswer[],
  domain: string,
  competitors: string[],
  opts: { batchSize?: number } = {},
): Promise<void> {
  const batchSize = opts.batchSize ?? 6;
  if (!answers.length || !judgeEnabled()) return;
  const rivals = competitors.filter((c) => !!c).join(', ') || '—';
  // todo — answers with non-empty text; batches reference the SAME objects (the
  // mutation is reflected on the original answers).
  const todo = answers.filter((a) => (a.text || '').trim());
  const batches: SnapshotAnswer[][] = [];
  for (let i = 0; i < todo.length; i += batchSize) batches.push(todo.slice(i, i + batchSize));
  if (!batches.length) return;

  const runBatch = async (batch: SnapshotAnswer[]): Promise<void> => {
    let blob = '';
    batch.forEach((a, i) => {
      blob +=
        `\n### Ответ ${i}\nПромпт: ${a.prompt || ''}\n` +
        `Ответ движка: ${cpSlice(a.text || '', 3000)}\n`;
    });
    const p =
      `Наш бренд: ${domain}. Конкуренты: ${rivals}.\n` +
      'Ты — судья ответов ИИ-ассистентов для оценки видимости нашего бренда. ' +
      'Оцени КАЖДЫЙ ответ ниже по нашему бренду.' +
      blob +
      '\nДля каждого ответа по индексу верни объект: score (0-100), sentiment ' +
      '(positive|neutral|negative; null если бренд не упомянут), factuality ' +
      '(0-100), relevance (0-100), recommendation (0-100), hallucination ' +
      '(low|med|high), reason (1-2 предложения по-русски).\n' +
      'Ответь СТРОГО JSON: {"answers":{"0":{"score":62,"sentiment":"neutral",' +
      '"factuality":80,"relevance":90,"recommendation":40,"hallucination":"low",' +
      '"reason":"..."}}}';
    let data: Record<string, unknown> | null = null;
    try {
      data = await askFlashJson(p);
    } catch {
      return; // aeo.py:2290 — judge failure does not fail the run
    }
    const rows = data?.answers;
    if (!isPlainObject(rows)) return;
    batch.forEach((a, i) => {
      const mentioned = (a.brands_found || []).some((x) => x.brand === domain);
      const j = judgeOne(rows[String(i)], mentioned);
      if (j) a.judge = j;
    });
  };

  const limit = pLimit(judgeWorkers(batches.length));
  await Promise.all(
    batches.map((b) =>
      limit(async () => {
        try {
          await runBatch(b);
        } catch {
          /* _run_safe: a failed judge batch does not fail the run */
        }
      }),
    ),
  );
}

// ── run sentiment (aeo.py:2153) ───────────────────────────────────────────────

export interface SentimentTheme {
  t: string;
  tone: 'good' | 'neutral' | 'bad';
}
export interface SentimentEntry {
  score: number;
  themes: SentimentTheme[];
}

/**
 * Port of sentiment_batch (aeo.py:2153): {brand: [answer excerpts]} →
 * {brand: {score 0-100, themes}}. Cheap flash LLM, up to 5 brands, up to 4
 * excerpts of 300 chars each. Empty input/failure/invalid JSON → null (the run
 * survives — sentiment is best-effort).
 */
export async function sentimentBatch(
  brandTexts: Record<string, string[]>,
): Promise<Record<string, SentimentEntry> | null> {
  const brands = Object.keys(brandTexts);
  if (!brands.length) return null;
  let blob = '';
  for (const b of brands.slice(0, 5)) {
    const joined = (brandTexts[b] || [])
      .slice(0, 4)
      .map((t) => cpSlice(t, 300))
      .join(' … ');
    blob += `\n### ${b}\n${joined}\n`;
  }
  const p =
    'Фрагменты ответов ИИ-ассистентов о брендах:' +
    blob +
    '\nДля каждого бренда оцени тональность описания (score 0-100, где 100 — ' +
    'восторженно, 50 — нейтрально) и до 3 тем (по-русски), каждая с tone: ' +
    'good|neutral|bad.\nОтветь СТРОГО JSON: {"brands":{"<бренд>":{"score":62,' +
    '"themes":[{"t":"...","tone":"good"}]}}}';
  let data: Record<string, unknown> | null = null;
  try {
    data = await askFlashJson(p);
  } catch {
    return null;
  }
  const rows = data?.brands;
  if (!isPlainObject(rows)) return null;
  const out: Record<string, SentimentEntry> = {};
  for (const [b, v] of Object.entries(rows)) {
    if (!isPlainObject(v)) continue;
    const score = clamp100(v.score);
    if (score === null) continue; // Python: int(None/garbage) → except → continue
    const rawThemes = Array.isArray(v.themes) ? v.themes : [];
    const themes: SentimentTheme[] = [];
    for (const t of rawThemes) {
      if (!isPlainObject(t)) continue;
      const label = cpSlice(pyStrOrEmpty(t.t).trim(), 80);
      if (!label) continue;
      const tone = t.tone;
      themes.push({
        t: label,
        tone: tone === 'good' || tone === 'neutral' || tone === 'bad' ? tone : 'neutral',
      });
      if (themes.length >= 3) break;
    }
    out[b] = { score, themes };
  }
  return Object.keys(out).length ? out : null;
}
