import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import type { SessionUser } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { PlanService } from '../plans/plans.service';

// Plans that ORIGINALLY unlocked the blog writer (pro/scale). Kept for backward
// compatibility/documentation; the actual gate is now limits.blogEnabled
// (see PlanGuard.canActivate), so lite + the blog_addon add-on also passes.
export const BLOG_PLANS = new Set(['pro', 'scale']);

/**
 * The user's plan from the SHARED `user_plans` table (written by scrapper / CLI —
 * there's no billing yet). The table is defined in the Prisma schema (UserPlan),
 * so we read it via the client. No row / DB unavailable → safe default 'free'.
 */
export async function resolveUserPlan(
  prisma: PrismaService,
  userId: number | undefined,
): Promise<string> {
  if (!userId) return 'free';
  try {
    const row = await prisma.userPlan.findUnique({ where: { userId } });
    return (row?.plan || 'free').toLowerCase();
  } catch {
    return 'free';
  }
}

/**
 * The user's "effective plan" — the single source of truth (matches the
 * scrapper's `_effective_plan` contract): admin (`_cw` with a=true) → 'scale',
 * otherwise the string from `user_plans` (or 'free'). The admin handling used to
 * be duplicated in PlanGuard, PaidPlanGuard and AccountPlanController — now they
 * all call this instead.
 */
export async function effectivePlan(
  prisma: PrismaService,
  user: SessionUser,
): Promise<string> {
  // OSS: no billing plans — by default EVERYONE is on the top plan 'scale' (removes
  // the 402 paywall, brand limits, plan gates). Disable with OSS_UNLOCKED=0 (restores
  // the tariff logic).
  if ((process.env.OSS_UNLOCKED ?? '1') !== '0') return 'scale';
  if (user.a === true) return 'scale';
  return resolveUserPlan(prisma, user.i);
}

/**
 * Gate for blog writer access: lets in the admin (`_cw` with a=true) OR a user
 * whose plan has the blog enabled — `PlanService.resolveLimits().blogEnabled`.
 * This covers not just pro/scale but also lite with the blog_addon add-on (a single
 * source of truth for limits instead of a hardcoded pro/scale set). Anything scoped
 * to a specific run/brand additionally checks ownership in the controllers
 * (BlogBrandContext.assertRunAccess).
 */
@Injectable()
export class PlanGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const user = this.auth.userFromRequest(req);
    if (!user) throw new UnauthorizedException('Login required');
    if (user.a === true) return true; // admin — always
    const limits = await this.plans.resolveLimits(user.i);
    if (limits.blogEnabled) return true;
    // Team (stage 5a): a member of an account with the blog enabled (any role) gets
    // into the owner's blog even if they themselves are on free. Simplification: the
    // controller-level gate doesn't know the specific brand, so we let membership in
    // ANY account with blogEnabled through; access to a SPECIFIC run/brand is further
    // restricted by BlogBrandContext (viewer read-only, mutations — owner/editor).
    if (await this.memberOfBlogAccount(user.i)) return true;
    throw new ForbiddenException(
      'The blog writer is available on the Pro plan and above (or Start with the "Blog" add-on). Upgrade your plan to generate posts.',
    );
  }

  /** true — the user is a member of an account whose owner has the blog enabled by plan. */
  private async memberOfBlogAccount(userId: number): Promise<boolean> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ ownerId: number }[]>(
        `SELECT DISTINCT owner_user_id AS "ownerId"
           FROM account_members WHERE member_user_id = $1`,
        userId,
      );
      for (const r of rows) {
        const lim = await this.plans.resolveLimits(Number(r.ownerId));
        if (lim.blogEnabled) return true;
      }
    } catch {
      /* no account_members table / DB unavailable → not a blog account */
    }
    return false;
  }
}
