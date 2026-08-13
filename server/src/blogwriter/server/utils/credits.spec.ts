/**
 * Charging credits for a run: we compute the DELTA (full cost from llm_usage
 * minus what's already charged for this runId). Guards exactly the hole that
 * used to let a retry finish an article for free: a failed phase charged a few
 * kopeks, and the repeat call was blocked as "already charged".
 */
import { chargeRunCredits } from './credits'
import { setBlogPrisma } from './prisma'

// Mock the official price list: the test shouldn't hit the model catalogs.
// 1 RUB per 1000 output tokens — easy to compute by hand.
jest.mock('../../../credits/official-price', () => ({
  officialRub: jest.fn(async (_model: string, _tin: number | null, tout: number | null) =>
    tout == null ? null : tout / 1000),
}))

const USAGE_ROWS = [{ user_id: 7, model: 'anthropic/claude-sonnet-5', tokens_in: 1000, tokens_out: 3200, fact_rub: 1.1 }]

/**
 * Prisma stub: the first $queryRawUnsafe is "how much has already been charged"
 * (credit_ledger), the second is the run's llm_usage rows. Distinguished by SQL
 * text, same as in the module itself.
 */
function mkPrisma(opts: { charged?: number | Error, rows?: any[] }) {
  const exec = jest.fn(() => Promise.resolve(1))
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('credit_ledger')) {
      if (opts.charged instanceof Error) throw opts.charged
      return [{ n: opts.charged ?? 0 }]
    }
    return opts.rows ?? USAGE_ROWS
  })
  setBlogPrisma({ $queryRawUnsafe: query, $executeRawUnsafe: exec } as any)
  return { exec, query }
}

/** The (negative) amount from the INSERT INTO credit_ledger call. */
const amountOf = (exec: jest.Mock) => exec.mock.calls[0]?.[2]
const metaOf = (exec: jest.Mock) => JSON.parse(exec.mock.calls[0]?.[3] || '{}')

describe('chargeRunCredits', () => {
  it('first charge: rounds RUB up to a whole credit', async () => {
    const { exec } = mkPrisma({ charged: 0 }) // 3200 output tokens → 3.2 RUB
    await expect(chargeRunCredits('run-1')).resolves.toBe(4)
    expect(amountOf(exec)).toBe(-4)
    expect(metaOf(exec)).toMatchObject({ runId: 'run-1', total: 4 })
  })

  it('repeat call at the same cost charges nothing (idempotency)', async () => {
    const { exec } = mkPrisma({ charged: 4 })
    await expect(chargeRunCredits('run-1')).resolves.toBe(0)
    expect(exec).not.toHaveBeenCalled()
  })

  it('retry after a failure: charges the DELTA, not zero', async () => {
    // 4 already charged for the failed phase; after the retry the run costs 10.1 RUB → 11 credits
    const { exec } = mkPrisma({
      charged: 4,
      rows: [{ user_id: 7, model: 'm', tokens_in: 1000, tokens_out: 10_100, fact_rub: 3 }],
    })
    await expect(chargeRunCredits('run-1')).resolves.toBe(7)
    expect(amountOf(exec)).toBe(-7)
    expect(metaOf(exec)).toMatchObject({ total: 11, prevCharged: 4 })
  })

  it('minimum 1 credit — only on the first charge, not forced on a top-up', async () => {
    // 100 output tokens → 0.1 RUB: from zero that's 1 credit…
    const rows = [{ user_id: 7, model: 'm', tokens_in: 10, tokens_out: 100, fact_rub: 0 }]
    const first = mkPrisma({ charged: 0, rows })
    await expect(chargeRunCredits('run-2')).resolves.toBe(1)
    // …but once 1 is already charged, there should be no top-up
    const again = mkPrisma({ charged: 1, rows })
    await expect(chargeRunCredits('run-2')).resolves.toBe(0)
    expect(again.exec).not.toHaveBeenCalled()
    expect(first.exec).toHaveBeenCalledTimes(1)
  })

  it('no calls in llm_usage / no owner → charge nothing', async () => {
    const empty = mkPrisma({ charged: 0, rows: [] })
    await expect(chargeRunCredits('run-3')).resolves.toBe(0)
    expect(empty.exec).not.toHaveBeenCalled()

    const anon = mkPrisma({ charged: 0, rows: [{ user_id: null, model: 'm', tokens_in: 1, tokens_out: 1000, fact_rub: 0 }] })
    await expect(chargeRunCredits('run-3')).resolves.toBe(0)
    expect(anon.exec).not.toHaveBeenCalled()
  })

  it('model price unknown → nothing to charge', async () => {
    const { exec } = mkPrisma({
      charged: 0,
      rows: [{ user_id: 7, model: 'unknown', tokens_in: 100, tokens_out: null, fact_rub: 0 }],
    })
    await expect(chargeRunCredits('run-4')).resolves.toBe(0)
    expect(exec).not.toHaveBeenCalled()
  })

  it('accounting unavailable (no table) → stay silent, don\'t charge blindly', async () => {
    const { exec } = mkPrisma({ charged: new Error('relation "credit_ledger" does not exist') })
    await expect(chargeRunCredits('run-5')).resolves.toBe(0)
    expect(exec).not.toHaveBeenCalled()
  })
})
