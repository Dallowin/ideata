/**
 * OpenAI Responses API client for AEO — the "chatgpt" engine. In grounded mode
 * the web_search tool runs the query for real, so the answer comes back with
 * citations (the OpenRouter route has no OpenAI search at all); without it the
 * engine returns plain mentions.
 *
 * PURE VERIFIABLE CORE — `parseOpenAi(envelope)`: envelope →
 * {text, citations, tokensIn, tokensOut}. The `openaiChat` transport is network
 * + usage accounting on top of the core; not exercised in tests (needs a live call).
 */
import { isDict, pyStrOrEmpty, pyStrip } from '../parse';
import {
  citationsFrom,
  intOrNull,
  joinContent,
  type ParsedAnswer,
  type RawSource,
} from './shared';
import { recordUsage, shortError } from '../usage';

export const OPENAI_URL = 'https://api.openai.com/v1/responses';

/** OpenAI web-search tool (grounding): real url_citation annotations in the answer. */
export const WEB_SEARCH_TOOL = { type: 'web_search' } as const;

const DEFAULT_TIMEOUT_MS = 120_000;

/** OpenAI call error; `status` — HTTP/body code (for the fallback retry logic). */
export class OpenAiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'OpenAiError';
    this.status = status;
  }
}

/**
 * Model id → API slug: drop the `:online`/`:free`/`:nitro` suffix and the
 * `openai/` prefix (`openai/gpt-4o-mini` → `gpt-4o-mini`). Version dots are part
 * of the OpenAI slug and stay as they are.
 */
export function toOpenAiModel(model: string): string {
  let m = (model || '').trim();
  for (const suf of [':online', ':free', ':nitro']) {
    if (m.endsWith(suf)) m = m.slice(0, -suf.length);
  }
  if (m.startsWith('openai/')) m = m.slice('openai/'.length);
  return m;
}

/**
 * Walk the Responses `output[]`: items of type 'message' → content[] parts of
 * type 'output_text' → their `.text`, and the url_citation annotations hanging
 * off those parts. Reasoning/tool-call items (web_search_call) carry no answer
 * text and are skipped.
 */
function parseOutput(data: unknown): { text: string; srcs: RawSource[] } {
  const output = isDict(data) ? (data as Record<string, unknown>).output : undefined;
  if (!Array.isArray(output)) return { text: '', srcs: [] };
  const texts: string[] = [];
  const srcs: RawSource[] = [];
  for (const item of output) {
    if (!isDict(item) || item.type !== 'message') continue;
    const parts = (item as Record<string, unknown>).content;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!isDict(part) || part.type !== 'output_text') continue;
      if (part.text) texts.push(String(part.text));
      const anns = (part as Record<string, unknown>).annotations;
      if (!Array.isArray(anns)) continue;
      for (const a of anns) {
        if (!isDict(a) || a.type !== 'url_citation' || !a.url) continue;
        srcs.push({ url: a.url, title: a.title || '' });
      }
    }
  }
  return { text: pyStrip(texts.join(' ')), srcs };
}

/** Responses usage block: input_tokens/output_tokens. */
function usageTokens(data: unknown): [number | null, number | null] {
  const u = isDict(data) ? (data as Record<string, unknown>).usage : undefined;
  if (!isDict(u)) return [null, null];
  return [intOrNull(u.input_tokens), intOrNull(u.output_tokens)];
}

/**
 * PURE CORE: Responses envelope → {text, citations, tokensIn, tokensOut}. Text
 * comes from the output[] walk; when that yields nothing, the convenience
 * top-level `output_text` string is accepted instead (SDK-style envelopes carry
 * it alongside output[]). Citations — canonical `[{url,title}]` via dedup. An
 * empty/malformed envelope → text='' (the transport treats this as an "empty
 * response" error, below).
 */
export function parseOpenAi(data: unknown): ParsedAnswer {
  const { text, srcs } = parseOutput(data);
  const flat = isDict(data) ? (data as Record<string, unknown>).output_text : undefined;
  const [tokensIn, tokensOut] = usageTokens(data);
  return {
    text: text || joinContent(flat),
    citations: citationsFrom(srcs),
    tokensIn,
    tokensOut,
  };
}

/**
 * Error envelope `{error:{message}}` — normally paired with the same HTTP
 * status, but a gateway in front can hand it back on HTTP 200, so the body is
 * checked as well. The API's `code` is a string ('invalid_api_key'), so the
 * status is the generic retryable one.
 */
function bodyError(data: unknown): { status: number; message: string } | null {
  if (!isDict(data)) return null;
  const err = (data as Record<string, unknown>).error;
  if (!isDict(err)) return null;
  return { status: 529, message: pyStrOrEmpty((err as Record<string, unknown>).message) || 'openai error' };
}

export interface OpenAiChatOpts {
  apiKey: string;
  grounded?: boolean;
  maxTokens?: number;
  system?: string;
}

/**
 * Transport: one call → ParsedAnswer + usage accounting. `grounded=true` turns
 * on the web_search tool. Throws `OpenAiError` (with `status`) on network/HTTP/
 * body-error/empty response, so the OpenRouter fallback can tell the reason apart.
 */
export async function openaiChat(
  model: string,
  prompt: string,
  { apiKey, grounded = false, maxTokens = 2000, system }: OpenAiChatOpts,
): Promise<ParsedAnswer & { model: string; grounded: boolean }> {
  const slug = toOpenAiModel(model);
  const body: Record<string, unknown> = {
    model: slug,
    input: prompt,
    max_output_tokens: maxTokens,
    ...(system ? { instructions: system } : {}),
    ...(grounded ? { tools: [{ ...WEB_SEARCH_TOOL }] } : {}),
  };
  const started = Date.now();
  const lat = () => Date.now() - started;

  let res: Response;
  try {
    res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (exc) {
    recordUsage({ provider: 'openai', model: slug, status: 'error', error: shortError(exc), latencyMs: lat(), grounded });
    throw new OpenAiError(`${slug}: transport ${String(exc)}`);
  }
  if (!res.ok) {
    recordUsage({ provider: 'openai', model: slug, status: 'error', error: String(res.status), latencyMs: lat(), grounded });
    throw new OpenAiError(`${slug}: HTTP ${res.status}`, res.status);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (exc) {
    recordUsage({ provider: 'openai', model: slug, status: 'error', error: 'non_json', latencyMs: lat(), grounded });
    throw new OpenAiError(`${slug}: non-JSON response`);
  }

  const parsed = parseOpenAi(data);
  const be = bodyError(data);
  if (be) {
    recordUsage({ provider: 'openai', model: slug, status: 'error', error: String(be.status), latencyMs: lat(), grounded });
    throw new OpenAiError(`${slug}: ${be.message}`, be.status);
  }
  if (!parsed.text) {
    recordUsage({ provider: 'openai', model: slug, status: 'error', error: 'empty', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, grounded });
    throw new OpenAiError(`${slug}: empty response from model`);
  }
  recordUsage({ provider: 'openai', model: slug, status: 'ok', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, grounded });
  return { ...parsed, model: slug, grounded };
}
