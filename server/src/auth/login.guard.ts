import {
  CanActivate,
  ExecutionContext,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { effectivePlan } from './plan.guard';

// Paid plans for the public API (matches the scrapper's _PAID_PLANS:
// lite/pro/scale). Differs from BLOG_PLANS (pro/scale) — the blog writer
// unlocks with Pro, while AI analyses already unlock with Lite.
export const PAID_PLANS = new Set(['lite', 'pro', 'scale']);

/**
 * Requires a live `_cw` session and puts SessionUser on req.user — retrieved
 * later via @CurrentUser(). REST equivalent of the manual requireUser() in ToolsResolver.
 */
@Injectable()
export class LoginGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const user = this.auth.userFromRequest(req);
    if (!user) throw new UnauthorizedException('Login required');
    (req as any).user = user;
    return true;
  }
}

/**
 * Login + a paid plan. 402 is the frontend contract: useApi routes on it to
 * the pricing page (like _require_paid in the scrapper).
 * An admin is treated as scale and always passes.
 */
@Injectable()
export class PaidPlanGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const user = this.auth.userFromRequest(req);
    if (!user) throw new UnauthorizedException('Login required');
    (req as any).user = user;
    const plan = await effectivePlan(this.prisma, user);
    if (PAID_PLANS.has(plan)) return true;
    throw new HttpException(
      'AI analysis is available on a paid plan. Upgrade your plan to continue.',
      402,
    );
  }
}
