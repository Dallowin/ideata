import { Injectable } from '@nestjs/common';
import { randomInt, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { sendMail, mailConfigured, type MailMessage, type MailResult } from '../aeo/mail';

/**
 * Email verification — a native port of scrapper/web/verify.py + related
 * functions from core/storage.py (get_user_verify/set_user_verify_code/
 * confirm_user_email/confirm_email_by_address) and core/usage.py::gen_code.
 *
 * Session mechanics are NOT pulled in here — that's auth.service's job (the `_cw`
 * cookie); this service only knows about the verification code on the users row
 * (verify_code/verify_sent_at/email_verified_at) and sending the email through the
 * shared mailer (../aeo/mail).
 *
 * AUDIT FIXES against the Python reference:
 *   1) gen_code: Python core/usage.py:401 gets the code from `random.randint`
 *      (Mersenne Twister — predictable from a few outputs). Here it's crypto.randomInt
 *      (CSPRNG); the range and format (6 digits, leading zeros) are identical.
 *   2) Attempt counter + lockout: the Python verify-email endpoint checked the code
 *      with no attempt limit — a 6-digit code (10^6) can be brute-forced in minutes.
 *      Here failed checks are tracked by an in-memory counter with a lockout
 *      (recordAttempt/lockLeftS), so even a short code can't be brute-forced. The key
 *      is users.id (session flow) or `e:<email>` (flow via the email link).
 *   3) Code comparison is constant-time (ctEq), so byte-by-byte comparison timing
 *      doesn't "hint" at correct prefixes.
 *   Secrets (code, email) are NOT logged.
 */

// verify.py:23-24 — code TTL and resend cooldown.
export const CODE_TTL_MIN = 15;
export const RESEND_COOLDOWN_SEC = 60;

// Audit fix #2: limit on failed checks and lockout duration. The threshold is lenient
// (people rarely mistype 6 digits), but 10^6/5 makes brute-forcing pointless.
export const MAX_VERIFY_ATTEMPTS = 5;
export const VERIFY_LOCK_MS = 15 * 60 * 1000;
// Memory safeguard: confirmByAddress's key is an attacker-controlled email on an
// UNauthenticated endpoint, so a stream of unique emails would bloat the Map — same
// concern as MAX_BUCKETS in LoginThrottleService.
export const MAX_ATTEMPT_KEYS = 50_000;

/** Result of sending the code (send-verify). Branches map 1:1 to api_public_send_verify. */
export type SendResult =
  | { ok: 'sent' } // email was sent
  | { ok: 'skipped'; reason: 'disabled' | 'mail_off' } // soft gate skip
  | { ok: 'verified' } // already verified (Telegram/Google/earlier)
  | { error: 'no_user'; status: 404 }
  | { error: 'no_email'; status: 400 }
  | { error: 'cooldown'; status: 429; retryAfterS: number }
  | { error: 'send_failed'; status: 502 };

/** Result of checking the code (verify-email). */
export type ConfirmResult =
  | { ok: 'verified' }
  | { error: 'locked'; status: 429; retryAfterS: number }
  | { error: 'bad_code'; status: 400 };

interface AttemptBucket {
  fails: number;
  lockUntil: number; // ms; 0 — not locked
}

/** Constant-time comparison of equal-length strings (otherwise false without throwing). */
function ctEq(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Python-style "enabled" flag: value is NOT in {0,false,no,off} (verify.py:36-37). */
function envFlagOn(name: string, def: boolean): boolean {
  const v = (process.env[name] ?? '').trim().toLowerCase();
  if (v === '') return def;
  return !['0', 'false', 'no', 'off'].includes(v);
}

@Injectable()
export class EmailVerifyService {
  constructor(private readonly prisma: PrismaService) {}

  // Attempt counters live in process memory (api is a single systemd instance, same
  // as LoginThrottleService). A restart on deploy resets them — doesn't help an attacker.
  private attempts = new Map<string | number, AttemptBucket>();

  /**
   * Audit fix #1: a 6-digit code from CSPRNG (crypto.randomInt), formatted like
   * Python's `f"{random.randint(0, 999999):06d}"` — 000000..999999 with leading
   * zeros. randomInt(0, 1_000_000) yields [0, 999999].
   */
  static genCode(): string {
    return String(randomInt(0, 1_000_000)).padStart(6, '0');
  }

  /** Master switch for the gates (EMAIL_VERIFY_ENABLED, default 1) — verify.py:34-37. */
  verifyEnabled(): boolean {
    return envFlagOn('EMAIL_VERIFY_ENABLED', true);
  }

  /**
   * Whether ENFORCED verification is active: enabled AND mail configured
   * (verify.py:40-43). Otherwise the gates pass through — prod doesn't get stuck
   * without mail credentials.
   */
  gateActive(): boolean {
    return this.verifyEnabled() && mailConfigured();
  }

  private baseUrl(): string {
    return (process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '') || 'https://ideata.io';
  }

  /** Confirmation link for the email (verify.py:51-54). */
  verifyLink(email: string, code: string): string {
    return `${this.baseUrl()}/api/public/auth/verify-email?email=${encodeURIComponent(
      email,
    )}&code=${encodeURIComponent(code)}`;
  }

  // --- attempt counter (audit fix #2) ------------------------------------
  private bucket(key: string | number): AttemptBucket {
    let b = this.attempts.get(key);
    if (!b) {
      // Guard against memory-DoS (unique emails on the public link-based endpoint).
      if (this.attempts.size >= MAX_ATTEMPT_KEYS) this.prune();
      b = { fails: 0, lockUntil: 0 };
      this.attempts.set(key, b);
    }
    return b;
  }

  /** Remove inactive entries (lock expired and no failures) — frees memory. */
  private prune(now = Date.now()): void {
    for (const [k, b] of this.attempts) {
      if (b.lockUntil <= now && b.fails === 0) this.attempts.delete(k);
    }
  }

  /** Seconds left until unlock for a key; 0 — not locked. */
  lockLeftS(key: string | number): number {
    const b = this.attempts.get(key);
    if (!b) return 0;
    const left = b.lockUntil - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  /** Failed check: accumulate; at the threshold — lock and reset the counter. */
  private recordAttempt(key: string | number): void {
    const b = this.bucket(key);
    b.fails += 1;
    if (b.fails >= MAX_VERIFY_ATTEMPTS) {
      b.lockUntil = Date.now() + VERIFY_LOCK_MS;
      b.fails = 0;
    }
  }

  private resetAttempts(key: string | number): void {
    this.attempts.delete(key);
  }

  /** How many seconds of resend cooldown remain (verify.py cooldown). */
  cooldownLeftS(sentAt: Date | null | undefined): number {
    if (!sentAt) return 0;
    const elapsed = (Date.now() - sentAt.getTime()) / 1000;
    return Math.max(0, Math.ceil(RESEND_COOLDOWN_SEC - elapsed));
  }

  /**
   * Whether the user's email is verified — storage.py:1297-1313. Telegram/Google
   * (tg_id/google_id) are considered implicitly verified; email/password only after
   * email_verified_at.
   */
  private isVerifiedRow(u: {
    emailVerifiedAt: Date | null;
    tgId: bigint | null;
    googleId: string | null;
  }): boolean {
    return u.emailVerifiedAt != null || u.tgId != null || u.googleId != null;
  }

  /**
   * Send a code to the current user — a port of api_public_send_verify (app.py:2214-2253).
   * No secrets in logs; the email is sent via an injectable `send` (tests supply
   * a spy so nothing hits the network).
   */
  async sendUserCode(
    uid: number,
    lang: string,
    deps: { send?: (msg: MailMessage) => Promise<MailResult> } = {},
  ): Promise<SendResult> {
    if (!this.verifyEnabled()) return { ok: 'skipped', reason: 'disabled' };
    if (!mailConfigured()) return { ok: 'skipped', reason: 'mail_off' };

    const u = await this.prisma.user.findUnique({
      where: { id: uid },
      select: { email: true, tgId: true, googleId: true, emailVerifiedAt: true, verifySentAt: true },
    });
    if (!u) return { error: 'no_user', status: 404 };
    if (this.isVerifiedRow(u)) return { ok: 'verified' };
    const email = (u.email || '').trim();
    if (!email) return { error: 'no_email', status: 400 };

    const left = this.cooldownLeftS(u.verifySentAt);
    if (left > 0) return { error: 'cooldown', status: 429, retryAfterS: left };

    const code = EmailVerifyService.genCode();
    await this.prisma.user.update({
      where: { id: uid },
      data: { verifyCode: code, verifySentAt: new Date() },
    });
    this.resetAttempts(uid); // new code — clean slate for attempts

    const send = deps.send ?? sendMail;
    const res = await send(this.buildCodeEmail(email, code, lang));
    if (!res.sent) return { error: 'send_failed', status: 502 };
    return { ok: 'sent' };
  }

  /**
   * Check the current user's code — a port of confirm_user_email (storage.py:1322-1345)
   * + audit fix #2 (attempt limit) and #3 (constant-time comparison).
   */
  async confirmUser(uid: number, code: string): Promise<ConfirmResult> {
    const locked = this.lockLeftS(uid);
    if (locked > 0) return { error: 'locked', status: 429, retryAfterS: locked };

    const u = await this.prisma.user.findUnique({
      where: { id: uid },
      select: { emailVerifiedAt: true, tgId: true, googleId: true, verifyCode: true, verifySentAt: true },
    });
    if (!u) {
      this.recordAttempt(uid);
      return { error: 'bad_code', status: 400 };
    }
    // Already verified (incl. implicitly via Telegram/Google) — idempotently True.
    if (this.isVerifiedRow(u)) {
      this.resetAttempts(uid);
      return { ok: 'verified' };
    }
    const stored = (u.verifyCode || '').trim();
    const given = String(code || '').trim();
    const fresh =
      !!u.verifySentAt && Date.now() - u.verifySentAt.getTime() < CODE_TTL_MIN * 60_000;
    if (!stored || !given || !ctEq(stored, given) || !fresh) {
      this.recordAttempt(uid);
      return { error: 'bad_code', status: 400 };
    }
    await this.prisma.user.update({
      where: { id: uid },
      data: { emailVerifiedAt: new Date(), verifyCode: null },
    });
    this.resetAttempts(uid);
    return { ok: 'verified' };
  }

  /**
   * Confirm by (email, code) without a session — a click on the link from the email;
   * a port of confirm_email_by_address (storage.py:1347-1369). Same attempt limit,
   * key `e:<email>`. Idempotent: a click on an already-verified address succeeds.
   */
  async confirmByAddress(email: string, code: string): Promise<boolean> {
    const e = (email || '').trim().toLowerCase();
    if (!e) return false;
    const key = `e:${e}`;
    if (this.lockLeftS(key) > 0) return false;

    const given = String(code || '').trim();
    const cutoff = new Date(Date.now() - CODE_TTL_MIN * 60_000);
    const row = given
      ? await this.prisma.user.findFirst({
          where: {
            email: { equals: e, mode: 'insensitive' },
            verifyCode: given,
            verifySentAt: { gt: cutoff },
          },
          orderBy: { id: 'asc' },
          select: { id: true },
        })
      : null;
    if (row) {
      await this.prisma.user.update({
        where: { id: row.id },
        data: { emailVerifiedAt: new Date(), verifyCode: null },
      });
      this.resetAttempts(key);
      return true;
    }
    // Already verified? then a click on the link succeeds (idempotently).
    const done = await this.prisma.user.findFirst({
      where: { email: { equals: e, mode: 'insensitive' }, emailVerifiedAt: { not: null } },
      select: { id: true },
    });
    if (done) return true;
    this.recordAttempt(key);
    return false;
  }

  // --- code email (a minimal port of emails.py verify_code_email + _T) --
  // Bilingual (ru/en), matching the bilingual site: the code arrives in the request's language.
  private static readonly I18N: Record<'ru' | 'en', Record<string, string>> = {
    ru: {
      subj: 'Ideata: подтверждение email',
      code: 'Ваш код подтверждения email: {code}',
      ttl: 'Введите его на сайте — код действует {min} минут.',
      link: 'Или подтвердите по ссылке:\n{link}',
      h1: 'Подтверждение email',
      sub: 'Введите код в кабинете, чтобы подтвердить адрес.',
    },
    en: {
      subj: 'Ideata: confirm your email',
      code: 'Your email verification code: {code}',
      ttl: 'Enter it on the site — the code expires in {min} minutes.',
      link: 'Or confirm via this link:\n{link}',
      h1: 'Confirm your email',
      sub: 'Enter the code in your account to confirm the address.',
    },
  };

  /** Language normalization → ru|en (emails.py normalize_lang:188-198). */
  static normalizeLang(lang: string | null | undefined): 'ru' | 'en' {
    const code = String(lang || '')
      .trim()
      .toLowerCase()
      .replace(/_/g, '-');
    if (!code) return 'ru';
    const head = code.split('-')[0];
    return head === 'en' ? 'en' : 'ru';
  }

  private static esc(s: string): string {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** Assemble the code email (subject + text + html). link is optional. */
  buildCodeEmail(email: string, code: string, lang: string): MailMessage {
    const L = EmailVerifyService.I18N[EmailVerifyService.normalizeLang(lang)];
    const link = this.verifyLink(email, code);
    const text = [
      L.code.replace('{code}', code),
      '',
      L.ttl.replace('{min}', String(CODE_TTL_MIN)),
      '',
      L.link.replace('{link}', link),
    ].join('\n');
    const ec = EmailVerifyService.esc(code);
    const html =
      `<div style="font:16px/1.5 system-ui,-apple-system,sans-serif;color:#0f172a;max-width:32rem;margin:0 auto">` +
      `<h1 style="font-size:20px;font-weight:600">${EmailVerifyService.esc(L.h1)}</h1>` +
      `<p style="color:#475569">${EmailVerifyService.esc(L.sub)}</p>` +
      `<div style="font:700 32px/1 ui-monospace,monospace;letter-spacing:8px;` +
      `padding:24px 12px;text-align:center;background:#f1f5f9;border:1px solid #e2e8f0;` +
      `border-radius:10px;margin:16px 0">${ec}</div>` +
      `<p style="color:#64748b;font-size:14px">${EmailVerifyService.esc(
        L.ttl.replace('{min}', String(CODE_TTL_MIN)),
      )}</p></div>`;
    return { to: email, subject: L.subj, text, html };
  }
}
