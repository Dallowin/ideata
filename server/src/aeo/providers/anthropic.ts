/**
 * Anthropic Messages API client for AEO — the "claude" engine. In grounded mode
 * the web_search tool runs the query for real, so the answer comes back with
 * citations; without it the engine returns plain mentions.
 *
 * PURE VERIFIABLE CORE — `parseAnthropic(envelope)`: envelope →
 * {text, citations, tokensIn, tokensOut}. The `anthropicChat` transport is
 * network + usage accounting on top of the core; not exercised in tests (needs
 * a live call).
 */
import { isDict, pyStrOrEmpty, pyStrip } from '../parse';
import {
  citationsFrom,
  intOrNull,
  type ParsedAnswer,
  type RawSource,
} from './shared';
import { recordUsage, shortError } from '../usage';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

/** Messages API version pinned in the request header. */
export const ANTHROPIC_VERSION = '2023-06-01';

/** Anthropic web-search tool (grounding); max_uses keeps the price in check. */
export const WEB_SEARCH_TOOL = {
  type: 'web_search_20250305',
  name: 'web_search',
  max_uses: 4,
} as const;

const DEFAULT_TIMEOUT_MS = 90_000;
const GROUNDED_TIMEOUT_MS = 120_000;

/** OpenRouter-style vendor prefixes the Messages API doesn't understand. */
const VENDOR_PREFIXES = [
  'anthropic/',
  'openai/',
  'google/',
  'x-ai/',
  'qwen/',
  'deepseek/',
  'perplexity/',
  'mistralai/',
  'meta-llama/',
];

/** Anthropic call error; `status` — HTTP/body code (for the fallback retry logic). */
export class AnthropicError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'AnthropicError';
    this.status = status;
  }
}

/**
 * Model id → API slug: drop the `:online`/`:free`/`:nitro` suffix and the
 * vendor prefix, version dots → dashes (`anthropic/claude-haiku-4.5` →
 * `claude-haiku-4-5`). An API slug passes through unchanged.
 */
export function toAnthropicModel(model: string): string {
  let m = (model || '').trim();
  for (const suf of [':online', ':free', ':nitro']) {
    if (m.endsWith(suf)) m = m.slice(0, -suf.length);
  }
  for (const p of VENDOR_PREFIXES) {
    if (m.startsWith(p)) {
      m = m.slice(p.length);
      break;
    }
  }
  return m.replace(/\./g, '-');
}

/** Anthropic envelope → (text, raw sources). */
function parseEnvelope(data: unknown): { text: string; srcs: RawSource[] } {
  const blocks = isDict(data) ? (data as Record<string, unknown>).content : undefined;
  if (!Array.isArray(blocks)) return { text: '', srcs: [] };
  const texts: string[] = [];
  const srcs: RawSource[] = [];
  for (const b of blocks) {
    if (!isDict(b)) continue;
    const t = b.type;
    if (t === 'text' && b.text) {
      texts.push(String(b.text));
    } else if (t === 'web_search_tool_result' || t === 'tool_result') {
      const inner = b.content;
      if (Array.isArray(inner)) {
        for (const item of inner) {
          if (isDict(item) && item.url) {
            srcs.push({ url: item.url, title: item.title || '' });
          }
        }
      }
    }
    // Citations inside text blocks (Anthropic citations API) — for EVERY block.
    const cs = (b as Record<string, unknown>).citations;
    if (Array.isArray(cs)) {
      for (const c of cs) {
        if (!isDict(c) || !c.url) continue;
        srcs.push({ url: c.url, title: c.title || c.document_title || '' });
      }
    }
  }
  return { text: pyStrip(texts.join(' ')), srcs };
}

/** Anthropic usage block: input_tokens/output_tokens. */
function usageTokens(data: unknown): [number | null, number | null] {
  const u = isDict(data) ? (data as Record<string, unknown>).usage : undefined;
  if (!isDict(u)) return [null, null];
  return [intOrNull(u.input_tokens), intOrNull(u.output_tokens)];
}

/**
 * PURE CORE: Anthropic envelope → {text, citations, tokensIn, tokensOut}.
 * Citations — canonical `[{url,title}]` via dedup + `citeItems`. An empty/
 * malformed envelope → text='' (the transport treats this as an "empty
 * response" error, below).
 */
export function parseAnthropic(data: unknown): ParsedAnswer {
  const { text, srcs } = parseEnvelope(data);
  const [tokensIn, tokensOut] = usageTokens(data);
  return { text, citations: citationsFrom(srcs), tokensIn, tokensOut };
}

/**
 * Error envelope `{type:'error', error:{message}}`. The API pairs it with the
 * matching HTTP status, but a gateway in front can hand it back on HTTP 200 —
 * so the body is checked as well.
 */
function bodyError(data: unknown): { status: number; message: string } | null {
  if (!isDict(data)) return null;
  if (data.type === 'error') {
    const err = (isDict(data.error) ? data.error : {}) as Record<string, unknown>;
    return { status: 529, message: pyStrOrEmpty(err.message) || 'anthropic error' };
  }
  return null;
}

export interface AnthropicChatOpts {
  apiKey: string;
  grounded?: boolean;
  maxTokens?: number;
  system?: string;
}

/**
 * Transport: one call → ParsedAnswer + usage accounting. `grounded=true` turns
 * on the web_search tool. Throws `AnthropicError` (with `status`) on network/
 * HTTP/body-error/empty response, so the OpenRouter fallback can tell the
 * reason apart.
 */
export async function anthropicChat(
  model: string,
  prompt: string,
  { apiKey, grounded = false, maxTokens = 2000, system }: AnthropicChatOpts,
): Promise<ParsedAnswer & { model: string; grounded: boolean }> {
  const slug = toAnthropicModel(model);
  const body: Record<string, unknown> = {
    model: slug,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }],
    ...(system ? { system } : {}),
    ...(grounded ? { tools: [WEB_SEARCH_TOOL] } : {}),
  };
  const started = Date.now();
  const lat = () => Date.now() - started;

  let res: Response;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(grounded ? GROUNDED_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
    });
  } catch (exc) {
    recordUsage({ provider: 'anthropic', model: slug, status: 'error', error: shortError(exc), latencyMs: lat(), grounded });
    throw new AnthropicError(`${slug}: transport ${String(exc)}`);
  }
  if (!res.ok) {
    recordUsage({ provider: 'anthropic', model: slug, status: 'error', error: String(res.status), latencyMs: lat(), grounded });
    throw new AnthropicError(`${slug}: HTTP ${res.status}`, res.status);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (exc) {
    recordUsage({ provider: 'anthropic', model: slug, status: 'error', error: 'non_json', latencyMs: lat(), grounded });
    throw new AnthropicError(`${slug}: non-JSON response`);
  }

  const parsed = parseAnthropic(data);
  const be = bodyError(data);
  if (be) {
    recordUsage({ provider: 'anthropic', model: slug, status: 'error', error: String(be.status), latencyMs: lat(), grounded });
    throw new AnthropicError(`${slug}: ${be.message}`, be.status);
  }
  if (!parsed.text) {
    recordUsage({ provider: 'anthropic', model: slug, status: 'error', error: 'empty', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, grounded });
    throw new AnthropicError(`${slug}: empty response from model`);
  }
  recordUsage({ provider: 'anthropic', model: slug, status: 'ok', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, grounded });
  return { ...parsed, model: slug, grounded };
}
