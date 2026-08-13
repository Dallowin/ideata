/**
 * Yandex Cloud AI client for AEO — port of scrapper/core/yandex_ai.py. Two engines
 * under one service key:
 *   - "Alice" (`aliceChat`): Foundation Models completion. No web search/citations
 *     in the API → mentions without citations (like gigachat). Tokens are available.
 *   - "Yandex Search" (`neuroSearch`): Neuro's generative answer (gen search).
 *     Grounded — real citations (like perplexity). The API doesn't return tokens →
 *     fixed price per request (FIXED_YANDEX_NEURO).
 *
 * PURE VERIFIABLE CORE — `parseAlice` (port of `_alice_text` yandex_ai.py:174 +
 * `_alice_usage`:159) and `parseNeuro` (port of `_neuro_parse`:250): envelope →
 * {text, citations, tokensIn, tokensOut}.
 */
import { isDict, pyStrip, pyStrOrEmpty, type CiteItem } from '../parse';
import { intOrNull, type ParsedAnswer } from './shared';
import { fixedCostUsd } from '../cost';
import { recordUsage, shortError } from '../usage';

export const YANDEX_COMPLETION_URL =
  'https://llm.api.cloud.yandex.net/foundationModels/v1/completion';
export const YANDEX_GEN_SEARCH_URL =
  'https://searchapi.api.cloud.yandex.net/v2/gen/search';
const DEFAULT_ALICE_MODEL = 'yandexgpt-lite';
const DEFAULT_TIMEOUT_MS = 60_000;

function aliceModel(): string {
  return (process.env.YANDEX_ALICE_MODEL || DEFAULT_ALICE_MODEL).trim();
}

function headers(key: string): Record<string, string> {
  return { Authorization: `Api-Key ${key}`, 'Content-Type': 'application/json' };
}

// ── "Alice": pure core + transport ────────────────────────────────────────────

/** `_alice_usage` (yandex_ai.py:159): result.usage → (inputTextTokens, completionTokens). */
function aliceUsage(data: unknown): [number | null, number | null] {
  const result = isDict(data) ? (data as Record<string, unknown>).result : undefined;
  const u = isDict(result) ? (result as Record<string, unknown>).usage : undefined;
  if (!isDict(u)) return [null, null];
  return [intOrNull(u.inputTextTokens), intOrNull(u.completionTokens)];
}

/**
 * PURE CORE for "Alice": completion envelope → {text, citations: [], tokens}.
 * Text — `result.alternatives[0].message.text`; tokens — result.usage. No citations.
 */
export function parseAlice(data: unknown): ParsedAnswer {
  const result = isDict(data) ? (data as Record<string, unknown>).result : undefined;
  const alts = isDict(result) ? (result as Record<string, unknown>).alternatives : undefined;
  const first = Array.isArray(alts) ? alts[0] : undefined;
  const msg = isDict(first) ? (first as Record<string, unknown>).message : undefined;
  const text = pyStrip(pyStrOrEmpty(isDict(msg) ? msg.text : undefined));
  const [tokensIn, tokensOut] = aliceUsage(data);
  return { text, citations: [], tokensIn, tokensOut };
}

/**
 * "Alice" transport (port of alice_chat, yandex_ai.py:92): failure-isolated → null
 * on any failure (missing key/folder, network, non-200, empty response) + usage
 * accounting. Returns ParsedAnswer or null (does NOT throw — the engine must not
 * bring down the run).
 */
export async function aliceChat(
  prompt: string,
  { apiKey, folderId, maxTokens = 2000 }: { apiKey: string; folderId: string; maxTokens?: number },
): Promise<ParsedAnswer | null> {
  if (!apiKey || !folderId) return null;
  const model = aliceModel();
  const body = {
    modelUri: `gpt://${folderId}/${model}`,
    completionOptions: { stream: false, maxTokens: String(maxTokens) },
    messages: [{ role: 'user', text: prompt }],
  };
  const started = Date.now();
  const lat = () => Date.now() - started;

  let res: Response;
  try {
    res = await fetch(YANDEX_COMPLETION_URL, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (exc) {
    recordUsage({ provider: 'yandex', model, status: 'error', error: shortError(exc), latencyMs: lat() });
    return null;
  }
  if (!res.ok) {
    recordUsage({ provider: 'yandex', model, status: 'error', error: String(res.status), latencyMs: lat() });
    return null;
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    recordUsage({ provider: 'yandex', model, status: 'error', error: 'non_json', latencyMs: lat() });
    return null;
  }
  const parsed = parseAlice(data);
  if (!parsed.text) {
    recordUsage({ provider: 'yandex', model, status: 'error', error: 'empty', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut });
    return null;
  }
  recordUsage({ provider: 'yandex', model, status: 'ok', latencyMs: lat(), tokensIn: parsed.tokensIn, tokensOut: parsed.tokensOut });
  return parsed;
}

// ── "Yandex Search" (Neuro): pure core + transport ────────────────────────────

/**
 * PURE CORE for Neuro (port of `_neuro_parse`, yandex_ai.py:250): GenSearchResponse →
 * {text, citations, tokens: null}. REST wraps the response in an ARRAY with one
 * object — we accept both the array and a bare object. `isAnswerRejected` → empty
 * (the model declined). Citations from `sources[]` are deduped by URL, preserving
 * order and title. The API doesn't return tokens → tokensIn/Out = null (fixed price).
 */
export function parseNeuro(data: unknown): ParsedAnswer {
  let d: unknown = data;
  if (Array.isArray(d)) d = d.find((x) => isDict(x)) ?? null; // first dict
  if (!isDict(d)) return { text: '', citations: [], tokensIn: null, tokensOut: null };
  if (d.isAnswerRejected) return { text: '', citations: [], tokensIn: null, tokensOut: null };
  // Python: str(((data.get("message") or {}).get("content")) or "").strip()
  const message = (d as Record<string, unknown>).message;
  const content = isDict(message) ? (message as Record<string, unknown>).content : undefined;
  const text = pyStrip(pyStrOrEmpty(content));
  // Own dedup by URL (yandex_ai.py:265-272), NOT _dedup_sources: title comes
  // from the first occurrence. Result is already canonical [{url,title}] = cite_items(sources).
  const cites: CiteItem[] = [];
  const seen = new Set<string>();
  const sources = (d as Record<string, unknown>).sources;
  if (Array.isArray(sources)) {
    for (const s of sources) {
      const u = pyStrip(pyStrOrEmpty(isDict(s) ? s.url : undefined));
      if (u && !seen.has(u)) {
        seen.add(u);
        cites.push({ url: u, title: pyStrip(pyStrOrEmpty(isDict(s) ? s.title : undefined)) });
      }
    }
  }
  return { text, citations: cites, tokensIn: null, tokensOut: null };
}

/**
 * Neuro transport (port of neuro_search, yandex_ai.py:184): failure-isolated → null
 * on any failure (missing key/folder, network, non-200, empty/rejected response).
 * Success is billed at a fixed rate (FIXED_YANDEX_NEURO in dollars), no tokens.
 */
export async function neuroSearch(
  prompt: string,
  { apiKey, folderId }: { apiKey: string; folderId: string },
): Promise<ParsedAnswer | null> {
  if (!apiKey || !folderId) return null;
  const body = { messages: [{ content: prompt, role: 'ROLE_USER' }], folderId };
  const started = Date.now();
  const lat = () => Date.now() - started;

  let res: Response;
  try {
    res = await fetch(YANDEX_GEN_SEARCH_URL, {
      method: 'POST',
      headers: headers(apiKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (exc) {
    recordUsage({ provider: 'yandex', model: 'neuro-search', status: 'error', error: shortError(exc), latencyMs: lat() });
    return null;
  }
  if (!res.ok) {
    recordUsage({ provider: 'yandex', model: 'neuro-search', status: 'error', error: String(res.status), latencyMs: lat() });
    return null;
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    recordUsage({ provider: 'yandex', model: 'neuro-search', status: 'error', error: 'non_json', latencyMs: lat() });
    return null;
  }
  const parsed = parseNeuro(data);
  if (!parsed.text) {
    recordUsage({ provider: 'yandex', model: 'neuro-search', status: 'error', error: 'empty', latencyMs: lat() });
    return null;
  }
  // Neuro's generative answer — fixed price per request (in dollars), the API doesn't return tokens.
  recordUsage({ provider: 'yandex', model: 'neuro-search', status: 'ok', latencyMs: lat(), costUsd: fixedCostUsd('yandex_neuro') });
  return parsed;
}
