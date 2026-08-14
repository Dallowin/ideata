/**
 * Cost tracking for the blog writer's LLM calls, in the SHARED `llm_usage` table
 * (created by the scrapper in the same Postgres). Every actual Anthropic/OpenRouter
 * call from llm.ts writes one row here: provider, model, tokens, latency, status,
 * and a RUB cost estimate.
 *
 * Resilience contract: the table may NOT exist yet on first deploy (the scrapper
 * creates it) — the insert goes through $executeRawUnsafe in try/catch, and any
 * logging failure (missing table / DB unavailable) NEVER breaks the generation pipeline.
 */
import { blogPrisma } from './prisma'
import { getUnifiedCatalog } from './modelCatalog'

/** Run context passed into the LLM for cost attribution. */
export interface LlmUsageContext {
  runId?: string | null // blog-run id as a string (null for ad-hoc generations)
  userId?: number | null // owner of the run's brand
  domain?: string | null // brand domain, if at hand
}

/** A single usage record — what the wrapper around a provider call knows. */
export interface LlmUsageEntry extends LlmUsageContext {
  provider: 'anthropic' | 'openrouter'
  model: string
  status: 'ok' | 'error'
  latencyMs: number
  tokensIn?: number | null
  tokensOut?: number | null
  error?: string | null
  requestId?: string | null
  /** tokens weren't returned by the provider and were estimated from text length (see estimateTokens) */
  estimated?: boolean
}

/** Exchange rate for converting model USD pricing into rubles. */
const USD_RUB = 90

/**
 * Mini price list for catalog models (shared/models.ts): $ per 1M tokens [in, out].
 * Matched against a substring of the slug (the catalog stores the OpenRouter style,
 * e.g. `anthropic/claude-opus-4.8`). Order matters — specific entries before general ones.
 * A model outside this list → cost unknown (NULL), backfilled by the scrapper.
 */
const PRICES_USD_PER_1M: Array<{ match: RegExp, in: number, out: number }> = [
  { match: /opus/i, in: 5, out: 25 }, // Claude Opus 4.8
  { match: /sonnet/i, in: 3, out: 15 }, // Claude Sonnet 5 / 4.5
  { match: /haiku/i, in: 1, out: 5 }, // Claude Haiku 4.5
  { match: /gemini[\w.-]*pro/i, in: 1.25, out: 10 }, // Gemini 2.5 Pro
  { match: /grok/i, in: 0.2, out: 0.5 }, // Grok 4.3
]

/**
 * Estimated RUB cost of a call from the LOCAL price list (the 5 regexes above).
 * NULL when there are no tokens or the model doesn't match. This is a fallback:
 * the primary path is costRubLive, which takes the price from the live catalog.
 */
export function costRub(
  model: string,
  tokensIn?: number | null,
  tokensOut?: number | null,
): number | null {
  if (tokensIn == null || tokensOut == null) return null
  const p = PRICES_USD_PER_1M.find(x => x.match.test(model || ''))
  if (!p) return null
  const usd = (tokensIn / 1e6) * p.in + (tokensOut / 1e6) * p.out
  return Math.round(usd * USD_RUB * 1e6) / 1e6 // RUB, to 6 decimals — amounts are fractions of a kopek
}

/**
 * Cost of a call from the LIVE model catalog (Anthropic + OpenRouter, 1h cache
 * inside getUnifiedCatalog), falling back to the local regexes.
 *
 * Why: the local price list only knows opus/sonnet/haiku/gemini-pro/grok, and the
 * whole GPT/DeepSeek/Qwen/Kimi range falls through. For those, costRub returned
 * NULL → chargeRunCredits saw "price unknown" and charged ZERO credits. So an
 * article on any model outside the five was free, even though the composer showed
 * the user a price.
 *
 * The estimate in the gate (CreditsService.estimatePost) is computed from this same
 * catalog — now the displayed price and the actual charge come from one source.
 */
export async function costRubLive(
  model: string,
  tokensIn?: number | null,
  tokensOut?: number | null,
): Promise<number | null> {
  if (tokensIn == null || tokensOut == null) return null
  try {
    const { models } = await getUnifiedCatalog()
    const m = models.find(x => x.id === model)
    if (m && m.inUsd != null && m.outUsd != null) {
      const usd = (tokensIn / 1e6) * m.inUsd + (tokensOut / 1e6) * m.outUsd
      return Math.round(usd * USD_RUB * 1e6) / 1e6
    }
  } catch {
    /* catalog unavailable — fall back to the local price list */
  }
  return costRub(model, tokensIn, tokensOut)
}

/**
 * Rough token estimate from text length. Needed because some provider responses
 * arrive WITHOUT a usage block: tokens ended up NULL, the call's cost was
 * treated as "unknown", and that call's contribution to the credit charge was
 * ZERO — an article generated entirely from such responses turned out free.
 *
 * Coefficients: Latin ≈3.5 chars per token, Cyrillic ≈2 (its tokenizer splits
 * finer). The estimate should never be too low — when in doubt, assume Cyrillic.
 */
export function estimateTokens(text: string): number {
  const s = String(text || '')
  if (!s) return 0
  const cyr = (s.match(/[Ѐ-ӿ]/g) || []).length
  const perToken = cyr > s.length * 0.2 ? 2 : 3.5
  return Math.max(1, Math.round(s.length / perToken))
}

/**
 * In-flight usage inserts. recordLlmUsage is called via `void` (logging must not
 * slow down generation), but credit charging reads EXACTLY these rows — without
 * waiting, the translation/retry step would be charged against an incomplete
 * sample and undercharge for what was spent. We only wait for already-started
 * inserts; this never throws.
 */
const pendingWrites = new Set<Promise<void>>()

export async function flushLlmUsage(): Promise<void> {
  await Promise.allSettled([...pendingWrites])
}

const INSERT_SQL = `INSERT INTO llm_usage
  (ts, provider, model, platform, purpose, run_kind, run_id, user_id, domain,
   status, error, latency_ms, tokens_in, tokens_out, cost_rub, request_id)
  VALUES (now(), $1, $2, NULL, 'blog', 'blog', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`

/**
 * Writes a usage row. NEVER throws: the table might not exist / the DB might be
 * down — cost tracking isn't critical for generation, so any failure is swallowed.
 */
export function recordLlmUsage(e: LlmUsageEntry): Promise<void> {
  const p = insertLlmUsage(e)
  pendingWrites.add(p)
  void p.finally(() => pendingWrites.delete(p))
  return p
}

async function insertLlmUsage(e: LlmUsageEntry): Promise<void> {
  try {
    await blogPrisma().$executeRawUnsafe(
      INSERT_SQL,
      e.provider,
      e.model,
      e.runId ?? null,
      e.userId ?? null,
      e.domain ?? null,
      e.status,
      // There's no dedicated column for the estimated flag in llm_usage (the table
      // is created by the scrapper, we don't carry migrations here) — mark it via
      // text in error: the row stays status='ok', but it's visible the tokens
      // aren't from the provider.
      e.error ? e.error.slice(0, 500) : (e.estimated ? 'tokens: estimated by length' : null),
      Math.max(0, Math.round(e.latencyMs)),
      e.tokensIn ?? null,
      e.tokensOut ?? null,
      await costRubLive(e.model, e.tokensIn, e.tokensOut),
      e.requestId ?? null,
    )
  } catch {
    // no llm_usage table (created by the scrapper) / DB unavailable — swallow it,
    // cost tracking must not break the blog writer pipeline
  }
}
