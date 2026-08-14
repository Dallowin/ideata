/**
 * AEO engine dispatcher — port of scrapper/core/aeo.py::ask_platform (aeo.py:593) and
 * the platform wrappers (aeo.py:313-612): official vendor engines, OpenRouter,
 * GigaChat, Alice/Neuro, AI Overviews.
 *
 * Holds the engine registries (ENGINE_MODELS / OPENROUTER_ENGINES /
 * NATIVE_ENGINES / OPENROUTER_FALLBACK), live model resolution (env →
 * app_settings, resolved on every call so admin edits take effect without a
 * restart), grounded lite/full mode, and the OpenRouter fallback using the same
 * model. Keys are read env → app_settings (like Python, where app_settings is
 * rolled into os.environ). Each engine is failure-isolated: a failure → null +
 * WARNING, the run keeps going.
 *
 * The route is chosen PER ENGINE, not globally: an engine runs on its vendor's
 * official API when that key is configured, and on OpenRouter otherwise — the
 * routes mix freely across engines within one run.
 *
 * `askPlatform(platform, prompt, {locationCode, languageCode, grounded})` →
 * {text, citations} | null. Slug → provider follows EXACTLY the ask_platform:601-612 chain.
 */
import { Logger } from '@nestjs/common';
import { type CiteItem } from '../parse';
import { type EngineAnswer, type ParsedAnswer } from './shared';
import { getSettingKey } from './settings';
import { AnthropicError, anthropicChat } from './anthropic';
import { GeminiError, geminiChat } from './google';
import { openrouterChat } from './openrouter';
import { openaiChat, toOpenAiModel } from './openai';
import { xaiChat, toXaiModel } from './xai';
import { deepseekChat, toDeepseekModel } from './deepseek';
import { perplexityChat, toPerplexityModel } from './perplexity';
import { gigachatChat } from './gigachat';
import { aliceChat, neuroSearch } from './yandex';
import { aiOverviewAnswer } from './dataforseo';
import { platformContext } from '../usage';

const log = new Logger('aeo/providers');

const ANSWER_MAX_TOKENS = 2000; // full engine answer (aeo.py:53)
const GROUNDED_MAX_TOKENS = 2500; // web_search answers run longer (aeo.py:54)

// ── engine registries (aeo.py:63-151) ─────────────────────────────────────────

/** Official-vendor engines: slug → [model env override, default]. aio has its own separate path. */
export const ENGINE_MODELS: Record<string, [string | null, string | null]> = {
  claude: ['AEO_CLAUDE_MODEL', 'claude-haiku-4-5'],
  gemini: ['AEO_GEMINI_MODEL', 'gemini-3.5-flash'],
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

/** OpenRouter route for an official-vendor engine: slug → [env override, default]. */
export const OPENROUTER_FALLBACK: Record<string, [string, string]> = {
  claude: ['AEO_CLAUDE_FALLBACK_MODEL', 'anthropic/claude-haiku-4.5'],
  gemini: ['AEO_GEMINI_FALLBACK_MODEL', 'google/gemini-3.5-flash'],
};

/** Official vendor key per provider kind (env → app_settings). */
const OFFICIAL_KEY: Record<'anthropic' | 'google', string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
};

/** An engine's own vendor API: settings key, transport, model transform, native search. */
export interface NativeEngine {
  key: string;
  chat: (
    model: string,
    prompt: string,
    opts: { apiKey: string; grounded?: boolean; maxTokens?: number },
  ) => Promise<ParsedAnswer>;
  toModel: (model: string) => string;
  /** Does the vendor API search the web in full mode (the DeepSeek API has no search at all). */
  search: boolean;
}

/**
 * OpenRouter-listed engines that ALSO have a vendor API of their own: with the
 * key configured the engine runs on it, without the key on OpenRouter. The model
 * setting is shared between the routes (openrouterModel) — the client strips the
 * OpenRouter-style prefix/suffix itself (toModel).
 */
export const NATIVE_ENGINES: Record<string, NativeEngine> = {
  // sonar searches on EVERY call; the search fee is charged per model family, not per mode.
  perplexity: { key: 'PERPLEXITY_API_KEY', chat: perplexityChat, toModel: toPerplexityModel, search: true },
  chatgpt: { key: 'OPENAI_API_KEY', chat: openaiChat, toModel: toOpenAiModel, search: true },
  // DeepSeek has no web search in the API: full mode is a plain answer, citations [].
  deepseek: { key: 'DEEPSEEK_API_KEY', chat: deepseekChat, toModel: toDeepseekModel, search: false },
  grok: { key: 'XAI_API_KEY', chat: xaiChat, toModel: toXaiModel, search: true },
};

/** Codes that trigger the fallback (aeo.py:134); status=null means a transport error. */
const FALLBACK_STATUSES = new Set([500, 502, 503, 504, 524, 529]);

/** OpenRouter web-plugin config for full-mode deepseek/grok (aeo.py:110). */
export const WEB_PLUGIN = { id: 'web', engine: 'exa', max_results: 3 } as const;

/** Which engines search natively in full mode: Claude (web_search) and Gemini (google_search). */
export const GROUNDED_PLATFORMS = new Set(['claude', 'gemini']);

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
 * Model for an official-vendor engine (port of aeo.py:304): env override →
 * default from ENGINE_MODELS. Resolved on every call (live setting). null — the
 * slug isn't served by a vendor API.
 */
export async function officialModel(platform: string): Promise<string | null> {
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
  | 'anthropic'
  | 'google';

/**
 * Which provider serves a slug — EXACTLY the ask_platform chain (aeo.py:601-612):
 * aio → DataForSEO; OpenRouter engines → OpenRouter; gigachat → Sber; alice/yandex
 * → Yandex; claude → Anthropic; gemini → Google; anything else → OpenRouter.
 */
export function providerFor(platform: string): ProviderKind {
  if (platform === 'aio') return 'aio';
  if (platform in OPENROUTER_ENGINES) return 'openrouter';
  if (platform === 'gigachat') return 'gigachat';
  if (platform === 'alice') return 'yandex-alice';
  if (platform === 'yandex') return 'yandex-neuro';
  if (platform.startsWith('claude')) return 'anthropic';
  if (platform.startsWith('gemini')) return 'google';
  return 'openrouter';
}

/**
 * Whether to fall back to OpenRouter based on the failed call's status (aeo.py:134,351):
 * status=undefined (transport error/timeout) OR the 5xx family → yes;
 * 401/403 (key) and 402 (balance) → no (not the provider's fault, a retry would double-bill).
 */
export function officialFallbackRetryable(status: number | undefined): boolean {
  return status === undefined || FALLBACK_STATUSES.has(status);
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

/**
 * Answer an official-vendor engine's prompt through OpenRouter on the same model
 * (aeo.py:351). Ungrounded: OpenRouter serves these models without a search
 * tool, so this route returns mentions without citations. `retry=true` — the
 * vendor call has already failed (worth an INFO line); otherwise this is the
 * engine's normal route on an install without the vendor key (DEBUG, one line
 * per answer would flood the log).
 */
async function openrouterFallbackAnswer(
  platform: string,
  prompt: string,
  grounded: boolean,
  retry = false,
): Promise<EngineAnswer | null> {
  const spec = OPENROUTER_FALLBACK[platform];
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
    const msg = `${platform}: answer taken from OpenRouter/${model}`;
    if (retry) log.log(msg);
    else log.debug(msg);
    return { text: res.text, citations: res.citations };
  } catch (exc) {
    log.warn(`${platform}: OpenRouter/${model} failed to answer (${String(exc)}) — engine dropped out`);
    return null;
  }
}

/**
 * A vendor-API engine (claude/gemini) with the OpenRouter fallback
 * (aeo.py:313). WITHOUT the vendor key the engine doesn't drop out of the
 * run: it goes to OpenRouter on the fallback model right away (only grounding
 * and vendor-native citations are lost). A failed vendor call retries the same
 * way, but only for transport/5xx — 401/402/403 don't get a second billed try.
 */
async function officialAnswer(platform: string, prompt: string, grounded: boolean): Promise<EngineAnswer | null> {
  const model = await officialModel(platform);
  if (!model) return null;
  const kind = providerFor(platform) === 'google' ? 'google' : 'anthropic';
  const g = grounded && GROUNDED_PLATFORMS.has(platform);
  const maxTokens = g ? GROUNDED_MAX_TOKENS : ANSWER_MAX_TOKENS;
  const key = await getSettingKey(OFFICIAL_KEY[kind]);
  if (!key) return openrouterFallbackAnswer(platform, prompt, g);
  try {
    const res =
      kind === 'google'
        ? await geminiChat(model, prompt, { apiKey: key, grounded: g, maxTokens })
        : await anthropicChat(model, prompt, { apiKey: key, grounded: g, maxTokens });
    return { text: res.text, citations: res.citations };
  } catch (exc) {
    log.warn(`${platform}/${model} failed to answer (${String(exc)}) — check ${OFFICIAL_KEY[kind]} (validity/balance/grounding)`);
    // status=None (transport) OR the 5xx family → retry; 401/402/403 — no.
    const status = exc instanceof AnthropicError || exc instanceof GeminiError ? exc.status : undefined;
    if (!officialFallbackRetryable(status)) return null;
    return openrouterFallbackAnswer(platform, prompt, g, true);
  }
}

/** `_openrouter_answer` (aeo.py:430): perplexity/chatgpt/deepseek/grok — also the vendor-API fallback target. */
async function openrouterAnswer(slug: string, prompt: string, grounded: boolean): Promise<EngineAnswer | null> {
  if (!Object.prototype.hasOwnProperty.call(OPENROUTER_ENGINES, slug)) return null;
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

/**
 * Status of a failed native call for the same fallback gate: every provider
 * client throws an error carrying `status` (HTTP/body code), a transport error
 * leaves it unset.
 */
function nativeStatus(exc: unknown): number | undefined {
  const s = (exc as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

/**
 * An engine on its OWN vendor API (the key is configured). The model comes from
 * the SAME setting as the OpenRouter route; grounding only happens where the
 * vendor actually searches (deepseek doesn't — full mode there is a plain
 * answer). A failed call goes to OpenRouter on the same slug, but only for
 * transport/5xx — 401/402/403 don't get a second billed try.
 */
async function nativeAnswer(
  slug: string,
  prompt: string,
  grounded: boolean,
  apiKey: string,
): Promise<EngineAnswer | null> {
  const spec = NATIVE_ENGINES[slug];
  const model = await openrouterModel(slug, grounded);
  const g = grounded && spec.search;
  try {
    const res = await spec.chat(model, prompt, {
      apiKey,
      grounded: g,
      maxTokens: g ? GROUNDED_MAX_TOKENS : ANSWER_MAX_TOKENS,
    });
    return { text: res.text, citations: res.citations };
  } catch (exc) {
    log.warn(`${slug}/${spec.toModel(model)} failed to answer (${String(exc)}) — check ${spec.key} (validity/balance/grounding)`);
    // status=None (transport) OR the 5xx family → retry through OpenRouter; 401/402/403 — no.
    if (!officialFallbackRetryable(nativeStatus(exc))) return null;
    return openrouterAnswer(slug, prompt, grounded);
  }
}

/**
 * An OpenRouter-listed engine (aeo.py:430 `_openrouter_answer` + the vendor
 * route on top): with the engine's own key configured it runs on the vendor API,
 * without it — on OpenRouter, exactly as before. The choice is per engine, so one
 * run can mix the routes.
 */
async function engineAnswer(slug: string, prompt: string, grounded: boolean): Promise<EngineAnswer | null> {
  const spec = NATIVE_ENGINES[slug];
  const nativeKey = spec ? await getSettingKey(spec.key) : '';
  if (nativeKey) return nativeAnswer(slug, prompt, grounded, nativeKey);
  return openrouterAnswer(slug, prompt, grounded);
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
 * usage accounting records the entry against this slug (usage.py:600). Inside the
 * chain the vendor-API engines (claude/gemini and NATIVE_ENGINES) pick their route
 * by key presence. `grounded` governs the dual-mode slugs
 * (chatgpt/deepseek/grok/claude/gemini); the rest don't depend on the mode.
 * Returns {text, citations} or null (engine unavailable/failed).
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
      case 'gigachat':
        return gigachatAnswer(prompt);
      case 'yandex-alice':
        return aliceAnswer(prompt);
      case 'yandex-neuro':
        return yandexSearchAnswer(prompt);
      case 'anthropic':
      case 'google':
        return officialAnswer(platform, prompt, grounded);
      case 'openrouter':
      default:
        return engineAnswer(platform, prompt, grounded);
    }
  });
}
