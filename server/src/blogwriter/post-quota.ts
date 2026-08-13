import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { PlanService } from '../plans/plans.service';
import { postLimitError } from '../plans/plan-limits';

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000; // Europe/Moscow = UTC+3, no DST since 2014

/**
 * Start of the current day in Europe/Moscow as a UTC ISO string (…Z). Runs store
 * created_at as `new Date().toISOString()` (UTC, Z, fixed format), so a
 * lexicographic comparison `created_at >= <this string>` is a chronological one:
 * this way the limit's "day" is counted by the Moscow calendar day, not by UTC.
 */
export function moscowDayStartIso(now: Date = new Date()): string {
  // MSK "wall-clock" hours: shift UTC by +3 and read the components as UTC
  const msk = new Date(now.getTime() + MSK_OFFSET_MS);
  const y = msk.getUTCFullYear();
  const m = msk.getUTCMonth();
  const d = msk.getUTCDate();
  // midnight of this day in MSK, expressed in UTC (00:00 MSK = 21:00 UTC the previous day)
  const mskMidnightUtcMs = Date.UTC(y, m, d) - MSK_OFFSET_MS;
  return new Date(mskMidnightUtcMs).toISOString();
}

/**
 * Daily limit for article-generation runs (by plan: pro=2, scale=3,
 * lite+blog_addon=1, + the extra_posts add-on). We count ACTUAL pipeline runs
 * within the current Moscow day, not publications: runs of the user's brand(s) where
 * `group_id == id` — i.e. primary articles, not translations (for translations
 * group_id points to the source's group) and not imports from an external blog (it
 * carries a historical created_at and isn't throttled by the limit, per the requirements).
 * Admin — no limit.
 */
@Injectable()
export class PostQuotaService {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
  ) {}

  /**
   * How many primary generations were started in the OWNER's account within the current
   * Moscow day (across all of the owner's brands). The quota is counted by owner
   * (account), not by member: a member generating in the owner's brand
   * spends the owner's quota.
   */
  async countTodayForOwner(
    ownerId: number,
    now: Date = new Date(),
  ): Promise<number> {
    const brands = await this.prisma.brand.findMany({
      where: { userId: ownerId },
      select: { id: true },
    });
    const ids = brands.map((b) => b.id);
    if (!ids.length) return 0;
    const since = moscowDayStartIso(now);
    const rows = await this.prisma.blogRun.findMany({
      where: { brandId: { in: ids }, created_at: { gte: since } },
      select: { id: true, group_id: true },
    });
    // primary article: its own group (this filters out translations)
    return rows.filter((r) => r.group_id === r.id).length;
  }

  /** Backward compatibility: count by the user's "own" account (owner == user). */
  async countTodayForUser(
    userId: number,
    now: Date = new Date(),
  ): Promise<number> {
    return this.countTodayForOwner(userId, now);
  }

  /**
   * Throws 429 if the brand's OWNER has exhausted the daily post limit. Call
   * BEFORE startRun (POST /runs and starting a content-plan slot). ``brandId`` —
   * the brand the run is starting in (if known): its owner determines both
   * the limit (resolveLimits) and usage. Without brandId — by the user's own account
   * (backward compatibility). It's guaranteed the request already passed PlanGuard.
   */
  async assertCanStart(
    req: Request,
    brandId?: number,
    now: Date = new Date(),
  ): Promise<void> {
    const user = this.auth.userFromRequest(req);
    if (!user || user.a === true) return; // no user → let PlanGuard decide; admin — no limit
    // the run's brand owner sets the quota; if the brand wasn't passed/not found — the user themselves
    let ownerId = user.i;
    if (brandId && brandId > 0) {
      try {
        const b = await this.prisma.brand.findUnique({
          where: { id: brandId },
          select: { userId: true },
        });
        if (b?.userId) ownerId = b.userId;
      } catch {
        /* no brand/DB — fall back to the user's own account */
      }
    }
    const limits = await this.plans.resolveLimits(ownerId);
    const perDay = limits.postsPerDay;
    const used = await this.countTodayForOwner(ownerId, now);
    if (used >= perDay) throw postLimitError(perDay, limits.title);
  }
}
