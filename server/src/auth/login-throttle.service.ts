import { Injectable } from '@nestjs/common';
import type { Request } from 'express';

// Anti-bruteforce for /auth/login and /auth/register: a sliding window of failed
// attempts per-email and per-IP, with two layers of defense on top of it:
//   1) captchaRequired — after a few failures the frontend must attach a
//      Turnstile token (checked by CaptchaService);
//   2) lock — truly relentless retrying gets a 429 with Retry-After.
// Storage lives in process memory: api is a single systemd instance, so a restart
// on deploy simply resets the counters (acceptable: doesn't help an attacker systemically).

interface Bucket {
  fails: number[]; // timestamps (ms) of failed attempts within the window
  lockUntil: number; // ms; 0 = not locked
  lockCount: number; // how many times already locked — lock duration grows exponentially
}

const WINDOW_MS = 15 * 60 * 1000;

// email is a narrow key (protects a specific account), IP is a broad one (protects
// against bruteforcing many accounts from one machine; real people sit behind NAT,
// so the thresholds are noticeably higher).
const EMAIL_CAPTCHA_AFTER = 3;
const EMAIL_LOCK_AFTER = 10;
const IP_CAPTCHA_AFTER = 10;
const IP_LOCK_AFTER = 30;
const BASE_LOCK_MS = 15 * 60 * 1000; // 15 min, doubles with each new lock

// Registrations: spam accounts from a single IP.
const REG_WINDOW_MS = 60 * 60 * 1000;
const REG_MAX_PER_IP = 5;

const MAX_BUCKETS = 50_000; // safeguard against memory bloat from spoofed keys

export interface ThrottleGate {
  /** seconds until unlock; 0 = not locked */
  retryAfterS: number;
  /** the frontend must attach a captcha token (if a captcha is configured at all) */
  captchaRequired: boolean;
}

@Injectable()
export class LoginThrottleService {
  private buckets = new Map<string, Bucket>();
  private regs = new Map<string, number[]>();

  /** The real IP behind the cloudflare/nginx proxy. */
  clientIp(req: Request): string {
    const h = req.headers;
    const first = (v: string | string[] | undefined) =>
      (Array.isArray(v) ? v[0] : v)?.split(',')[0]?.trim() || '';
    return (
      first(h['cf-connecting-ip']) ||
      first(h['x-real-ip']) ||
      first(h['x-forwarded-for']) ||
      req.ip ||
      'unknown'
    );
  }

  private bucket(key: string): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= MAX_BUCKETS) this.prune();
      b = { fails: [], lockUntil: 0, lockCount: 0 };
      this.buckets.set(key, b);
    }
    return b;
  }

  private prune(now = Date.now()): void {
    for (const [k, b] of this.buckets) {
      b.fails = b.fails.filter((t) => now - t < WINDOW_MS);
      if (!b.fails.length && b.lockUntil <= now) this.buckets.delete(k);
    }
    for (const [k, ts] of this.regs) {
      const alive = ts.filter((t) => now - t < REG_WINDOW_MS);
      if (alive.length) this.regs.set(k, alive);
      else this.regs.delete(k);
    }
  }

  private failsIn(b: Bucket, now: number): number {
    b.fails = b.fails.filter((t) => now - t < WINDOW_MS);
    return b.fails.length;
  }

  /** State BEFORE the login attempt: locked out? captcha required? */
  check(email: string, ip: string): ThrottleGate {
    const now = Date.now();
    const eb = this.bucket(`e:${email}`);
    const ib = this.bucket(`i:${ip}`);
    const lockUntil = Math.max(eb.lockUntil, ib.lockUntil);
    if (lockUntil > now)
      return { retryAfterS: Math.ceil((lockUntil - now) / 1000), captchaRequired: true };
    return {
      retryAfterS: 0,
      captchaRequired:
        this.failsIn(eb, now) >= EMAIL_CAPTCHA_AFTER ||
        this.failsIn(ib, now) >= IP_CAPTCHA_AFTER,
    };
  }

  /** Failed login: accumulate, and once the threshold is crossed, lock with a growing duration. */
  recordFail(email: string, ip: string): void {
    const now = Date.now();
    const eb = this.bucket(`e:${email}`);
    const ib = this.bucket(`i:${ip}`);
    eb.fails.push(now);
    ib.fails.push(now);
    for (const [b, limit] of [
      [eb, EMAIL_LOCK_AFTER],
      [ib, IP_LOCK_AFTER],
    ] as const) {
      if (this.failsIn(b, now) >= limit && b.lockUntil <= now) {
        b.lockUntil = now + BASE_LOCK_MS * 2 ** Math.min(b.lockCount, 4); // max 4 hours
        b.lockCount += 1;
        b.fails = []; // the window starts over after a lock
      }
    }
  }

  /** Successful login: the account is clean; the IP counter is left to decay on its own. */
  recordSuccess(email: string): void {
    this.buckets.delete(`e:${email}`);
  }

  /** Registration limit from a single IP (spam accounts). true = allowed. */
  allowRegister(ip: string): boolean {
    const now = Date.now();
    const ts = (this.regs.get(ip) ?? []).filter((t) => now - t < REG_WINDOW_MS);
    this.regs.set(ip, ts);
    return ts.length < REG_MAX_PER_IP;
  }

  recordRegister(ip: string): void {
    const ts = this.regs.get(ip) ?? [];
    ts.push(Date.now());
    this.regs.set(ip, ts);
  }
}
