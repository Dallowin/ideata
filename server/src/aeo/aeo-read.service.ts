/**
 * Native AEO dashboard reads in Nest — a parity port of services.aeo_aggregates
 * (scrapper/web/services.py:626-685). Writes/runs stay in Python; here we ONLY
 * read the rows that Python writes and assemble the same 18-field payload.
 *
 * Layers:
 *   • assembleDashboard(...) — PURE core: tracker fields + window rows →
 *     payload. Exactly mirrors services.aeo_aggregates:651-685 (panel, counts,
 *     run_meta, prompt cap, aggregate_monitoring). Golden-tested, doesn't touch
 *     the DB.
 *   • AeoReadService.readDashboard / getDashboard — Prisma wrapper: reads the
 *     tracker, rows (aeoAnswer, like aeo_answers_since), the active job, the
 *     owner's plan; checks access fail-closed; in shadow mode compares native
 *     vs Python.
 *
 * Dates: Prisma returns a naive timestamp as a JS Date (UTC wall-clock), Python
 * sees a naive datetime and takes str()[:10]. naiveTs() converts a Date to the
 * same naive string 'YYYY-MM-DD HH:MM:SS.mmm', so the date bucket (the [:10]
 * slice) and the ISO weeks in aggregate.ts agree for both a Date and a string
 * (see risk #1).
 */
import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { AeoTracker } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PlanService } from '../plans/plans.service';
import { InternalClient } from '../public-api/internal.client';
import { aggregateMonitoring, DEFAULT_PLATFORMS } from './aggregate';
import type { MonitoringRow } from './aggregate.types';
import { deepDiff } from './parity/diff';
import { isDict } from './parse';
import { normalizePanel, promptStatus, promptCount } from './panel';

// ── Python-isms (kept local so the core is self-contained) ────────────────────

/** Python truthiness: None/False/0/-0/""/[]/{} — falsy. */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '') return false;
  if (typeof v === 'number') return v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return true;
}

/**
 * Prisma's Date for a naive timestamp → a naive Python-style string
 * 'YYYY-MM-DD HH:MM:SS.mmm'. toISOString gives the same wall-clock (Prisma
 * reads a naive timestamp as UTC), so the [:10] slice = Python's
 * str(run_at)[:10]. A string is returned as-is (in the golden, run_at is
 * already a naive string).
 */
export function naiveTs(v: string | Date): string {
  if (v instanceof Date) {
    const iso = v.toISOString(); // 2026-07-22T01:57:43.925Z
    return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`;
  }
  return String(v);
}

/** jobs._tracker_run_meta (jobs.py:608-616): jsonb|text|None → a dict of timestamps. */
function normalizeRunMeta(meta: unknown): Record<string, unknown> {
  let m: unknown = meta;
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m);
    } catch {
      m = null;
    }
  }
  return isDict(m) ? m : {};
}

// ── pure core ─────────────────────────────────────────────────────────────────

/** Tracker fields in Python-dict shape (what services.aeo_aggregates reads). */
export interface AssembleTracker {
  id: number;
  domain: string;
  competitors?: unknown; // list | null
  prompts?: unknown; // list | null
  platforms?: unknown; // list | null
  active?: unknown;
  last_run_at?: unknown; // string | Date | null
  prompts_limit?: unknown; // number | null
  run_meta?: unknown; // dict | string | null
}

/** Full dashboard payload — 18 fields, services.aeo_aggregates:669-685. */
export interface DashboardPayload {
  id: number;
  domain: string;
  competitors: unknown;
  prompts: unknown;
  panel: unknown;
  activeCount: number;
  suggestedCount: number;
  inactiveCount: number;
  active: boolean;
  last_run_at: unknown;
  microAt: unknown;
  midAt: unknown;
  fullAt: unknown;
  yandexAt: unknown;
  promptsLimit: number | null;
  promptCap: number;
  running: boolean;
  aggregates: unknown;
}

/**
 * Port of services.aeo_aggregates:651-685. `tracker` — tracker fields (already
 * converted to Python shape), `rows` — window rows (aeo_answers for N weeks,
 * sorted by run_at), `activeJob` — id of the active run or null, `plan` — the
 * owner's effective plan, `aeoPromptsSetting` — the raw AEO_PROMPTS value.
 */
export function assembleDashboard(
  tracker: AssembleTracker,
  rows: MonitoringRow[],
  activeJob: unknown,
  plan: string | null | undefined,
  aeoPromptsSetting: string | null | undefined,
): DashboardPayload {
  // services.py:651 — platform columns: tuple(tracker.platforms or DEFAULT).
  const platforms =
    Array.isArray(tracker.platforms) && tracker.platforms.length
      ? (tracker.platforms as string[])
      : [...DEFAULT_PLATFORMS];
  // services.py:652-655 — aggregates: competitors are filtered for falsy values.
  const competitorsList = Array.isArray(tracker.competitors)
    ? tracker.competitors
    : [];
  const competitorsForAgg = competitorsList.filter((c) => pyTruthy(c)) as string[];
  const agg = aggregateMonitoring(rows, tracker.domain, competitorsForAgg, {
    platforms,
  });
  // services.py:656-657 — int(prompts_limit) or None.
  const limitRaw = tracker.prompts_limit;
  const promptsLimit =
    limitRaw === null || limitRaw === undefined
      ? null
      : Math.trunc(Number(limitRaw));
  // services.py:660-665 — the panel and its breakdown by status.
  const panel = normalizePanel(tracker.prompts ?? []);
  let activeCount = 0;
  let suggestedCount = 0;
  let inactiveCount = 0;
  for (const p of panel) {
    const s = promptStatus(p);
    if (s === 'active') activeCount += 1;
    else if (s === 'suggested') suggestedCount += 1;
    else if (s === 'inactive') inactiveCount += 1;
  }
  // services.py:666-668 — run timestamps from aeo_trackers.run_meta.
  const runMeta = normalizeRunMeta(tracker.run_meta);
  // services.py:669-685 — assembly (key order doesn't matter: deepDiff canonicalizes).
  return {
    id: tracker.id,
    domain: tracker.domain,
    competitors: pyTruthy(tracker.competitors) ? tracker.competitors : [],
    prompts: pyTruthy(tracker.prompts) ? tracker.prompts : [],
    panel,
    activeCount,
    suggestedCount,
    inactiveCount,
    active: pyTruthy(tracker.active),
    last_run_at: tracker.last_run_at ?? null,
    microAt: runMeta.micro_at ?? null,
    midAt: runMeta.mid_at ?? null,
    fullAt: runMeta.full_at ?? null,
    yandexAt: runMeta.yandex_at ?? null,
    promptsLimit,
    promptCap: promptCount(plan, aeoPromptsSetting),
    running: activeJob !== null && activeJob !== undefined,
    // services.py:685 — `agg or None`: an empty window ({}) → null.
    aggregates: Object.keys(agg).length ? agg : null,
  };
}

// ── Prisma wrapper + shadow ───────────────────────────────────────────────────

type ReadMode = 'native' | 'shadow' | 'python';

/** native/shadow/python toggle (env AEO_READ_MODE, defaults to shadow). */
function readMode(): ReadMode {
  const m = (process.env.AEO_READ_MODE || 'shadow').trim().toLowerCase();
  return m === 'native' || m === 'python' ? (m as ReadMode) : 'shadow';
}

@Injectable()
export class AeoReadService {
  private readonly logger = new Logger('AeoRead');

  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly internal: InternalClient,
  ) {}

  /**
   * The caller's role in the owner's account — a mirror of storage.team_role
   * (storage.py:888-904): owner==user → "owner"; otherwise account_members.role
   * ('owner'|'editor'|'viewer') or null (unrelated / no table). Also null when
   * the owner/caller is missing.
   */
  private async teamRole(
    ownerUserId: number | null | undefined,
    userId: number | null | undefined,
  ): Promise<string | null> {
    if (!ownerUserId || !userId) return null;
    if (ownerUserId === userId) return 'owner';
    try {
      const m = await this.prisma.accountMember.findFirst({
        where: { ownerUserId, memberUserId: userId },
        select: { role: true },
      });
      return m ? m.role ?? null : null;
    } catch {
      return null; // no account_members table — same as team_role → None
    }
  }

  /**
   * READ access, modeled on services._assert_can_read (services.py:84-92), but
   * FAIL-CLOSED: in Python this helper is fail-open (the owner was checked by
   * the calling loop, and Nest called into Python with check_owner=False), so
   * THIS method has now become the gate — and it must be closed.
   *
   *   access = account owner OR a member (account_members, ANY role);
   *   no owner OR no caller → 404 (fail-closed);
   *   someone else's / non-member → 404 (NOT 403 — we don't confirm the
   *   tracker's existence).
   *
   * Team access is preserved: a member of the owner's account passes the same
   * way as in Python (team_role != None).
   */
  async assertCanRead(
    ownerUserId: number | null | undefined,
    userId: number | null | undefined,
    checkOwner = true,
    notFound = 'tracker not found',
  ): Promise<void> {
    if (!checkOwner) return;
    if (!ownerUserId || !userId) throw new NotFoundException(notFound);
    if ((await this.teamRole(ownerUserId, userId)) === null) {
      throw new NotFoundException(notFound);
    }
  }

  /**
   * MUTATE access, modeled on services._assert_can_mutate (services.py:94-105),
   * FAIL-CLOSED. Needed for POST :id/prompts (Python calls set_aeo_prompts with
   * check_owner=False — the gate lives entirely on Nest):
   *
   *   owner/editor — pass; viewer → 403 (role upsell — existence is no longer a
   *   secret since read is open to them); someone else's / no owner / no
   *   caller → 404.
   *
   * Difference from assertCanRead: a viewer can read but NOT mutate — otherwise
   * a member with the "view" role could edit the prompt panel.
   */
  async assertCanMutate(
    ownerUserId: number | null | undefined,
    userId: number | null | undefined,
    checkOwner = true,
    notFound = 'tracker not found',
  ): Promise<void> {
    if (!checkOwner) return;
    if (!ownerUserId || !userId) throw new NotFoundException(notFound);
    const role = await this.teamRole(ownerUserId, userId);
    if (role === 'owner' || role === 'editor') return;
    if (role === 'viewer') {
      throw new ForbiddenException(
        'View-only access — ask the owner to grant the editor role',
      );
    }
    throw new NotFoundException(notFound);
  }

  /**
   * The owner's effective plan — a mirror of storage.effective_plan
   * (storage.py:694-708): no user/users row → null; admin → scale; otherwise
   * the degraded plan from user_plans (PlanService.getUserPlanRow) or free.
   */
  async effectivePlan(userId: number | null | undefined): Promise<string | null> {
    if (!userId) return null;
    let u: { isAdmin: boolean } | null = null;
    try {
      u = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { isAdmin: true },
      });
    } catch {
      u = null;
    }
    if (!u) return null; // no users row → "plan unknown" (None)
    if (u.isAdmin) return 'scale';
    const row = await this.plans.getUserPlanRow(userId);
    return row.plan || 'free';
  }

  /**
   * AEO_PROMPTS — the raw value for promptCount. Python reads os.environ (which
   * the admin overlay populates from app_settings). In api we read app_settings
   * directly, with env as the fallback. An empty string means "not set"
   * (Python's `if raw:`).
   */
  async readAeoPromptsSetting(): Promise<string | null> {
    try {
      const row = await this.prisma.appSetting.findUnique({
        where: { key: 'AEO_PROMPTS' },
      });
      if (row && row.value) return row.value;
    } catch {
      /* no table — fall back to env */
    }
    const env = process.env.AEO_PROMPTS;
    return env ? env : null;
  }

  /**
   * storage.find_active_aeo_job (storage.py:2202-2215) — the id of the
   * tracker's still-running (queued/running) AEO run (matches tracker_id inside
   * the params JSON) or null. READ-ONLY, the exact Python SQL (params — TEXT,
   * cast to jsonb).
   */
  private async findActiveAeoJob(trackerId: number): Promise<number | null> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ id: number }>>(
        `SELECT id FROM scrape_jobs WHERE kind='aeo' ` +
          `AND status IN ('queued','running') AND params IS NOT NULL ` +
          `AND (params::jsonb ->> 'tracker_id') = $1 ORDER BY id ASC LIMIT 1`,
        String(trackerId),
      );
      return rows.length ? Number(rows[0].id) : null;
    } catch {
      return null;
    }
  }

  /** aeo_answers_since (storage.py:2753-2760): window rows → MonitoringRow[]. */
  private mapAnswerRows(
    rows: Array<{
      runAt: Date;
      platform: string;
      prompt: string;
      rawText: string | null;
      brandsFound: unknown;
      citations: unknown;
      sentiment: unknown;
      judge: unknown;
    }>,
  ): MonitoringRow[] {
    return rows.map((r) => ({
      run_at: naiveTs(r.runAt), // Date → naive string (the [:10] bucket agrees)
      platform: r.platform,
      prompt: r.prompt,
      text: r.rawText, // raw_text AS text
      brands_found: (r.brandsFound as MonitoringRow['brands_found']) ?? null,
      citations: (r.citations as MonitoringRow['citations']) ?? null,
      sentiment: (r.sentiment as MonitoringRow['sentiment']) ?? null,
      judge: r.judge ?? null,
    }));
  }

  /**
   * Assemble the payload from an already-loaded tracker (no gate, no repeat
   * findUnique) — a shared bottom layer for the native path and shadow. Reads
   * the window rows, the active job, the plan and AEO_PROMPTS, then
   * assembleDashboard.
   */
  private async assembleFromDb(
    tracker: AeoTracker,
    weeks: number,
  ): Promise<DashboardPayload> {
    // services.py:641-642 — window clamp(weeks, 1, 26) weeks back from now(UTC).
    const w = Math.max(1, Math.min(26, weeks));
    const since = new Date(Date.now() - w * 7 * 86400_000);
    const answerRows = await this.prisma.aeoAnswer.findMany({
      where: { trackerId: tracker.id, runAt: { gte: since } },
      orderBy: { runAt: 'asc' }, // aeo_answers_since ... ORDER BY run_at
      select: {
        runAt: true,
        platform: true,
        prompt: true,
        rawText: true,
        brandsFound: true,
        citations: true,
        sentiment: true,
        judge: true,
      },
    });
    const rows = this.mapAnswerRows(answerRows);
    const [plan, aeoPromptsSetting, activeJob] = await Promise.all([
      this.effectivePlan(tracker.userId),
      this.readAeoPromptsSetting(),
      this.findActiveAeoJob(tracker.id),
    ]);
    const assembleTracker: AssembleTracker = {
      id: tracker.id,
      domain: tracker.domain,
      competitors: tracker.competitors,
      prompts: tracker.prompts,
      platforms: tracker.platforms,
      active: tracker.active,
      last_run_at: tracker.lastRunAt ? naiveTs(tracker.lastRunAt) : null,
      prompts_limit: tracker.promptsLimit,
      run_meta: tracker.runMeta,
    };
    return assembleDashboard(
      assembleTracker,
      rows,
      activeJob,
      plan,
      aeoPromptsSetting,
    );
  }

  /**
   * A native read with a fail-closed owner check. `checkOwner=false` — when
   * the owner was already checked by the caller (like check_owner in Python).
   */
  async readDashboard(
    trackerId: number,
    weeks: number,
    userId: number | null | undefined,
    { checkOwner = true }: { checkOwner?: boolean } = {},
  ): Promise<DashboardPayload> {
    const tracker = await this.prisma.aeoTracker.findUnique({
      where: { id: trackerId },
    });
    if (!tracker) throw new NotFoundException('tracker not found');
    await this.assertCanRead(tracker.userId, userId, checkOwner);
    return this.assembleFromDb(tracker, weeks);
  }

  /**
   * The GET :id controller entry point. A single fail-closed owner gate, then
   * a mode from AEO_READ_MODE:
   *   • python — the previous internal proxy (a safe behavior default);
   *   • native — native assembly (the flip comes later, manually);
   *   • shadow (default) — compute BOTH paths, deepDiff, log discrepancies,
   *     but return the Python result (the client never risks the native path).
   */
  async getDashboard(
    trackerId: number,
    weeks: number,
    userId: number | null | undefined,
  ): Promise<unknown> {
    const tracker = await this.prisma.aeoTracker.findUnique({
      where: { id: trackerId },
    });
    if (!tracker) throw new NotFoundException('tracker not found');
    await this.assertCanRead(tracker.userId, userId, true);
    const w = Math.max(1, Math.min(26, weeks));
    const mode = readMode();
    if (mode === 'native') return this.assembleFromDb(tracker, w);
    if (mode === 'python') return this.internal.aeoAggregates(trackerId, w);
    // shadow: the client response = Python (latency and load exactly as today).
    // Native is computed in the BACKGROUND via setImmediate — AFTER the response
    // has already gone out — and only compared and logged. The client is
    // unaffected in every way: latency doesn't grow, and any native throw is
    // swallowed here and never becomes an unhandled rejection. Python errors
    // are propagated as before (await below).
    const pythonValue = await this.internal.aeoAggregates(trackerId, w);
    setImmediate(() => {
      void (async () => {
        try {
          const native = await this.assembleFromDb(tracker, w);
          const diff = deepDiff(native, pythonValue);
          if (diff.length) {
            this.logger.warn(
              `[aeo-shadow] parity diff tracker=${trackerId} weeks=${w}: ` +
                `${diff.length} paths; first=${JSON.stringify(diff.slice(0, 20))}`,
            );
          } else {
            this.logger.log(
              `[aeo-shadow] parity OK tracker=${trackerId} weeks=${w}`,
            );
          }
        } catch (e) {
          this.logger.error(
            `[aeo-shadow] native threw tracker=${trackerId} weeks=${w}: ` +
              `${(e as Error)?.message ?? e}`,
          );
        }
      })();
    });
    return pythonValue;
  }
}
