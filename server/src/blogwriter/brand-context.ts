import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { BrandsService } from '../brands/brands.service';

/**
 * Resolves the active brand workspace for a blog-writer request FROM THE SESSION (_cw cookie),
 * not from the request body/header — the client can't spoof someone else's brand. All
 * controllers are under PlanGuard, so the user is already verified (admin OR blog access via plan /
 * membership). Access to a SPECIFIC brand/run is checked by membership:
 *   • read (lists, run view) — any accessible role (owner/editor/viewer);
 *   • mutations (start/publish/delete/retry/…) — owner/editor; viewer → 403.
 */
@Injectable()
export class BlogBrandContext {
  constructor(
    private readonly auth: AuthService,
    private readonly brands: BrandsService,
  ) {}

  /** Active brand id (0 — no accessible brands / account-wide defaults). */
  async brandId(req: Request | undefined): Promise<number> {
    const brand = await this.brand(req);
    return brand?.id ?? 0;
  }

  /**
   * The full active brand (or null). We prefer the X-Brand-Id header (sent by
   * useBlogtool from the optimistic switcher), but ONLY if that brand is ACCESSIBLE
   * to the current user (their own, or an owner's brand they're a member of). Otherwise — the active
   * one from user_active_brand (pointer) falling back to their own Brand.isActive.
   */
  async brand(req: Request | undefined) {
    const user = this.auth.userFromRequest(req);
    if (!user?.i) return null;
    try {
      const hdr = Number((req?.headers?.['x-brand-id'] as string) || '');
      if (Number.isFinite(hdr) && hdr > 0) {
        const acc = await this.brands.getAccessible(user.i, hdr);
        if (acc)
          return {
            id: acc.brand.id,
            domain: acc.brand.domain,
            name: acc.brand.name || null,
            myRole: acc.role,
            ownerUserId: acc.brand.userId,
            isActive: true,
          } as any;
      }
      return await this.brands.activeForUser(user.i);
    } catch {
      return null;
    }
  }

  /** true — admin session (`_cw` a=true): sees all runs/brands, as before. */
  isAdmin(req: Request | undefined): boolean {
    return this.auth.userFromRequest(req)?.a === true;
  }

  /** Current user's role for the run's brand (null — inaccessible). Admin → 'owner'. */
  private async roleForRun(
    req: Request | undefined,
    row: { brandId?: number | null } | null | undefined,
  ): Promise<string | null> {
    if (this.isAdmin(req)) return 'owner';
    const user = this.auth.userFromRequest(req);
    const brandId = row?.brandId ?? 0;
    if (!user?.i || brandId <= 0) return null;
    const acc = await this.brands.getAccessible(user.i, brandId);
    return acc?.role ?? null;
  }

  /**
   * Checks READ access to a run (view/lists/export). Rule:
   *   • admin → always;
   *   • run belongs to an accessible brand (owner/editor/viewer) → ok;
   *   • otherwise (someone else's brand OR a run with no brand — global/imported) →
   *     404, so we don't leak the existence of someone else's run.
   */
  async assertRunAccess(
    req: Request | undefined,
    row: { brandId?: number | null } | null | undefined,
  ): Promise<void> {
    const role = await this.roleForRun(req, row);
    if (role) return;
    throw new NotFoundException('run not found');
  }

  /**
   * Checks MUTATE access to a run (start/publish/delete/retry/…):
   * owner/editor — pass; viewer → 403; inaccessible → 404.
   */
  async assertRunMutate(
    req: Request | undefined,
    row: { brandId?: number | null } | null | undefined,
  ): Promise<void> {
    const role = await this.roleForRun(req, row);
    if (role === 'owner' || role === 'editor') return;
    if (role === 'viewer')
      throw new ForbiddenException(
        'View-only access — ask the owner to grant you the editor role',
      );
    throw new NotFoundException('run not found');
  }

  /**
   * Checks that the active brand allows MUTATION (creating a run/generation without
   * being tied to an existing run). owner/editor — ok; viewer → 403; no brand
   * → let the caller decide (usually requires a brand separately).
   */
  async assertBrandMutate(req: Request | undefined): Promise<void> {
    if (this.isAdmin(req)) return;
    const brand: any = await this.brand(req);
    if (!brand) return; // no active brand — not our error to raise (the controller decides)
    if (brand.myRole === 'viewer')
      throw new ForbiddenException(
        'View-only access — ask the owner to grant you the editor role',
      );
  }
}
