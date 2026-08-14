/**
 * Credits: estimate before the call, charge after the fact. The catalog is
 * mocked — the price shouldn't depend on what the live catalog happens to
 * return today. Credits are computed from the OFFICIAL price (see
 * official-price.spec).
 */
import { CreditsService, USD_RUB, creditsForImageUsd, creditsForUsd } from './credits.service';

jest.mock('../blogwriter/server/utils/modelCatalog', () => ({
  getUnifiedCatalog: jest.fn(async () => ({
    models: [
      { id: 'anthropic/claude-sonnet-5', label: 'Sonnet', provider: 'anthropic', format: 'claude', inUsd: 3, outUsd: 15, desc: '', context: null },
      { id: 'openai/gpt-5-mini', label: 'GPT-5 Mini', provider: 'openrouter', format: 'openai', inUsd: 0.25, outUsd: 2, desc: '', context: null },
    ],
    source: 'snapshot' as const,
    at: '2026-07-26T00:00:00.000Z',
  })),
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

  it('a bare slug costs the same as the vendor-prefixed one — the route does not change the price', async () => {
    const { svc } = mkService();
    await expect(svc.estimateAsk('claude-sonnet-5')).resolves.toBe(4);
  });

  it('model outside the catalog → a conservative estimate, not zero', async () => {
    const { svc } = mkService();
    await expect(svc.estimateAsk('неизвестная/модель')).resolves.toBe(2);
    await expect(svc.estimateAsk(null)).resolves.toBe(2);
  });
});

describe('balance — accounting is not wired in this build', () => {
  it('reports a degraded balance instead of guessing a pool', async () => {
    const { svc, prisma } = mkService({ plan: 'free', pool: 100, spent: 100 });
    await expect(svc.balance(1)).resolves.toMatchObject({
      pool: 0, granted: 0, spent: 0, balance: 0, degraded: true,
    });
    // no ledger to read: the journal query is never issued
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  it('the plan still comes from the plan service', async () => {
    const { svc, plans } = mkService({ plan: 'pro' });
    await expect(svc.balance(1)).resolves.toMatchObject({ plan: 'pro' });
    expect(plans.resolveLimits).toHaveBeenCalledWith(1);
  });
});

describe('assertEnough — gate before hitting the model', () => {
  it('degraded accounting does not block the product, however large the ask', async () => {
    const { svc } = mkService({ pool: 100, spent: 10 });
    await expect(svc.assertEnough(1, 5)).resolves.toMatchObject({ degraded: true });
    await expect(svc.assertEnough(1, 999_999)).resolves.toMatchObject({ degraded: true });
  });

  it('survives a dead journal the same way', async () => {
    const { svc } = mkService({ pool: 10, dbFails: true });
    await expect(svc.assertEnough(1, 999)).resolves.toMatchObject({ degraded: true });
  });
});

describe('chargeRub — charging at actual cost', () => {
  it('writes a negative row, rounding up to a credit', async () => {
    const { svc, inserts } = mkService();
    await expect(svc.chargeRub(7, 0.82, 'ask', 'anthropic/claude-sonnet-5')).resolves.toBe(1);
    await expect(svc.chargeRub(7, 3.2, 'ask', 'anthropic/claude-sonnet-5')).resolves.toBe(4);
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
    // an image at $0.09 → 0.09 × 3 × 90 = 24.3 → 25 credits. Without the
    // multiplier it would be 9, and the same pool would mean something
    // different depending on whether it went on text or on pictures.
    expect(creditsForImageUsd(0.09)).toBe(25);
    expect(creditsForImageUsd(0.02)).toBe(6);
    expect(creditsForUsd(0.09)).toBe(9);       // markup-free formula
  });

  it('one credit stands for the same amount on images as on text', () => {
    const usd = 0.09;
    const rubPerImage = usd * USD_RUB;         // 8.1 ₽ at the vendor's price
    const perCredit = rubPerImage / creditsForImageUsd(usd);
    expect(perCredit).toBeLessThan(0.35);      // for text it's ≈ 0.28 ₽
  });

  it('minimum one credit and protection from junk input', () => {
    expect(creditsForImageUsd(0.0001)).toBe(1);
    expect(creditsForImageUsd(0)).toBe(1);
    expect(creditsForImageUsd(Number.NaN)).toBe(1);
  });
});
