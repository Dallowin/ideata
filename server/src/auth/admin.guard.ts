import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service';

/**
 * Guards routes that require an admin session (`_cw` cookie with `a=true`).
 * Reads the session via AuthService.userFromRequest — same check the scrapper
 * admin panel uses — and rejects anyone who isn't a verified admin.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const user = this.auth.userFromRequest(req);
    if (user?.a === true) return true;
    throw new UnauthorizedException('Admin session required');
  }
}
