/**
 * Credits: estimate before the call, charge after the fact. Catalogs are
 * mocked — the price shouldn't depend on what kie/OpenRouter happen to
 * return today. Credits are computed from the OFFICIAL price (see
 * official-price.spec).
 */
import { CreditsService, USD_RUB, creditsForImageUsd, creditsForUsd } from './credits.service';

jest.mock('../blogwriter/server/utils/modelCatalog', () => ({
  getUnifiedCatalog: jest.fn(async () => ({
    models: [
      { id: 'anthropic/claude-sonnet-5', label: 'Sonnet', provider: 'openrouter', format: 'openai', inUsd: 3, outUsd: 15, desc: '', context: null },
      { id: 'openai/gpt-5-mini', label: 'GPT-5 Mini', provider: 'openrouter', format: 'openai', inUsd: 0.25, outUsd: 2, desc: '', context: null },
    ],
    source: 'snapshot' as const,
    at: '2026-07-26T00:00:00.000Z',
  })),
}));

jest.mock('../blogwriter/server/utils/kieCatalog', () => ({
  getKieCatalog: jest.fn(async () => ({ models: [], scrapedAt: '', stale: false })),
}));

function mkService(opts: { pool?: number; spent?: number; dbFails?: boolean; plan?: string } = {}) {
  const inserts: any[][] = [];
  const prisma = {
    $queryRawUnsafe: jest.fn(async (..._args: any[]) => {
      if (opts.dbFails) throw new Error('no such table');
      return [{ granted: 0, spent: opts.spent ?? 0 }];
    }),
    $executeRawUnsafe: jest.fn(async (...args: any[]) => {
      inserts.push(args);
      return 1;
    }),
  };
  const plans = {
    resolveLimits: jest.fn(async () => ({ plan: opts.plan ?? 'pro', credits: opts.pool ?? 1500 })),
  };
  const svc = new CreditsService(prisma as any, plans as any);
  return { svc, prisma, plans, inserts };
}

describe('estimateAsk — assistant question price', () => {
  it('computes from the official price of the selected model', async () => {
    const { svc } = mkService();
    // 8000 in × $0.25/1M + 700 out × $2/1M = $0.0034 × 90 ₽ = 0.306 ₽ → 1 credit
    await expect(svc.estimateAsk('openai/gpt-5-mini')).resolves.toBe(1);
    // 8000 × 3 + 700 × 15 = $0.0345 × 90 = 3.105 ₽ → 4 credits
    await expect(svc.estimateAsk('anthropic/claude-sonnet-5')).resolves.toBe(4);
  });

  it('a kie slug costs the same as the vendor one: the discount is not for the client', async () => {
    const { svc } = mkService();
    await expect(svc.estimateAsk('claude-sonnet-5')).resolves.toBe(4);
  });

  it('model outside the catalog → a conservative estimate, not zero', async () => {
    const { svc } = mkService();
    await expect(svc.estimateAsk('неизвестная/модель')).resolves.toBe(2);
    await expect(svc.estimateAsk(null)).resolves.toBe(2);
  });
});

describe('balance — pool window depends on the plan', () => {
  it('free: pool is one-time, charges are counted over all time', async () => {
    const { svc, prisma } = mkService({ plan: 'free', pool: 100, spent: 100 });
    await expect(svc.balance(1)).resolves.toMatchObject({ pool: 100, spent: 100, balance: 0 });
    // no monthly window: spent it once — a new month won't bring the pool back
    expect(String(prisma.$queryRawUnsafe.mock.calls[0][0])).not.toContain('date_trunc');
  });

  it('paid: pool renews every calendar month', async () => {
    const { svc, prisma } = mkService({ plan: 'pro', pool: 1500, spent: 200 });
    await expect(svc.balance(1)).resolves.toMatchObject({ balance: 1300 });
    expect(String(prisma.$queryRawUnsafe.mock.calls[0][0])).toContain("date_trunc('month', now())");
  });
});

describe('assertEnough — gate before hitting the model', () => {
  it('passes through when the balance is enough', async () => {
    const { svc } = mkService({ pool: 100, spent: 10 });
    await expect(svc.assertEnough(1, 5)).resolves.toMatchObject({ balance: 90 });
  });

  it('throws 402 when it is not enough', async () => {
    const { svc } = mkService({ pool: 10, spent: 9 });
    await expect(svc.assertEnough(1, 5)).rejects.toMatchObject({ status: 402 });
  });

  it('accounting unavailable → does not block the product', async () => {
    const { svc } = mkService({ pool: 10, dbFails: true });
    await expect(svc.assertEnough(1, 999)).resolves.toMatchObject({ degraded: true });
  });
});

describe('chargeRub — charging at actual cost', () => {
  it('writes a negative row, rounding up to a credit', async () => {
    const { svc, inserts } = mkService();
    await expect(svc.chargeRub(7, 0.82, 'ask', 'kie/claude-sonnet-5')).resolves.toBe(1);
    await expect(svc.chargeRub(7, 3.2, 'ask', 'kie/claude-sonnet-5')).resolves.toBe(4);
    expect(inserts).toHaveLength(2);
    expect(inserts[0][1]).toBe(7);      // user_id
    expect(inserts[0][2]).toBe(-1);     // amount as negative
    expect(inserts[0][3]).toBe('ask');  // reason
  });

  it('price unknown → charges nothing', async () => {
    const { svc, inserts } = mkService();
    await expect(svc.chargeRub(7, null, 'ask')).resolves.toBe(0);
    await expect(svc.chargeRub(7, 0, 'ask')).resolves.toBe(0);
    expect(inserts).toHaveLength(0);
  });

  it('a journal failure does not fail the action', async () => {
    const { svc, prisma } = mkService();
    prisma.$executeRawUnsafe.mockRejectedValueOnce(new Error('db is down'));
    await expect(svc.chargeRub(7, 5, 'ask')).resolves.toBe(5);
  });
});

describe('creditsForImageUsd — image markup', () => {
  it('evens out the scale: an image costs the client three times more credits', () => {
    // Nano Banana Pro: our purchase price $0.09 → 0.09 × 3 × 90 = 24.3 → 25 credits.
    // It used to be 9 credits, and one credit cost us 0.9 ₽ vs 0.3 ₽ for
    // text — the same pool meant something different depending on the spend.
    expect(creditsForImageUsd(0.09)).toBe(25);
    expect(creditsForImageUsd(0.02)).toBe(6);
    expect(creditsForUsd(0.09)).toBe(9);       // old, markup-free formula
  });

  it('credit cost is now on par with text', () => {
    const usd = 0.09;
    const rubWePay = usd * USD_RUB;            // 8.1 ₽ goes to kie
    const perCredit = rubWePay / creditsForImageUsd(usd);
    expect(perCredit).toBeLessThan(0.35);      // for text it's ≈ 0.28 ₽
  });

  it('minimum one credit and protection from junk input', () => {
    expect(creditsForImageUsd(0.0001)).toBe(1);
    expect(creditsForImageUsd(0)).toBe(1);
    expect(creditsForImageUsd(Number.NaN)).toBe(1);
  });
});
