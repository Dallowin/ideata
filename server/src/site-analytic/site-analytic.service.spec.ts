/**
 * Tests for the top-level orchestrator: pipeline composition
 * (collect→normalize→LLM layer→AEO snapshot→guide), per-run DataForSEO cost
 * accounting → facts.meta.cost_usd, the runAnalysis flow (cache/coalescing/
 * writing to site_analyses) on mock Prisma, and the ISO week.
 */
import { HttpException } from '@nestjs/common';
import { SiteAnalyticService } from './site-analytic.service';
import { dfsCostCtx } from '../discover/cost-context';
import type { LlmLayer } from './llm-layer';

const noopLlm: LlmLayer = {
  runLlmLayer: async () => ({ merge: {}, outputs: {} }),
  runAeoSnapshot: async () => null,
  contentGuide: async () => null,
};

/** Mock PlanService: the plan's brand limit. Doesn't gate by default (huge). */
function mkPlans(brands = 999999, title = 'Test'): any {
  return { resolveLimits: jest.fn(async () => ({ brands, title })) };
}

/** Catches a thrown error (to check the HttpException status). */
async function catchErr(fn: () => Promise<unknown>): Promise<any> {
  try {
    await fn();
  } catch (e) {
    return e;
  }
  throw new Error('expected an exception, but none was thrown');
}

function mkClients() {
  const dfs: any = {
    domainOverview: jest.fn(async () => null),
    historicalOverview: jest.fn(async () => null),
    domainKeywords: jest.fn(async () => null),
    domainPages: jest.fn(async () => null),
    domainCompetitors: jest.fn(async () => null),
    domainBacklinks: jest.fn(async () => null),
    backlinksAnchors: jest.fn(async () => null),
    backlinksHistory: jest.fn(async () => null),
    domainTechnologies: jest.fn(async () => null),
    domainGapKeywords: jest.fn(async () => null),
  };
  const keysso: any = {
    domainOverview: jest.fn(async () => ({ total_traffic: 1000, organic_etv: 1000, paid_etv: 0, organic_keywords: 5 })),
    domainKeywords: jest.fn(async () => []),
    domainCompetitors: jest.fn(async () => []),
  };
  const site: any = {
    similarweb: jest.fn(async () => null), pagespeed: jest.fn(async () => null),
    entity: jest.fn(async () => null), crawl: jest.fn(async () => null),
    ads: jest.fn(async () => null), youtube: jest.fn(async () => null),
    yandexSerp: jest.fn(async () => null), news: jest.fn(async () => null),
  };
  return { dfs, keysso, site };
}

function mkService(prisma: any, llm: LlmLayer = noopLlm, clients = mkClients(), plans: any = mkPlans()) {
  const svc = new SiteAnalyticService(prisma, clients.dfs, clients.keysso, clients.site, llm, plans);
  return { svc, plans, ...clients };
}

describe('weekKey — ISO week UTC', () => {
  const { svc } = mkService({});
  it.each([
    ['2026-01-01T12:00:00Z', '2026-W01'], // Thursday = W01
    ['2025-12-29T00:00:00Z', '2026-W01'], // Monday → ISO week is already 2026
    ['2024-12-30T00:00:00Z', '2025-W01'], // year boundary, forward
    ['2023-01-01T00:00:00Z', '2022-W52'], // Sunday → last year's week
  ])('%s → %s', (iso, key) => {
    expect(svc.weekKey(new Date(iso))).toBe(key);
  });
});

describe('analyzeDomain — pipeline composition', () => {
  it('LLM merge + AEO block + competitor substitution + guide', async () => {
    const llm: LlmLayer = {
      runLlmLayer: async () => ({ merge: { plan: ['step'] }, outputs: { a: 1 } }),
      runAeoSnapshot: async () => ({
        block: { aiBrands: ['b'], sovSelf: 12 },
        run: { answers: [] },
        competitors: [{ domain: 'validated.com' }],
      }),
      contentGuide: async () => ({ diagnosis: 'd' }),
    };
    const { svc } = mkService({}, llm);
    const { facts, llmOutputs, costUsd } = await svc.analyzeDomain('shop.ru', { geo: 'ru' });

    expect(facts.plan).toEqual(['step']);        // LLM layer merged in
    expect(facts.aiBrands).toEqual(['b']);        // AEO block merged in
    expect(facts.competitors).toEqual([{ domain: 'validated.com' }]); // substitution
    expect(facts.aeoGuide).toEqual({ diagnosis: 'd' });
    expect(llmOutputs.a).toBe(1);
    expect(llmOutputs.aeo_snapshot).toEqual({ answers: [] });
    expect(facts.meta.cost_usd).toBe(costUsd);
  });

  it('DataForSEO cost is collected by a per-run meter → cost_usd', async () => {
    const clients = mkClients();
    // The client inside post() adds USD to the active meter (dfsCostCtx). Emulated here.
    clients.dfs.domainOverview = jest.fn(async (_d: string, geo: any) => {
      dfsCostCtx.getStore()?.addUsd(0.01);
      return geo?.locationCode === 2840
        ? { organic_etv: 5000, paid_etv: 0, total_traffic: 5000, organic_keywords: 10, pos_dist: { '1-3': 1 } }
        : null;
    });
    const { svc } = mkService({}, noopLlm, clients);

    const OLD = process.env.AA_GEO_MARKETS;
    process.env.AA_GEO_MARKETS = '3';
    try {
      const { costUsd, facts } = await svc.analyzeDomain('acme.com', { geo: 'us' });
      expect(clients.dfs.domainOverview).toHaveBeenCalledTimes(3);
      expect(costUsd).toBe(0.03); // 3 markets × $0.01, banker's rounding to 4 decimals
      expect(facts.meta.cost_usd).toBe(0.03);
    } finally {
      if (OLD === undefined) delete process.env.AA_GEO_MARKETS; else process.env.AA_GEO_MARKETS = OLD;
    }
  });
});

describe('runAnalysis — cache/coalescing/writes', () => {
  function mkPrisma() {
    return {
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn().mockResolvedValue(0),
      siteAnalysis: {
        create: jest.fn().mockResolvedValue({ id: 42 }),
        update: jest.fn().mockResolvedValue({}),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
      },
    };
  }

  // The run is detached into the background (runAnalysis returns queued right
  // away); drain the microtask/timer queue to wait for the background write of
  // running→done/error.
  const flush = async () => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  };

  it('weekly cache hit → done, no row created', async () => {
    const prisma = mkPrisma();
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 7, user_id: null, compare_domain: null, status: 'done' }]);
    const { svc } = mkService(prisma);
    const res = await svc.runAnalysis({ domain: 'acme.com', geo: 'us' });
    expect(res).toEqual({ id: 7, status: 'done', cached: true });
    expect(prisma.siteAnalysis.create).not.toHaveBeenCalled();
  });

  it('an active run is in progress → coalescing', async () => {
    const prisma = mkPrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([])                                   // findCached
      .mockResolvedValueOnce([{ id: 8, user_id: null, status: 'running' }]); // findActive
    const { svc } = mkService(prisma);
    const res = await svc.runAnalysis({ domain: 'acme.com', geo: 'us' });
    expect(res).toEqual({ id: 8, status: 'running', cached: false, coalesced: true });
    expect(prisma.siteAnalysis.create).not.toHaveBeenCalled();
  });

  it('no cache/active → create → queued right away, background running → done with facts and cost_cents', async () => {
    const prisma = mkPrisma();
    const { svc } = mkService(prisma); // keysso branch (shop.ru), llm no-op
    const res = await svc.runAnalysis({ domain: 'shop.ru' });
    // Detach: the response is queued immediately (the client polls GET /analyses/:id).
    expect(res).toEqual({ id: 42, status: 'queued', cached: false });
    expect(prisma.siteAnalysis.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'queued', domain: 'shop.ru', geo: 'ru' }) }),
    );

    await flush(); // wait for the background write of done
    const doneCall = prisma.siteAnalysis.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.status === 'done',
    );
    expect(doneCall).toBeTruthy();
    expect(doneCall[0].data.progress).toBe(100);
    expect(doneCall[0].data.facts).toBeTruthy();
    expect(typeof doneCall[0].data.costCents).toBe('number');
  });

  it('battle: pipeline error → the row is marked error (the detach does NOT propagate to the client)', async () => {
    const prisma = mkPrisma();
    const clients = mkClients();
    clients.keysso.domainOverview = jest.fn(async () => { throw new Error('unused'); }); // safe swallows it — not this path
    // Fail the finish write: update(done) throws — runPipeline catches it and writes error.
    prisma.siteAnalysis.update.mockImplementation(async (arg: any) =>
      arg?.data?.status === 'done' ? Promise.reject(new Error('db write failed')) : {});
    const { svc } = mkService(prisma, noopLlm, clients);
    // Detach: the POST doesn't fail from the pipeline error — the response is queued, the error goes into the row.
    const res = await svc.runAnalysis({ domain: 'shop.ru' });
    expect(res).toEqual({ id: 42, status: 'queued', cached: false });

    await flush();
    const errCall = prisma.siteAnalysis.update.mock.calls.find(
      (c: any[]) => c[0]?.data?.status === 'error',
    );
    expect(errCall).toBeTruthy();
  });

  it('plan brand limit exhausted → 402 before the cache, no row', async () => {
    const prisma = mkPrisma();
    prisma.$queryRaw.mockResolvedValueOnce([{ n: 1 }]); // countAnalysisDomainsForUser → 1
    const plans = mkPlans(1, 'Старт'); // brands = 1
    const { svc } = mkService(prisma, noopLlm, mkClients(), plans);
    const err = await catchErr(() =>
      svc.runAnalysis({ domain: 'new-brand.com', geo: 'us', userId: 5 }),
    );
    expect(err).toBeInstanceOf(HttpException);
    expect(err.getStatus()).toBe(402);
    expect(plans.resolveLimits).toHaveBeenCalledWith(5);
    expect(prisma.siteAnalysis.create).not.toHaveBeenCalled();
  });

  it('admin bypasses the brand limit (isAdmin) → create, limits not read', async () => {
    const prisma = mkPrisma();
    prisma.$queryRaw.mockResolvedValue([]); // findCached/findActive empty
    const plans = mkPlans(1, 'Старт'); // strict limit, but doesn't apply to admin
    const { svc } = mkService(prisma, noopLlm, mkClients(), plans);
    const res = await svc.runAnalysis({ domain: 'shop.ru', userId: 9, isAdmin: true });
    expect(res).toEqual({ id: 42, status: 'queued', cached: false });
    expect(plans.resolveLimits).not.toHaveBeenCalled();
    await flush(); // let the background run settle (avoid "logs after the test")
  });

  it('per-user quota exhausted → 429 after cache/coalescing, no row', async () => {
    const prisma = mkPrisma();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ n: 0 }]) // countAnalysisDomainsForUser (brand limit ok)
      .mockResolvedValueOnce([]) // findCached
      .mockResolvedValueOnce([]); // findActive
    prisma.siteAnalysis.count.mockResolvedValue(2); // countActive → 2
    const { svc } = mkService(prisma);
    const OLD = process.env.ANALYTIC_USER_QUOTA;
    process.env.ANALYTIC_USER_QUOTA = '2';
    try {
      const err = await catchErr(() =>
        svc.runAnalysis({ domain: 'acme.com', geo: 'us', userId: 5 }),
      );
      expect(err).toBeInstanceOf(HttpException);
      expect(err.getStatus()).toBe(429);
      expect(prisma.siteAnalysis.create).not.toHaveBeenCalled();
    } finally {
      if (OLD === undefined) delete process.env.ANALYTIC_USER_QUOTA;
      else process.env.ANALYTIC_USER_QUOTA = OLD;
    }
  });

  it('countAnalysisDomainsForUser: COUNT bigint → number, error → 0', async () => {
    const prisma = mkPrisma();
    const { svc } = mkService(prisma);
    prisma.$queryRaw.mockResolvedValueOnce([{ n: 3n }]); // Postgres COUNT → bigint
    expect(await svc.countAnalysisDomainsForUser(5, 'x.com')).toBe(3);
    prisma.$queryRaw.mockRejectedValueOnce(new Error('no table'));
    expect(await svc.countAnalysisDomainsForUser(5, 'x.com')).toBe(0);
  });

  it('reapStale: flips stale running/queued (executeRaw), error → 0, never throws', async () => {
    const prisma = mkPrisma();
    const { svc } = mkService(prisma);
    prisma.$executeRaw.mockResolvedValueOnce(3);
    expect(await svc.reapStale()).toBe(3);
    expect(prisma.$executeRaw).toHaveBeenCalled();
    prisma.$executeRaw.mockRejectedValueOnce(new Error('no table'));
    expect(await svc.reapStale()).toBe(0); // doesn't throw
  });
});
