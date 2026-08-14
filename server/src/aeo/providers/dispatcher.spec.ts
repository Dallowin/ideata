/**
 * Dispatcher: slug → provider routing EXACTLY like ask_platform (aeo.py:601-612),
 * live model resolution (env override → default), grounded lite/full mode + web plugin,
 * OpenRouter fallback gate by status. We don't burn live calls — we test pure
 * decisions. Model resolvers are async (env → app_settings; no DB in tests → env/default).
 *
 * The per-engine route (vendor API with the engine's key, OpenRouter without it)
 * is checked on askPlatform with the provider clients mocked: which client got
 * the call, with which model/mode, and who picks up a failure.
 */

// Provider clients: no network. toModel stays real-ish (it only shapes the log line).
jest.mock('./openai', () => ({ openaiChat: jest.fn(), toOpenAiModel: (m: string) => m.replace(/^openai\//, '') }));
jest.mock('./xai', () => ({ xaiChat: jest.fn(), toXaiModel: (m: string) => m.replace(/^x-ai\//, '') }));
jest.mock('./deepseek', () => ({ deepseekChat: jest.fn(), toDeepseekModel: (m: string) => m.replace(/^deepseek\//, '') }));
jest.mock('./perplexity', () => ({ perplexityChat: jest.fn(), toPerplexityModel: (m: string) => m.replace(/^perplexity\//, '') }));
jest.mock('./openrouter', () => ({ openrouterChat: jest.fn() }));

// Settings: the app_settings layer as a flat dict, env stays the second layer
// (the model describes below set process.env) — exactly getSettingKey's order.
const mockSettings: Record<string, string> = {};
jest.mock('./settings', () => ({
  getSettingKey: jest.fn(
    async (name: string): Promise<string> => mockSettings[name] ?? (process.env[name] || '').trim(),
  ),
}));

import {
  DEFAULT_PLATFORMS,
  ENGINE_MODELS,
  NATIVE_ENGINES,
  OPENROUTER_ENGINES,
  OPENROUTER_FALLBACK,
  GROUNDED_PLATFORMS,
  RU_MARKET_PLATFORMS,
  askPlatform,
  providerFor,
  officialModel,
  openrouterModel,
  officialFallbackRetryable,
  webPluginsFor,
  WEB_PLUGIN,
} from './dispatcher';
import { openaiChat } from './openai';
import { xaiChat } from './xai';
import { deepseekChat } from './deepseek';
import { perplexityChat } from './perplexity';
import { openrouterChat } from './openrouter';

const mockOpenai = openaiChat as unknown as jest.Mock;
const mockXai = xaiChat as unknown as jest.Mock;
const mockDeepseek = deepseekChat as unknown as jest.Mock;
const mockPerplexity = perplexityChat as unknown as jest.Mock;
const mockOpenrouter = openrouterChat as unknown as jest.Mock;

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
    claude: 'anthropic',
    gemini: 'google',
  };
  it.each(Object.entries(expected))('%s → %s', (slug, kind) => {
    expect(providerFor(slug)).toBe(kind);
  });
  it('all DEFAULT_PLATFORMS route correctly', () => {
    for (const p of DEFAULT_PLATFORMS) expect(providerFor(p)).toBe(expected[p]);
  });
  it('a claude-/gemini-ish slug keeps its vendor', () => {
    expect(providerFor('claude-next')).toBe('anthropic');
    expect(providerFor('gemini-next')).toBe('google');
  });
  it('unknown slug → openrouter (default branch)', () => {
    expect(providerFor('llama')).toBe('openrouter');
    expect(providerFor('')).toBe('openrouter');
  });
});

describe('officialModel — live resolution (aeo.py:304)', () => {
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

  it('claude/gemini → default from ENGINE_MODELS (vendor API slugs)', async () => {
    expect(await officialModel('claude')).toBe('claude-haiku-4-5');
    expect(await officialModel('gemini')).toBe('gemini-3.5-flash');
  });
  it('env override beats the default', async () => {
    process.env.AEO_CLAUDE_MODEL = 'claude-sonnet-5';
    expect(await officialModel('claude')).toBe('claude-sonnet-5');
  });
  it('aio → null (special path), unknown slug → null', async () => {
    expect(await officialModel('aio')).toBeNull();
    expect(await officialModel('perplexity')).toBeNull();
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

describe('officialFallbackRetryable — fallback gate (aeo.py:134)', () => {
  it('transport (undefined) and the 5xx family → fallback', () => {
    for (const s of [undefined, 500, 502, 503, 504, 524, 529]) {
      expect(officialFallbackRetryable(s)).toBe(true);
    }
  });
  it('401/403 (key) and 402 (balance) and 200 → no fallback', () => {
    for (const s of [400, 401, 402, 403, 404, 200]) {
      expect(officialFallbackRetryable(s)).toBe(false);
    }
  });
});

describe('askPlatform — per-engine route (vendor API with the key, OpenRouter without it)', () => {
  /** app_settings for one case: the whole engine key layer is explicitly empty. */
  function setKeys(keys: Record<string, string> = {}): void {
    for (const k of Object.keys(mockSettings)) delete mockSettings[k];
    for (const k of [
      'OPENROUTER_API_KEY',
      ...Object.values(NATIVE_ENGINES).map((n) => n.key),
      ...Object.values(OPENROUTER_ENGINES).flatMap((e) => [e.lite[0], e.full[0]]),
    ]) {
      mockSettings[k] = '';
    }
    Object.assign(mockSettings, keys);
  }

  /** A client's answer (only text/citations reach the caller). */
  const answer = (text: string) => ({
    text,
    citations: [{ url: 'https://a.io', title: 'A' }],
    tokensIn: 10,
    tokensOut: 20,
  });

  /** A failure the way a provider client throws it: an Error carrying `status`. */
  const fail = (status?: number) => Object.assign(new Error(`HTTP ${status ?? 'transport'}`), { status });

  beforeEach(() => {
    setKeys();
    for (const m of [mockOpenai, mockXai, mockDeepseek, mockPerplexity, mockOpenrouter]) m.mockReset();
  });

  it('chatgpt with OPENAI_API_KEY → the OpenAI API, grounded, OpenRouter untouched', async () => {
    setKeys({ OPENAI_API_KEY: 'sk', OPENROUTER_API_KEY: 'or' });
    mockOpenai.mockResolvedValue(answer('native'));
    await expect(askPlatform('chatgpt', 'q', { grounded: true })).resolves.toEqual({
      text: 'native',
      citations: [{ url: 'https://a.io', title: 'A' }],
    });
    expect(mockOpenai).toHaveBeenCalledWith('openai/gpt-4o-mini', 'q', { apiKey: 'sk', grounded: true, maxTokens: 2500 });
    expect(mockOpenrouter).not.toHaveBeenCalled();
  });

  it('grok and perplexity go to their own keys; lite mode = plain budget', async () => {
    setKeys({ XAI_API_KEY: 'x', PERPLEXITY_API_KEY: 'p' });
    mockXai.mockResolvedValue(answer('grok'));
    mockPerplexity.mockResolvedValue(answer('sonar'));
    await expect(askPlatform('grok', 'q', { grounded: true })).resolves.toMatchObject({ text: 'grok' });
    await expect(askPlatform('perplexity', 'q', { grounded: false })).resolves.toMatchObject({ text: 'sonar' });
    expect(mockXai).toHaveBeenCalledWith('x-ai/grok-4.3', 'q', { apiKey: 'x', grounded: true, maxTokens: 2500 });
    expect(mockPerplexity).toHaveBeenCalledWith('perplexity/sonar', 'q', { apiKey: 'p', grounded: false, maxTokens: 2000 });
  });

  it('deepseek native: full mode WITHOUT grounding (the vendor API has no web search)', async () => {
    setKeys({ DEEPSEEK_API_KEY: 'ds' });
    mockDeepseek.mockResolvedValue(answer('ds'));
    await expect(askPlatform('deepseek', 'q', { grounded: true })).resolves.toMatchObject({ text: 'ds' });
    expect(mockDeepseek).toHaveBeenCalledWith('deepseek/deepseek-v3.2', 'q', { apiKey: 'ds', grounded: false, maxTokens: 2000 });
  });

  it('a 5xx from the vendor API → one retry through OpenRouter on the same slug', async () => {
    setKeys({ XAI_API_KEY: 'x', OPENROUTER_API_KEY: 'or' });
    mockXai.mockRejectedValue(fail(503));
    mockOpenrouter.mockResolvedValue(answer('from openrouter'));
    await expect(askPlatform('grok', 'q', { grounded: true })).resolves.toMatchObject({ text: 'from openrouter' });
    expect(mockOpenrouter).toHaveBeenCalledWith('x-ai/grok-4.3', 'q', {
      apiKey: 'or',
      plugins: [{ ...WEB_PLUGIN }],
      maxTokens: 2500,
    });
  });

  it('a transport error (no status) → the same retry', async () => {
    setKeys({ OPENAI_API_KEY: 'sk', OPENROUTER_API_KEY: 'or' });
    mockOpenai.mockRejectedValue(fail());
    mockOpenrouter.mockResolvedValue(answer('or'));
    await expect(askPlatform('chatgpt', 'q', { grounded: true })).resolves.toMatchObject({ text: 'or' });
    expect(mockOpenrouter).toHaveBeenCalledTimes(1);
  });

  it('401/402/403 → no second billed try, the engine drops out', async () => {
    for (const status of [401, 402, 403]) {
      setKeys({ OPENAI_API_KEY: 'sk', OPENROUTER_API_KEY: 'or' });
      mockOpenai.mockRejectedValue(fail(status));
      await expect(askPlatform('chatgpt', 'q', { grounded: true })).resolves.toBeNull();
      expect(mockOpenrouter).not.toHaveBeenCalled();
    }
  });

  it('a retryable failure without OPENROUTER_API_KEY → null (nothing to retry through)', async () => {
    setKeys({ DEEPSEEK_API_KEY: 'ds' });
    mockDeepseek.mockRejectedValue(fail(500));
    await expect(askPlatform('deepseek', 'q', { grounded: true })).resolves.toBeNull();
    expect(mockOpenrouter).not.toHaveBeenCalled();
  });

  it('no vendor key → the OpenRouter route unchanged (same model, Exa plugin)', async () => {
    setKeys({ OPENROUTER_API_KEY: 'or' });
    mockOpenrouter.mockResolvedValue(answer('or'));
    await expect(askPlatform('deepseek', 'q', { grounded: true })).resolves.toMatchObject({ text: 'or' });
    expect(mockOpenrouter).toHaveBeenCalledWith('deepseek/deepseek-v3.2', 'q', {
      apiKey: 'or',
      plugins: [{ ...WEB_PLUGIN }],
      maxTokens: 2500,
    });
    expect(mockDeepseek).not.toHaveBeenCalled();
  });

  it('no keys at all → the engine drops out without a single call', async () => {
    await expect(askPlatform('chatgpt', 'q', { grounded: true })).resolves.toBeNull();
    expect(mockOpenai).not.toHaveBeenCalled();
    expect(mockOpenrouter).not.toHaveBeenCalled();
  });

  it('the routes mix inside one run: chatgpt native, deepseek through OpenRouter', async () => {
    setKeys({ OPENAI_API_KEY: 'sk', OPENROUTER_API_KEY: 'or' });
    mockOpenai.mockResolvedValue(answer('native'));
    mockOpenrouter.mockResolvedValue(answer('or'));
    await expect(askPlatform('chatgpt', 'q')).resolves.toMatchObject({ text: 'native' });
    await expect(askPlatform('deepseek', 'q')).resolves.toMatchObject({ text: 'or' });
  });
});

describe('engine registries (aeo.py:63-151)', () => {
  it('web_plugin only on deepseek/grok', () => {
    expect(OPENROUTER_ENGINES.deepseek.web_plugin).toBe(true);
    expect(OPENROUTER_ENGINES.grok.web_plugin).toBe(true);
    expect(OPENROUTER_ENGINES.perplexity.web_plugin).toBeUndefined();
    expect(OPENROUTER_ENGINES.chatgpt.web_plugin).toBeUndefined();
  });
  it('OPENROUTER_FALLBACK on the same model — claude/gemini', () => {
    expect(OPENROUTER_FALLBACK.claude[1]).toBe('anthropic/claude-haiku-4.5');
    expect(OPENROUTER_FALLBACK.gemini[1]).toBe('google/gemini-3.5-flash');
  });
  it('the fallback covers every engine served by a vendor API', () => {
    for (const slug of Object.keys(ENGINE_MODELS)) {
      if (ENGINE_MODELS[slug][1]) expect(OPENROUTER_FALLBACK[slug]).toBeDefined();
    }
  });
  it('NATIVE_ENGINES: a vendor key per engine, and only deepseek without native search', () => {
    expect(Object.keys(NATIVE_ENGINES).sort()).toEqual(['chatgpt', 'deepseek', 'grok', 'perplexity']);
    expect(NATIVE_ENGINES.chatgpt.key).toBe('OPENAI_API_KEY');
    expect(NATIVE_ENGINES.grok.key).toBe('XAI_API_KEY');
    expect(NATIVE_ENGINES.deepseek.key).toBe('DEEPSEEK_API_KEY');
    expect(NATIVE_ENGINES.perplexity.key).toBe('PERPLEXITY_API_KEY');
    expect(Object.keys(NATIVE_ENGINES).filter((s) => !NATIVE_ENGINES[s].search)).toEqual(['deepseek']);
  });
  it('every native engine keeps its OpenRouter route (the fallback target)', () => {
    for (const slug of Object.keys(NATIVE_ENGINES)) expect(OPENROUTER_ENGINES[slug]).toBeDefined();
  });
  it('aio in ENGINE_MODELS with no model (special path)', () => {
    expect(ENGINE_MODELS.aio).toEqual([null, null]);
  });
  it('grounded engines: claude (web_search) and gemini (google_search)', () => {
    expect([...GROUNDED_PLATFORMS].sort()).toEqual(['claude', 'gemini']);
  });
  it('RU-market engines', () => {
    expect([...RU_MARKET_PLATFORMS].sort()).toEqual(['alice', 'gigachat', 'yandex']);
  });
});
