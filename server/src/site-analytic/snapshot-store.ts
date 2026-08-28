/**
 * Prisma implementation of AeoSnapshotStore — the DB half of the "unified brand
 * panel" (site_analytic.py:711-910) and resolveUserPlan (auth/plan.guard).
 * Monitoring persistence happens only after SiteAnalysis itself is durably
 * finished, through AeoTrackerProvisioningService.
 *
 * COVERAGE-GAP: promptPoolLeft returns null (no clamping by the account's
 * remaining pool — the port of storage.prompt_pool_left with plan + add-on limits
 * is deferred). Without the clamp n_prompts stays at the plan's prompt_count(plan),
 * which does not overstate behaviour.
 */
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { resolveUserPlan } from '../auth/plan.guard';
import type { PanelEntry } from '../aeo/panel';
import type { AeoSnapshotStore, SnapshotTracker } from './aeo-snapshot';

export class PrismaSnapshotStore implements AeoSnapshotStore {
  constructor(private readonly prisma: PrismaService) {}

  /** effective_plan(user_id) — plan from user_plans (admin → scale is handled deeper, not needed here). */
  async effectivePlan(userId: number): Promise<string | null> {
    return resolveUserPlan(this.prisma, userId);
  }

  /** find_aeo_tracker(domain, user_id, include_paused=True): active ones come first. */
  async findTracker(
    domain: string,
    userId: number,
  ): Promise<SnapshotTracker | null> {
    try {
      const t = await this.prisma.aeoTracker.findFirst({
        where: { domain, userId },
        orderBy: [{ active: 'desc' }, { id: 'desc' }],
        select: { id: true, prompts: true },
      });
      return t ? { id: t.id, prompts: t.prompts } : null;
    } catch {
      return null; // missing table/connection — treated as "no tracker"
    }
  }

  /** brand_aliases(user_id, domain) — confirmed spellings of the brand (best-effort). */
  async brandAliases(userId: number, domain: string): Promise<string[]> {
    try {
      const b = await this.prisma.brand.findFirst({
        where: { userId, domain },
        orderBy: [{ isActive: 'desc' }, { id: 'asc' }],
        select: { aliases: true },
      });
      const list = Array.isArray(b?.aliases) ? (b!.aliases as unknown[]) : [];
      return list.filter((x): x is string => typeof x === 'string' && !!x);
    } catch {
      return [];
    }
  }

  /** COVERAGE-GAP: no clamping by the account pool (null → n_prompts = prompt_count(plan)). */
  async promptPoolLeft(): Promise<number | null> {
    return null;
  }

  /** update_aeo_tracker(id, prompts=merged) — sync the panel top-up back into the tracker. */
  async updateTrackerPrompts(
    trackerId: number,
    prompts: PanelEntry[],
  ): Promise<void> {
    await this.prisma.aeoTracker.update({
      where: { id: trackerId },
      data: { prompts: prompts as unknown as Prisma.InputJsonValue },
    });
  }
}
