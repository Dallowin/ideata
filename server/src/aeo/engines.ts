/**
 * Money-safety layer for the AEO engine — port of the "profile" half of
 * core/aeo.py. Everything that decides WHICH engines and for HOW MANY prompts
 * actually go into a paid run (and thus how much it costs):
 *
 *   • parseSlugs         (aeo.py:214) — CSV → valid slugs (garbage dropped, dedup,
 *                         order preserved);
 *   • enginesOff         (aeo.py:222 disabled_platforms) — global kill switch
 *                         AEO_ENGINES_OFF: an engine drops out of ALL profiles;
 *   • profileBase        (aeo.py:227) — profile composition from AEO_PROFILE_*
 *                         WITHOUT the kill switch ("-" → empty, garbage → default);
 *   • platformsFor       (aeo.py:242) — profileBase MINUS the kill switch;
 *   • platformsForLang   (aeo.py:154) — strips RU-market engines for a non-Russian project;
 *   • availablePlatforms (aeo.py:528) — key-gating (the engine's own vendor key /
 *                         OpenRouter/GigaChat/Yandex) + kill switch;
 *   • yandexPromptsMax   (aeo.py:1388) + topVolumePrompts (aeo.py:1400) — Yandex
 *                         clamp: Neuro is expensive (fixed price per answer), so we
 *                         run not the whole panel but the top prompts by volume.
 *
 * Settings are LIVE: AEO_* are resolved on EVERY call via getSettingKey
 * (app_settings → env) — mirroring how Python reads os.environ, which the
 * worker rolls in from app_settings on every job (jobs._apply_admin_settings).
 * That's why every resolver that reads settings is async.
 *
 * Engine registries (DEFAULT_PLATFORMS / OPENROUTER_ENGINES / NATIVE_ENGINES /
 * RU_MARKET_PLATFORMS) come from providers/dispatcher (single source, no
 * duplication). Prompt-text dedup in topVolumePrompts goes through normPrompt
 * (the same _norm_prompt used by the panel).
 */
import { getSettingKey } from './providers/settings';
import {
  DEFAULT_PLATFORMS,
  NATIVE_ENGINES,
  OPENROUTER_ENGINES,
  RU_MARKET_PLATFORMS,
} from './providers/dispatcher';
import { normPrompt } from './text';
import { isDict } from './parse';

/** All valid slugs (aeo.py:142 DEFAULT_PLATFORMS) — membership set for parseSlugs. */
const DEFAULT_SET: ReadonlySet<string> = new Set(DEFAULT_PLATFORMS);

/** Default plan-profile composition (aeo.py:186-195, PROFILE_PLATFORMS). */
export const PROFILE_PLATFORMS: Readonly<Record<string, readonly string[]>> = {
  micro: ['chatgpt', 'deepseek', 'grok', 'gigachat', 'claude', 'aio'],
  mid: ['alice', 'gemini', 'perplexity'],
  full: ['chatgpt', 'deepseek', 'grok', 'claude'],
  yandex: ['yandex'],
};

/** Profiles that run search (grounded) execution (aeo.py:198). */
export const GROUNDED_PROFILES: ReadonlySet<string> = new Set(['full', 'yandex']);

/** Profile → its composition's env key (aeo.py:210-211, PROFILE_ENV). */
const PROFILE_ENV: Readonly<Record<string, string>> = {
  micro: 'AEO_PROFILE_MICRO',
  mid: 'AEO_PROFILE_MID',
  full: 'AEO_PROFILE_FULL',
  yandex: 'AEO_PROFILE_YANDEX',
};

/** Default cap on yandex-profile prompts (aeo.py:1385, YANDEX_PROMPTS_MAX). */
export const YANDEX_PROMPTS_MAX = 30;

// ── Python-isms ────────────────────────────────────────────────────────────

/** `int(raw)` as a strict integer (Python's int): whitespace trimmed, "5.0"/""/"abc"
 *  → null (ValueError). Truncation toward zero for large numbers. */
function pyIntStrict(raw: string): number | null {
  const t = raw.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n));

/** Python's `dict.get(key)` (OWN keys ONLY — not Object.prototype). */
function ownGet<T>(obj: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

// ── engine composition ────────────────────────────────────────────────────────

/**
 * aeo.py:214 — CSV string → valid engine slugs: each trimmed+lowercased,
 * garbage (not in DEFAULT_PLATFORMS) dropped, duplicates collapsed
 * (dict.fromkeys), ORDER preserved.
 */
export function parseSlugs(raw: string | null | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of (raw || '').split(',')) {
    const s = part.trim().toLowerCase();
    if (DEFAULT_SET.has(s) && !seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * aeo.py:222 (disabled_platforms) — engines globally disabled by the admin
 * (AEO_ENGINES_OFF, kill switch). A Set (like Python's frozenset): order
 * doesn't matter — only used for the membership test `p not in off`. Empty →
 * everything is enabled.
 */
export async function enginesOff(): Promise<Set<string>> {
  return new Set(parseSlugs(await getSettingKey('AEO_ENGINES_OFF')));
}

/**
 * aeo.py:227 — plan-profile composition WITHOUT the kill switch filter
 * (profile membership is what the admin edits): AEO_PROFILE_* → default. "-" →
 * empty (profile deliberately disabled). Garbage (not a single valid slug) →
 * default, NOT empty: a typo in the setting shouldn't silently kill runs. An
 * unknown profile → []. Order from the setting/default is preserved.
 */
export async function profileBase(profile: string): Promise<string[]> {
  const key = String(profile ?? '').trim().toLowerCase();
  const def = ownGet(PROFILE_PLATFORMS, key);
  if (def === undefined) return [];
  const raw = (await getSettingKey(PROFILE_ENV[key])).trim();
  if (raw === '-') return [];
  const parsed = parseSlugs(raw);
  return parsed.length ? parsed : [...def];
}

/**
 * aeo.py:242 — profile slugs with admin overrides applied (profileBase) MINUS
 * globally disabled engines (enginesOff). A garbage profile → []. Order from
 * profileBase is preserved. THIS is the money filter: an engine in
 * AEO_ENGINES_OFF will not end up here and will not enter the run.
 */
export async function platformsFor(profile: string): Promise<string[]> {
  const [base, off] = await Promise.all([profileBase(profile), enginesOff()]);
  return base.filter((p) => !off.has(p));
}

/**
 * aeo.py:154 — strip out-of-market engines. lang starting with 'ru' → list is
 * left untouched; otherwise drop RU_MARKET_PLATFORMS (alice/yandex/gigachat).
 * Order preserved, may return []. lang=null/'' → NOT ru → strip (Python's
 * `(lang or "").lower().startswith("ru")`).
 *
 * NOTE for callers: in jobs.py the barrier is applied ONLY when the project's
 * language is known (plang truthy); when unknown (null) the composition is
 * left UNTOUCHED — guessing wrong is worse than running an extra engine. This
 * null branch is the caller's responsibility (see run-job `forLang`), not this
 * function's.
 */
export function platformsForLang(platforms: readonly string[], lang: string | null | undefined): string[] {
  if ((lang || '').toLowerCase().startsWith('ru')) return [...platforms];
  return platforms.filter((p) => !RU_MARKET_PLATFORMS.has(p));
}

/**
 * aeo.py:528 — engines available RIGHT NOW: perplexity/chatgpt/deepseek/grok
 * with EITHER their own vendor key (NATIVE_ENGINES — the engine then runs on the
 * official API) OR OPENROUTER_API_KEY, gigachat with GIGACHAT_API_KEY,
 * alice/yandex with YANDEX_SEARCH_API_KEY; claude/gemini (vendor APIs) and aio
 * always stay (their availability is decided by their own keys at call time).
 * Plus the kill switch (enginesOff). Order preserved. Keys go through
 * getSettingKey (env→app_settings), the equivalent of Python's
 * `<client>.api_key()`.
 */
export async function availablePlatforms(
  platforms: readonly string[] = DEFAULT_PLATFORMS,
): Promise<string[]> {
  const [off, orKey, gigaKey, yandexKey] = await Promise.all([
    enginesOff(),
    getSettingKey('OPENROUTER_API_KEY'),
    getSettingKey('GIGACHAT_API_KEY'),
    getSettingKey('YANDEX_SEARCH_API_KEY'),
  ]);
  const nativeKeys = new Map(
    await Promise.all(
      Object.entries(NATIVE_ENGINES).map(
        async ([slug, spec]) => [slug, !!(await getSettingKey(spec.key))] as const,
      ),
    ),
  );
  return platforms.filter(
    (p) =>
      !off.has(p) &&
      (!Object.prototype.hasOwnProperty.call(OPENROUTER_ENGINES, p) || !!orKey || !!nativeKeys.get(p)) &&
      (p !== 'gigachat' || !!gigaKey) &&
      ((p !== 'alice' && p !== 'yandex') || !!yandexKey),
  );
}

// ── Yandex clamp (aeo.py:1388, 1400) ──────────────────────────────────────────

/**
 * aeo.py:1388 — cap on yandex-profile prompts (clamped to 1..150).
 * AEO_YANDEX_PROMPTS_MAX (env→app_settings) → default (30). Resolved per call.
 */
export async function yandexPromptsMax(defaultN = YANDEX_PROMPTS_MAX): Promise<number> {
  const raw = await getSettingKey('AEO_YANDEX_PROMPTS_MAX');
  if (raw) {
    const n = pyIntStrict(raw);
    if (n !== null) return clamp(n, 1, 150);
  }
  return defaultN;
}

/**
 * aeo.py:1400 — top-n prompts for the run by panel volume. Rank by volume
 * (descending; no volume → tail), but RETURN in the original `prompts` order
 * (the runner cares about the panel's canonical order). n<=0 or
 * len(prompts)<=n → the whole list unchanged. volume is looked up via
 * normPrompt(text) against the panel; the sort is stable (tie-break — original
 * index), like Python's `sorted`. The returned strings are the ORIGINAL ones
 * from `prompts` (normalization is only for the lookup).
 */
export function topVolumePrompts(
  panel: readonly unknown[] | null | undefined,
  prompts: string[],
  n: number,
): string[] {
  if (n <= 0 || prompts.length <= n) return [...prompts];
  const vol = new Map<string, number | null | undefined>();
  for (const p of panel || []) {
    if (isDict(p)) {
      vol.set(normPrompt(String(p.prompt ?? '')), p.volume as number | null | undefined);
    }
  }
  const ranked = prompts
    .map((t, i) => {
      const v = vol.get(normPrompt(t));
      return { t, i, isNone: v === null || v === undefined, num: -((v as number) || 0) };
    })
    .sort((a, b) => {
      // (volume is None, -(volume or 0)) — None goes to the tail, higher volume first.
      if (a.isNone !== b.isNone) return a.isNone ? 1 : -1;
      if (a.num !== b.num) return a.num - b.num;
      return a.i - b.i; // stability: tie-break by original order (like sorted)
    });
  const keep = new Set(ranked.slice(0, n).map((r) => r.t));
  return prompts.filter((t) => keep.has(t));
}
