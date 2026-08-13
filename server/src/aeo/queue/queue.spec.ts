/**
 * AEO queue scheduler — the single MOST MONEY-SENSITIVE code without tests
 * (decides which trackers and profiles go into a paid run today). Tests freeze
 * `now` (passed as an argument, NOT Date.now) so the quota math is deterministic.
 *
 * What's covered:
 *   • dueProfiles — PARITY with live Python jobs.due_profiles/_profile_scheduled
 *     (goldens captured from the reference oracle 2026-08-10; pure function):
 *     micro/mid/full/yandex schedules, catch-up runs across downtime,
 *     "don't run twice a day", "once";
 *   • enqueueRun — dedup by tracker's active job (findActiveAeoJob), stable
 *     jobId, shape of the scrape_jobs row (port of enqueue_aeo);
 *   • registerDailyScheduler — repeatable idempotency (a single DAILY_SCHEDULER_ID,
 *     dedup in Redis), hour from AEO_TRACK_HOUR;
 *   • runDailyTick — fan-out across active trackers, per-tracker isolation.
 *
 * bullmq/ioredis are mocked (we don't spin up Redis), blogPrisma is a mock
 * accessor (we don't touch the DB). The real queue/scheduler code comes from ./queue.
 */

const mockPrisma = {
  $queryRawUnsafe: jest.fn(),
  scrapeJob: { create: jest.fn() },
  aeoTracker: { findMany: jest.fn() },
};
jest.mock('../../blogwriter/server/utils/prisma', () => ({
  blogPrisma: jest.fn(() => mockPrisma),
  setBlogPrisma: jest.fn(),
}));

// Same Queue instance across all constructions (queue.ts caches a singleton).
const mockQueue = {
  add: jest.fn(),
  upsertJobScheduler: jest.fn(),
  close: jest.fn(),
};
jest.mock('bullmq', () => ({
  Queue: jest.fn(() => mockQueue),
}));

const mockRedis = { on: jest.fn(), quit: jest.fn(), disconnect: jest.fn() };
jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn(() => mockRedis),
}));

import {
  dueProfiles,
  enqueueRun,
  findActiveAeoJob,
  registerDailyScheduler,
  registerWeeklyReportsScheduler,
  reportsHour,
  runDailyTick,
  trackerRunMeta,
  RUN_JOB,
  TICK_JOB,
  DAILY_SCHEDULER_ID,
  WEEKLY_REPORTS_JOB,
  WEEKLY_REPORTS_SCHEDULER_ID,
  type PlanRunCfg,
  type ResolveRun,
} from './queue';

/** Frozen day (noon UTC — regardless of the AEO_TRACK_HOUR gate). */
const day = (iso: string): Date => new Date(`${iso}T12:00:00.000Z`);
/** ISO run_meta timestamp in the same format run-job writes (runAt.toISOString()). */
const at = (iso: string): string => `${iso}T06:00:00.000Z`;

beforeEach(() => {
  jest.clearAllMocks();
  mockPrisma.$queryRawUnsafe.mockResolvedValue([]); // no active job by default
  mockPrisma.scrapeJob.create.mockResolvedValue({ id: 123 });
  mockPrisma.aeoTracker.findMany.mockResolvedValue([]);
  mockQueue.add.mockResolvedValue({ id: 'job' });
  mockQueue.upsertJobScheduler.mockResolvedValue(undefined);
  mockQueue.close.mockResolvedValue(undefined);
});

// ── dueProfiles: parity with live Python due_profiles ─────────────────────────
// Reference dates (weekday Mon=0..Sun=6, nth = (day-1)//7): 08-03 Mon nth0, 08-04 Tue,
// 08-05 Wed nth0, 08-17 Mon nth2, 08-19 Wed nth2.
describe('dueProfiles — parity with jobs.due_profiles (quota × timestamps, catch-up)', () => {
  const CASES: Array<{ cfg: PlanRunCfg; meta: Record<string, unknown>; date: string; got: string[]; note: string }> = [
    { cfg: { micro: 'daily' }, meta: {}, date: '2026-08-04', got: ['micro'], note: 'daily, not run yet' },
    { cfg: { micro: 'daily' }, meta: { micro_at: at('2026-08-04') }, date: '2026-08-04', got: [], note: 'daily, already today' },
    { cfg: { micro: 'daily' }, meta: { micro_at: at('2026-08-03') }, date: '2026-08-04', got: ['micro'], note: 'daily, ran yesterday' },
    { cfg: { micro: '2w' }, meta: {}, date: '2026-08-03', got: ['micro'], note: '2w on Mon' },
    { cfg: { micro: '2w' }, meta: {}, date: '2026-08-04', got: ['micro'], note: '2w on Tue → catch up to Mon' },
    { cfg: { micro: '2w' }, meta: { micro_at: at('2026-08-03') }, date: '2026-08-04', got: [], note: '2w Tue, ran Mon → covered' },
    { cfg: { micro: 'once' }, meta: {}, date: '2026-08-04', got: ['micro'], note: 'once, first time' },
    { cfg: { micro: 'once' }, meta: { micro_at: at('2026-07-01') }, date: '2026-08-04', got: [], note: 'once, already happened' },
    { cfg: { mid: '3w' }, meta: {}, date: '2026-08-05', got: ['mid'], note: '3w on Wed' },
    { cfg: { mid: '3w' }, meta: {}, date: '2026-08-04', got: ['mid'], note: '3w on Tue → catch up to Mon' },
    { cfg: { full_per_month: 1 }, meta: {}, date: '2026-08-03', got: ['full'], note: 'full×1, 1st Mon' },
    { cfg: { full_per_month: 1 }, meta: {}, date: '2026-08-17', got: ['full'], note: 'full×1, 3rd Mon empty → catch up to 1st Mon' },
    { cfg: { full_per_month: 1 }, meta: { full_at: at('2026-08-03') }, date: '2026-08-17', got: [], note: 'full×1, ran 1st Mon → covered' },
    { cfg: { full_per_month: 2 }, meta: {}, date: '2026-08-17', got: ['full'], note: 'full×2, 3rd Mon' },
    { cfg: { full_per_month: 4 }, meta: {}, date: '2026-08-17', got: ['full'], note: 'full×4, any Mon' },
    { cfg: { full_per_month: 2 }, meta: {}, date: '2026-08-05', got: ['full'], note: 'full×2 on Wed → catch up to 1st Mon' },
    { cfg: { full_per_month: 0 }, meta: {}, date: '2026-08-03', got: [], note: 'full×0 disabled' },
    { cfg: { yandex_per_month: 1 }, meta: {}, date: '2026-08-05', got: ['yandex'], note: 'yandex×1, 1st Wed' },
    { cfg: { yandex_per_month: 2 }, meta: {}, date: '2026-08-19', got: ['yandex'], note: 'yandex×2, 3rd Wed' },
    { cfg: { yandex_per_month: 1 }, meta: {}, date: '2026-08-19', got: ['yandex'], note: 'yandex×1, 3rd Wed empty → catch up to 1st Wed' },
    { cfg: { yandex_per_month: 2 }, meta: {}, date: '2026-08-03', got: ['yandex'], note: 'yandex×2 on Mon → catch up to last Wed' },
    {
      cfg: { micro: 'daily', mid: '3w', full_per_month: 2, yandex_per_month: 2 },
      meta: {},
      date: '2026-08-03',
      got: ['micro', 'mid', 'full', 'yandex'],
      note: 'combo on 1st Mon (yandex catches up from last month)',
    },
    {
      cfg: { micro: 'daily', mid: '3w', full_per_month: 2, yandex_per_month: 2 },
      meta: {},
      date: '2026-08-05',
      got: ['micro', 'mid', 'full', 'yandex'],
      note: 'combo on 1st Wed (full catches up from Mon)',
    },
    { cfg: {}, meta: {}, date: '2026-08-03', got: [], note: 'empty config — nothing' },
    { cfg: { micro: 'daily' }, meta: { micro_at: 'garbage' }, date: '2026-08-04', got: ['micro'], note: 'garbage timestamp → treated as never run' },
  ];

  it.each(CASES)('$note', ({ cfg, meta, date, got }) => {
    expect(dueProfiles(cfg, meta, day(date))).toEqual(got);
  });

  it('output order is canonical: micro, mid, full, yandex', () => {
    const out = dueProfiles(
      { micro: 'daily', mid: '3w', full_per_month: 4, yandex_per_month: 2 },
      {},
      day('2026-08-05'),
    );
    expect(out).toEqual(['micro', 'mid', 'full', 'yandex']);
  });

  it('runCfg/runMeta = null/undefined don\'t crash (empty plan → [])', () => {
    expect(dueProfiles(null, null, day('2026-08-03'))).toEqual([]);
    expect(dueProfiles(undefined, undefined, day('2026-08-03'))).toEqual([]);
  });
});

// ── trackerRunMeta: jsonb|string|null → flat object ────────────────────────────
describe('trackerRunMeta — jsonb|string|null → timestamps object', () => {
  it('object as-is; JSON string is parsed; garbage/array → {}', () => {
    expect(trackerRunMeta({ micro_at: 'x' })).toEqual({ micro_at: 'x' });
    expect(trackerRunMeta('{"mid_at":"y"}')).toEqual({ mid_at: 'y' });
    expect(trackerRunMeta('not json')).toEqual({});
    expect(trackerRunMeta(['a'])).toEqual({}); // array — not a dict
    expect(trackerRunMeta(null)).toEqual({});
  });
});

// ── findActiveAeoJob: dedup query for a tracker's active job ──────────────────
describe('findActiveAeoJob — tracker\'s active queued/running run, or null', () => {
  it('row exists → its id', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ id: 42 }]);
    expect(await findActiveAeoJob(7)).toBe(42);
    // trackerId goes out as a string (params::jsonb ->> is compared as text)
    expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(expect.any(String), '7');
  });
  it('empty → null', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
    expect(await findActiveAeoJob(7)).toBeNull();
  });
  it('SQL failed (no table / DB down) → null, does not throw (better an extra run)', async () => {
    mockPrisma.$queryRawUnsafe.mockRejectedValue(new Error('relation does not exist'));
    expect(await findActiveAeoJob(7)).toBeNull();
  });
});

// ── enqueueRun: dedup + enqueueing ────────────────────────────────────────────
describe('enqueueRun — dedup by active job + stable jobId (port of enqueue_aeo)', () => {
  it('no active job → creates scrape_jobs and enqueues job with jobId aeo:run:{id}', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
    mockPrisma.scrapeJob.create.mockResolvedValue({ id: 500 });

    const res = await enqueueRun({
      trackerId: 7,
      domain: 'brand.com',
      userId: 3,
      profiles: ['micro', 'full'],
      source: 'schedule',
    });

    expect(res).toEqual({ scrapeJobId: 500, enqueued: true });

    // scrape_jobs row: kind='aeo', status='queued', params with tracker_id+profiles
    const createArg = mockPrisma.scrapeJob.create.mock.calls[0][0];
    expect(createArg.data).toMatchObject({ kind: 'aeo', status: 'queued', userId: 3 });
    expect(JSON.parse(createArg.data.params)).toEqual({ tracker_id: 7, profiles: ['micro', 'full'] });

    // 'run' job with a stable jobId and no auto-retry (attempts:1 — a paid run)
    expect(mockQueue.add).toHaveBeenCalledTimes(1);
    const [jobName, data, opts] = mockQueue.add.mock.calls[0];
    expect(jobName).toBe(RUN_JOB);
    expect(data).toMatchObject({ trackerId: 7, scrapeJobId: 500, profiles: ['micro', 'full'], source: 'schedule' });
    expect(opts).toMatchObject({ jobId: 'aeo:run:500', attempts: 1 });
  });

  it('tracker already has an active job → enqueues NOTHING, rides along on it (enqueued=false)', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([{ id: 55 }]); // active run
    const res = await enqueueRun({ trackerId: 7, domain: 'brand.com' });
    expect(res).toEqual({ scrapeJobId: 55, enqueued: false });
    expect(mockPrisma.scrapeJob.create).not.toHaveBeenCalled();
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it('no profiles → params without the profiles key, data.profiles=undefined (manual micro+mid)', async () => {
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
    mockPrisma.scrapeJob.create.mockResolvedValue({ id: 9 });
    await enqueueRun({ trackerId: 4, domain: 'x.io' });
    const createArg = mockPrisma.scrapeJob.create.mock.calls[0][0];
    expect(JSON.parse(createArg.data.params)).toEqual({ tracker_id: 4 });
    expect(mockQueue.add.mock.calls[0][1].profiles).toBeUndefined();
  });
});

// ── registerDailyScheduler: repeatable idempotency ────────────────────────────
describe('registerDailyScheduler — a single DAILY_SCHEDULER_ID (dedup in Redis)', () => {
  const prevHour = process.env.AEO_TRACK_HOUR;
  afterEach(() => {
    if (prevHour === undefined) delete process.env.AEO_TRACK_HOUR;
    else process.env.AEO_TRACK_HOUR = prevHour;
  });

  it('cron 0 {AEO_TRACK_HOUR} * * * UTC, name=tick, stable id', async () => {
    delete process.env.AEO_TRACK_HOUR; // default 6
    await registerDailyScheduler();
    expect(mockQueue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    const [id, repeat, template] = mockQueue.upsertJobScheduler.mock.calls[0];
    expect(id).toBe(DAILY_SCHEDULER_ID);
    expect(repeat).toEqual({ pattern: '0 6 * * *', tz: 'UTC' });
    expect(template).toMatchObject({ name: TICK_JOB });
  });

  it('repeat call — SAME id (repeatable dedups in Redis, no duplicates)', async () => {
    delete process.env.AEO_TRACK_HOUR;
    await registerDailyScheduler();
    await registerDailyScheduler();
    expect(mockQueue.upsertJobScheduler).toHaveBeenCalledTimes(2);
    expect(mockQueue.upsertJobScheduler.mock.calls[0][0]).toBe(DAILY_SCHEDULER_ID);
    expect(mockQueue.upsertJobScheduler.mock.calls[1][0]).toBe(DAILY_SCHEDULER_ID);
  });

  it('AEO_TRACK_HOUR changes the cron hour', async () => {
    process.env.AEO_TRACK_HOUR = '9';
    await registerDailyScheduler();
    expect(mockQueue.upsertJobScheduler.mock.calls[0][1]).toEqual({ pattern: '0 9 * * *', tz: 'UTC' });
  });
});

// ── registerWeeklyReportsScheduler: weekly mailing (Monday) ──────────────────
describe('registerWeeklyReportsScheduler — repeatable Monday (dedup in Redis)', () => {
  const prevHour = process.env.AEO_TRACK_HOUR;
  const prevOff = process.env.REPORTS_HOUR_OFFSET;
  afterEach(() => {
    if (prevHour === undefined) delete process.env.AEO_TRACK_HOUR;
    else process.env.AEO_TRACK_HOUR = prevHour;
    if (prevOff === undefined) delete process.env.REPORTS_HOUR_OFFSET;
    else process.env.REPORTS_HOUR_OFFSET = prevOff;
  });

  it('reportsHour = AEO_TRACK_HOUR + REPORTS_HOUR_OFFSET (default 6+3=9)', () => {
    delete process.env.AEO_TRACK_HOUR;
    delete process.env.REPORTS_HOUR_OFFSET;
    expect(reportsHour()).toBe(9);
    process.env.AEO_TRACK_HOUR = '6';
    process.env.REPORTS_HOUR_OFFSET = '4';
    expect(reportsHour()).toBe(10);
  });

  it('cron 0 {reportsHour} * * 1 (Monday) UTC, name=reports-tick, stable id', async () => {
    delete process.env.AEO_TRACK_HOUR; // 6
    delete process.env.REPORTS_HOUR_OFFSET; // 3 → hour 9
    await registerWeeklyReportsScheduler();
    expect(mockQueue.upsertJobScheduler).toHaveBeenCalledTimes(1);
    const [id, repeat, template] = mockQueue.upsertJobScheduler.mock.calls[0];
    expect(id).toBe(WEEKLY_REPORTS_SCHEDULER_ID);
    expect(repeat).toEqual({ pattern: '0 9 * * 1', tz: 'UTC' }); // '* * 1' — Monday
    expect(template).toMatchObject({ name: WEEKLY_REPORTS_JOB });
  });

  it('repeat call — SAME id (repeatable dedups, no duplicates)', async () => {
    await registerWeeklyReportsScheduler();
    await registerWeeklyReportsScheduler();
    expect(mockQueue.upsertJobScheduler.mock.calls[0][0]).toBe(WEEKLY_REPORTS_SCHEDULER_ID);
    expect(mockQueue.upsertJobScheduler.mock.calls[1][0]).toBe(WEEKLY_REPORTS_SCHEDULER_ID);
  });
});

// ── runDailyTick: fan-out across active trackers ──────────────────────────────
describe('runDailyTick — owner plan → today\'s profiles → enqueueRun (dedup)', () => {
  it('enqueues only due trackers; active one is deduped; count = actually enqueued', async () => {
    mockPrisma.aeoTracker.findMany.mockResolvedValue([
      { id: 1, domain: 'a.com', userId: 10, runMeta: {} }, // due micro, no active job → enqueue
      { id: 2, domain: 'b.com', userId: 20, runMeta: {} }, // empty plan → no profiles → skip
      { id: 3, domain: 'c.com', userId: 30, runMeta: {} }, // due micro, but has an active job → dedup
    ]);
    // plan: user 20 — no schedule; the rest — daily
    const resolveRun: ResolveRun = jest.fn(async (uid) => (uid === 20 ? {} : { micro: 'daily' }));
    // only tracker 3 has an active job (findActiveAeoJob sends String(trackerId))
    mockPrisma.$queryRawUnsafe.mockImplementation(async (_sql: string, tid: string) =>
      tid === '3' ? [{ id: 903 }] : [],
    );
    mockPrisma.scrapeJob.create.mockResolvedValue({ id: 700 });

    const queued = await runDailyTick(resolveRun, day('2026-08-10')); // Mon — micro daily due

    expect(queued).toBe(1); // tracker 1 only
    expect(resolveRun).toHaveBeenCalledTimes(3); // plan resolved for each
    expect(mockPrisma.scrapeJob.create).toHaveBeenCalledTimes(1); // only tracker 1 created a row
    const createArg = mockPrisma.scrapeJob.create.mock.calls[0][0];
    expect(JSON.parse(createArg.data.params)).toEqual({ tracker_id: 1, profiles: ['micro'] });
    expect(mockQueue.add).toHaveBeenCalledTimes(1);
    expect(mockQueue.add.mock.calls[0][1]).toMatchObject({ trackerId: 1, source: 'schedule' });
  });

  it('failure on one tracker is isolated — the rest still get enqueued', async () => {
    mockPrisma.aeoTracker.findMany.mockResolvedValue([
      { id: 1, domain: 'a.com', userId: 10, runMeta: {} },
      { id: 2, domain: 'b.com', userId: 20, runMeta: {} },
    ]);
    // resolving the plan for user 10 throws — tracker 1 should be skipped without killing the tick
    const resolveRun: ResolveRun = jest.fn(async (uid) => {
      if (uid === 10) throw new Error('plan resolution failed');
      return { micro: 'daily' };
    });
    mockPrisma.$queryRawUnsafe.mockResolvedValue([]);
    mockPrisma.scrapeJob.create.mockResolvedValue({ id: 800 });

    const queued = await runDailyTick(resolveRun, day('2026-08-10'));
    expect(queued).toBe(1); // tracker 2 went through
    expect(mockPrisma.scrapeJob.create).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockPrisma.scrapeJob.create.mock.calls[0][0].data.params).tracker_id).toBe(2);
  });

  it('tracker list not read (DB down) → 0, tick does not crash', async () => {
    mockPrisma.aeoTracker.findMany.mockRejectedValue(new Error('db down'));
    const resolveRun: ResolveRun = jest.fn(async () => ({ micro: 'daily' }));
    expect(await runDailyTick(resolveRun, day('2026-08-10'))).toBe(0);
    expect(mockQueue.add).not.toHaveBeenCalled();
  });

  it('no tracker is due (once plan already ran) → 0 enqueued', async () => {
    mockPrisma.aeoTracker.findMany.mockResolvedValue([
      { id: 1, domain: 'a.com', userId: 10, runMeta: { micro_at: at('2026-07-01') } },
    ]);
    const resolveRun: ResolveRun = jest.fn(async () => ({ micro: 'once' }));
    expect(await runDailyTick(resolveRun, day('2026-08-10'))).toBe(0);
    expect(mockPrisma.scrapeJob.create).not.toHaveBeenCalled();
  });
});
