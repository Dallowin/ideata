/**
 * Entry point for the AEO-run WORKER (NOT the HTTP process). Built by nest
 * build into dist/aeo-worker.js and run as a separate process (docker-compose
 * service aeo-worker: `node dist/aeo-worker`). Runs a BullMQ Worker over the
 * 'aeo' queue plus the daily scheduler; the api process (dist/main) does not
 * process runs itself.
 *
 * Port of scrapper/web/worker.py (RQ worker) + warm-shutdown from
 * deploy/scrapper-analytic-worker@.service (KillMode=mixed): in Node this is
 * await worker.close() on SIGTERM — stop taking new jobs, drain active ones,
 * then close Redis/Prisma and exit 0.
 *
 * Prisma for non-DI ports (usage.recordUsage, queue.*, run-job.processAeoRun)
 * is spun up here and stashed in the shared setBlogPrisma accessor — exactly
 * like the HTTP process does in BlogwriterModule.onModuleInit. Without this,
 * the client would never see usage tracking or recorded answers.
 */
import { PrismaClient } from '@prisma/client';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';

import { setBlogPrisma } from './blogwriter/server/utils/prisma';
import { PLAN_DEFAULTS, PlanService } from './plans/plans.service';
import type { PrismaService } from './prisma/prisma.service';
import {
  AEO_QUEUE,
  RUN_JOB,
  TICK_JOB,
  WEEKLY_REPORTS_JOB,
  type AeoRunJobData,
  type ResolveRun,
  closeQueue,
  markJobDone,
  markJobError,
  markJobRunning,
  redisUrl,
  registerDailyScheduler,
  registerWeeklyReportsScheduler,
  runDailyTick,
} from './aeo/queue/queue';
// processAeoRun — orchestrates a single run (panel→platforms→run_snapshot→
// judge→write). Written by another agent (src/aeo/run-job.ts); imported by name.
import { processAeoRun } from './aeo/run-job';
// Weekly AEO report mailing (port of reports.run_weekly_reports): the plan
// gate is built from PlanService.resolveLimits, weekly idempotency lives in report_log.
import { runWeeklyReports, type ChannelsResolver } from './aeo/reports';
// app_settings → env for mail keys (see hydrateMailEnv).
import { getSettingKey } from './aeo/providers/settings';

/**
 * Overlay of mail keys from app_settings into process.env, ONLY for the
 * worker process (a narrowed port of settings_store.apply_to_environ, mail
 * only). The mailer in aeo/mail.ts reads keys straight from process.env,
 * while RESEND_API_KEY lives in app_settings — without this overlay, weekly
 * reports would never go out. Done in the worker, NOT the shared server .env,
 * so we don't accidentally enable sendMail in the HTTP process (email-verify).
 * SMTP_FROM defaults to Resend's verified sender (the same one Python used:
 * noreply@ideata.io), otherwise the mailer's default no-reply@ (with a hyphen)
 * would be rejected by Resend.
 */
async function hydrateMailEnv(): Promise<void> {
  const keys = [
    'MAIL_DRIVER',
    'RESEND_API_KEY',
    'BREVO_API_KEY',
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASSWORD',
    'SMTP_FROM',
    'SMTP_SSL',
    'SMTP_TLS',
  ];
  for (const k of keys) {
    const v = await getSettingKey(k); // app_settings (non-empty) → env → ''
    if (v) process.env[k] = v;
  }
  if (!(process.env.SMTP_FROM || '').trim() && !(process.env.SMTP_USER || '').trim()) {
    process.env.SMTP_FROM = 'noreply@ideata.io';
  }
}

// ── structured logs (one JSON line per event) ─────────────────────────────────
function slog(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  const line = { t: new Date().toISOString(), level, svc: 'aeo-worker', msg, ...extra };
  (level === 'error' ? console.error : console.log)(JSON.stringify(line));
}

/** Integer from env, clamped (default otherwise). */
function envInt(name: string, def: number, lo: number, hi: number): number {
  const n = parseInt(process.env[name] || '', 10);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
}

/** Redis URL with credentials masked — for logs. */
function safeRedis(): string {
  return redisUrl().replace(/\/\/[^@]*@/, '//***@');
}

async function main(): Promise<void> {
  // How many TRACKER runs in parallel (within a single run, prompt×platform
  // fan-out is bounded by p-limit in run-job.ts). Kept modest so we don't
  // flood providers with a batch of simultaneous trackers.
  const concurrency = envInt('AEO_WORKER_CONCURRENCY', 2, 1, 32);

  // Prisma for non-DI ports: recordUsage (usage.ts), queue.*, and processAeoRun
  // all read the client via blogPrisma().
  const prisma = new PrismaClient();
  setBlogPrisma(prisma);
  await prisma.$connect();

  // mail keys (RESEND_API_KEY etc.) from app_settings → this process's env, so
  // weekly reports actually go out. Worker only, the api process is untouched.
  await hydrateMailEnv();

  // Plan run-config for the tracker's owner, for the scheduler (port of
  // jobs.py:1013: effective_plan(user_id) or 'scale' → get_plan_config(...).run).
  // A system tracker without an owner is not downgraded — scale scheduling.
  // PlanService only uses $queryRawUnsafe, so a plain PrismaClient is enough for it.
  const plans = new PlanService(prisma as unknown as PrismaService);
  const resolveRun: ResolveRun = async (userId) => {
    if (!userId) return PLAN_DEFAULTS.scale.run;
    const row = await plans.getUserPlanRow(userId);
    const cfg = await plans.getPlanConfig(row.plan);
    return cfg.run;
  };

  // Plan gate for weekly-report channels (port of reports._report_channels):
  // email is granted when reports.email=='weekly' (lite+); telegram — pro+
  // (not yet sent from Nest, see reports.ts). resolveLimits reads the owner's
  // plan from user_plans; in prod an admin is treated per-plan, same as in the cabinet.
  const channelsFor: ChannelsResolver = async (userId) => {
    const lim = await plans.resolveLimits(userId);
    return { email: lim.reports.email === 'weekly', telegram: !!lim.reports.telegram };
  };

  // Daily scheduler (repeatable; dedup in Redis — one tick across all instances).
  // CUTOVER GATE: while Python is still running trackers, the Nest scheduler
  // MUST stay disabled (otherwise a double run = double billing). Enabled
  // EXPLICITLY, exactly at the moment of cutover (Python trackers retired):
  // AEO_SCHEDULER=on. The worker still processes manually queued jobs either
  // way (the first write-run).
  if ((process.env.AEO_SCHEDULER || '').trim().toLowerCase() === 'on') {
    await registerDailyScheduler();
    // Weekly report mailing (Monday) — under the same cutover gate as the
    // daily scheduler: while it's disabled, the tick never fires and no
    // emails go out for real. The tick itself is further gated by
    // REPORTS_ENABLED inside runWeeklyReports.
    await registerWeeklyReportsScheduler();
  } else {
    slog('warn', 'daily+weekly schedulers DISABLED (set AEO_SCHEDULER=on at cutover) — processing manual jobs only');
  }

  // Separate connection for the Worker's blocking loop (BullMQ recommends not
  // sharing the connection between Worker and Queue: BRPOPLPUSH would monopolize
  // the queue's client).
  const workerConn = new IORedis(redisUrl(), { maxRetriesPerRequest: null });
  workerConn.on('error', (e) => slog('warn', 'redis (worker) error', { err: String(e) }));

  const worker = new Worker<AeoRunJobData>(
    AEO_QUEUE,
    async (job) => {
      if (job.name === TICK_JOB) {
        const queued = await runDailyTick(resolveRun);
        return { queued };
      }
      if (job.name === WEEKLY_REPORTS_JOB) {
        // Weekly mailing: gated by REPORTS_ENABLED inside runWeeklyReports,
        // plan via channelsFor, weekly idempotency via report_log.
        const res = await runWeeklyReports({ channelsFor });
        slog('info', 'weekly reports tick', { users: res.sent.length });
        return { reports: res.sent.length };
      }
      if (job.name === RUN_JOB) {
        const { trackerId, profiles, scrapeJobId } = job.data;
        slog('info', 'run start', { jobId: job.id, trackerId, profiles: profiles ?? null });
        // The worker owns scrape_jobs status (processAeoRun is keyed on
        // trackerId and doesn't touch the row): running → done/error, otherwise
        // the row would get stuck in the queue and findActiveAeoJob would dedup
        // the tracker forever.
        if (scrapeJobId) await markJobRunning(scrapeJobId);
        try {
          // Positional port signature: processAeoRun(trackerId, profiles?).
          // profiles=undefined → defaults internally to micro+mid (manual refresh).
          const res = await processAeoRun(trackerId, profiles);
          if (scrapeJobId) await markJobDone(scrapeJobId, res.inserted);
          return res;
        } catch (e) {
          if (scrapeJobId) await markJobError(scrapeJobId, String(e));
          throw e; // let BullMQ mark the job failed (event/logs); no retry
        }
      }
      slog('warn', 'unknown job', { jobId: job.id, name: job.name });
      return null;
    },
    { connection: workerConn, concurrency },
  );

  worker.on('completed', (job) => slog('info', 'job completed', { jobId: job.id, name: job.name }));
  worker.on('failed', (job, err) =>
    slog('error', 'job failed', { jobId: job?.id, name: job?.name, trackerId: job?.data?.trackerId, err: String(err) }),
  );
  worker.on('error', (err) => slog('error', 'worker error', { err: String(err) }));

  slog('info', 'worker up', { queue: AEO_QUEUE, concurrency, redis: safeRedis() });

  // ── warm shutdown ──────────────────────────────────────────────────────────
  // SIGTERM (docker stop / systemd) → stop taking new jobs, drain the active
  // ones (worker.close waits for them), close Redis and Prisma, exit 0.
  let closing = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (closing) return;
    closing = true;
    slog('info', 'shutdown: draining active jobs', { signal });
    try {
      await worker.close(); // drain active jobs, stop picking up new ones
      await closeQueue(); // Queue + its connection (scheduler)
      await workerConn.quit().catch(() => workerConn.disconnect());
      await prisma.$disconnect();
      slog('info', 'shutdown: complete');
      process.exit(0);
    } catch (e) {
      slog('error', 'shutdown failed', { err: String(e) });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e) => {
  slog('error', 'fatal on boot', { err: String(e) });
  process.exit(1);
});
