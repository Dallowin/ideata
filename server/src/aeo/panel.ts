/**
 * Port of the "panel" half of core/aeo.py — the functions the AI-monitoring
 * page assembles ON TOP OF the aggregates (aggregate.ts already covers the
 * window math):
 *
 *   • normalizeProjectLang (aeo.py:168-177) — language tag → 'ru'|'en'|null;
 *   • heuristicIntent      (aeo.py:813-838) — rough intent bucket by markers;
 *   • promptStatus         (aeo.py:849-855) — panel prompt status (active/…);
 *   • normalizePanel       (aeo.py:883-931) — free-form input → canonical panel;
 *   • promptCount          (aeo.py:1368-1379) — plan prompt-count ceiling.
 *
 * Plus constants: PROMPT_INTENTS (aeo.py:273-282, only the KEYS are needed
 * here — the descriptions live in Python and are only used by the LLM
 * generator), PROMPT_STATUSES (aeo.py:846), PANEL_SOURCES (the set from
 * aeo.py:921), and PLAN_PROMPT_COUNTS (aeo.py:1363-1365, per-plan prompt-pool
 * defaults from core/plans.py PLAN_DEFAULTS; mirrored in
 * api/src/plans/plans.service.ts).
 *
 * Panel dedup and text normalization go through `normPrompt` from ./text
 * (the same `_norm_prompt`, 583 parity tests), so it is NOT duplicated here.
 */
import { normPrompt } from './text';
import { isDict, pyStrip, pyStrOrEmpty } from './parse';

/**
 * Panel intent-bucket keys (aeo.py:273-282, PROMPT_INTENTS). In normalize_panel
 * only membership matters (`intent in PROMPT_INTENTS`) — the category
 * descriptions stay in Python (only the LLM prompt generator reads them).
 */
export const PROMPT_INTENTS: ReadonlySet<string> = new Set([
  'best',
  'alternatives',
  'comparison',
  'how_to_choose',
  'reviews',
  'pricing',
  'use_case',
  'definition',
]);

/**
 * aeo.py:273-282 — key → human-readable intent label (buyer-journey).
 * Only the KEYS matter in normalize_panel (PROMPT_INTENTS), but aggregate_facts
 * renders this label as the `label` of the "visibility by intent" row
 * (`PROMPT_INTENTS.get(k, k)`, aeo.py:2494) — kept here next to the keys.
 */
export const PROMPT_INTENT_LABELS: Readonly<Record<string, string>> = {
  best: '«лучший сервис/инструмент для задачи» (топ-подборка)',
  alternatives: 'альтернативы/замена конкретному сервису',
  comparison: 'сравнение двух решений (X vs Y)',
  how_to_choose: 'как выбрать решение под свои требования',
  reviews: 'отзывы, надёжность, «стоит ли пользоваться»',
  pricing: 'цены, тарифы, «сколько стоит»',
  use_case: 'как решить конкретную задачу ниши этим классом продукта',
  definition: 'что это такое / базовое объяснение категории',
};

/** aeo.py:846 — lifecycle of a panel prompt. */
export const PROMPT_STATUSES: ReadonlySet<string> = new Set([
  'active',
  'suggested',
  'inactive',
]);

/** aeo.py:921 — allowed prompt sources; anything else → default_source. */
export const PANEL_SOURCES: ReadonlySet<string> = new Set([
  'real',
  'generated',
  'manual',
  'fallback',
]);

/**
 * aeo.py:1363-1365 — per-plan prompt pool (core/plans.py PLAN_DEFAULTS
 * .prompts_pool). Kept local so this "primitive" layer doesn't pull in a
 * Prisma-backed service; the values mirror core/plans.py and
 * api/src/plans/plans.service.ts PLAN_DEFAULTS (single source of truth —
 * Python). A golden test catches drift on scale=125.
 */
export const PLAN_PROMPT_COUNTS: Readonly<Record<string, number>> = {
  free: 10,
  lite: 25,
  pro: 50,
  scale: 125,
};

// ── Python quirks ─────────────────────────────────────────────────────────

/**
 * Python truthiness for `if x` / `x or …`: None/False/0/-0/""/empty list/
 * empty dict are falsy. Needed for `if topic` and `str(x or "")` in normalize_panel.
 */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '') return false;
  if (typeof v === 'number') return v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return true;
}

/**
 * `int(v)` from aeo.py:912 wrapped in try/except (TypeError, ValueError) → None.
 * Python's `int`: bool→0/1, float/number→truncation TOWARD ZERO (int(3.9)==3,
 * int(-3.9)==-3), string→strict integer parse with whitespace stripped (int("5.0")
 * raises ValueError). Unparseable / dict / list → None (as in the except branch).
 * `v is None` is filtered out by the caller BEFORE reaching this function.
 */
function pyIntOrNone(v: unknown): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null; // int(nan) → ValueError
    return Math.trunc(v);
  }
  if (typeof v === 'string') {
    const t = pyStrip(v);
    if (!/^[+-]?\d+$/.test(t)) return null; // int() rejects "5.0"/"" /"abc"
    const n = Number(t);
    return Number.isSafeInteger(n) ? n : Math.trunc(n);
  }
  return null; // None/list/dict → except → None
}

/** `int(raw)` for the AEO_PROMPTS env string: strict integer, else null (ValueError). */
function pyIntStrict(raw: string): number | null {
  const t = pyStrip(raw);
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

// ── public functions ─────────────────────────────────────────────────────

/**
 * aeo.py:168-177 — any language tag (`ru`, `RU`, `ru-RU`, `en_US`) → 'ru'/'en';
 * empty and anything unrecognized → null. Deliberately differs from
 * emails.normalize_lang: here null means "project language is undetermined".
 */
export function normalizeProjectLang(value: unknown): 'ru' | 'en' | null {
  // str(value or "") — a falsy operand collapses to "".
  const raw = pyTruthy(value) ? pyStrOrEmpty(value) : '';
  const code = pyStrip(raw).toLowerCase().replace(/_/g, '-').split('-')[0];
  return code === 'ru' || code === 'en' ? code : null;
}

/**
 * aeo.py:813-838 — rough classification of a question into an intent bucket
 * by markers (ru+en). Check order matters: commercial markers before generic
 * ones. `t` is padded with spaces so markers like " vs " match whole words.
 */
export function heuristicIntent(text: unknown): string {
  const t = ` ${normPrompt(text as string)} `;
  const has = (...ws: string[]): boolean => ws.some((w) => t.includes(w));
  if (has(' vs ', ' versus ', ' или ', 'сравн', 'compar')) return 'comparison';
  if (has('альтернатив', 'alternativ', 'замен', 'instead of', 'аналог')) {
    return 'alternatives';
  }
  if (has('сколько стоит', ' цен', 'тариф', 'price', 'pricing', ' cost', 'стоимост')) {
    return 'pricing';
  }
  if (
    has('отзыв', 'review', 'стоит ли', 'worth it', 'надежн', 'надёжн', 'reliable',
      'развод', 'scam', 'честн')
  ) {
    return 'reviews';
  }
  if (has('как выбрать', 'how to choose', 'какой выбрать', ' which ', 'как подобрать')) {
    return 'how_to_choose';
  }
  if (has('лучш', ' best ', ' топ ', ' top ')) return 'best';
  if (has('что такое', 'what is', 'что это', 'как работает', 'how does')) {
    return 'definition';
  }
  return 'use_case';
}

/**
 * aeo.py:849-855 — panel prompt status; missing/garbage → "active"
 * (back-compat: an active prompt has no status field in the canonical form at all).
 */
export function promptStatus(p: unknown): string {
  if (isDict(p)) {
    const s = p.status;
    if (typeof s === 'string' && PROMPT_STATUSES.has(s)) return s;
  }
  return 'active';
}

/** Canonical shape of a single panel row (aeo.py:915-929). */
export interface PanelEntry {
  prompt: string;
  topic: string | null;
  volume: number | null;
  intent: string;
  source: string;
  /** only for suggested/inactive (active = field absent) */
  status?: string;
  /** only for suggested */
  suggested_at?: string;
}

/**
 * aeo.py:883-931 — free-form input (strings / panel objects) → canonical
 * [{prompt, topic, volume, intent, source}], deduped by normalized text,
 * order preserved. status/suggested_at are kept, but the canonical form is
 * "lean": the status field only appears for suggested/inactive, suggested_at
 * only for suggested.
 */
export function normalizePanel(
  items: unknown,
  { defaultSource = 'manual' }: { defaultSource?: string } = {},
): PanelEntry[] {
  const out: PanelEntry[] = [];
  const seen = new Set<string>();
  const list = Array.isArray(items) ? items : [];
  for (const it of list) {
    let text: string;
    let topic: unknown;
    let vol: unknown;
    let src: unknown;
    let intent: unknown;
    let status: unknown;
    let suggestedAt: unknown;
    if (isDict(it)) {
      // str(it.get("prompt") or "").strip()
      text = pyStrip(pyStrOrEmpty(it.prompt));
      topic = it.topic;
      vol = it.volume;
      src = it.source;
      intent = it.intent;
      status = it.status;
      suggestedAt = it.suggested_at;
    } else {
      // str(it or "").strip(); everything else — None
      text = pyStrip(pyStrOrEmpty(it));
      topic = null;
      vol = null;
      src = null;
      intent = null;
      status = null;
      suggestedAt = null;
    }
    if (!text) continue;
    const k = normPrompt(text);
    if (seen.has(k)) continue;
    seen.add(k);
    // vol: int(vol) if vol is not None else None (wrapped in try → None)
    const volume = vol === null || vol === undefined ? null : pyIntOrNone(vol);
    const entry: PanelEntry = {
      prompt: text,
      // (str(topic).strip() or None) if topic else None
      topic: pyTruthy(topic) ? pyStrip(pyStrOrEmpty(topic)) || null : null,
      volume,
      intent:
        typeof intent === 'string' && PROMPT_INTENTS.has(intent)
          ? intent
          : heuristicIntent(text),
      source:
        typeof src === 'string' && PANEL_SOURCES.has(src) ? src : defaultSource,
    };
    if (status === 'suggested' || status === 'inactive') {
      entry.status = status;
      if (status === 'suggested' && pyTruthy(suggestedAt)) {
        entry.suggested_at = pyStrOrEmpty(suggestedAt);
      }
    }
    out.push(entry);
  }
  return out;
}

/**
 * aeo.py:934-938 — template fallback prompts (source='fallback') are an
 * emergency placeholder, not a live panel: we never persist them to the
 * tracker and drop them on merge. Non-dict entries pass through untouched
 * (like the Python isinstance check).
 */
export function dropFallback<T>(panel: readonly T[] | null | undefined): T[] {
  return (panel || []).filter((p) => !(isDict(p) && p.source === 'fallback'));
}

/**
 * aeo.py:941-956 — unified brand panel: existing (curated/manual) prompts
 * stay as-is and keep their order, fresh generation tops up to n with
 * dedup by normalized text. Fallback templates are dropped from both sides
 * (an empty result means "no live panel" — the caller decides on the template).
 */
export function mergePanels(existing: unknown, fresh: unknown, n: number): PanelEntry[] {
  const out = dropFallback(normalizePanel(existing));
  const seen = new Set<string>(out.map((p) => normPrompt(p.prompt)));
  for (const p of dropFallback(normalizePanel(fresh, { defaultSource: 'generated' }))) {
    if (out.length >= n) break;
    const k = normPrompt(p.prompt);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out.slice(0, n);
}

/**
 * aeo.py:1368-1379 — AEO panel prompt count (clamped 5..150). A single knob
 * shared by parsing and monitoring: env/admin setting AEO_PROMPTS (passed in
 * as `aeoPromptsSetting`, the caller is the reader) → plan pool
 * (PLAN_PROMPT_COUNTS) → default (50).
 *
 * `aeoPromptsSetting` — the raw string value of AEO_PROMPTS (like
 * os.environ.get): a non-empty string that parses as an int → that's the
 * answer (after clamping); empty/non-integer → fall back to the plan (in
 * Python this is `if raw:` + try/except ValueError).
 */
export function promptCount(
  plan: string | null | undefined,
  aeoPromptsSetting: string | null | undefined,
  defaultN = 50,
): number {
  if (aeoPromptsSetting) {
    // `if raw:` — non-empty string. int(raw); ValueError → fall back to the plan.
    const n = pyIntStrict(aeoPromptsSetting);
    if (n !== null) return clamp(n, 5, 150);
  }
  const key = (plan ?? '').trim().toLowerCase();
  // Mirrors Python `dict.get(key, default)`: only OWN keys. `key in` would
  // also catch Object.prototype ('constructor'/'__proto__' → function → NaN);
  // hasOwnProperty excludes inherited properties, just like a Python dict.
  const n = Object.prototype.hasOwnProperty.call(PLAN_PROMPT_COUNTS, key)
    ? PLAN_PROMPT_COUNTS[key]
    : defaultN;
  return clamp(n, 5, 150);
}
