import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';

/**
 * A light throttle on expensive LLM endpoints that do NOT charge credits
 * (ai-edit, antislop/rewrite, factfix, topic/keyword generation, link research,
 * voice analysis, content-plan generation). An article run charges credits as it goes
 * (chargeRunCredits) and is thus self-regulating, but these aren't: one loop in a browser
 * console burns money with the provider without leaving a single trace in billing.
 *
 * The implementation is intentionally simple — an in-process-memory token bucket, no Redis or
 * new dependencies. This is not protection against a distributed attack (we have several
 * workers, each with its own bucket), but insurance against a "stuck button" and against
 * a single user's script. The key is userId from the session, so an office NAT doesn't
 * catch someone else's limits; without a session, requests don't get this far anyway (PlanGuard above).
 *
 * The run pipeline is NOT covered by this guard — it goes through its own runs/* endpoints.
 */

/** Bucket capacity: how many requests in a row can be made in a "burst". */
const BURST = 12;
/** Time for the bucket to fully refill (≈ BURST requests per minute). */
const REFILL_MS = 60_000;
/** The bucket expires if unused — so the map doesn't grow forever. */
const IDLE_TTL_MS = 10 * 60_000;

interface Bucket {
  tokens: number;
  at: number;
}

@Injectable()
export class LlmRateGuard implements CanActivate {
  private readonly buckets = new Map<number, Bucket>();
  private lastSweep = 0;

  constructor(private readonly auth: AuthService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const userId = this.auth.userFromRequest(req)?.i;
    if (!userId) return true; // not our concern: auth is checked by PlanGuard

    const now = Date.now();
    this.sweep(now);

    const b = this.buckets.get(userId) ?? { tokens: BURST, at: now };
    // continuous refill: BURST tokens over REFILL_MS
    b.tokens = Math.min(BURST, b.tokens + ((now - b.at) * BURST) / REFILL_MS);
    b.at = now;

    if (b.tokens < 1) {
      this.buckets.set(userId, b);
      const waitS = Math.ceil(((1 - b.tokens) * REFILL_MS) / BURST / 1000);
      throw new HttpException(
        `Too many requests — wait ${waitS}s and try again`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    b.tokens -= 1;
    this.buckets.set(userId, b);
    return true;
  }

  /** Once a minute, evict buckets that haven't been touched in a while. */
  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [k, v] of this.buckets) {
      if (now - v.at > IDLE_TTL_MS) this.buckets.delete(k);
    }
  }
}
