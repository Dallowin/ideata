/**
 * DeepSeek API client for AEO — the "deepseek" engine on the vendor's own key.
 * The API is OpenAI-chat-shaped and has NO web search of its own: full mode
 * returns a plain answer and citations are always empty (search for this engine
 * exists only on the OpenRouter route, through the Exa plugin).
 *
 * PURE VERIFIABLE CORE — `parseDeepseek(envelope)`: envelope →
 * {text, citations, tokensIn, tokensOut}. The `deepseekChat` transport is
 * network + usage accounting on top of the core; not exercised in tests (needs
 * a live call).
 */
import { isDict, pyStrOrEmpty } from '../parse';
import { intOrNull, joinContent, type ParsedAnswer } from './shared';
import { recordUsage, shortError } from '../usage';

export const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

const DEFAULT_TIMEOUT_MS = 120_000;

/** DeepSeek call error; `status` — HTTP/body code (for the fallback retry logic). */
export class DeepseekError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'DeepseekError';
    this.status = status;
  }
}

/**
 * Model id → API slug: drop the `:online`/`:free`/`:nitro` suffix and the
 * `deepseek/` prefix, then fold the OpenRouter family names onto the two slugs
 * the vendor API actually serves: `deepseek-v*` → `deepseek-chat` (the
 * non-thinking family), a reasoning name (`r1`/`reasoner`) →
 * `deepseek-reasoner`. An API slug passes through unchanged.
 */
export function toDeepseekModel(model: string): string {
  let m = (model || '').trim();
  for (const suf of [':online', ':free', ':nitro']) {
    if (m.endsWith(suf)) m = m.slice(0, -suf.length);
  }
  if (m.startsWith('deepseek/')) m = m.slice('deepseek/'.length);
  if (/^deepseek-v/i.test(m)) return 'deepseek-chat';
  if (/reasoner|r1/i.test(m)) return 'deepseek-reasoner';
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
 * `citations` are ALWAYS empty — the engine returns mentions without sources on
 * this route. An empty/malformed envelope → text='' (the transport treats this
 * as an "empty response" error, below).
 */
export function parseDeepseek(data: unknown): ParsedAnswer {
  const choices = isDict(data) ? (data as Record<string, unknown>).choices : undefined;
  const choice = (Array.isArray(choices) ? choices[0] : undefined) ?? {};
  const msg = (isDict(choice) ? (choice as Record<string, unknown>).message : undefined) ?? {};
  const text = joinContent(isDict(msg) ? (msg as Record<string, unknown>).content : undefined);
  const [tokensIn, tokensOut] = usageTokens(data);
  return { text, citations: [], tokensIn, tokensOut };
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
    message: pyStrOrEmpty((err as Record<string, unknown>).message) || 'deepseek error',
  };
}

export interface DeepseekChatOpts {
  apiKey: string;
  /**
   * Accepted for signature parity with the other native clients; the vendor API
   * has no search tool, so the mode changes neither the request nor the answer.
   */
  grounded?: boolean;
  maxTokens?: number;
  system?: string;
}

/**
 * Transport: one call → ParsedAnswer + usage accounting. Usage is recorded with
 * grounded=false in every mode — the flag marks a search that actually ran (the
 * same rule as `isGroundedModel`), and none ever runs here, so no search fee is
 * due. Throws `DeepseekError` (with `status`) on network/HTTP/body-error/empty
 * response, so the OpenRouter fallback can tell the reason apart.
 */
export async function deepseekChat(
  model: string,
  prompt: string,
  { apiKey, maxTokens = 2000, system }: DeepseekChatOpts,
): Promise<ParsedAnswer & { model: string }> {
  const slug = toDeepseekModel(model);
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
    res = await fetch(DEEPSEEK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (exc) {
    recordUsage({ provider: 'deepseek', model: slug, status: 'error', error: shortError(exc), latencyMs: lat(), grounded: false });
    throw new DeepseekError(`${slug}: transport ${String(exc)}`);
  }
  if (!res.ok) {
    recordUsage({ provider: 'deepseek', model: slug, status: 'error', error: String(res.status), latencyMs: lat(), grounded: false });
    throw new DeepseekError(`${slug}: HTTP ${res.status}`, res.status);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (exc) {
    recordUsage({ provider: 'deepseek', model: slug, status: 'error', error: 'non_json', latencyMs: lat(), grounded: false });
    throw new DeepseekError(`${slug}: non-JSON response`);
  }

  const parsed = parseDeepseek(data);
  const be = bodyError(data);
  if (be) {
    recordUsage({ provider: 'deepseek', model: slug, status: 'error', error: String(be.status), latencyMs: lat(), grounded: false });
    throw new DeepseekError(`${slug}: ${be.message}`, be.status);
  }
  if (!parsed.text) {
    recordUsage({ provider: 'deepseek', model: slug, status: 'error', error: 'empty', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, grounded: false });
    throw new DeepseekError(`${slug}: empty response from model`);
  }
  recordUsage({ provider: 'deepseek', model: slug, status: 'ok', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut, grounded: false });
  return { ...parsed, model: slug };
}
