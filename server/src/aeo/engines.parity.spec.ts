/**
 * Parity of engines.ts (engine money-safety) with LIVE Python core/aeo.py.
 * Goldens captured from the reference oracle (the Python source,
 * .venv/bin/python) on 2026-08-10: parse_slugs/disabled_platforms/
 * profile_base/platforms_for/platforms_for_lang/top_volume_prompts are pure
 * functions (no DB/network), so the values are frozen as constants rather than
 * captured over SSH in CI.
 *
 * getSettingKey is mocked with a flat mockSettings dict — this is exactly the
 * Python settings model: os.environ, rolled in from app_settings by the worker
 * (env→app_settings in TS = a single layer). We set AEO_* keys before each
 * call. The dispatcher constants (DEFAULT_PLATFORMS/OPENROUTER_ENGINES/
 * NATIVE_ENGINES/RU_MARKET_PLATFORMS) are real (single source, no duplication),
 * so they are not part of the mock.
 */

const mockSettings: Record<string, string> = {};
jest.mock('./providers/settings', () => ({
  getSettingKey: jest.fn(async (name: string): Promise<string> => mockSettings[name] ?? ''),
}));

import {
  enginesOff,
  profileBase,
  platformsFor,
  platformsForLang,
  availablePlatforms,
  yandexPromptsMax,
  topVolumePrompts,
} from './engines';

/** Replace the whole settings set (empty = all keys cleared, like a clean os.environ). */
function setEnv(env: Record<string, string> = {}): void {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  Object.assign(mockSettings, env);
}

beforeEach(() => setEnv({}));

// ── disabled_platforms (aeo.py:222): AEO_ENGINES_OFF → set. Order does NOT
//    matter (Python frozenset), so we compare as sets. ─────────────────────────
describe('enginesOff — parity with disabled_platforms (parse_slugs + kill switch)', () => {
  const CASES: Array<{ in: string; got: string[] }> = [
    { in: '', got: [] },
    { in: 'claude', got: ['claude'] },
    { in: 'claude,grok', got: ['grok', 'claude'] },
    { in: '  Claude , GROK ', got: ['grok', 'claude'] }, // strip + lower
    { in: 'claude,claude,grok', got: ['grok', 'claude'] }, // dedup
    { in: 'claude,bogus,grok', got: ['grok', 'claude'] }, // garbage dropped
    { in: 'bogus', got: [] },
    { in: 'CLAUDE,,grok,', got: ['grok', 'claude'] }, // empty tokens/trailing
  ];
  it.each(CASES)('AEO_ENGINES_OFF=%j', async ({ in: raw, got }) => {
    setEnv({ AEO_ENGINES_OFF: raw });
    const off = await enginesOff();
    expect([...off].sort()).toEqual([...got].sort());
  });
});

// ── profile_base (aeo.py:227): profile composition WITHOUT kill switch, order preserved.
describe('profileBase — parity with profile_base (AEO_PROFILE_*, "-", garbage→default)', () => {
  const CASES: Array<{ profile: string; env: Record<string, string>; got: string[] }> = [
    { profile: 'micro', env: {}, got: ['chatgpt', 'deepseek', 'grok', 'gigachat', 'claude', 'aio'] },
    { profile: 'mid', env: {}, got: ['alice', 'gemini', 'perplexity'] },
    { profile: 'full', env: {}, got: ['chatgpt', 'deepseek', 'grok', 'claude'] },
    { profile: 'yandex', env: {}, got: ['yandex'] },
    { profile: 'bogus', env: {}, got: [] },
    { profile: 'full', env: { AEO_PROFILE_FULL: 'chatgpt,claude' }, got: ['chatgpt', 'claude'] },
    { profile: 'full', env: { AEO_PROFILE_FULL: '-' }, got: [] }, // "-" → empty
    { profile: 'full', env: { AEO_PROFILE_FULL: 'bogus' }, got: ['chatgpt', 'deepseek', 'grok', 'claude'] }, // garbage → default
    { profile: 'micro', env: { AEO_PROFILE_MICRO: '  Claude , GROK , claude ' }, got: ['claude', 'grok'] },
    { profile: 'MICRO', env: {}, got: ['chatgpt', 'deepseek', 'grok', 'gigachat', 'claude', 'aio'] }, // key lowercased
  ];
  it.each(CASES)('profileBase($profile) env=$env', async ({ profile, env, got }) => {
    setEnv(env);
    expect(await profileBase(profile)).toEqual(got);
  });
});

// ── platforms_for (aeo.py:242): profileBase MINUS kill switch, order preserved.
describe('platformsFor — parity with platforms_for (overrides + kill switch)', () => {
  const CASES: Array<{ profile: string; env: Record<string, string>; got: string[] }> = [
    { profile: 'micro', env: {}, got: ['chatgpt', 'deepseek', 'grok', 'gigachat', 'claude', 'aio'] },
    { profile: 'micro', env: { AEO_ENGINES_OFF: 'claude,aio' }, got: ['chatgpt', 'deepseek', 'grok', 'gigachat'] },
    {
      profile: 'full',
      env: { AEO_PROFILE_FULL: 'chatgpt,claude,grok', AEO_ENGINES_OFF: 'grok' },
      got: ['chatgpt', 'claude'],
    },
    { profile: 'full', env: { AEO_PROFILE_FULL: '-' }, got: [] },
    { profile: 'bogus', env: {}, got: [] },
    // the kill switch can EMPTY OUT a profile entirely — the profile's run won't happen.
    { profile: 'micro', env: { AEO_ENGINES_OFF: 'chatgpt,deepseek,grok,gigachat,claude,aio' }, got: [] },
  ];
  it.each(CASES)('platformsFor($profile) env=$env', async ({ profile, env, got }) => {
    setEnv(env);
    expect(await platformsFor(profile)).toEqual(got);
  });
});

// ── platforms_for_lang (aeo.py:154): pure, doesn't read settings. ──────────────
describe('platformsForLang — parity with platforms_for_lang (RU-market barrier)', () => {
  const BASE = ['claude', 'alice', 'yandex', 'gigachat', 'gemini'];
  const CASES: Array<{ lang: string | null; got: string[] }> = [
    { lang: 'ru', got: ['claude', 'alice', 'yandex', 'gigachat', 'gemini'] },
    { lang: 'en', got: ['claude', 'gemini'] },
    { lang: 'RU', got: ['claude', 'alice', 'yandex', 'gigachat', 'gemini'] },
    { lang: 'ru-RU', got: ['claude', 'alice', 'yandex', 'gigachat', 'gemini'] },
    { lang: 'en_US', got: ['claude', 'gemini'] },
    { lang: null, got: ['claude', 'gemini'] }, // null → NOT ru → strip (like Python)
    { lang: '', got: ['claude', 'gemini'] },
  ];
  it.each(CASES)('lang=%j', ({ lang, got }) => {
    expect(platformsForLang(BASE, lang)).toEqual(got);
  });
});

// ── top_volume_prompts (aeo.py:1400): pure. ────────────────────────────────────
describe('topVolumePrompts — parity with top_volume_prompts (Yandex clamp)', () => {
  const PANEL = [
    { prompt: 'a', volume: 10 },
    { prompt: 'b', volume: 50 },
    { prompt: 'c', volume: null },
    { prompt: 'd', volume: 30 },
  ];
  const CASES: Array<{ panel: unknown[]; prompts: string[]; n: number; got: string[] }> = [
    // rank by volume desc.: b(50),d(30),a(10),c(None) → top-2 {b,d} in original order
    { panel: PANEL, prompts: ['a', 'b', 'c', 'd'], n: 2, got: ['b', 'd'] },
    { panel: PANEL, prompts: ['a', 'b', 'c', 'd'], n: 0, got: ['a', 'b', 'c', 'd'] }, // n<=0 → all
    { panel: PANEL, prompts: ['a', 'b'], n: 5, got: ['a', 'b'] }, // len<=n → all
    // 'x' not in the panel → volume None → tail; top-1 = b
    { panel: [{ prompt: 'a', volume: 10 }, { prompt: 'b', volume: 50 }], prompts: ['x', 'b', 'a'], n: 1, got: ['b'] },
    // lookup via normPrompt (lower): 'D'→d(30),'B'→b(50) → top-2 {D,B}, RETURNS original strings
    { panel: PANEL, prompts: ['D', 'B', 'A', 'C'], n: 2, got: ['D', 'B'] },
  ];
  it.each(CASES)('n=$n prompts=$prompts', ({ panel, prompts, n, got }) => {
    expect(topVolumePrompts(panel, prompts, n)).toEqual(got);
  });
});

// ── availablePlatforms (aeo.py:528): key-gating + kill switch. Synthetic cases
//    (depends on which provider keys are present), not an SSH parity check. ────
describe('availablePlatforms — key-gating + kill switch (aeo.py:528)', () => {
  it('all keys present, kill switch empty → the full DEFAULT_PLATFORMS in canonical order', async () => {
    setEnv({ OPENROUTER_API_KEY: 'k', GIGACHAT_API_KEY: 'k', YANDEX_SEARCH_API_KEY: 'k' });
    expect(await availablePlatforms()).toEqual([
      'claude', 'gemini', 'perplexity', 'aio', 'gigachat', 'alice', 'yandex', 'chatgpt', 'deepseek', 'grok',
    ]);
  });
  it('no OPENROUTER_API_KEY → perplexity/chatgpt/deepseek/grok drop out, claude/gemini/aio/sber/yandex survive', async () => {
    setEnv({ GIGACHAT_API_KEY: 'k', YANDEX_SEARCH_API_KEY: 'k' });
    expect(await availablePlatforms()).toEqual(['claude', 'gemini', 'aio', 'gigachat', 'alice', 'yandex']);
  });
  it('no OPENROUTER_API_KEY, but the engine has its OWN vendor key → it stays (native route)', async () => {
    setEnv({ OPENAI_API_KEY: 'k', XAI_API_KEY: 'k' });
    const out = await availablePlatforms();
    expect(out).toContain('chatgpt');
    expect(out).toContain('grok');
    expect(out).not.toContain('deepseek'); // no DEEPSEEK_API_KEY and no OpenRouter — no route
    expect(out).not.toContain('perplexity');
  });
  it('the kill switch strips an engine even with its vendor key set', async () => {
    setEnv({ OPENAI_API_KEY: 'k', AEO_ENGINES_OFF: 'chatgpt' });
    expect(await availablePlatforms()).not.toContain('chatgpt');
  });
  it('no YANDEX_SEARCH_API_KEY → alice and yandex drop out', async () => {
    setEnv({ OPENROUTER_API_KEY: 'k', GIGACHAT_API_KEY: 'k' });
    const out = await availablePlatforms();
    expect(out).not.toContain('alice');
    expect(out).not.toContain('yandex');
    expect(out).toContain('gigachat');
  });
  it('kill switch on top of keys: AEO_ENGINES_OFF strips even an engine with a key', async () => {
    setEnv({
      OPENROUTER_API_KEY: 'k',
      GIGACHAT_API_KEY: 'k',
      YANDEX_SEARCH_API_KEY: 'k',
      AEO_ENGINES_OFF: 'claude,perplexity',
    });
    const out = await availablePlatforms();
    expect(out).not.toContain('claude');
    expect(out).not.toContain('perplexity');
    expect(out).toContain('gemini');
  });
  it('a subset on input — filters only that subset, order preserved', async () => {
    setEnv({ GIGACHAT_API_KEY: 'k' }); // OPENROUTER and YANDEX are empty
    expect(await availablePlatforms(['gigachat', 'chatgpt', 'alice', 'claude'])).toEqual(['gigachat', 'claude']);
  });
});

// ── yandex_prompts_max (aeo.py:1388): clamped to 1..150. ───────────────────────
describe('yandexPromptsMax — clamp 1..150 (aeo.py:1388)', () => {
  it('not set → default 30', async () => {
    setEnv({});
    expect(await yandexPromptsMax()).toBe(30);
  });
  it('valid number', async () => {
    setEnv({ AEO_YANDEX_PROMPTS_MAX: '50' });
    expect(await yandexPromptsMax()).toBe(50);
  });
  it('below 1 → clamp to 1', async () => {
    setEnv({ AEO_YANDEX_PROMPTS_MAX: '0' });
    expect(await yandexPromptsMax()).toBe(1);
  });
  it('above 150 → clamp to 150', async () => {
    setEnv({ AEO_YANDEX_PROMPTS_MAX: '999' });
    expect(await yandexPromptsMax()).toBe(150);
  });
  it('garbage → default (ValueError)', async () => {
    setEnv({ AEO_YANDEX_PROMPTS_MAX: 'abc' });
    expect(await yandexPromptsMax()).toBe(30);
  });
  it('whitespace is trimmed (Python int)', async () => {
    setEnv({ AEO_YANDEX_PROMPTS_MAX: ' 20 ' });
    expect(await yandexPromptsMax()).toBe(20);
  });
});
