/**
 * LLM cost tracking: the wrapper around a provider call writes an ok/error row
 * to llm_usage (mocked Prisma) and NEVER breaks the pipeline on an insert/network failure.
 */
import { LLM } from './llm'
import { costRub, costRubLive, estimateTokens, recordLlmUsage } from './llmUsage'
import { setBlogPrisma } from './prisma'

// Mock the model catalog: it's the price source for accounting, and the test
// shouldn't hit the network (or depend on what the catalogs return today).
// Prices here are deliberately NOT equal to the local price list — so it's
// visible which source was used.
jest.mock('./modelCatalog', () => ({
  ...jest.requireActual('./modelCatalog'),
  getUnifiedCatalog: jest.fn(async () => ({
    models: [
      { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', provider: 'anthropic', format: 'claude', inUsd: 0.9, outUsd: 4.5, desc: '', context: null },
      { id: 'openai/gpt-5-mini', label: 'GPT-5 Mini', provider: 'openrouter', format: 'openai', inUsd: 0.25, outUsd: 2, desc: '', context: null },
    ],
    source: 'snapshot' as const,
    at: '2026-07-26T00:00:00.000Z',
  })),
}))

// Parameter positions in the $executeRawUnsafe(SQL, ...params) call.
const P = {
  provider: 1, model: 2, runId: 3, userId: 4, domain: 5,
  status: 6, error: 7, latency: 8, tokensIn: 9, tokensOut: 10, cost: 11, requestId: 12,
} as const

function mkPrisma(exec: jest.Mock) {
  setBlogPrisma({ $executeRawUnsafe: exec } as any)
  return exec
}

const flush = () => new Promise(r => setImmediate(r))

describe('costRub — RUB estimate from the catalog price list (rate 90 RUB/$)', () => {
  it('sonnet: (1k in ×$3 + 2k out ×$15)/1M ×90 = 2.97 RUB', () => {
    expect(costRub('anthropic/claude-sonnet-5', 1000, 2000)).toBeCloseTo(2.97, 6)
  })
  it('opus is more expensive than sonnet for the same tokens', () => {
    expect(costRub('anthropic/claude-opus-4.8', 1000, 2000)!).toBeGreaterThan(
      costRub('anthropic/claude-sonnet-5', 1000, 2000)!,
    )
  })
  it('no tokens → NULL (provider sent no usage)', () => {
    expect(costRub('anthropic/claude-sonnet-5', null, null)).toBeNull()
    expect(costRub('anthropic/claude-sonnet-5', 100, null)).toBeNull()
  })
  it('model outside the price list → NULL', () => {
    expect(costRub('some/unknown-model', 100, 200)).toBeNull()
  })
})

describe('costRubLive — price from the live catalog, local price list as fallback', () => {
  it('model is in the catalog → priced from it, not from regex', async () => {
    // 1000 in × $0.9/1M + 2000 out × $4.5/1M = $0.0099 × 90 RUB = 0.891 RUB
    await expect(costRubLive('anthropic/claude-sonnet-4.5', 1000, 2000)).resolves.toBeCloseTo(0.891, 6)
  })

  it('used to cost ZERO: a model outside the five regexes now has a price', async () => {
    // gpt-* doesn't match any local regex → costRub gives null…
    expect(costRub('openai/gpt-5-mini', 1000, 2000)).toBeNull()
    // …but the catalog knows the price: 1000×0.25/1M + 2000×2/1M = $0.00425 × 90 = 0.3825 RUB
    await expect(costRubLive('openai/gpt-5-mini', 1000, 2000)).resolves.toBeCloseTo(0.3825, 6)
  })

  it('model not in the catalog → falls back to the local price list', async () => {
    await expect(costRubLive('anthropic/claude-sonnet-5', 1000, 2000)).resolves.toBeCloseTo(2.97, 6)
  })

  it('not in the catalog or the price list → null (nothing to charge)', async () => {
    await expect(costRubLive('some/unknown-model', 100, 200)).resolves.toBeNull()
  })

  it('no tokens → null either way', async () => {
    await expect(costRubLive('anthropic/claude-sonnet-4.5', null, null)).resolves.toBeNull()
  })
})

describe('estimateTokens — fallback for when the provider sent no usage', () => {
  it('Latin ≈3.5 chars per token, Cyrillic ≈2', () => {
    expect(estimateTokens('a'.repeat(350))).toBe(100)
    expect(estimateTokens('а'.repeat(200))).toBe(100)
  })
  it('empty text → 0, non-empty → at least 1', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('ok')).toBe(1)
  })
})

describe('recordLlmUsage — usage row in llm_usage', () => {
  it('ok: writes provider/model/tokens/latency/RUB and the run context', async () => {
    const exec = mkPrisma(jest.fn(() => Promise.resolve(1)))
    await recordLlmUsage({
      provider: 'openrouter', model: 'anthropic/claude-sonnet-5', status: 'ok',
      latencyMs: 123.7, tokensIn: 1000, tokensOut: 2000, requestId: 'req_1',
      runId: 'run-1', userId: 7, domain: 'ex.com',
    })
    expect(exec).toHaveBeenCalledTimes(1)
    const a = exec.mock.calls[0]
    expect(a[P.provider]).toBe('openrouter')
    expect(a[P.model]).toBe('anthropic/claude-sonnet-5')
    expect(a[P.runId]).toBe('run-1')
    expect(a[P.userId]).toBe(7)
    expect(a[P.domain]).toBe('ex.com')
    expect(a[P.status]).toBe('ok')
    expect(a[P.error]).toBeNull()
    expect(a[P.latency]).toBe(124) // rounding
    expect(a[P.tokensIn]).toBe(1000)
    expect(a[P.tokensOut]).toBe(2000)
    // model isn't in the catalog → priced from the local price list (sonnet 3/15 $)
    expect(a[P.cost]).toBeCloseTo(2.97, 6)
    expect(a[P.requestId]).toBe('req_1')
  })

  it('error: status error, error text, tokens and RUB = NULL', async () => {
    const exec = mkPrisma(jest.fn(() => Promise.resolve(1)))
    await recordLlmUsage({
      provider: 'anthropic', model: 'anthropic/claude-opus-4.8', status: 'error',
      error: 'Anthropic 402 (claude-opus-4-8): insufficient credits', latencyMs: 50,
    })
    const a = exec.mock.calls[0]
    expect(a[P.status]).toBe('error')
    expect(a[P.error]).toContain('402')
    expect(a[P.tokensIn]).toBeNull()
    expect(a[P.tokensOut]).toBeNull()
    expect(a[P.cost]).toBeNull()
    expect(a[P.requestId]).toBeNull()
  })

  it('insert failure (missing table) does NOT throw', async () => {
    mkPrisma(jest.fn(() => Promise.reject(new Error('relation "llm_usage" does not exist'))))
    await expect(
      recordLlmUsage({ provider: 'anthropic', model: 'x', status: 'ok', latencyMs: 1 }),
    ).resolves.toBeUndefined()
  })
})

describe('LLM.complete — usage-tracking wrapper around the actual call', () => {
  const realFetch = global.fetch
  afterEach(() => { global.fetch = realFetch })

  const cfg = {
    provider: 'anthropic' as const, apiKey: 'k',
    modelStrong: 'anthropic/claude-sonnet-5', modelFast: 'anthropic/claude-haiku-4.5',
    usage: { runId: 'r1', userId: 9, domain: 'd.io' },
  }

  it('success: returns the text and writes an ok row with usage tokens', async () => {
    const exec = mkPrisma(jest.fn(() => Promise.resolve(1)))
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'msg_1', content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 10, output_tokens: 20 } }),
    })) as any

    const out = await new LLM(cfg).complete('hi', { strong: true })
    await flush()

    expect(out).toBe('hello')
    expect(exec).toHaveBeenCalledTimes(1)
    const a = exec.mock.calls[0]
    expect(a[P.provider]).toBe('anthropic')
    expect(a[P.model]).toBe('anthropic/claude-sonnet-5')
    expect(a[P.status]).toBe('ok')
    expect(a[P.runId]).toBe('r1')
    expect(a[P.userId]).toBe(9)
    expect(a[P.domain]).toBe('d.io')
    expect(a[P.tokensIn]).toBe(10)
    expect(a[P.tokensOut]).toBe(20)
    expect(a[P.requestId]).toBe('msg_1')
  })

  // A response without usage used to give tokens NULL → price "unknown" →
  // ZERO contribution to the charge: an article on such responses came out free.
  it('provider without usage: tokens estimated from length, row marked estimated', async () => {
    const exec = mkPrisma(jest.fn(() => Promise.resolve(1)))
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'msg_3', content: [{ type: 'text', text: 'a'.repeat(350) }] }),
    })) as any

    await new LLM(cfg).complete('hi', { strong: true })
    await flush()

    const a = exec.mock.calls[0]
    expect(a[P.status]).toBe('ok')
    expect(a[P.tokensOut]).toBe(100) // 350 Latin characters / 3.5
    expect(a[P.tokensIn]).toBeGreaterThan(0)
    expect(a[P.error]).toContain('estimated')
    expect(a[P.cost]).toBeGreaterThan(0) // price is no longer NULL → charge isn't zero
  })

  it('provider failure (402): writes an error row and rethrows', async () => {
    const exec = mkPrisma(jest.fn(() => Promise.resolve(1)))
    global.fetch = jest.fn(async () => ({
      ok: false, status: 402, text: async () => 'insufficient credits',
    })) as any

    await expect(new LLM(cfg).complete('hi', { strong: true })).rejects.toThrow(/402/)
    await flush()

    expect(exec).toHaveBeenCalledTimes(1)
    const a = exec.mock.calls[0]
    expect(a[P.status]).toBe('error')
    expect(a[P.error]).toContain('402')
  })

  it('logging failure does not break the call: text is still returned', async () => {
    mkPrisma(jest.fn(() => Promise.reject(new Error('llm_usage missing'))))
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ id: 'msg_2', content: [{ type: 'text', text: 'ok-text' }] }),
    })) as any

    const out = await new LLM(cfg).complete('hi', { strong: true })
    await flush()
    expect(out).toBe('ok-text')
  })

  it('mock mode (no key): no actual call is made — nothing is tracked', async () => {
    const exec = mkPrisma(jest.fn(() => Promise.resolve(1)))
    const out = await new LLM({ ...cfg, apiKey: '' }).complete('составь блок FAQ по теме')
    await flush()
    expect(typeof out).toBe('string')
    expect(exec).not.toHaveBeenCalled()
  })
})
