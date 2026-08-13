/**
 * Charging credits for article generation.
 *
 * The pipeline is flat modules without DI, so we write to credit_ledger directly
 * (like llmUsage). Logic: every LLM call already writes a row to llm_usage with
 * the model and token counts; once the run finishes, we re-price ITS rows at the
 * official rate and charge once — so the ledger has one clear entry ("article: N
 * credits") instead of fifty fractional ones, and rounding up happens once
 * instead of on every call.
 *
 * 1 credit = 1 RUB of OFFICIAL cost. We do NOT compute from llm_usage.cost_rub:
 * that holds the actual amount paid (to kie/OpenRouter), and the difference
 * between the actual cost and the vendor price list is our margin. The price to
 * the client is the same regardless of which provider we routed the call through.
 */
import { officialRub } from '../../../credits/official-price'
import { flushLlmUsage } from './llmUsage'
import { blogPrisma } from './prisma'

/**
 * How many credits have already been charged for this run. There used to be a
 * "charged or not" flag here, and it broke money on retries: a generation that
 * failed in its first phase charged a few kopeks, and a restart would finish the
 * article for FREE — the second charge was blocked as a "duplicate". We now
 * charge the DELTA (full cost minus what's already charged), so idempotency of
 * a repeat call is preserved (delta = 0), while a retry pays the difference.
 * @returns null — accounting unavailable (no table/DB): can't charge blindly
 */
async function chargedSoFar(runId: string): Promise<number | null> {
  try {
    const rows = await blogPrisma().$queryRawUnsafe<{ n: number }[]>(
      `SELECT COALESCE(-SUM(amount), 0)::int AS n FROM credit_ledger
        WHERE reason = 'post' AND meta->>'runId' = $1`, runId)
    return Number(rows?.[0]?.n || 0)
  } catch {
    return null // no table/DB — stay silent to avoid generating noise
  }
}

/**
 * Charge for a run based on what was actually spent. Never throws: the
 * generation already happened, and an accounting failure must not break it.
 * @returns how many credits THIS call charged (0 — nothing to charge/already covered)
 */
export async function chargeRunCredits(runId: string): Promise<number> {
  if (!runId) return 0
  try {
    // usage rows are written via `void` — wait for started inserts, otherwise
    // we'd compute cost from an incomplete sample (especially on short runs)
    await flushLlmUsage()
    const already = await chargedSoFar(runId)
    if (already == null) return 0

    // Take the individual call rows, not the ready-made cost_rub sum: we re-price
    // by the model's official price list (cost_rub holds the actual payment to the provider).
    const rows = await blogPrisma().$queryRawUnsafe<
      { user_id: number | null; model: string | null; tokens_in: number | null; tokens_out: number | null; fact_rub: number | null }[]
    >(
      `SELECT user_id, model, tokens_in, tokens_out, cost_rub AS fact_rub
         FROM llm_usage
        WHERE run_id = $1 AND status = 'ok'`, runId)
    if (!rows?.length) return 0

    const userId = rows.map(r => r.user_id).find(v => v != null) ?? null
    if (!userId) return 0

    let rub = 0
    let fact = 0
    for (const r of rows) {
      rub += (await officialRub(String(r.model || ''), r.tokens_in, r.tokens_out)) ?? 0
      fact += Number(r.fact_rub || 0)
    }
    // price unknown for every model in the run — nothing to charge
    if (!(rub > 0)) return 0

    // Full run cost as of NOW; minimum 1 credit — but only when nothing has been
    // charged yet (otherwise the minimum would turn into an extra charge for no reason).
    const total = Math.max(already > 0 ? 0 : 1, Math.ceil(rub))
    const credits = total - already
    if (credits <= 0) return 0 // already fully covered by a previous charge
    await blogPrisma().$executeRawUnsafe(
      `INSERT INTO credit_ledger (user_id, amount, reason, model, meta)
       VALUES ($1, $2, 'post', NULL, $3::jsonb)`,
      userId, -credits, JSON.stringify({
        runId,
        rub: Math.round(rub * 100) / 100,          // official — this is what was charged
        factRub: Math.round(fact * 100) / 100,     // what was actually paid to the provider
        calls: rows.length,
        total,                                     // full run cost at charge time
        ...(already > 0 ? { prevCharged: already } : {}), // top-up after a retry
      }),
    )
    return credits
  } catch {
    return 0
  }
}
