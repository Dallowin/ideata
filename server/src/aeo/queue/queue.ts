/**
 * AEO run queue on BullMQ + ioredis — infrastructure layer for the Python→NestJS
 * move (phase B3/B4). Port of the enqueueing half of scrapper/web/jobs.py
 * (enqueue_aeo:584, _aeo_schedule_tick:992, due_profiles:965) and the dedup
 * from scrapper/core/storage.py (find_active_aeo_job:2202).
 *
 * Architecture (see audit decisions):
 *   • ONE queue 'aeo', a SEPARATE worker process (src/aeo-worker.ts). Here we
 *     only have Queue (enqueueing) and the scheduler; the actual Worker lives
 *     in the worker entrypoint, so the HTTP api process never pulls run processing.
 *   • NOT @nestjs/bullmq and NOT @nestjs/schedule: the first ties the queue to
 *     Nest's lifecycle, the second would fire in EVERY api instance → double runs.
 *   • Scheduler — a repeatable job via Queue.upsertJobScheduler: dedup lives in
 *     Redis, so with N instances the daily tick is enqueued EXACTLY once.
 *   • Tracker run idempotency — in the DB: we don't enqueue a second active
 *     aeo run for the same tracker (findActiveAeoJob, mirrors Python's uniq
 *     check). Plus a stable jobId in Redis guards against duplicates at the
 *     queue level.
 *
 * We get Prisma via blogPrisma() — the same flat accessor as usage.ts: both the
 * HTTP process (BlogwriterModule.onModuleInit → setBlogPrisma) and the worker
 * (src/aeo-worker.ts) put a single PrismaClient into it on startup. The name
 * "blogPrisma" is historical: it's the shared client for non-DI ports, not just the blog.
 */
import { Logger } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { blogPrisma } from '../../blogwriter/server/utils/prisma';

const log = new Logger('aeo/queue');

/** Name of the single AEO queue. */
export const AEO_QUEUE = 'aeo';

/** Job type: run for a single tracker (enqueue_aeo → _process_aeo). */
export const RUN_JOB = 'run';

/** Job type: daily scheduler tick (_aeo_schedule_tick), fans out into 'run'. */
export const TICK_JOB = 'tick';

/** Stable id of the repeatable scheduler (dedup in Redis across all instances). */
export const DAILY_SCHEDULER_ID = 'aeo-daily';

/** Job type: weekly report-mailing tick (reports.runWeeklyReports). */
export const WEEKLY_REPORTS_JOB = 'reports-tick';

/** Stable id of the weekly reports scheduler (dedup in Redis). */
export const WEEKLY_REPORTS_SCHEDULER_ID = 'aeo-weekly-reports';

/**
 * Payload of the 'run' job — contract with processAeoRun (src/aeo/run-job.ts).
 * Empty `profiles` → cheap core micro+mid (manual refresh; a manual run does NOT
 * burn the monthly full/yandex quota — enqueue_aeo:588). `scrapeJobId` is the
 * scrape_jobs row that processAeoRun drives through statuses (running→done, like
 * _process_aeo via update_job).
 */
export interface AeoRunJobData {
  trackerId: number;
  domain?: string | null;
  userId?: number | null;
  profiles?: string[];
  scrapeJobId?: number;
  /** where the run came from: scheduler or manual refresh (diagnostics). */
  source?: 'schedule' | 'manual';
}

/** Tracker owner's plan run-config (plans.PlanRun; fields optional for dedup). */
export interface PlanRunCfg {
  micro?: string;
  mid?: string;
  full_per_month?: number;
  yandex_per_month?: number;
}

// ── lazy Redis + Queue connection ─────────────────────────────────────────
// Lazy, so a plain module import doesn't open a socket: the HTTP api process and
// tests that don't need the queue never touch Redis. The first enqueue/scheduler
// call brings up the connection and Queue; closeQueue() tears it down (worker warm shutdown).

let _connection: Redis | null = null;
// We keep Queue without a strict DataType: the queue carries TWO kinds of jobs —
// 'run' (AeoRunJobData) and 'tick' (empty scheduler data). A strict Queue<AeoRunJobData>
// would reject the tick template's data:{}; type safety instead lives on
// .add(RUN_JOB, data:AeoRunJobData) and on Worker<AeoRunJobData> in the worker entrypoint.
let _queue: Queue | null = null;

/** Redis URL from the environment (redis://redis:6379 in compose); defaults to local. */
export function redisUrl(): string {
  return (process.env.REDIS_URL || '').trim() || 'redis://127.0.0.1:6379';
}

/**
 * The process's single ioredis connection backing the Queue. `maxRetriesPerRequest: null`
 * is a BullMQ requirement (otherwise blocking commands fail on the retry limit).
 */
export function connection(): Redis {
  if (!_connection) {
    _connection = new IORedis(redisUrl(), { maxRetriesPerRequest: null });
    _connection.on('error', (e) => log.warn(`redis: ${String(e)}`));
  }
  return _connection;
}

/** Lazy singleton Queue 'aeo'. */
export function aeoQueue(): Queue {
  if (!_queue) {
    _queue = new Queue(AEO_QUEUE, { connection: connection() });
  }
  return _queue;
}

/** Options for the 'run' job: no auto-retry (a full run makes paid calls; a retry
 *  would burn money again — Python doesn't retry runs either) + gentle cleanup. */
const RUN_OPTS: JobsOptions = {
  attempts: 1,
  removeOnComplete: { age: 3600, count: 200 },
  removeOnFail: { age: 24 * 3600 },
};

// ── tracker run idempotency (port of find_active_aeo_job:2202) ───────────────

/**
 * Id of THIS tracker's still-active (queued/running) aeo run in scrape_jobs, or
 * null. The tracker is linked to the job only via the params JSON (source='aeo:{domain}'
 * isn't unique per tracker), so we match tracker_id inside params::jsonb —
 * a literal port of storage.find_active_aeo_job. params is a String in the schema,
 * so this needs raw SQL (Prisma doesn't cast String→jsonb).
 */
export async function findActiveAeoJob(trackerId: number): Promise<number | null> {
  try {
    const rows = await blogPrisma().$queryRawUnsafe<{ id: number }[]>(
      `SELECT id FROM scrape_jobs
         WHERE kind = 'aeo' AND status IN ('queued','running')
           AND params IS NOT NULL
           AND (params::jsonb ->> 'tracker_id') = $1
         ORDER BY id ASC LIMIT 1`,
      String(Math.trunc(trackerId)),
    );
    const r = rows?.[0];
    return r ? Number(r.id) : null;
  } catch (e) {
    // No table / DB is down — skip dedup (better an extra run than a scheduler
    // crash). Surface the diagnostic.
    log.warn(`findActiveAeoJob(#${trackerId}): ${String(e)}`);
    return null;
  }
}

export interface EnqueueRunInput {
  trackerId: number;
  domain?: string | null;
  userId?: number | null;
  profiles?: string[];
  source?: 'schedule' | 'manual';
}

export interface EnqueueRunResult {
  /** id of the scrape_jobs row (existing one on dedup, or the new one). */
  scrapeJobId: number;
  /** true — enqueued a new run; false — an active one already existed, we rode along on it. */
  enqueued: boolean;
}

/**
 * Enqueue a single AEO run for a tracker (port of enqueue_aeo:584 + create_job:2162).
 * First dedups against the DB (findActiveAeoJob): if the tracker already has an
 * active run, we enqueue NOTHING and return its id (enqueued=false). Otherwise we
 * write a scrape_jobs row (kind='aeo', status='queued', params={tracker_id[,profiles]})
 * — both the idempotency record and the run's audit trail — and enqueue the 'run'
 * job with a stable jobId `aeo:run:{scrapeJobId}` (insurance against duplicates in Redis).
 */
export async function enqueueRun(input: EnqueueRunInput): Promise<EnqueueRunResult> {
  const trackerId = Math.trunc(input.trackerId);
  const profiles = (input.profiles || []).filter((p) => !!p);

  const existing = await findActiveAeoJob(trackerId);
  if (existing !== null) {
    return { scrapeJobId: existing, enqueued: false };
  }

  const payload: { tracker_id: number; profiles?: string[] } = { tracker_id: trackerId };
  if (profiles.length) payload.profiles = profiles;

  const jobRow = await blogPrisma().scrapeJob.create({
    data: {
      source: `aeo:${input.domain || ''}`,
      kind: 'aeo',
      status: 'queued',
      params: JSON.stringify(payload),
      userId: input.userId ?? null,
      // createdAt is a String with no default in the schema: we supply ISO ourselves (like _now_iso).
      createdAt: new Date().toISOString(),
      log: `queued aeo run tracker #${trackerId} ${input.domain || ''} profiles=${profiles.join(',') || 'micro,mid'}\n`,
    },
    select: { id: true },
  });

  const data: AeoRunJobData = {
    trackerId,
    domain: input.domain ?? null,
    userId: input.userId ?? null,
    profiles: profiles.length ? profiles : undefined,
    scrapeJobId: jobRow.id,
    source: input.source ?? 'manual',
  };
  await aeoQueue().add(RUN_JOB, data, { ...RUN_OPTS, jobId: `aeo:run:${jobRow.id}` });
  return { scrapeJobId: jobRow.id, enqueued: true };
}

// ── scrape_jobs row lifecycle (port of update_job:2771) ──────────────────────
// CRITICAL for idempotency: processAeoRun (run-job.ts) is keyed on trackerId and
// never touches the scrape_jobs row, so the worker owns the status. While the row
// stays queued/running, findActiveAeoJob dedups this tracker — so on run completion
// it MUST be moved to done/error, otherwise the tracker gets stuck and the tick
// stops enqueueing it. Updates are best-effort, but failures are logged loudly.

/** Mark the run as running (status='running', started_at). */
export async function markJobRunning(scrapeJobId: number): Promise<void> {
  try {
    await blogPrisma().scrapeJob.update({
      where: { id: scrapeJobId },
      data: { status: 'running', startedAt: new Date().toISOString() },
    });
  } catch (e) {
    log.warn(`markJobRunning(#${scrapeJobId}): ${String(e)}`);
  }
}

/** Mark the run as successful (status='done', finished_at, found_count=inserted). */
export async function markJobDone(scrapeJobId: number, foundCount: number): Promise<void> {
  try {
    await blogPrisma().scrapeJob.update({
      where: { id: scrapeJobId },
      data: {
        status: 'done',
        finishedAt: new Date().toISOString(),
        foundCount: Math.max(0, Math.trunc(foundCount || 0)),
      },
    });
  } catch (e) {
    log.warn(`markJobDone(#${scrapeJobId}): ${String(e)} — row may get stuck in running, blocking the tracker via dedup`);
  }
}

/** Mark the run as failed (status='error', finished_at, error_text). */
export async function markJobError(scrapeJobId: number, message: string): Promise<void> {
  try {
    await blogPrisma().scrapeJob.update({
      where: { id: scrapeJobId },
      data: {
        status: 'error',
        finishedAt: new Date().toISOString(),
        errorText: String(message).slice(0, 2000),
      },
    });
  } catch (e) {
    log.warn(`markJobError(#${scrapeJobId}): ${String(e)} — row may get stuck in running, blocking the tracker via dedup`);
  }
}

// ── plan schedule (pure port of due_profiles:965 and helpers) ────────────────
// Pure functions: tests freeze the date. Python weekday(): Mon=0..Sun=6; JS
// getUTCDay(): Sun=0..Sat=6 — we convert.

/** Day of week Mon=0..Sun=6 (Python-style weekday) from a UTC date. */
function utcWeekday(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}

/** 0-based ordinal of this weekday within the month: (day-1)//7 (jobs.py:921). */
function utcNth(d: Date): number {
  return Math.floor((d.getUTCDate() - 1) / 7);
}

/** Day ordinal (UTC midnight / day) — for comparing dates without time. */
function dayNum(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000);
}

/** today − n days in UTC (for scanning back over scheduled days). */
function addDaysUtc(d: Date, days: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + days);
  return x;
}

/** `int(cfg or 0)` from jobs.py:929, for monthly quotas (full/yandex). */
function intOrZero(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Is day d a scheduled day for the profile (port of _profile_scheduled:918, minus
 * "once" — dueProfiles handles that based on whether a first run has happened).
 * For micro/mid, cfg is a schedule string ('daily'/'2w'/'3w'); for full/yandex it's
 * a per-month count.
 */
function profileScheduled(profile: string, cfg: unknown, d: Date): boolean {
  const wd = utcWeekday(d);
  const nth = utcNth(d);
  if (profile === 'micro') return cfg === 'daily' || (cfg === '2w' && (wd === 0 || wd === 3));
  if (profile === 'mid') {
    return (cfg === '3w' && (wd === 0 || wd === 2 || wd === 4)) || (cfg === '2w' && (wd === 0 || wd === 3));
  }
  const n = intOrZero(cfg);
  if (n <= 0) return false;
  if (profile === 'full') {
    if (wd !== 0) return false;
    return n >= 4 || (n === 2 && (nth === 0 || nth === 2)) || (n === 1 && nth === 0);
  }
  if (profile === 'yandex') {
    if (wd !== 2) return false;
    return (n >= 2 && (nth === 0 || nth === 2)) || (n === 1 && nth === 0);
  }
  return false;
}

/** Last scheduled day for the profile ≤ today (null — no schedule). Looks back
 *  ~3 months: enough for monthly quotas to survive downtime (jobs.py:945). */
function lastScheduledDay(profile: string, cfg: unknown, today: Date, lookback = 92): Date | null {
  for (let i = 0; i < lookback; i++) {
    const d = addDaysUtc(today, -i);
    if (profileScheduled(profile, cfg, d)) return d;
  }
  return null;
}

/** ISO run_meta timestamp → date (null — never run / garbage). Port of _parse_meta_day:955. */
function parseMetaDay(v: unknown): Date | null {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Which plan profiles to run today: the run-config plan × the last-run timestamps
 * (run_meta). Catch-up behavior is a literal port of due_profiles:965: a scheduled
 * day missed due to downtime is caught up by the nearest tick (the profile stays
 * due as long as its timestamp is older than the last scheduled day); we don't run
 * it twice the same day (timestamp today ≥ the scheduled day).
 */
export function dueProfiles(
  runCfg: PlanRunCfg | null | undefined,
  runMeta: Record<string, unknown> | null | undefined,
  today: Date,
): string[] {
  const out: string[] = [];
  const meta = runMeta || {};
  const cfg = (runCfg || {}) as Record<string, unknown>;
  const pairs: Array<[string, string]> = [
    ['micro', 'micro'],
    ['mid', 'mid'],
    ['full', 'full_per_month'],
    ['yandex', 'yandex_per_month'],
  ];
  for (const [profile, key] of pairs) {
    const val = cfg[key];
    const last = parseMetaDay(meta[`${profile}_at`]);
    if ((profile === 'micro' || profile === 'mid') && val === 'once') {
      if (last === null) out.push(profile); // one-time run — on the first tick
      continue;
    }
    const sched = lastScheduledDay(profile, val, today);
    if (sched === null) continue;
    if (last !== null && dayNum(last) >= dayNum(sched)) continue; // already covered
    out.push(profile);
  }
  return out;
}

/** Tracker's run_meta (jsonb|string|null) → flat timestamps object (port of _tracker_run_meta:608). */
export function trackerRunMeta(runMeta: unknown): Record<string, unknown> {
  let meta: unknown = runMeta;
  if (typeof meta === 'string') {
    try {
      meta = JSON.parse(meta);
    } catch {
      meta = null;
    }
  }
  return meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {};
}

// ── scheduler ──────────────────────────────────────────────────────────────

/** Daily run hour in UTC (env AEO_TRACK_HOUR, default 6 — same as Python). */
export function trackHour(): number {
  const n = parseInt(process.env.AEO_TRACK_HOUR || '', 10);
  return Number.isFinite(n) && n >= 0 && n <= 23 ? n : 6;
}

/**
 * Register (idempotently) the daily repeatable scheduler: once a day at
 * AEO_TRACK_HOUR UTC it enqueues a 'tick' job. upsertJobScheduler keeps the dedup
 * in Redis, so with N workers/instances there's exactly one tick. A repeat call
 * with the same DAILY_SCHEDULER_ID only updates the schedule — no duplicates.
 */
export async function registerDailyScheduler(): Promise<void> {
  const hour = trackHour();
  await aeoQueue().upsertJobScheduler(
    DAILY_SCHEDULER_ID,
    { pattern: `0 ${hour} * * *`, tz: 'UTC' },
    { name: TICK_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } } },
  );
  log.log(`daily scheduler armed: '${DAILY_SCHEDULER_ID}' at ${String(hour).padStart(2, '0')}:00 UTC`);
}

/**
 * Weekly report-mailing hour in UTC (jobs._reports_tick:1031-1049): Monday,
 * AFTER the daily runs — AEO_TRACK_HOUR + REPORTS_HOUR_OFFSET (default +3h).
 * In Python this was guarded by a 10-min loop checking `now.hour >= track+offset`;
 * BullMQ cron fires exactly once at the scheduled hour, so we encode that hour
 * directly (weekly idempotency is still held by report_log in reports.reportAlreadySent).
 */
export function reportsHour(): number {
  const raw = parseInt(process.env.REPORTS_HOUR_OFFSET || '', 10);
  const offset = Number.isFinite(raw) ? raw : 3;
  return Math.max(0, Math.min(23, trackHour() + offset));
}

/**
 * Register (idempotently) the WEEKLY repeatable scheduler for report mailing: on
 * Mondays at reportsHour() UTC it enqueues a 'reports-tick' job (handled by the
 * worker → reports.runWeeklyReports). upsertJobScheduler keeps the dedup in Redis:
 * with N instances there's exactly one tick. A repeat call only updates the
 * schedule. Registration itself sends NOTHING — emails go out only once the
 * worker processes the tick and reportsEnabled() allows it.
 */
export async function registerWeeklyReportsScheduler(): Promise<void> {
  const hour = reportsHour();
  await aeoQueue().upsertJobScheduler(
    WEEKLY_REPORTS_SCHEDULER_ID,
    { pattern: `0 ${hour} * * 1`, tz: 'UTC' }, // '* * 1' — Monday
    { name: WEEKLY_REPORTS_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } } },
  );
  log.log(
    `weekly reports scheduler armed: '${WEEKLY_REPORTS_SCHEDULER_ID}' Mon at ${String(hour).padStart(2, '0')}:00 UTC`,
  );
}

/** Resolver for the plan run-config by tracker owner (the worker passes its own,
 *  backed by PlanService). Empty userId → system tracker, scale schedule (jobs.py:1013). */
export type ResolveRun = (userId: number | null | undefined) => Promise<PlanRunCfg>;

/**
 * A single scheduler tick (port of _aeo_schedule_tick:992): for each active
 * tracker — owner's plan → profiles due today → enqueueRun with them.
 * enqueueRun dedups on its own (findActiveAeoJob), so a separate in-memory retry
 * guard (Python's _AEO_TICK_MARKS) isn't needed: the tick is daily, not every 10 min.
 * Each tracker runs in its own try — the scheduler must not fail because of one.
 * `now` is injected by tests. Returns the number of runs actually enqueued.
 */
export async function runDailyTick(resolveRun: ResolveRun, now: Date = new Date()): Promise<number> {
  const today = now;
  let queued = 0;
  let trackers: Array<{ id: number; domain: string; userId: number | null; runMeta: unknown }> = [];
  try {
    trackers = (await blogPrisma().aeoTracker.findMany({
      where: { active: true },
      select: { id: true, domain: true, userId: true, runMeta: true },
    })) as typeof trackers;
  } catch (e) {
    log.warn(`tick: failed to read active trackers: ${String(e)}`);
    return 0;
  }
  for (const t of trackers) {
    try {
      const runCfg = await resolveRun(t.userId);
      const profiles = dueProfiles(runCfg, trackerRunMeta(t.runMeta), today);
      if (!profiles.length) continue;
      const res = await enqueueRun({
        trackerId: t.id,
        domain: t.domain,
        userId: t.userId,
        profiles,
        source: 'schedule',
      });
      if (res.enqueued) queued++;
    } catch (e) {
      log.warn(`tick: tracker #${t.id} skipped: ${String(e)}`);
    }
  }
  if (queued) log.log(`aeo schedule: ${queued} tracker(s) queued`);
  return queued;
}

// ── shutdown ───────────────────────────────────────────────────────────────

/** Close the Queue and connection (worker warm shutdown). Idempotent. */
export async function closeQueue(): Promise<void> {
  try {
    if (_queue) await _queue.close();
  } finally {
    _queue = null;
    if (_connection) {
      await _connection.quit().catch(() => _connection?.disconnect());
      _connection = null;
    }
  }
}
