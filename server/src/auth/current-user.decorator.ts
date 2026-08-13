import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { SessionUser } from './auth.service';

/**
 * SessionUser placed on req.user by a guard (LoginGuard/PaidPlanGuard).
 * Only works alongside one of them: without a guard it returns undefined, not 401.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SessionUser => {
    const req = ctx.switchToHttp().getRequest();
    return req.user as SessionUser;
  },
);
