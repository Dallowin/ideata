/**
 * Perplexity API client for AEO — the "perplexity" engine on the vendor's own
 * key. The API is OpenAI-chat-shaped; sonar searches the web on EVERY call, so
 * the answer always comes back with sources — there is no ungrounded mode to
 * switch off.
 *
 * PURE VERIFIABLE CORE — `parsePerplexity(envelope)`: envelope →
 * {text, citations, tokensIn, tokensOut}. TWO source formats, both accepted and
 * deduped: the top-level `citations` (bare URL strings) and `search_results[]`
 * ({title,url}) — the same URL comes back in both, so the title is taken from
 * the first non-empty occurrence.
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

export const PERPLEXITY_URL = 'https://api.perplexity.ai/chat/completions';

const DEFAULT_TIMEOUT_MS = 120_000;

/** Perplexity call error; `status` — HTTP/body code (for the fallback retry logic). */
export class PerplexityError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'PerplexityError';
    this.status = status;
  }
}

/**
 * Model id → API slug: drop the `:online`/`:free`/`:nitro` suffix and the
 * `perplexity/` prefix (`perplexity/sonar` → `sonar`). Version dots aren't used
 * in Perplexity slugs, so nothing else is rewritten; an API slug passes through
 * unchanged.
 */
export function toPerplexityModel(model: string): string {
  let m = (model || '').trim();
  for (const suf of [':online', ':free', ':nitro']) {
    if (m.endsWith(suf)) m = m.slice(0, -suf.length);
  }
  if (m.startsWith('perplexity/')) m = m.slice('perplexity/'.length);
  return m;
}

/** OpenAI-format usage → (prompt, completion). */
function usageTokens(data: unknown): [number | null, number | null] {
  const u = isDict(data) ? (data as Record<string, unknown>).usage : undefined;
  if (!isDict(u)) return [null, null];
  return [intOrNull(u.prompt_tokens), intOrNull(u.completion_tokens)];
}

/**
 * PURE CORE: chat-completions envelope → {text, citations, tokensIn, tokensOut}.
 * Both source formats are collected into a shared raw list and deduped by URL
 * (`citations` usually carries bare URLs, `search_results` the same URLs with a
 * title). An empty/malformed envelope → text='' (the transport treats this as
 * an "empty response" error, below).
 */
export function parsePerplexity(data: unknown): ParsedAnswer {
  const choices = isDict(data) ? (data as Record<string, unknown>).choices : undefined;
  const choice = (Array.isArray(choices) ? choices[0] : undefined) ?? {};
  const msg = (isDict(choice) ? (choice as Record<string, unknown>).message : undefined) ?? {};
  const text = joinContent(isDict(msg) ? (msg as Record<string, unknown>).content : undefined);

  const srcs: RawSource[] = [];
  // Format 1: top-level citations — a URL string (or an object, if it ever arrives that way).
  const cites = isDict(data) ? (data as Record<string, unknown>).citations : undefined;
  if (Array.isArray(cites)) {
    for (const u of cites) {
      if (typeof u === 'string') srcs.push({ url: u, title: '' });
      else if (isDict(u) && u.url) srcs.push({ url: String(u.url), title: u.title || '' });
    }
  }
  // Format 2: search_results — the same sources with titles.
  const results = isDict(data) ? (data as Record<string, unknown>).search_results : undefined;
  if (Array.isArray(results)) {
    for (const r of results) {
      if (isDict(r) && r.url) srcs.push({ url: String(r.url), title: r.title || '' });
    }
  }

  const [tokensIn, tokensOut] = usageTokens(data);
  return { text, citations: citationsFrom(srcs), tokensIn, tokensOut };
}

/**
 * Error envelope `{error:{message,code}}` — normally paired with the same HTTP
 * status, but a gateway in front can hand it back on HTTP 200, so the body is
 * checked as well. A non-numeric `code` (the API sends string codes) → 529,
 * i.e. "worth a retry elsewhere".
 */
function bodyError(data: unknown): { status: number; message: string } | null {
  if (!isDict(data)) return null;
  const err = (data as Record<string, unknown>).error;
  if (!isDict(err)) return null;
  const code = (err as Record<string, unknown>).code;
  return {
    status: typeof code === 'number' ? code : 529,
    message: pyStrOrEmpty((err as Record<string, unknown>).message) || 'perplexity error',
  };
}

export interface PerplexityChatOpts {
  apiKey: string;
  /**
   * Accepted for signature parity with the other native clients; sonar searches
   * on every call, so the mode changes neither the request nor the answer.
   */
  grounded?: boolean;
  maxTokens?: number;
  system?: string;
}

/**
 * Transport: one call → ParsedAnswer + usage accounting. Usage is recorded with
 * grounded=true in every mode — the flag marks a search that actually ran (the
 * same rule as `isGroundedModel`, which counts sonar as grounded), and sonar
 * always searches, so the search fee is always due. Throws `PerplexityError`
 * (with `status`) on network/HTTP/body-error/empty response, so the OpenRouter
 * fallback can tell the reason apart.
 */
export async function perplexityChat(
  model: string,
  prompt: string,
  { apiKey, maxTokens = 2000, system }: PerplexityChatOpts,
): Promise<ParsedAnswer & { model: string }> {
  const slug = toPerplexityModel(model);
  const body: Record<string, unknown> = {
    model: slug,
    max_tokens: maxTokens,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ],
  };
  const started = Date.now();
  const lat = () => Date.now() - started;

  let res: Response;
  try {
    res = await fetch(PERPLEXITY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (exc) {
    recordUsage({ provider: 'perplexity', model: slug, status: 'error', error: shortError(exc), latencyMs: lat(), grounded: true });
    throw new PerplexityError(`${slug}: transport ${String(exc)}`);
  }
  if (!res.ok) {
    recordUsage({ provider: 'perplexity', model: slug, status: 'error', error: String(res.status), latencyMs: lat(), grounded: true });
    throw new PerplexityError(`${slug}: HTTP ${res.status}`, res.status);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (exc) {
    recordUsage({ provider: 'perplexity', model: slug, status: 'error', error: 'non_json', latencyMs: lat(), grounded: true });
    throw new PerplexityError(`${slug}: non-JSON response`);
  }

  const parsed = parsePerplexity(data);
  const be = bodyError(data);
  if (be) {
    recordUsage({ provider: 'perplexity', model: slug, status: 'error', error: String(be.status), latencyMs: lat(), grounded: true });
    throw new PerplexityError(`${slug}: ${be.message}`, be.status);
  }
  if (!parsed.text) {
    recordUsage({ provider: 'perplexity', model: slug, status: 'error', error: 'empty', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, grounded: true });
    throw new PerplexityError(`${slug}: empty response from model`);
  }
  recordUsage({ provider: 'perplexity', model: slug, status: 'ok', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, grounded: true });
  return { ...parsed, model: slug };
}
