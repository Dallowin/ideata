import { Injectable, Logger } from '@nestjs/common';

// Cloudflare Turnstile: server-side verification of the widget token.
// Without TURNSTILE_SECRET_KEY in the environment, the captcha is considered
// disabled — throttling (LoginThrottleService) keeps working on its own, and
// local development doesn't need keys. The site is behind Cloudflare anyway;
// keys live in the CF Turnstile dashboard.
@Injectable()
export class CaptchaService {
  private readonly log = new Logger(CaptchaService.name);
  private secret = (process.env.TURNSTILE_SECRET_KEY ?? '').trim();

  get enabled(): boolean {
    return !!this.secret;
  }

  /** true = token is valid (or the captcha is disabled — no gate at all in that case). */
  async verify(token: string | undefined, ip: string): Promise<boolean> {
    if (!this.enabled) return true;
    if (!token || typeof token !== 'string') return false;
    try {
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret: this.secret, response: token, remoteip: ip }),
      });
      if (!res.ok) throw new Error(`siteverify HTTP ${res.status}`);
      const data: any = await res.json();
      return data?.success === true;
    } catch (e: any) {
      // fail-open: a down CF service shouldn't lock out login for all users —
      // throttling with a lockout still guards against bruteforce either way.
      this.log.warn(`Turnstile siteverify unavailable: ${e?.message || e}`);
      return true;
    }
  }
}
