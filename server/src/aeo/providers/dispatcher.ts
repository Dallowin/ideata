/**
 * AEO engine dispatcher — port of scrapper/core/aeo.py::ask_platform (aeo.py:593) and
 * the platform wrappers `_kie_answer`/`_openrouter_answer`/`_gigachat_answer`/
 * `_alice_answer`/`_yandex_search_answer`/`_ai_overview_answer` (aeo.py:313-612).
 *
 * Holds the engine registries (ENGINE_MODELS / OPENROUTER_ENGINES / KIE_FALLBACK),
 * live model resolution (env → app_settings, resolved on every call so admin edits
 * take effect without a restart), grounded lite/full mode, and the kie→OpenRouter
 * fallback using the same model. Keys are read env → app_settings (like Python,
 * where app_settings is rolled into os.environ). Each engine is failure-isolated:
 * a failure → null + WARNING, the run keeps going.
 *
 * `askPlatform(platform, prompt, {locationCode, languageCode, grounded})` →
 * {text, citations} | null. Slug → provider follows EXACTLY the ask_platform:601-612 chain.
 */
import { Logger } from '@nestjs/common';
import { type CiteItem } from '../parse';
import { type EngineAnswer } from './shared';
import { getSettingKey } from './settings';
import { KieError, kieChat } from './kie';
import { openrouterChat } from './openrouter';
import { gigachatChat } from './gigachat';
import { aliceChat, neuroSearch } from './yandex';
import { aiOverviewAnswer } from './dataforseo';
import { platformContext } from '../usage';

const log = new Logger('aeo/providers');

const ANSWER_MAX_TOKENS = 2000; // full engine answer (aeo.py:53)
const GROUNDED_MAX_TOKENS = 2500; // web_search answers run longer (aeo.py:54)

// ── engine registries (aeo.py:63-151) ─────────────────────────────────────────

/** kie engines: slug → [model env override, default]. aio has its own separate path. */
export const ENGINE_MODELS: Record<string, [string | null, string | null]> = {
  claude: ['AEO_CLAUDE_MODEL', 'claude-haiku-4-5'],
  gemini: ['AEO_GEMINI_MODEL', 'gemini-3-5-flash-openai'],
  aio: [null, null],
};

/** OpenRouter engines: slug → {lite:[env,def], full:[env,def], web_plugin?}. */
export const OPENROUTER_ENGINES: Record<
  string,
  { lite: [string, string]; full: [string, string]; web_plugin?: boolean }
> = {
  perplexity: {
    lite: ['AEO_PERPLEXITY_MODEL', 'perplexity/sonar'],
    full: ['AEO_PERPLEXITY_MODEL', 'perplexity/sonar'],
  },
  chatgpt: {
    lite: ['AEO_CHATGPT_MODEL_LITE', 'openai/gpt-4o-mini'],
    // gpt-4o-mini-search-preview does NOT exist on OpenRouter (HTTP 404) — there's
    // no search variant of OpenAI models there at all. Default = plain gpt-4o-mini
    // (valid, price matches the gpt-mini family in cost.ts). Grounding chatgpt
    // (web search) when needed goes through the Exa web plugin, same as
    // deepseek/grok. Live override — app_settings.AEO_CHATGPT_MODEL.
    full: ['AEO_CHATGPT_MODEL', 'openai/gpt-4o-mini'],
  },
  deepseek: {
    lite: ['AEO_DEEPSEEK_MODEL_LITE', 'deepseek/deepseek-v3.2'],
    full: ['AEO_DEEPSEEK_MODEL', 'deepseek/deepseek-v3.2'],
    web_plugin: true,
  },
  grok: {
    lite: ['AEO_GROK_MODEL_LITE', 'x-ai/grok-4.3'],
    full: ['AEO_GROK_MODEL', 'x-ai/grok-4.3'],
    web_plugin: true,
  },
};

/** kie → OpenRouter fallback using the same model: slug → [env override, default]. */
export const KIE_FALLBACK: Record<string, [string, string]> = {
  claude: ['AEO_CLAUDE_FALLBACK_MODEL', 'anthropic/claude-haiku-4.5'],
  gemini: ['AEO_GEMINI_FALLBACK_MODEL', 'google/gemini-3.5-flash'],
};

/** Codes that trigger the fallback (aeo.py:134); status=null means a transport error. */
const KIE_FALLBACK_STATUSES = new Set([500, 502, 503, 504, 524, 529]);

/** OpenRouter web-plugin config for full-mode deepseek/grok (aeo.py:110). */
export const WEB_PLUGIN = { id: 'web', engine: 'exa', max_results: 3 } as const;

/** Which kie engines have web_search (full mode) — only Claude (aeo.py:111). */
export const GROUNDED_PLATFORMS = new Set(['claude']);

/** All engines in canonical order (aeo.py:142). */
export const DEFAULT_PLATFORMS = [
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
] as const;

/** RU-market engines (aeo.py:151) — filtered out by the caller on non-Russian projects. */
export const RU_MARKET_PLATFORMS = new Set(['alice', 'yandex', 'gigachat']);

// ── model resolution (env → app_settings, live) ───────────────────────────────

/**
 * Model for a kie engine (port of `_kie_model`, aeo.py:304): env override → default
 * from ENGINE_MODELS. Resolved on every call (live setting). null — not a kie engine.
 */
export async function kieModel(platform: string): Promise<string | null> {
  const spec = ENGINE_MODELS[platform];
  if (!spec) return null;
  const [env, def] = spec;
  if (!def) return null;
  const override = env ? await getSettingKey(env) : '';
  return (override || def).trim();
}

/**
 * Model for an OpenRouter engine in the given mode (port of `_openrouter_model`, aeo.py:421):
 * env override (full/lite) → default. Resolved on every call.
 */
export async function openrouterModel(slug: string, grounded: boolean): Promise<string> {
  const [env, def] = OPENROUTER_ENGINES[slug][grounded ? 'full' : 'lite'];
  return ((await getSettingKey(env)) || def).trim();
}

// ── slug → provider routing (port of ask_platform:601-612) ────────────────────

export type ProviderKind =
  | 'aio'
  | 'openrouter'
  | 'gigachat'
  | 'yandex-alice'
  | 'yandex-neuro'
  | 'kie';

/**
 * Which provider serves a slug — EXACTLY the ask_platform chain (aeo.py:601-612):
 * aio → DataForSEO; OpenRouter engines → OpenRouter; gigachat → Sber; alice/yandex
 * → Yandex; everything else (claude/gemini/unknown) → kie (the default branch).
 */
export function providerFor(platform: string): ProviderKind {
  if (platform === 'aio') return 'aio';
  if (platform in OPENROUTER_ENGINES) return 'openrouter';
  if (platform === 'gigachat') return 'gigachat';
  if (platform === 'alice') return 'yandex-alice';
  if (platform === 'yandex') return 'yandex-neuro';
  return 'kie';
}

/**
 * Whether to fall back kie→OpenRouter based on the failed call's status (aeo.py:134,351):
 * status=undefined (transport error/timeout) OR the 5xx family → yes;
 * 401/403 (key) and 402 (balance) → no (not the provider's fault, a retry would double-bill).
 */
export function kieFallbackRetryable(status: number | undefined): boolean {
  return status === undefined || KIE_FALLBACK_STATUSES.has(status);
}

/**
 * Web-plugin config for an OpenRouter engine (aeo.py:452-455): only in full mode
 * (grounded) for engines with web_plugin (deepseek/grok), and only if the model
 * doesn't already carry the `:online` suffix (which turns on web with its own
 * defaults — we don't duplicate it). Otherwise undefined (perplexity/chatgpt search
 * natively, they don't need the plugin).
 */
export function webPluginsFor(slug: string, grounded: boolean, model: string): unknown[] | undefined {
  if (grounded && OPENROUTER_ENGINES[slug]?.web_plugin && !model.endsWith(':online')) {
    return [{ ...WEB_PLUGIN }];
  }
  return undefined;
}

// ── platform wrappers (failure-isolated → null) ────────────────────────────────

/** Retry a failed kie call with the same model through OpenRouter (port of `_kie_fallback_answer`). */
async function kieFallbackAnswer(
  platform: string,
  prompt: string,
  err: unknown,
  grounded: boolean,
): Promise<EngineAnswer | null> {
  // status=None (transport) OR the 5xx family → retry; 401/402/403 — no.
  const status = err instanceof KieError ? err.status : undefined;
  if (!kieFallbackRetryable(status)) return null;
  const spec = KIE_FALLBACK[platform];
  if (!spec) return null;
  const [env, def] = spec;
  const model = ((await getSettingKey(env)) || def).trim();
  const key = await getSettingKey('OPENROUTER_API_KEY');
  if (!model || !key) return null;
  try {
    const res = await openrouterChat(model, prompt, {
      apiKey: key,
      maxTokens: grounded ? GROUNDED_MAX_TOKENS : ANSWER_MAX_TOKENS,
    });
    log.log(`${platform}: kie failed, answer taken from OpenRouter/${model}`);
    return { text: res.text, citations: res.citations };
  } catch (exc) {
    log.warn(`${platform}: fallback to OpenRouter/${model} also failed to answer (${String(exc)}) — engine dropped out`);
    return null;
  }
}

/** `_kie_answer` (aeo.py:313): kie engine (claude/gemini) with fallback. */
async function kieAnswer(platform: string, prompt: string, grounded: boolean): Promise<EngineAnswer | null> {
  const key = await getSettingKey('KIE_API_KEY');
  const model = await kieModel(platform);
  if (!key || !model) return null;
  const g = grounded && GROUNDED_PLATFORMS.has(platform);
  try {
    const res = await kieChat(model, prompt, {
      apiKey: key,
      grounded: g,
      maxTokens: g ? GROUNDED_MAX_TOKENS : ANSWER_MAX_TOKENS,
    });
    return { text: res.text, citations: res.citations };
  } catch (exc) {
    log.warn(`${platform}/${model} failed to answer (${String(exc)}) — check KIE_API_KEY (validity/balance/web_search)`);
    return kieFallbackAnswer(platform, prompt, exc, g);
  }
}

/** `_openrouter_answer` (aeo.py:430): perplexity/chatgpt/deepseek/grok. */
async function openrouterAnswer(slug: string, prompt: string, grounded: boolean): Promise<EngineAnswer | null> {
  const key = await getSettingKey('OPENROUTER_API_KEY');
  if (!key) return null;
  const model = await openrouterModel(slug, grounded);
  const plugins = webPluginsFor(slug, grounded, model);
  try {
    const res = await openrouterChat(model, prompt, {
      apiKey: key,
      plugins,
      maxTokens: grounded ? GROUNDED_MAX_TOKENS : ANSWER_MAX_TOKENS,
    });
    return { text: res.text, citations: res.citations };
  } catch (exc) {
    log.warn(`${slug}/${model} failed to answer (${String(exc)}) — check OPENROUTER_API_KEY (HTTP 402 = out of credits) and model/web-search availability`);
    return null;
  }
}

/** `_gigachat_answer` (aeo.py:469): GigaChat (Sber), mentions without citations. */
async function gigachatAnswer(prompt: string): Promise<EngineAnswer | null> {
  const key = await getSettingKey('GIGACHAT_API_KEY');
  if (!key) return null;
  try {
    const res = await gigachatChat(prompt, { authKey: key, maxTokens: ANSWER_MAX_TOKENS });
    return { text: res.text, citations: [] as CiteItem[] };
  } catch (exc) {
    log.warn(`gigachat failed to answer (${String(exc)}) — check GIGACHAT_API_KEY (validity/scope/balance) and TLS (GIGACHAT_CA_BUNDLE)`);
    return null;
  }
}

/** `_alice_answer` (aeo.py:488): "Alice" (Yandex FM), mentions without citations. */
async function aliceAnswer(prompt: string): Promise<EngineAnswer | null> {
  const key = await getSettingKey('YANDEX_SEARCH_API_KEY');
  if (!key) return null;
  const folderId = await getSettingKey('YANDEX_CLOUD_FOLDER_ID');
  const res = await aliceChat(prompt, { apiKey: key, folderId, maxTokens: ANSWER_MAX_TOKENS });
  if (!res) return null;
  return { text: res.text, citations: res.citations };
}

/** `_yandex_search_answer` (aeo.py:508): "Yandex Search" (Neuro), real citations. */
async function yandexSearchAnswer(prompt: string): Promise<EngineAnswer | null> {
  const key = await getSettingKey('YANDEX_SEARCH_API_KEY');
  if (!key) return null;
  const folderId = await getSettingKey('YANDEX_CLOUD_FOLDER_ID');
  const res = await neuroSearch(prompt, { apiKey: key, folderId });
  if (!res) return null;
  return { text: res.text, citations: res.citations };
}

export interface AskPlatformOpts {
  locationCode?: number;
  languageCode?: string;
  /** dual-mode slug mode: lite=plain model, full=search-backed execution */
  grounded?: boolean;
}

/**
 * A single engine call (port of `ask_platform`, aeo.py:593). Slug → provider follows
 * strictly the ask_platform:601-612 chain. Wraps the call in platformContext(slug) so
 * usage accounting records the entry against this slug (usage.py:600). `grounded`
 * governs the dual-mode slugs (chatgpt/deepseek/grok/claude); the rest don't depend
 * on the mode. Returns {text, citations} or null (engine unavailable/failed).
 */
export function askPlatform(
  platform: string,
  prompt: string,
  opts: AskPlatformOpts = {},
): Promise<EngineAnswer | null> {
  const { locationCode = 2840, languageCode = 'en', grounded = true } = opts;
  return platformContext(platform, () => {
    switch (providerFor(platform)) {
      case 'aio':
        return aiOverviewAnswer(prompt, { locationCode, languageCode });
      case 'openrouter':
        return openrouterAnswer(platform, prompt, grounded);
      case 'gigachat':
        return gigachatAnswer(prompt);
      case 'yandex-alice':
        return aliceAnswer(prompt);
      case 'yandex-neuro':
        return yandexSearchAnswer(prompt);
      case 'kie':
      default:
        return kieAnswer(platform, prompt, grounded);
    }
  });
}
