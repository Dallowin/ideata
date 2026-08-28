import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AeoTrackerProvisioningService } from './tracker-provisioning.service';

const RUN_AT = new Date('2026-08-28T10:00:00.000Z');

function analysis(overrides: Record<string, unknown> = {}) {
  return {
    id: 91,
    userId: 7,
    brandId: null,
    domain: 'acme.com',
    geo: 'us',
    status: 'done',
    createdAt: new Date('2026-08-28T09:00:00.000Z'),
    finishedAt: RUN_AT,
    llmOutputs: {
      aeo_snapshot: {
        prompts: [
          { prompt: 'best analytics platform', status: 'active' },
          { prompt: 'analytics for teams', status: 'active' },
        ],
        answers: [
          {
            platform: 'chatgpt',
            prompt: 'best analytics platform',
            text: 'Acme is visible.',
            brands_found: [{ brand: 'acme.com', pos: 1 }],
            citations: [{ url: 'https://example.com' }],
            judge: { score: 80 },
          },
          {
            platform: 'claude',
            prompt: 'analytics for teams',
            text: 'Try Acme.',
            brands_found: [],
            citations: [],
          },
        ],
        platforms: ['chatgpt', 'claude'],
        competitors: ['rival.io', 'acme.com'],
        sentiment: { 'acme.com': { positive: 1, neutral: 0, negative: 0 } },
      },
    },
    ...overrides,
  };
}

function harness(
  opts: {
    analysis?: ReturnType<typeof analysis>;
    tracker?: Record<string, any> | null;
  } = {},
) {
  const row = opts.analysis ?? analysis();
  const trackers: Record<string, any>[] = opts.tracker
    ? [{ ...opts.tracker }]
    : [];
  const answers: Record<string, any>[] = [];
  let nextTrackerId = 300;
  const brand = {
    id: 12,
    userId: 7,
    domain: 'acme.com',
    competitors: ['brand-rival.com'],
    geo: 'ge',
    language: 'en',
    isActive: true,
  };

  const tx: any = {
    $queryRaw: jest.fn(async () => [{ pg_advisory_xact_lock: null }]),
    brand: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.userId === brand.userId && where.domain === brand.domain
          ? brand
          : null,
      ),
    },
    aeoTracker: {
      findFirst: jest.fn(
        async ({ where }: any) =>
          trackers
            .filter(
              (tracker) =>
                tracker.userId === where.userId &&
                tracker.domain === where.domain,
            )
            .sort(
              (a, b) => Number(b.active) - Number(a.active) || b.id - a.id,
            )[0] ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const tracker = {
          id: nextTrackerId++,
          lastRunAt: null,
          runMeta: null,
          promptsLimit: null,
          ...data,
        };
        trackers.push(tracker);
        return { ...tracker };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const tracker = trackers.find((item) => item.id === where.id);
        if (!tracker) throw new Error('tracker not found');
        Object.assign(tracker, data);
        return { ...tracker };
      }),
    },
    aeoAnswer: {
      findMany: jest.fn(async ({ where }: any) =>
        answers
          .filter(
            (answer) =>
              answer.trackerId === where.trackerId &&
              answer.runAt.getTime() === where.runAt.getTime(),
          )
          .map(({ platform, prompt }) => ({ platform, prompt })),
      ),
      createMany: jest.fn(async ({ data }: any) => {
        const rows = Array.isArray(data) ? data : [data];
        answers.push(...rows.map((item) => ({ ...item })));
        return { count: rows.length };
      }),
    },
  };

  const matchesAnalysis = (where: any) => {
    if (where.id !== undefined && where.id !== row.id) return false;
    if (where.userId !== undefined && where.userId !== row.userId) return false;
    if (where.domain !== undefined && where.domain !== row.domain) return false;
    if (where.status !== undefined && where.status !== row.status) return false;
    return true;
  };
  let transactionTail: Promise<unknown> = Promise.resolve();
  const prisma: any = {
    siteAnalysis: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.id === row.id ? row : null,
      ),
      findFirst: jest.fn(async ({ where }: any) =>
        matchesAnalysis(where) ? row : null,
      ),
    },
    $transaction: jest.fn((fn: (client: any) => Promise<unknown>) => {
      const result = transactionTail.then(() => fn(tx));
      transactionTail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }),
  };
  return {
    service: new AeoTrackerProvisioningService(prisma),
    prisma,
    tx,
    trackers,
    answers,
  };
}

describe('AeoTrackerProvisioningService', () => {
  it('creates the tracker and atomically materializes the ready snapshot', async () => {
    const { service, trackers, answers, tx } = harness();

    const result = await service.provisionFromAnalysis(91);

    expect(result).toEqual({
      id: 300,
      tracker_id: 300,
      analysis_id: 91,
      created: true,
      materialized_answers: 2,
      status: 'done',
    });
    expect(trackers).toHaveLength(1);
    expect(trackers[0]).toMatchObject({
      userId: 7,
      brandId: 12,
      domain: 'acme.com',
      geo: 'ge',
      lang: 'en',
      active: true,
      competitors: ['rival.io'],
      platforms: ['chatgpt', 'claude'],
      lastRunAt: RUN_AT,
      runMeta: {
        micro_at: RUN_AT.toISOString(),
        full_at: RUN_AT.toISOString(),
      },
    });
    expect(trackers[0].prompts).toHaveLength(2);
    expect(trackers[0].runMeta).toEqual({
      micro_at: RUN_AT.toISOString(),
      full_at: RUN_AT.toISOString(),
    });
    expect(answers).toHaveLength(3);
    expect(answers.map((item) => item.platform)).toEqual([
      'chatgpt',
      'claude',
      '_sentiment',
    ]);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const [sql, lockUserId, lockDomain] = tx.$queryRaw.mock.calls[0];
    expect(sql.join('?')).toContain('?::int');
    expect(sql.join('?')).toContain('::text AS lock');
    expect(lockUserId).toBe(7);
    expect(lockDomain).toBe('acme.com');
  });

  it('is repeat-safe without relying on a database unique index', async () => {
    const { service, trackers, answers, tx } = harness();

    const first = await service.provisionFromAnalysis(91);
    const second = await service.provisionFromAnalysis(91);

    expect(first?.materialized_answers).toBe(2);
    expect(second?.materialized_answers).toBe(0);
    expect(second?.created).toBe(false);
    expect(trackers).toHaveLength(1);
    expect(answers).toHaveLength(3);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('serializes concurrent recovery into one tracker and exactly one 59+sentiment run', async () => {
    const full = analysis();
    const snapshot = (full.llmOutputs as any).aeo_snapshot;
    snapshot.prompts = Array.from({ length: 10 }, (_, i) => ({
      prompt: `audience prompt ${i}`,
      status: 'active',
    }));
    snapshot.platforms = Array.from({ length: 7 }, (_, i) => `platform-${i}`);
    snapshot.answers = Array.from({ length: 59 }, (_, i) => ({
      platform: snapshot.platforms[i % snapshot.platforms.length],
      prompt: `audience answer prompt ${i}`,
      text: `answer ${i}`,
      brands_found: [],
      citations: [],
    }));
    const { service, trackers, answers } = harness({ analysis: full });

    await Promise.all([
      service.provisionFromAnalysis(91),
      service.provisionFromAnalysis(91),
      service.provisionForUser({
        userId: 7,
        domain: 'acme.com',
        analysisId: 91,
      }),
    ]);

    expect(trackers).toHaveLength(1);
    expect(answers).toHaveLength(60);
    expect(
      answers.filter((item) => item.platform === '_sentiment'),
    ).toHaveLength(1);
  });

  it('reactivates an existing tracker, links its brand, and preserves custom panel/platforms', async () => {
    const { service, trackers, answers } = harness({
      tracker: {
        id: 44,
        userId: 7,
        brandId: null,
        domain: 'acme.com',
        competitors: ['old.example'],
        prompts: [{ prompt: 'custom prompt', status: 'active' }],
        platforms: ['perplexity'],
        geo: 'us',
        lang: null,
        active: false,
        lastRunAt: null,
        runMeta: {
          micro_at: '2026-08-29T10:00:00.000Z',
          mid_at: '2026-01-01T00:00:00.000Z',
        },
      },
    });

    const result = await service.provisionFromAnalysis(91);

    expect(result?.created).toBe(false);
    expect(trackers).toHaveLength(1);
    expect(trackers[0]).toMatchObject({
      id: 44,
      active: true,
      brandId: 12,
      geo: 'ge',
      lang: 'en',
      prompts: [{ prompt: 'custom prompt', status: 'active' }],
      platforms: ['perplexity'],
      competitors: ['old.example'],
      runMeta: {
        micro_at: '2026-08-29T10:00:00.000Z',
        mid_at: '2026-01-01T00:00:00.000Z',
        full_at: RUN_AT.toISOString(),
      },
    });
    expect(answers).toHaveLength(3);
    expect(trackers[0].runMeta).toEqual({
      micro_at: '2026-08-29T10:00:00.000Z',
      mid_at: '2026-01-01T00:00:00.000Z',
      full_at: RUN_AT.toISOString(),
    });
  });

  it('explicit provisioning validates analysis owner, status, and domain', async () => {
    const { service, prisma } = harness();

    await expect(
      service.provisionForUser({
        userId: 8,
        domain: 'acme.com',
        analysisId: 91,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.provisionForUser({
        userId: 7,
        domain: 'other.com',
        analysisId: 91,
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects malformed identifiers before Prisma and an analysis without a ready snapshot', async () => {
    const invalid = harness();
    await expect(
      invalid.service.provisionForUser({
        userId: 7,
        domain: 'acme.com',
        analysisId: '91',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      invalid.service.provisionForUser({ userId: 7, domain: 'not-a-domain' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(invalid.prisma.siteAnalysis.findFirst).not.toHaveBeenCalled();

    const missing = harness({
      analysis: analysis({ llmOutputs: { plan: [] } }),
    });
    await expect(missing.service.provisionFromAnalysis(91)).resolves.toBeNull();
    await expect(
      missing.service.provisionForUser({ userId: 7, analysisId: 91 }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(missing.trackers).toHaveLength(0);
    expect(missing.answers).toHaveLength(0);
    expect(missing.prisma.$transaction).not.toHaveBeenCalled();
  });
});
