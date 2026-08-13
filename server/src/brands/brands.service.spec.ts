import { BrandsService } from './brands.service';
import { PLAN_LIMIT_BRANDS_CODE } from '../plans/plan-limits';

/** Full brand row for toBrand(). */
function brandRow(over: Partial<any> = {}) {
  return {
    id: 1,
    userId: 42,
    domain: 'acme.com',
    name: 'Acme',
    description: null,
    competitors: [],
    geo: 'us',
    language: 'ru',
    topics: [],
    aliases: [],
    isActive: true,
    createdAt: new Date('2026-07-19T00:00:00.000Z'),
    ...over,
  };
}

/**
 * Prisma mock: findUnique is configurable, count is programmable, create/tx
 * return a ready-made row. $transaction supports both forms (callback for
 * create, array for setActive).
 */
function mkPrisma(opts: { existing?: any; count?: number } = {}) {
  const created = brandRow({ id: 7 });
  const tx = {
    brand: {
      create: jest.fn(() => Promise.resolve(created)),
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
      update: jest.fn(() => Promise.resolve(created)),
    },
  };
  return {
    _created: created,
    brand: {
      findUnique: jest.fn(() => Promise.resolve(opts.existing ?? null)),
      count: jest.fn(() => Promise.resolve(opts.count ?? 0)),
      create: jest.fn(() => Promise.resolve(created)),
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
      update: jest.fn(() => Promise.resolve(created)),
    },
    $transaction: jest.fn((arg: any) =>
      Array.isArray(arg) ? Promise.all(arg) : arg(tx),
    ),
  } as any;
}

/** PlanService mock: only resolveLimits matters for the brand limit. */
function mkPlans(brands: number, title = 'Бестселлер') {
  return {
    resolveLimits: jest.fn(() =>
      Promise.resolve({ brands, title, postsPerDay: 0 } as any),
    ),
  } as any;
}

describe('BrandsService.create — brand limit', () => {
  it('allows creation when brands are under the limit', async () => {
    const prisma = mkPrisma({ count: 1 });
    const plans = mkPlans(2);
    const svc = new BrandsService(prisma, plans);
    const b = await svc.create(42, { domain: 'new.com' });
    expect(b.id).toBe(7);
    expect(prisma.brand.count).toHaveBeenCalled();
    expect(prisma.brand.create).not.toHaveBeenCalled(); // creation goes through tx
  });

  it('throws PLAN_LIMIT_BRANDS when the limit is reached', async () => {
    const prisma = mkPrisma({ count: 2 });
    const plans = mkPlans(2, 'Бестселлер');
    const svc = new BrandsService(prisma, plans);
    expect.assertions(3);
    try {
      await svc.create(42, { domain: 'new.com' });
    } catch (e: any) {
      expect(e.extensions?.code).toBe(PLAN_LIMIT_BRANDS_CODE);
      expect(e.message).toBe('На тарифе Бестселлер доступно 2 бренда — расширьте тариф');
      expect(prisma.$transaction).not.toHaveBeenCalled(); // never got to creation
    }
  });

  it('limit=1 gives the singular "1 brand available" form', async () => {
    const prisma = mkPrisma({ count: 1 });
    const svc = new BrandsService(prisma, mkPlans(1, 'Старт'));
    await expect(svc.create(42, { domain: 'new.com' })).rejects.toThrow(
      'На тарифе Старт доступен 1 бренд — расширьте тариф',
    );
  });

  it('admin creates a brand over the limit (no plan check)', async () => {
    const prisma = mkPrisma({ count: 99 });
    const plans = mkPlans(1);
    const svc = new BrandsService(prisma, plans);
    const b = await svc.create(42, { domain: 'new.com' }, { isAdmin: true });
    expect(b.id).toBe(7);
    expect(plans.resolveLimits).not.toHaveBeenCalled();
    expect(prisma.brand.count).not.toHaveBeenCalled();
  });

  it('reactivating an existing brand does not consume the limit', async () => {
    const prisma = mkPrisma({ existing: brandRow({ id: 5 }), count: 99 });
    const plans = mkPlans(1);
    const svc = new BrandsService(prisma, plans);
    const b = await svc.create(42, { domain: 'acme.com' });
    expect(b.id).toBe(5);
    expect(plans.resolveLimits).not.toHaveBeenCalled(); // limit wasn't checked
    expect(prisma.brand.count).not.toHaveBeenCalled();
  });
});
