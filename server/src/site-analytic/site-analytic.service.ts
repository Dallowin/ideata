/**
 * Top-level orchestrator for the AI-analytic (port of run_site_analytic,
 * site_analytic.py:651-708 + start_site_analytic, web/services.py:109-205 +
 * storage.py:2255-2410).
 *
 * Two entry points:
 *   • analyzeDomain(domain, opts) — the PURE pipeline for one domain:
 *       cost_reset → collect → normalize → LLM layer → AEO snapshot → AEO guide →
 *       cost_total → facts.meta.cost_usd. Returns {facts, llmOutputs, costUsd}.
 *       DataForSEO cost is collected with a per-run meter (runWithCostMeter),
 *       not a module-global like in Python (where the client is a singleton).
 *   • runAnalysis(...) — the launch flow: a weekly cache keyed by (domain, geo,
 *       week) with a privacy predicate, coalescing of parallel clicks, writing
 *       to site_analyses (create → running → done/error). The logic that in
 *       Python lives in the scraper contour behind internal.client is native here.
 */
import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlanService } from '../plans/plans.service';
import { DataForSeoClient } from '../discover/dataforseo.client';
import { KeysSoClient } from '../discover/keysso.client';
import { CostMeter, runWithCostMeter } from '../discover/cost-context';
import { cleanDomain } from '../public-api/clean-domain';
import { collect } from './collect';
import { DefaultSiteCollectors } from './site-collectors';
import { isRuDomain } from './geo';
import { normalize } from './normalize';
import { pyRound } from './pyhelpers';
import { LLM_LAYER, type LlmLayer } from './llm-layer';
import type { Facts, Raw } from './types';

const ANALYTIC_GEOS = new Set(['us', 'gb', 'de', 'ru']); // web/services.py:24

/**
 * "Live run" window in minutes. A run is detached into the current process's
 * background (this port has no separate worker), so a process restart mid-run
 * leaves the row in running forever. Two safeguards against coalescing forever
 * onto a dead row: (1) findActive only coalesces onto rows younger than the
 * window; (2) reapStale, on startup, flips stale running/queued rows older
 * than the window to error. The window has margin over the real run duration
 * (minutes). Gated on created_at (rather than "flip everything on startup") so
 * that at cutover time we don't kill a LIVE Python run that's still writing to
 * the same table before the flip.
 */
const SA_STALE_MIN = 20;

/**
 * Ceiling on concurrent analyses per user (port of _analytic_user_quota,
 * web/jobs.py:407): env ANALYTIC_USER_QUOTA, default 2, "<=0" disables the quota.
 */
function analyticUserQuota(): number {
  const n = parseInt(process.env.ANALYTIC_USER_QUOTA ?? '2', 10);
  return Number.isFinite(n) ? n : 2;
}

export interface AnalyzeOpts {
  compare?: string | null;
  geo?: string;
  userId?: number | null;
  lite?: boolean;
  progress?: (label: string) => void;
}

export interface AnalyzeResult {
  facts: Facts;
  llmOutputs: Record<string, any>;
  costUsd: number;
}

export interface RunAnalysisInput {
  domain: string;
  compare?: string | null;
  geo?: string;
  refresh?: boolean;
  userId?: number | null;
  /** Admin (`_cw` session a=true / internal call) — the plan's brand limit
   *  doesn't apply (port of _account_limits: is_admin_user → no gate). */
  isAdmin?: boolean;
  lite?: boolean;
}

@Injectable()
export class SiteAnalyticService {
  private readonly log = new Logger('SiteAnalytic');

  constructor(
    private readonly prisma: PrismaService,
    private readonly dfs: DataForSeoClient,
    private readonly keysso: KeysSoClient,
    private readonly site: DefaultSiteCollectors,
    @Inject(LLM_LAYER) private readonly llm: LlmLayer,
    private readonly plans: PlanService,
  ) {}

  /** ISO week UTC → "YYYY-Www" (port of week_key, web/services.py:69-71). */
  weekKey(now: Date = new Date()): string {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
    d.setUTCDate(d.getUTCDate() - dayNum + 3); // Thursday of this week
    const isoYear = d.getUTCFullYear();
    const firstThu = new Date(Date.UTC(isoYear, 0, 4));
    const firstDayNum = (firstThu.getUTCDay() + 6) % 7;
    firstThu.setUTCDate(firstThu.getUTCDate() - firstDayNum + 3);
    const week = 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 24 * 3600 * 1000));
    return `${isoYear}-W${String(week).padStart(2, '0')}`;
  }

  /**
   * The PURE pipeline for one domain (run_site_analytic). Network failures
   * inside collect are isolated; the LLM layer/snapshot/guide are best-effort
   * (Python failure-isolated) — the deterministic report stays valid without them.
   */
  async analyzeDomain(domain: string, opts: AnalyzeOpts = {}): Promise<AnalyzeResult> {
    const meter = new CostMeter();
    const progress = opts.progress;
    const llmOpts = { userId: opts.userId ?? null, lite: !!opts.lite, progress };

    const { facts, llmOutputs } = await runWithCostMeter(meter, async () => {
      const raw: Raw = await collect(
        domain,
        { dfs: this.dfs, keysso: this.keysso, site: this.site },
        { compare: opts.compare ?? null, geo: opts.geo || 'us', progress },
      );
      if (progress) progress('normalization');
      let f = normalize(raw);

      // LLM layer (clusters/thinCluster/priorities/plan). No key → {} (no-op).
      let outputs: Record<string, any> = {};
      try {
        const r = await this.llm.runLlmLayer(f, (raw.keywords as any[]) ?? [], llmOpts);
        f = { ...f, ...r.merge };
        outputs = r.outputs ?? {};
      } catch (e: any) {
        this.log.warn(`LLM layer failed: ${e?.message ?? e}`);
        outputs = { error: String(e?.message ?? e) };
      }

      // AEO snapshot: the AEO block of facts + a raw run + validated competitors.
      try {
        const aeo = await this.llm.runAeoSnapshot(domain, f, raw, llmOpts);
        if (aeo) {
          f = { ...f, ...aeo.block };
          if (aeo.run) outputs.aeo_snapshot = aeo.run;
          if (aeo.competitors) f.competitors = aeo.competitors;
        }
      } catch (e: any) {
        this.log.warn(`AEO snapshot failed: ${e?.message ?? e}`);
      }

      // Full AEO guide (after the snapshot — builds on real AI answers).
      try {
        const guide = await this.llm.contentGuide(f, llmOpts);
        if (guide) f.aeoGuide = guide;
      } catch (e: any) {
        this.log.warn(`content guide failed: ${e?.message ?? e}`);
      }
      return { facts: f, llmOutputs: outputs };
    });

    const costUsd = pyRound(meter.totalUsdCost(), 4);
    facts.meta.cost_usd = costUsd;
    return { facts, llmOutputs, costUsd };
  }

  // ── storage / coalescing ──────────────────────────────────────────────────

  /**
   * A finished analysis for this week (weekly cache) with the privacy
   * predicate (_SA_VISIBLE): a private audit of one's own brand isn't served
   * from the shared cache.
   */
  async findCached(domain: string, geo: string, week: string, userId: number | null) {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT sa.id, sa.user_id, sa.job_id, sa.compare_domain, sa.status
      FROM site_analyses sa
      WHERE sa.domain = ${domain} AND sa.geo = ${geo} AND sa.week_key = ${week}
        AND sa.status = 'done' AND sa.facts IS NOT NULL
        AND (sa.user_id = ${userId} OR NOT EXISTS (
          SELECT 1 FROM brands b WHERE b.domain = sa.domain AND b.user_id = sa.user_id))
      ORDER BY sa.id DESC LIMIT 1`;
    return rows[0] ?? null;
  }

  /**
   * An unfinished analysis for the same week — coalescing parallel clicks.
   * Only a "live" one (created_at within SA_STALE_MIN): a row stuck after a
   * restart is NOT coalesced onto (otherwise every next click on the domain
   * until the end of the ISO week would return status='running' forever), so
   * the request goes to a fresh run or a refresh-reset of its own row.
   */
  async findActive(domain: string, geo: string, week: string, userId: number | null) {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT sa.id, sa.user_id, sa.job_id, sa.status
      FROM site_analyses sa
      WHERE sa.domain = ${domain} AND sa.geo = ${geo} AND sa.week_key = ${week}
        AND sa.status IN ('queued', 'running')
        AND sa.created_at > now() - make_interval(mins => ${SA_STALE_MIN}::int)
        AND (sa.user_id = ${userId} OR NOT EXISTS (
          SELECT 1 FROM brands b WHERE b.domain = sa.domain AND b.user_id = sa.user_id))
      ORDER BY sa.id DESC LIMIT 1`;
    return rows[0] ?? null;
  }

  /**
   * Flips stale runs (running/queued older than SA_STALE_MIN) to error — a
   * safeguard against a process restart mid-detached-run. Called on module
   * startup (OnModuleInit). Gated by age, not "everything at once", so it
   * doesn't kill a live Python run before the nginx flip. Never throws.
   */
  async reapStale(): Promise<number> {
    try {
      const n = await this.prisma.$executeRaw`
        UPDATE site_analyses
        SET status = 'error', error_text = 'прервано рестартом', finished_at = now()
        WHERE status IN ('queued', 'running')
          AND created_at < now() - make_interval(mins => ${SA_STALE_MIN}::int)`;
      if (n) this.log.warn(`reapStale: flipped stale analyses: ${n}`);
      return Number(n) || 0;
    } catch (e: any) {
      this.log.warn(`reapStale skipped: ${e?.message ?? e}`);
      return 0;
    }
  }

  /** Active (queued/running) analyses for a user — for the per-user quota. */
  async countActive(userId: number): Promise<number> {
    return this.prisma.siteAnalysis.count({
      where: { userId, status: { in: ['queued', 'running'] } },
    });
  }

  /**
   * Count of DISTINCT domains for a user (their analyses ∪ AEO trackers) —
   * usage for the plan's brand limit (port of
   * count_analysis_domains_for_user, storage.py:832). excludeDomain is the
   * current request's domain: re-analyzing your own domain doesn't take a new
   * slot. Missing tables / error → 0 (the gate shouldn't fail the launch).
   */
  async countAnalysisDomainsForUser(userId: number, excludeDomain: string): Promise<number> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ n: bigint | number }>>`
        SELECT COUNT(*) AS n FROM (
          SELECT domain FROM site_analyses WHERE user_id = ${userId}
          UNION SELECT domain FROM aeo_trackers WHERE user_id = ${userId}
        ) s WHERE s.domain <> COALESCE(${excludeDomain}, '')`;
      return Number(rows[0]?.n ?? 0);
    } catch (e: any) {
      this.log.warn(`count analysis domains skipped: ${e?.message ?? e}`);
      return 0;
    }
  }

  /**
   * The analysis launch flow (start_site_analytic): the plan's brand limit →
   * weekly cache → coalescing → per-user quota → refresh of its own row →
   * create → DETACH the run into the background → respond queued right away
   * (the client polls GET /analyses/:id). The only copy of this logic
   * (cache/coalescing/quota/limit) in prod — the Python contour for
   * site_analytic is no longer invoked. Returns {id, status, cached,
   * coalesced?}: cached→done, fresh→queued.
   */
  async runAnalysis(input: RunAnalysisInput): Promise<{
    id: number; status: string; cached: boolean; coalesced?: boolean;
  }> {
    const domain = cleanDomain(input.domain);
    if (!domain || !domain.includes('.')) {
      throw new HttpException('domain required', 400);
    }
    const compare = cleanDomain(input.compare || '') || null;
    let geo = String(input.geo || '').trim().toLowerCase();
    if (!ANALYTIC_GEOS.has(geo)) geo = isRuDomain(domain) ? 'ru' : 'us';
    const userId = input.userId ?? null;
    const week = this.weekKey();

    // Plan's brand limit (port of _account_limits + count_analysis_domains_for_user,
    // web/services.py:39,150): analyzing a NEW domain can't exceed limits.brands
    // (previously analyzed own domains are re-analyzed freely). Admin / no user
    // — no gate. Checked BEFORE the cache: a cache hit on someone else's
    // analysis is cloned to the user, i.e. it also takes a brand slot.
    if (userId && !input.isAdmin) {
      const limits = await this.plans.resolveLimits(userId);
      const used = await this.countAnalysisDomainsForUser(userId, domain);
      if (used >= limits.brands) {
        throw new HttpException(
          `Limit of ${limits.brands} brand(s) on the ${limits.title} plan — ` +
            'upgrade your plan to analyze more sites',
          402,
        );
      }
    }

    // Weekly cache (unless refresh): the compare value must match too.
    if (!input.refresh) {
      const cached = await this.findCached(domain, geo, week, userId);
      if (cached && (cached.compare_domain || null) === compare) {
        let id = cached.id as number;
        if (userId && cached.user_id !== userId) {
          const clone = await this.cloneForUser(cached.id, userId);
          if (clone) id = clone;
        }
        return { id, status: 'done', cached: true };
      }
    }

    // Coalescing: landed on an already-running run — no new job (or spend).
    const active = await this.findActive(domain, geo, week, userId);
    if (active) return { id: active.id, status: active.status, cached: false, coalesced: true };

    // Per-user quota of concurrent analyses (port of
    // enqueue_analytic→QuotaExceeded, web/jobs.py:415): cache hits and
    // coalescing don't reach here — just like Python, they aren't blocked by
    // the quota and don't rack up spend. Checked BEFORE creating the row, so
    // no "-1" like Python used to exclude the just-created queued row from the count.
    const quota = analyticUserQuota();
    if (userId && quota > 0) {
      const activeCount = await this.countActive(userId);
      if (activeCount >= quota) {
        throw new HttpException(
          `You already have ${activeCount} analysis/analyses running. ` +
            'Please wait for it to finish and try again.',
          429,
        );
      }
    }

    // "Refresh analysis": a re-run updates ITS OWN weekly row in place.
    let saId: number;
    const own = input.refresh && userId
      ? await this.prisma.siteAnalysis.findFirst({
          where: { userId, domain, geo, weekKey: week },
          orderBy: { id: 'desc' },
          select: { id: true },
        })
      : null;
    if (own) {
      // Bump createdAt to now(): the row is reused, but for findActive/
      // reapStale this is "the start of a new run" — otherwise the old
      // created_at would immediately count as stale and a parallel click
      // would spawn a duplicate run.
      await this.prisma.siteAnalysis.update({
        where: { id: own.id },
        data: {
          status: 'queued', progress: 0, errorText: null, finishedAt: null,
          compareDomain: compare, createdAt: new Date(),
        },
      });
      saId = own.id;
    } else {
      const created = await this.prisma.siteAnalysis.create({
        data: { userId, domain, compareDomain: compare, geo, weekKey: week, status: 'queued' },
        select: { id: true },
      });
      saId = created.id;
    }

    // Detach: the run goes into the current process's background, and we
    // respond right away as queued. An inline await used to exceed nginx's
    // proxy_read_timeout (504 to the client, even though Node kept writing)
    // and blocked the response for minutes. The client polls GET
    // /analyses/:id (the standard openapi async contract). runPipeline
    // manages running→done/error itself and never throws (an unhandled
    // rejection doesn't crash the process).
    void this.runPipeline(saId, domain, { compare, geo, userId, lite: !!input.lite });
    return { id: saId, status: 'queued', cached: false };
  }

  /**
   * Background run for one site_analyses row: running → analyzeDomain →
   * done/error. Never throws (writes the error into the row). Called
   * detached from runAnalysis (without await). IMPORTANT: a process restart
   * mid-run leaves the row in running — reapStale/findActive will pick it up
   * via SA_STALE_MIN.
   */
  private async runPipeline(
    saId: number,
    domain: string,
    opts: { compare: string | null; geo: string; userId: number | null; lite: boolean },
  ): Promise<void> {
    try {
      await this.prisma.siteAnalysis.update({ where: { id: saId }, data: { status: 'running' } });
      const { facts, llmOutputs, costUsd } = await this.analyzeDomain(domain, {
        compare: opts.compare, geo: opts.geo, userId: opts.userId, lite: opts.lite,
      });
      await this.prisma.siteAnalysis.update({
        where: { id: saId },
        data: {
          status: 'done',
          progress: 100,
          facts: facts as any,
          llmOutputs: llmOutputs as any,
          costCents: pyRound(costUsd * 100),
          finishedAt: new Date(),
        },
      });
    } catch (e: any) {
      this.log.warn(`site_analysis #${saId} (${domain}) failed: ${e?.message ?? e}`);
      await this.prisma.siteAnalysis
        .update({
          where: { id: saId },
          data: { status: 'error', errorText: String(e?.message ?? e).slice(0, 500), finishedAt: new Date() },
        })
        .catch(() => undefined);
    }
  }

  /**
   * Clone a finished analysis into a new row for the user on a cache hit of
   * someone else's/system analysis (clone_site_analysis_for_user). cost=0 —
   * a cache hit doesn't inflate the user's spend.
   */
  async cloneForUser(srcId: number, userId: number): Promise<number | null> {
    const src = await this.prisma.siteAnalysis.findUnique({ where: { id: srcId } });
    if (!src) return null;
    const created = await this.prisma.siteAnalysis.create({
      data: {
        userId,
        jobId: src.jobId,
        domain: src.domain,
        compareDomain: src.compareDomain,
        geo: src.geo,
        weekKey: src.weekKey,
        status: 'done',
        progress: 100,
        facts: src.facts as any,
        llmOutputs: src.llmOutputs as any,
        costCents: 0,
        finishedAt: new Date(),
      },
      select: { id: true },
    });
    return created.id;
  }
}
