import type { Request } from 'express';
import { PostQuotaService, moscowDayStartIso } from './post-quota';
import { PLAN_LIMIT_POSTS_CODE } from '../plans/plan-limits';

describe('moscowDayStartIso — start of the Moscow day in UTC', () => {
  it('during the MSK daytime returns 21:00 UTC the previous day', () => {
    // 10:00 UTC = 13:00 MSK the same day → start of day 00:00 MSK = 21:00 UTC yesterday
    expect(moscowDayStartIso(new Date('2026-07-19T10:00:00.000Z'))).toBe(
      '2026-07-18T21:00:00.000Z',
    );
  });

  it('late evening UTC of the same MSK day gives the same boundary', () => {
    // 20:30 UTC = 23:30 MSK on the 19th → same boundary
    expect(moscowDayStartIso(new Date('2026-07-19T20:30:00.000Z'))).toBe(
      '2026-07-18T21:00:00.000Z',
    );
  });

  it('after 21:00 UTC it is already the next Moscow day', () => {
    // 21:30 UTC = 00:30 MSK on the 20th → boundary shifts to 21:00 UTC on the 19th
    expect(moscowDayStartIso(new Date('2026-07-19T21:30:00.000Z'))).toBe(
      '2026-07-19T21:00:00.000Z',
    );
  });
});

/** Mock Prisma for the run counter. */
function mkPrisma(runs: Array<{ id: string; group_id: string }>, brands = [{ id: 1 }]) {
  return {
    brand: { findMany: jest.fn(() => Promise.resolve(brands)) },
    blogRun: { findMany: jest.fn(() => Promise.resolve(runs)) },
  } as any;
}
function mkAuth(user: any) {
  return { userFromRequest: jest.fn(() => user) } as any;
}
function mkPlans(postsPerDay: number, title = 'Бестселлер') {
  return {
    resolveLimits: jest.fn(() => Promise.resolve({ postsPerDay, title, brands: 1 } as any)),
  } as any;
}
const REQ = {} as Request;

describe('PostQuotaService.assertCanStart — daily post limit', () => {
  it('allows under the limit (1 primary run < 2)', async () => {
    const plans = mkPlans(2);
    const svc = new PostQuotaService(
      mkAuth({ i: 42, a: false }),
      mkPrisma([{ id: 'a', group_id: 'a' }]),
      plans,
    );
    await expect(svc.assertCanStart(REQ)).resolves.toBeUndefined();
  });

  it('throws 429 PLAN_LIMIT_POSTS when the limit is exhausted', async () => {
    const svc = new PostQuotaService(
      mkAuth({ i: 42, a: false }),
      mkPrisma([
        { id: 'a', group_id: 'a' },
        { id: 'b', group_id: 'b' },
      ]),
      mkPlans(2, 'Бестселлер'),
    );
    expect.assertions(3);
    try {
      await svc.assertCanStart(REQ);
    } catch (e: any) {
      expect(e.getStatus()).toBe(429);
      expect(e.getResponse().code).toBe(PLAN_LIMIT_POSTS_CODE);
      expect(e.getResponse().message).toBe('Лимит 2 поста в день на тарифе Бестселлер');
    }
  });

  it('translations (group_id != id) do not count toward the limit', async () => {
    // 1 primary (a==a) + 1 translation (b!=x) → used=1 < 2 → passes
    const svc = new PostQuotaService(
      mkAuth({ i: 42, a: false }),
      mkPrisma([
        { id: 'a', group_id: 'a' },
        { id: 'b', group_id: 'x' },
      ]),
      mkPlans(2),
    );
    await expect(svc.assertCanStart(REQ)).resolves.toBeUndefined();
  });

  it('admin — no limit (resolveLimits is not called)', async () => {
    const plans = mkPlans(0);
    const svc = new PostQuotaService(
      mkAuth({ i: 1, a: true }),
      mkPrisma([{ id: 'a', group_id: 'a' }]),
      plans,
    );
    await expect(svc.assertCanStart(REQ)).resolves.toBeUndefined();
    expect(plans.resolveLimits).not.toHaveBeenCalled();
  });

  it('no user — does not throw (decision deferred to PlanGuard)', async () => {
    const plans = mkPlans(2);
    const svc = new PostQuotaService(mkAuth(null), mkPrisma([]), plans);
    await expect(svc.assertCanStart(REQ)).resolves.toBeUndefined();
    expect(plans.resolveLimits).not.toHaveBeenCalled();
  });

  it('user has no brands — count is 0, limit does not block the first post', async () => {
    const svc = new PostQuotaService(
      mkAuth({ i: 42, a: false }),
      mkPrisma([], []),
      mkPlans(1),
    );
    await expect(svc.assertCanStart(REQ)).resolves.toBeUndefined();
  });

  it('quota is by the OWNER of the run brand (a member spends the owner quota)', async () => {
    // A member (id=42) starts a run in the owner's brand (id=7). Prisma:
    // findUnique of brand 99 → owner 7; findMany of owner 7's brands → [{id:99}];
    // owner's runs today: 2 primary → used=2 >= perDay=2 → 429.
    const prisma = {
      brand: {
        findUnique: jest.fn(() => Promise.resolve({ userId: 7 })),
        findMany: jest.fn(() => Promise.resolve([{ id: 99 }])),
      },
      blogRun: {
        findMany: jest.fn(() =>
          Promise.resolve([
            { id: 'a', group_id: 'a' },
            { id: 'b', group_id: 'b' },
          ]),
        ),
      },
    } as any;
    const plans = mkPlans(2, 'Бестселлер');
    const svc = new PostQuotaService(mkAuth({ i: 42, a: false }), prisma, plans);
    await expect(svc.assertCanStart(REQ, 99)).rejects.toThrow(
      'Лимит 2 поста в день на тарифе Бестселлер',
    );
    // limit and usage were computed for owner 7, not for member 42
    expect(plans.resolveLimits).toHaveBeenCalledWith(7);
    expect(prisma.brand.findMany).toHaveBeenCalledWith({
      where: { userId: 7 },
      select: { id: true },
    });
  });
});
