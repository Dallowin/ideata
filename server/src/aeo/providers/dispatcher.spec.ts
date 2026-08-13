/**
 * Dispatcher: slug → provider routing EXACTLY like ask_platform (aeo.py:601-612),
 * live model resolution (env override → default), grounded lite/full mode + web plugin,
 * kie→OpenRouter fallback gate by status. We don't burn live calls — we test pure
 * decisions. Model resolvers are async (env → app_settings; no DB in tests → env/default).
 */
import {
  DEFAULT_PLATFORMS,
  ENGINE_MODELS,
  OPENROUTER_ENGINES,
  KIE_FALLBACK,
  RU_MARKET_PLATFORMS,
  providerFor,
  kieModel,
  openrouterModel,
  kieFallbackRetryable,
  webPluginsFor,
  WEB_PLUGIN,
} from './dispatcher';

describe('providerFor — ask_platform chain (aeo.py:601-612)', () => {
  const expected: Record<string, string> = {
    aio: 'aio',
    perplexity: 'openrouter',
    chatgpt: 'openrouter',
    deepseek: 'openrouter',
    grok: 'openrouter',
    gigachat: 'gigachat',
    alice: 'yandex-alice',
    yandex: 'yandex-neuro',
    claude: 'kie',
    gemini: 'kie',
  };
  it.each(Object.entries(expected))('%s → %s', (slug, kind) => {
    expect(providerFor(slug)).toBe(kind);
  });
  it('all DEFAULT_PLATFORMS route correctly', () => {
    for (const p of DEFAULT_PLATFORMS) expect(providerFor(p)).toBe(expected[p]);
  });
  it('unknown slug → kie (default branch)', () => {
    expect(providerFor('llama')).toBe('kie');
    expect(providerFor('')).toBe('kie');
  });
});

describe('kieModel — live resolution (aeo.py:304)', () => {
  const KEYS = ['AEO_CLAUDE_MODEL', 'AEO_GEMINI_MODEL'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('claude/gemini → default from ENGINE_MODELS', async () => {
    expect(await kieModel('claude')).toBe('claude-haiku-4-5');
    expect(await kieModel('gemini')).toBe('gemini-3-5-flash-openai');
  });
  it('env override beats the default', async () => {
    process.env.AEO_CLAUDE_MODEL = 'claude-sonnet-5';
    expect(await kieModel('claude')).toBe('claude-sonnet-5');
  });
  it('aio → null (not a kie model), unknown slug → null', async () => {
    expect(await kieModel('aio')).toBeNull();
    expect(await kieModel('perplexity')).toBeNull();
  });
});

describe('openrouterModel — grounded lite/full (aeo.py:421)', () => {
  const KEYS = ['AEO_CHATGPT_MODEL', 'AEO_CHATGPT_MODEL_LITE', 'AEO_PERPLEXITY_MODEL'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('chatgpt: lite=plain, full=gpt-4o-mini (search-preview is 404 on OpenRouter)', async () => {
    expect(await openrouterModel('chatgpt', false)).toBe('openai/gpt-4o-mini');
    // gpt-4o-mini-search-preview doesn't exist on OpenRouter (404) — default full = plain gpt-4o-mini.
    expect(await openrouterModel('chatgpt', true)).toBe('openai/gpt-4o-mini');
  });
  it('perplexity: single-mode (sonar in both modes)', async () => {
    expect(await openrouterModel('perplexity', false)).toBe('perplexity/sonar');
    expect(await openrouterModel('perplexity', true)).toBe('perplexity/sonar');
  });
  it('env override beats full', async () => {
    process.env.AEO_CHATGPT_MODEL = 'openai/gpt-5-search';
    expect(await openrouterModel('chatgpt', true)).toBe('openai/gpt-5-search');
  });
});

describe('webPluginsFor — Exa web plugin only in full mode for deepseek/grok (aeo.py:452)', () => {
  it('deepseek/grok grounded, not :online → Exa plugin', () => {
    expect(webPluginsFor('deepseek', true, 'deepseek/deepseek-v3.2')).toEqual([{ ...WEB_PLUGIN }]);
    expect(webPluginsFor('grok', true, 'x-ai/grok-4.3')).toEqual([{ ...WEB_PLUGIN }]);
  });
  it('lite mode → no plugin', () => {
    expect(webPluginsFor('deepseek', false, 'deepseek/deepseek-v3.2')).toBeUndefined();
  });
  it(':online in the model → plugin NOT duplicated', () => {
    expect(webPluginsFor('deepseek', true, 'deepseek/deepseek-v3.2:online')).toBeUndefined();
  });
  it('perplexity/chatgpt (native search, no web_plugin) → no plugin', () => {
    expect(webPluginsFor('perplexity', true, 'perplexity/sonar')).toBeUndefined();
    expect(webPluginsFor('chatgpt', true, 'openai/gpt-4o-mini')).toBeUndefined();
  });
});

describe('kieFallbackRetryable — fallback gate (aeo.py:134)', () => {
  it('transport (undefined) and the 5xx family → fallback', () => {
    for (const s of [undefined, 500, 502, 503, 504, 524, 529]) {
      expect(kieFallbackRetryable(s)).toBe(true);
    }
  });
  it('401/403 (key) and 402 (balance) and 200 → no fallback', () => {
    for (const s of [400, 401, 402, 403, 404, 200]) {
      expect(kieFallbackRetryable(s)).toBe(false);
    }
  });
});

describe('engine registries (aeo.py:63-151)', () => {
  it('web_plugin only on deepseek/grok', () => {
    expect(OPENROUTER_ENGINES.deepseek.web_plugin).toBe(true);
    expect(OPENROUTER_ENGINES.grok.web_plugin).toBe(true);
    expect(OPENROUTER_ENGINES.perplexity.web_plugin).toBeUndefined();
    expect(OPENROUTER_ENGINES.chatgpt.web_plugin).toBeUndefined();
  });
  it('KIE_FALLBACK on the same model via OpenRouter — claude/gemini', () => {
    expect(KIE_FALLBACK.claude[1]).toBe('anthropic/claude-haiku-4.5');
    expect(KIE_FALLBACK.gemini[1]).toBe('google/gemini-3.5-flash');
  });
  it('aio in ENGINE_MODELS with no model (special path)', () => {
    expect(ENGINE_MODELS.aio).toEqual([null, null]);
  });
  it('RU-market engines', () => {
    expect([...RU_MARKET_PLATFORMS].sort()).toEqual(['alice', 'gigachat', 'yandex']);
  });
});
