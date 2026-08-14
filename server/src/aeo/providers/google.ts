/**
 * Google Gemini API client for AEO — the "gemini" engine. In grounded mode the
 * google_search tool runs the query for real: the answer carries
 * groundingMetadata, from which the citations come; without it the engine
 * returns plain mentions.
 *
 * PURE VERIFIABLE CORE — `parseGemini(envelope)`: envelope →
 * {text, citations, tokensIn, tokensOut}. The `geminiChat` transport is network
 * + usage accounting on top of the core; not exercised in tests (needs a live call).
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

export const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

/** Generation endpoint for a model slug. */
export const geminiUrl = (slug: string): string => `${GEMINI_API_BASE}/${slug}:generateContent`;

/** Google search grounding tool (real citations in groundingMetadata). */
export const GOOGLE_SEARCH_TOOL = { google_search: {} } as const;

const DEFAULT_TIMEOUT_MS = 90_000;
const GROUNDED_TIMEOUT_MS = 120_000;

/** Gemini call error; `status` — HTTP/body code (for the fallback retry logic). */
export class GeminiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GeminiError';
    this.status = status;
  }
}

/**
 * Model id → API slug: drop the `:online`/`:free`/`:nitro` suffix and the
 * `google/` prefix (`google/gemini-3.5-flash` → `gemini-3.5-flash`). Version
 * dots are part of the Google slug and stay as they are.
 */
export function toGeminiModel(model: string): string {
  let m = (model || '').trim();
  for (const suf of [':online', ':free', ':nitro']) {
    if (m.endsWith(suf)) m = m.slice(0, -suf.length);
  }
  if (m.startsWith('google/')) m = m.slice('google/'.length);
  return m;
}

/** First candidate of the response (the request always asks for one). */
function firstCandidate(data: unknown): Record<string, unknown> {
  const cands = isDict(data) ? (data as Record<string, unknown>).candidates : undefined;
  const c = Array.isArray(cands) ? cands[0] : undefined;
  return isDict(c) ? c : {};
}

/** usageMetadata: promptTokenCount/candidatesTokenCount. */
function usageTokens(data: unknown): [number | null, number | null] {
  const u = isDict(data) ? (data as Record<string, unknown>).usageMetadata : undefined;
  if (!isDict(u)) return [null, null];
  return [intOrNull(u.promptTokenCount), intOrNull(u.candidatesTokenCount)];
}

/**
 * PURE CORE: Gemini envelope → {text, citations, tokensIn, tokensOut}. Text is
 * the join of the candidate's content parts; the sources come from
 * groundingMetadata.groundingChunks[].web ({uri,title}), deduped by URL into
 * the canonical `[{url,title}]` shared with the other providers. An empty/
 * malformed envelope → text='' (the transport treats this as an "empty
 * response" error, below).
 */
export function parseGemini(data: unknown): ParsedAnswer {
  const cand = firstCandidate(data);
  const content = cand.content;
  const text = joinContent(isDict(content) ? (content as Record<string, unknown>).parts : undefined);

  const srcs: RawSource[] = [];
  const meta = cand.groundingMetadata;
  const chunks = isDict(meta) ? (meta as Record<string, unknown>).groundingChunks : undefined;
  if (Array.isArray(chunks)) {
    for (const ch of chunks) {
      const web = (isDict(ch) ? ch.web : undefined) as Record<string, unknown> | undefined;
      if (isDict(web) && web.uri) srcs.push({ url: web.uri, title: web.title || '' });
    }
  }

  const [tokensIn, tokensOut] = usageTokens(data);
  return { text, citations: citationsFrom(srcs), tokensIn, tokensOut };
}

/** Error envelope `{error:{code,message}}` — normally paired with the same HTTP status. */
function bodyError(data: unknown): { status: number; message: string } | null {
  if (!isDict(data)) return null;
  const err = (data as Record<string, unknown>).error;
  if (!isDict(err)) return null;
  const code = (err as Record<string, unknown>).code;
  return {
    status: typeof code === 'number' ? code : 529,
    message: pyStrOrEmpty((err as Record<string, unknown>).message) || 'gemini error',
  };
}

export interface GeminiChatOpts {
  apiKey: string;
  grounded?: boolean;
  maxTokens?: number;
  system?: string;
}

/**
 * Transport: one call → ParsedAnswer + usage accounting. `grounded=true` turns
 * on the google_search tool. Throws `GeminiError` (with `status`) on network/
 * HTTP/body-error/empty response, so the OpenRouter fallback can tell the
 * reason apart.
 */
export async function geminiChat(
  model: string,
  prompt: string,
  { apiKey, grounded = false, maxTokens = 2000, system }: GeminiChatOpts,
): Promise<ParsedAnswer & { model: string; grounded: boolean }> {
  const slug = toGeminiModel(model);
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: { maxOutputTokens: maxTokens },
    ...(grounded ? { tools: [{ ...GOOGLE_SEARCH_TOOL }] } : {}),
  };
  const started = Date.now();
  const lat = () => Date.now() - started;

  let res: Response;
  try {
    res = await fetch(geminiUrl(slug), {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(grounded ? GROUNDED_TIMEOUT_MS : DEFAULT_TIMEOUT_MS),
    });
  } catch (exc) {
    recordUsage({ provider: 'google', model: slug, status: 'error', error: shortError(exc), latencyMs: lat(), grounded });
    throw new GeminiError(`${slug}: transport ${String(exc)}`);
  }
  if (!res.ok) {
    recordUsage({ provider: 'google', model: slug, status: 'error', error: String(res.status), latencyMs: lat(), grounded });
    throw new GeminiError(`${slug}: HTTP ${res.status}`, res.status);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (exc) {
    recordUsage({ provider: 'google', model: slug, status: 'error', error: 'non_json', latencyMs: lat(), grounded });
    throw new GeminiError(`${slug}: non-JSON response`);
  }

  const parsed = parseGemini(data);
  const be = bodyError(data);
  if (be) {
    recordUsage({ provider: 'google', model: slug, status: 'error', error: String(be.status), latencyMs: lat(), grounded });
    throw new GeminiError(`${slug}: ${be.message}`, be.status);
  }
  if (!parsed.text) {
    recordUsage({ provider: 'google', model: slug, status: 'error', error: 'empty', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, grounded });
    throw new GeminiError(`${slug}: empty response from model`);
  }
  recordUsage({ provider: 'google', model: slug, status: 'ok', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, grounded });
  return { ...parsed, model: slug, grounded };
}
