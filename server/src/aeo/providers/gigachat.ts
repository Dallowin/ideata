/**
 * GigaChat (Sber) client for AEO — port of scrapper/core/gigachat.py. A key
 * AI assistant for the RU market; no native web search/citations in the API →
 * mentions without citations (like gemini). Access is two-step: OAuth (authorization
 * key → access_token, TTL ~30 min, cached in-process) → chat (OpenAI-compatible
 * /chat/completions).
 *
 * PURE VERIFIABLE CORE — `parseGigachat(envelope)` (port of `_extract_text`
 * gigachat.py:129 + usage tokens gigachat.py:191): envelope →
 * {text, citations: [], tokensIn, tokensOut}.
 *
 * TLS LIMITATION: Sber's certificates are signed by "Russian Trusted Root CA",
 * which isn't in the standard trust store. Python sets verify=CA bundle; in
 * Node, fetch can't be given a custom CA per request without an undici
 * dispatcher — this is a transport detail (not parsing), flagged in
 * coverage_gaps.
 */
import { isDict } from '../parse';
import { intOrNull, joinContent, type ParsedAnswer } from './shared';
import { recordUsage, shortError } from '../usage';

export const GIGACHAT_OAUTH_URL = 'https://ngw.devices.sberbank.ru:9443/api/v2/oauth';
export const GIGACHAT_CHAT_URL = 'https://gigachat.devices.sberbank.ru/api/v1/chat/completions';
const DEFAULT_MODEL = 'GigaChat';
const DEFAULT_SCOPE = 'GIGACHAT_API_PERS';
const DEFAULT_TIMEOUT_MS = 90_000;
const OAUTH_TIMEOUT_MS = 30_000;

/** GigaChat call error; `status` — HTTP code. */
export class GigaChatError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GigaChatError';
    this.status = status;
  }
}

/**
 * PURE CORE: GigaChat envelope → {text, citations: [], tokensIn, tokensOut}.
 * Text — `choices[0].message.content` (or joined parts); tokens —
 * `usage.prompt_tokens/completion_tokens`. No citations (no web search in the API).
 */
export function parseGigachat(data: unknown): ParsedAnswer {
  const choices = isDict(data) ? (data as Record<string, unknown>).choices : undefined;
  const choice = (Array.isArray(choices) ? choices[0] : undefined) ?? {};
  const msg = (isDict(choice) ? (choice as Record<string, unknown>).message : undefined) ?? {};
  const text = joinContent(isDict(msg) ? (msg as Record<string, unknown>).content : undefined);
  const u = isDict(data) ? (data as Record<string, unknown>).usage : undefined;
  const tokensIn = intOrNull(isDict(u) ? u.prompt_tokens : undefined);
  const tokensOut = intOrNull(isDict(u) ? u.completion_tokens : undefined);
  return { text, citations: [], tokensIn, tokensOut };
}

// ── OAuth token: cached in-process (port of gigachat.py:44-126) ───────────────
let tokenCache: { value: string; exp: number } = { value: '', exp: 0 };

function scope(): string {
  return (process.env.GIGACHAT_SCOPE || DEFAULT_SCOPE).trim();
}

/** OAuth: authorization key → access_token (gigachat.py:90). Cache refreshed 60s before expiry. */
async function fetchToken(authKey: string): Promise<string> {
  const rqUid =
    (globalThis.crypto as { randomUUID?: () => string })?.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  let res: Response;
  try {
    res = await fetch(GIGACHAT_OAUTH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authKey}`,
        RqUID: rqUid,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({ scope: scope() }).toString(),
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
  } catch (exc) {
    throw new GigaChatError(`oauth transport ${String(exc)}`);
  }
  if (!res.ok) throw new GigaChatError(`oauth HTTP ${res.status}`, res.status);
  let data: unknown;
  try {
    data = await res.json();
  } catch (exc) {
    throw new GigaChatError('oauth non-JSON');
  }
  const tok = isDict(data) ? data.access_token : undefined;
  if (!tok || typeof tok !== 'string') throw new GigaChatError('oauth missing access_token');
  // expires_at — epoch MILLIseconds; otherwise assume a 25-minute lifetime (gigachat.py:115-117).
  const expMs = Number((isDict(data) ? data.expires_at : 0) || 0);
  tokenCache = { value: tok, exp: expMs ? expMs / 1000 : Date.now() / 1000 + 1500 };
  return tok;
}

async function getToken(authKey: string, force = false): Promise<string> {
  if (!force && tokenCache.value && Date.now() / 1000 < tokenCache.exp - 60) {
    return tokenCache.value;
  }
  return fetchToken(authKey);
}

/** Reset the token cache (for tests). */
export function _resetTokenCache(): void {
  tokenCache = { value: '', exp: 0 };
}

export interface GigaChatOpts {
  authKey: string;
  model?: string;
  maxTokens?: number;
  system?: string;
}

/**
 * Transport (port of gigachat.chat, gigachat.py:138): a call → ParsedAnswer + usage
 * accounting. On HTTP 401, one forced token refresh. Throws `GigaChatError` on
 * network/HTTP/empty response. No citations.
 */
export async function gigachatChat(
  prompt: string,
  { authKey, model, maxTokens = 2000, system }: GigaChatOpts,
): Promise<ParsedAnswer & { model: string }> {
  const mdl = model || (process.env.GIGACHAT_MODEL || DEFAULT_MODEL).trim();
  const body: Record<string, unknown> = {
    model: mdl,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: prompt },
    ],
    max_tokens: maxTokens,
  };
  const started = Date.now();
  const lat = () => Date.now() - started;

  const post = async (token: string): Promise<Response> =>
    fetch(GIGACHAT_CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

  let res: Response;
  try {
    res = await post(await getToken(authKey));
    if (res.status === 401) res = await post(await getToken(authKey, true));
  } catch (exc) {
    recordUsage({ provider: 'gigachat', model: mdl, status: 'error', error: shortError(exc), latencyMs: lat() });
    throw new GigaChatError(`${mdl}: transport ${String(exc)}`);
  }
  if (!res.ok) {
    recordUsage({ provider: 'gigachat', model: mdl, status: 'error', error: String(res.status), latencyMs: lat() });
    throw new GigaChatError(`${mdl}: HTTP ${res.status}`, res.status);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch (exc) {
    recordUsage({ provider: 'gigachat', model: mdl, status: 'error', error: 'non_json', latencyMs: lat() });
    throw new GigaChatError(`${mdl}: non-JSON response`);
  }
  const parsed = parseGigachat(data);
  if (!parsed.text) {
    recordUsage({ provider: 'gigachat', model: mdl, status: 'error', error: 'empty', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut });
    throw new GigaChatError(`${mdl}: empty response from model`);
  }
  recordUsage({ provider: 'gigachat', model: mdl, status: 'ok', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut });
  return { ...parsed, model: mdl };
}
