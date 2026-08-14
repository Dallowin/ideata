/**
 * xAI client for AEO — the "grok" engine, OpenAI chat format on api.x.ai. In
 * grounded mode Live Search (`search_parameters`) runs the query for real and
 * the answer comes back with citations; without it the engine returns plain
 * mentions.
 *
 * PURE VERIFIABLE CORE — `parseXai(envelope)`: envelope →
 * {text, citations, tokensIn, tokensOut}. The `xaiChat` transport is network +
 * usage accounting on top of the core; not exercised in tests (needs a live call).
 */
import { isDict, pyStrOrEmpty } from '../parse';
import {
  citationsFrom,
  intOrNull,
  joinContent,
  type ParsedAnswer,
  type RawSource,
} from './shared';
import { recordUsage, shortError } from '../usage';

export const XAI_URL = 'https://api.x.ai/v1/chat/completions';

/** xAI Live Search (grounding); max_search_results keeps the per-source price in check. */
export const SEARCH_PARAMETERS = {
  mode: 'on',
  return_citations: true,
  max_search_results: 3,
} as const;

const DEFAULT_TIMEOUT_MS = 120_000;

/** xAI call error; `status` — HTTP/body code (for the fallback retry logic). */
export class XaiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'XaiError';
    this.status = status;
  }
}

/**
 * Model id → API slug: drop the `:online`/`:free`/`:nitro` suffix and the
 * `x-ai/` prefix (`x-ai/grok-4.3` → `grok-4.3`). Version dots are part of the
 * xAI slug and stay as they are.
 */
export function toXaiModel(model: string): string {
  let m = (model || '').trim();
  for (const suf of [':online', ':free', ':nitro']) {
    if (m.endsWith(suf)) m = m.slice(0, -suf.length);
  }
  if (m.startsWith('x-ai/')) m = m.slice('x-ai/'.length);
  return m;
}

/** OpenAI-format usage → (prompt, completion). */
function usageTokens(data: unknown): [number | null, number | null] {
  const u = isDict(data) ? (data as Record<string, unknown>).usage : undefined;
  if (!isDict(u)) return [null, null];
  return [intOrNull(u.prompt_tokens), intOrNull(u.completion_tokens)];
}

/**
 * PURE CORE: xAI envelope → {text, citations, tokensIn, tokensOut}. Text is
 * choices[0].message.content (a list of parts is joined); the sources come from
 * the top-level `citations` Live Search fills in — a bare URL string OR an
 * object {url,title} — deduped into the canonical `[{url,title}]` shared with
 * the other providers. An empty/malformed envelope → text='' (the transport
 * treats this as an "empty response" error, below).
 */
export function parseXai(data: unknown): ParsedAnswer {
  const choices = isDict(data) ? (data as Record<string, unknown>).choices : undefined;
  const choice = (Array.isArray(choices) ? choices[0] : undefined) ?? {};
  const msg = (isDict(choice) ? (choice as Record<string, unknown>).message : undefined) ?? {};
  const text = joinContent(isDict(msg) ? (msg as Record<string, unknown>).content : undefined);

  const srcs: RawSource[] = [];
  const cites = isDict(data) ? (data as Record<string, unknown>).citations : undefined;
  if (Array.isArray(cites)) {
    for (const c of cites) {
      if (typeof c === 'string') srcs.push({ url: c, title: '' });
      else if (isDict(c) && c.url) srcs.push({ url: String(c.url), title: c.title || '' });
    }
  }

  const [tokensIn, tokensOut] = usageTokens(data);
  return { text, citations: citationsFrom(srcs), tokensIn, tokensOut };
}

/**
 * Error envelope `{error}` — a message string or an object with `message`.
 * Normally paired with the same HTTP status, but a gateway in front can hand it
 * back on HTTP 200, so the body is checked as well.
 */
function bodyError(data: unknown): { status: number; message: string } | null {
  if (!isDict(data)) return null;
  const err = (data as Record<string, unknown>).error;
  if (!err) return null;
  const message = isDict(err) ? pyStrOrEmpty((err as Record<string, unknown>).message) : pyStrOrEmpty(err);
  return { status: 529, message: message || 'xai error' };
}

export interface XaiChatOpts {
  apiKey: string;
  grounded?: boolean;
  maxTokens?: number;
  system?: string;
}

/**
 * Transport: one call → ParsedAnswer + usage accounting. `grounded=true` turns
 * on Live Search (without it `search_parameters` is omitted entirely, so xAI
 * doesn't search on its own). Throws `XaiError` (with `status`) on network/
 * HTTP/body-error/empty response, so the OpenRouter fallback can tell the
 * reason apart.
 */
export async function xaiChat(
  model: string,
  prompt: string,
  { apiKey, grounded = false, maxTokens = 2000, system }: XaiChatOpts,
): Promise<ParsedAnswer & { model: string; grounded: boolean }> {
  const slug = toXaiModel(model);
  const body: Record<string, unknown> = {
    model: slug,
    max_tokens: maxTokens,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ],
    ...(grounded ? { search_parameters: { ...SEARCH_PARAMETERS } } : {}),
  };
  const started = Date.now();
  const lat = () => Date.now() - started;

  let res: Response;
  try {
    res = await fetch(XAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (exc) {
    recordUsage({ provider: 'xai', model: slug, status: 'error', error: shortError(exc), latencyMs: lat(), grounded });
    throw new XaiError(`${slug}: transport ${String(exc)}`);
  }
  if (!res.ok) {
    recordUsage({ provider: 'xai', model: slug, status: 'error', error: String(res.status), latencyMs: lat(), grounded });
    throw new XaiError(`${slug}: HTTP ${res.status}`, res.status);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (exc) {
    recordUsage({ provider: 'xai', model: slug, status: 'error', error: 'non_json', latencyMs: lat(), grounded });
    throw new XaiError(`${slug}: non-JSON response`);
  }

  const parsed = parseXai(data);
  const be = bodyError(data);
  if (be) {
    recordUsage({ provider: 'xai', model: slug, status: 'error', error: String(be.status), latencyMs: lat(), grounded });
    throw new XaiError(`${slug}: ${be.message}`, be.status);
  }
  if (!parsed.text) {
    recordUsage({ provider: 'xai', model: slug, status: 'error', error: 'empty', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, grounded });
    throw new XaiError(`${slug}: empty response from model`);
  }
  recordUsage({ provider: 'xai', model: slug, status: 'ok', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, grounded });
  return { ...parsed, model: slug, grounded };
}
