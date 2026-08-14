/**
 * OpenRouter client for AEO — port of scrapper/core/openrouter.py. The shared route
 * for every engine whose own vendor key is not configured: perplexity (sonar),
 * chatgpt (plain gpt-4o-mini — no OpenAI search variant exists there), deepseek/grok
 * (Exa web plugin). It also serves as the fallback route for the claude/gemini engines.
 *
 * PURE VERIFIABLE CORE — `parseOpenRouter(envelope)` (port of `_parse_sources`
 * openrouter.py:77 + `_usage_tokens` openrouter.py:193): envelope →
 * {text, citations, tokensIn, tokensOut}. TWO citation formats, both accepted and
 * deduped (openrouter.py:93-101):
 *   1) top-level `citations` (Perplexity/Sonar): a bare URL string OR an object {url,title};
 *   2) `message.annotations[].url_citation` (search-preview / :online plugin): {url,title}.
 */
import { isDict } from '../parse';
import {
  citationsFrom,
  intOrNull,
  joinContent,
  type ParsedAnswer,
  type RawSource,
} from './shared';
import { recordUsage, shortError } from '../usage';

export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_TIMEOUT_MS = 120_000;

/** OpenRouter call error; `status` — HTTP/body code. */
export class OpenRouterError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OpenRouterError';
    this.status = status;
  }
}

/** `_usage_tokens` (openrouter.py:193): OpenAI-format usage → (prompt, completion). */
function usageTokens(data: unknown): [number | null, number | null] {
  const u = isDict(data) ? (data as Record<string, unknown>).usage : undefined;
  if (!isDict(u)) return [null, null];
  return [intOrNull(u.prompt_tokens), intOrNull(u.completion_tokens)];
}

/**
 * PURE CORE: OpenRouter envelope → {text, citations, tokensIn, tokensOut}.
 * Both citation formats are collected into a shared raw-source list and deduped
 * (title — from the first non-empty occurrence: the same URL often arrives bare
 * in top-level `citations` and with a title in `annotations`). Port of `_parse_sources`.
 */
export function parseOpenRouter(data: unknown): ParsedAnswer {
  // Python: choice = ((data.get("choices") or [{}])[0]) or {}; msg = choice.get("message") or {}
  const choices = isDict(data) ? (data as Record<string, unknown>).choices : undefined;
  const choice = (Array.isArray(choices) ? choices[0] : undefined) ?? {};
  const msg = (isDict(choice) ? (choice as Record<string, unknown>).message : undefined) ?? {};
  const text = joinContent(isDict(msg) ? (msg as Record<string, unknown>).content : undefined);

  const srcs: RawSource[] = [];
  // Format 1: top-level citations (a URL string or an object).
  const cites = isDict(data) ? (data as Record<string, unknown>).citations : undefined;
  if (Array.isArray(cites)) {
    for (const u of cites) {
      if (typeof u === 'string') srcs.push({ url: u, title: '' });
      else if (isDict(u) && u.url) srcs.push({ url: String(u.url), title: u.title || '' });
    }
  }
  // Format 2: message.annotations[].url_citation.
  const anns = isDict(msg) ? (msg as Record<string, unknown>).annotations : undefined;
  if (Array.isArray(anns)) {
    for (const ann of anns) {
      const uc = (isDict(ann) ? ann.url_citation : undefined) as Record<string, unknown> | undefined;
      if (isDict(uc) && uc.url) srcs.push({ url: String(uc.url), title: uc.title || '' });
    }
  }

  const [tokensIn, tokensOut] = usageTokens(data);
  return { text, citations: citationsFrom(srcs), tokensIn, tokensOut };
}

/** OpenRouter generation id (request_id for usage accounting). */
function genId(data: unknown): string | null {
  const id = isDict(data) ? (data as Record<string, unknown>).id : undefined;
  return typeof id === 'string' && id ? id : null;
}

/**
 * grounded flag for the search-fixed-cost pricing (openrouter.py:140): a plugin,
 * or the `:online` suffix, or `search`/`sonar` in the model name. Separate from
 * the profile mode: the search price is driven by the fact of search execution
 * itself.
 */
export function isGroundedModel(model: string, plugins?: unknown[]): boolean {
  const m = (model || '').toLowerCase();
  return Boolean(plugins && plugins.length) || model.endsWith(':online') || m.includes('search') || m.includes('sonar');
}

export interface OpenRouterChatOpts {
  apiKey: string;
  maxTokens?: number;
  system?: string;
  plugins?: unknown[];
}

/**
 * Transport (port of openrouter.chat, openrouter.py:112): a call → ParsedAnswer +
 * usage accounting. `plugins` — web search in the request body ([{id:'web',engine:'exa',...}]).
 * Throws `OpenRouterError` (with `status`) on network/HTTP/body-error/empty response.
 */
export async function openrouterChat(
  model: string,
  prompt: string,
  { apiKey, maxTokens = 2000, system, plugins }: OpenRouterChatOpts,
): Promise<ParsedAnswer & { model: string }> {
  const body: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ],
    ...(plugins && plugins.length ? { plugins } : {}),
  };
  const grounded = isGroundedModel(model, plugins);
  const started = Date.now();
  const lat = () => Date.now() - started;

  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://ideata.io',
        'X-Title': 'Ideata AEO',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (exc) {
    recordUsage({ provider: 'openrouter', model, status: 'error', error: shortError(exc), latencyMs: lat(), grounded });
    throw new OpenRouterError(`${model}: transport ${String(exc)}`);
  }
  if (!res.ok) {
    recordUsage({ provider: 'openrouter', model, status: 'error', error: String(res.status), latencyMs: lat(), grounded });
    throw new OpenRouterError(`${model}: HTTP ${res.status}`, res.status);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (exc) {
    recordUsage({ provider: 'openrouter', model, status: 'error', error: 'non_json', latencyMs: lat(), grounded });
    throw new OpenRouterError(`${model}: non-JSON response`);
  }
  if (isDict(data) && data.error) {
    const err = data.error;
    const msg = isDict(err) ? String(err.message ?? '') : String(err);
    recordUsage({ provider: 'openrouter', model, status: 'error', error: '529', latencyMs: lat(), grounded });
    throw new OpenRouterError(`${model}: ${msg}`, 529);
  }
  const parsed = parseOpenRouter(data);
  const reqId = genId(data);
  if (!parsed.text) {
    recordUsage({ provider: 'openrouter', model, status: 'error', error: 'empty', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, requestId: reqId, grounded });
    throw new OpenRouterError(`${model}: empty response from model`);
  }
  recordUsage({ provider: 'openrouter', model, status: 'ok', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, requestId: reqId, grounded });
  return { ...parsed, model };
}
