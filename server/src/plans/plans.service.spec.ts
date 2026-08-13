import { PlanService, PLAN_DEFAULTS, deepMerge } from './plans.service';

/** Mock PrismaService: programmable $queryRawUnsafe by SQL prefix. */
function mkPrisma(handlers: {
  userPlan?: (uid: number) => any[];
  planConfig?: (slug: string) => any[];
  throwOn?: 'userPlan' | 'planConfig';
}) {
  return {
    $queryRawUnsafe: jest.fn((sql: string, ...params: any[]) => {
      if (sql.includes('FROM user_plans')) {
        if (handlers.throwOn === 'userPlan') throw new Error('db down');
        return Promise.resolve(handlers.userPlan?.(params[0]) ?? []);
      }
      if (sql.includes('FROM plans')) {
        if (handlers.throwOn === 'planConfig') throw new Error('no table');
        return Promise.resolve(handlers.planConfig?.(params[0]) ?? []);
      }
      return Promise.resolve([]);
    }),
  } as any;
}

describe('deepMerge', () => {
  it('merges nested dicts and replaces arrays/scalars without mutating base', () => {
    const base = {
      a: 1,
      run: { micro: 'daily', mid: '3w' },
      export: ['csv', 'xlsx'],
    };
    const out = deepMerge(base, {
      a: 2,
      run: { micro: 'once' },
      export: ['csv'],
    });
    expect(out).toEqual({
      a: 2,
      run: { micro: 'once', mid: '3w' },
      export: ['csv'],
    });
    // base is not mutated
    expect(base.a).toBe(1);
    expect(base.run.micro).toBe('daily');
    expect(base.export).toEqual(['csv', 'xlsx']);
  });
});

describe('PLAN_DEFAULTS', () => {
  it('carries the canonical prompt pools and api gate', () => {
    expect(PLAN_DEFAULTS.free.prompts_pool).toBe(10);
    expect(PLAN_DEFAULTS.lite.prompts_pool).toBe(25);
    expect(PLAN_DEFAULTS.pro.prompts_pool).toBe(50);
    expect(PLAN_DEFAULTS.scale.prompts_pool).toBe(125);
    expect(PLAN_DEFAULTS.scale.api_access).toBe(true);
    expect(PLAN_DEFAULTS.pro.api_access).toBe(false);
  });
});

describe('PlanService.getUserPlanRow', () => {
  it('returns the active plan for an active, non-expired row', async () => {
    const svc = new PlanService(
      mkPrisma({
        userPlan: () => [
          {
            plan: 'pro',
            status: 'active',
            expires_at: null,
            addons: { extra_prompts: 5 },
            free_run_at: null,
          },
        ],
      }),
    );
    const row = await svc.getUserPlanRow(42);
    expect(row.plan).toBe('pro');
    expect(row.rawPlan).toBe('pro');
    expect(row.addons).toEqual({ extra_prompts: 5 });
  });

  it('degrades an expired subscription to free', async () => {
    const svc = new PlanService(
      mkPrisma({
        userPlan: () => [
          {
            plan: 'pro',
            status: 'active',
            expires_at: new Date(Date.now() - 86400000),
            addons: {},
            free_run_at: null,
          },
        ],
      }),
    );
    const row = await svc.getUserPlanRow(42);
    expect(row.plan).toBe('free');
    expect(row.rawPlan).toBe('pro'); // raw slug is preserved
  });

  it('degrades a non-active status to free', async () => {
    const svc = new PlanService(
      mkPrisma({
        userPlan: () => [
          {
            plan: 'scale',
            status: 'canceled',
            expires_at: null,
            addons: {},
            free_run_at: null,
          },
        ],
      }),
    );
    expect((await svc.getUserPlanRow(42)).plan).toBe('free');
  });

  it('falls back to free for a missing row, no userId, or db error', async () => {
    const empty = new PlanService(mkPrisma({ userPlan: () => [] }));
    expect((await empty.getUserPlanRow(42)).plan).toBe('free');
    const noUser = new PlanService(mkPrisma({}));
    expect((await noUser.getUserPlanRow(undefined)).plan).toBe('free');
    const down = new PlanService(mkPrisma({ throwOn: 'userPlan' }));
    expect((await down.getUserPlanRow(42)).plan).toBe('free');
  });
});

describe('PlanService.getPlanConfig', () => {
  it('applies a partial db override via deep-merge', async () => {
    const svc = new PlanService(
      mkPrisma({
        planConfig: () => [
          { config: { prompts_pool: 999, run: { micro: 'once' } } },
        ],
      }),
    );
    const cfg = await svc.getPlanConfig('pro');
    expect(cfg.prompts_pool).toBe(999);
    expect(cfg.run.micro).toBe('once'); // overridden
    expect(cfg.run.mid).toBe('3w'); // kept from default
    expect(cfg.brands_max).toBe(2); // untouched
  });

  it('returns pure defaults with no override and free for unknown slug', async () => {
    const svc = new PlanService(mkPrisma({ planConfig: () => [] }));
    expect((await svc.getPlanConfig('scale')).prompts_pool).toBe(125);
    expect((await svc.getPlanConfig('bogus')).prompts_pool).toBe(10); // free
  });

  it('falls back to defaults when the plans table errors', async () => {
    const svc = new PlanService(mkPrisma({ throwOn: 'planConfig' }));
    expect((await svc.getPlanConfig('pro')).prompts_pool).toBe(50);
  });
});

describe('PlanService.resolveLimits', () => {
  it('resolves base pro limits', async () => {
    const svc = new PlanService(
      mkPrisma({
        userPlan: () => [
          {
            plan: 'pro',
            status: 'active',
            expires_at: null,
            addons: {},
            free_run_at: null,
          },
        ],
        planConfig: () => [],
      }),
    );
    const lim = await svc.resolveLimits(42);
    expect(lim.prompts).toBe(50);
    expect(lim.brands).toBe(2);
    expect(lim.postsPerDay).toBe(2);
    expect(lim.blogEnabled).toBe(true);
    expect(lim.apiAccess).toBe(false);
    expect(lim.seats).toBeNull();
    expect(lim.run.full_per_month).toBe(2);
  });

  it('opens the blog writer on free by default (ceiling is credits, not posts_per_day)', async () => {
    const svc = new PlanService(
      mkPrisma({
        userPlan: () => [
          {
            plan: 'free',
            status: 'active',
            expires_at: null,
            addons: {},
            free_run_at: null,
          },
        ],
        planConfig: () => [],
      }),
    );
    const lim = await svc.resolveLimits(42);
    expect(lim.blogEnabled).toBe(true);
    expect(lim.credits).toBe(100);
  });

  it('applies addons: extra prompts and blog_addon opening a plan without posts', async () => {
    const svc = new PlanService(
      mkPrisma({
        userPlan: () => [
          {
            // lite is the only plan with posts_per_day: 0, so this is where we
            // test the addon branch (free's blog is open by default)
            plan: 'lite',
            status: 'active',
            expires_at: null,
            addons: { extra_prompts: 15, extra_brands: 1, blog_addon: true },
            free_run_at: null,
          },
        ],
        planConfig: () => [],
      }),
    );
    const lim = await svc.resolveLimits(42);
    expect(lim.prompts).toBe(40); // 25 + 15
    expect(lim.brands).toBe(2); // 1 + 1
    expect(lim.blogEnabled).toBe(true); // addon opened the blog
    expect(lim.postsPerDay).toBe(1); // base 0 → 1
  });
});
