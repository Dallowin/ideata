import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Per-IP rate limit for the free tech audit — port of web/ratelimit.py.
 *
 * Needed specifically for the free tool: it has neither a session nor a
 * per-user quota, and every call hits someone else's site from our IP.
 * Without a limit, the tool becomes an open scanning proxy.
 *
 * In-process memory storage, like LoginThrottleService: the api is a single
 * systemd instance, so a redeploy restart simply resets the windows. Python
 * prefers Redis here, but even there it's noted that for "10 checks per hour"
 * the difference between a fixed and a sliding window doesn't matter.
 */

const LIMIT = Number(process.env.AUDIT_IP_LIMIT || 10);
const WINDOW_MS = Number(process.env.AUDIT_IP_WINDOW || 3600) * 1000;

@Injectable()
export class AuditThrottleService {
  private hits = new Map<string, number[]>();

  /**
   * The client's real IP, not nginx's/Cloudflare's.
   *
   * Trust order: CF-Connecting-IP (Cloudflare sets it and overwrites the
   * client's, so it can't be spoofed from outside) → first X-Forwarded-For
   * address → socket. The client CAN spoof XFF, so it's lower priority; behind
   * our nginx that's acceptable — this limit is about courtesy, not security.
   */
  clientIp(req: Request): string {
    const cf = String(req.headers['cf-connecting-ip'] || '').trim();
    if (cf) return cf;
    const xff = String(req.headers['x-forwarded-for'] || '').trim();
    if (xff) return xff.split(',')[0].trim();
    return req.ip || req.socket?.remoteAddress || 'unknown';
  }

  /** Registers an attempt. true — allowed, false — limit exhausted. */
  allow(key: string): boolean {
    const now = Date.now();
    const queue = (this.hits.get(key) || []).filter((t) => now - t <= WINDOW_MS);
    if (queue.length >= LIMIT) {
      this.hits.set(key, queue);
      return false;
    }
    queue.push(now);
    this.hits.set(key, queue);
    return true;
  }

  get limit(): number { return LIMIT; }
}
