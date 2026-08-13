/**
 * Port of verify.py + storage.py(verify)/usage.py(gen_code). We check:
 *   • gen_code — crypto (audit fix #1): format/range like Python, but CSPRNG;
 *   • send-verify gates (disabled/mail_off/verified/no_email/cooldown/success);
 *   • code checking: TTL, wrong code, idempotency, and NEW — the attempt counter
 *     with lockout (audit fix #2);
 *   • confirm by address (link from email) + idempotency + lock.
 * Prisma and the mailer are mocked (no network/DB access — money/mail safety).
 */
import {
  EmailVerifyService,
  MAX_VERIFY_ATTEMPTS,
  CODE_TTL_MIN,
  type SendResult,
  type ConfirmResult,
} from './email-verify.service';
import type { MailMessage, MailResult } from '../aeo/mail';

// env keys affecting the gates/mailer — reset between tests.
const ENV_KEYS = ['EMAIL_VERIFY_ENABLED', 'MAIL_DRIVER', 'RESEND_API_KEY', 'PUBLIC_BASE_URL'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

type UserRow = Record<string, unknown> | null;
function mkPrisma(row: UserRow, opts: { findFirst?: UserRow[] } = {}) {
  const firsts = opts.findFirst ? [...opts.findFirst] : [];
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue(row),
      findFirst: jest.fn().mockImplementation(() => Promise.resolve(firsts.length ? firsts.shift() : null)),
      update: jest.fn().mockResolvedValue({}),
    },
  };
}
const svc = (prisma: unknown) => new EmailVerifyService(prisma as never);
// The param is required: without it jest.fn(okSend) shows calls as [], and
// send.mock.calls[0][0] ends up typed as undefined (breaks tsc).
const okSend = async (_msg: MailMessage): Promise<MailResult> => ({ sent: true });

// ── gen_code: audit fix #1 (crypto) ─────────────────────────────────────────
describe('genCode — crypto, format/range like Python f"{n:06d}"', () => {
  it('always exactly 6 digits (incl. leading zeros) and in range 0..999999', () => {
    for (let i = 0; i < 3000; i++) {
      const c = EmailVerifyService.genCode();
      expect(c).toMatch(/^\d{6}$/);
      const n = Number(c);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(999999);
    }
  });
  it('codes are not constant (there is entropy)', () => {
    const set = new Set(Array.from({ length: 200 }, () => EmailVerifyService.genCode()));
    expect(set.size).toBeGreaterThan(150);
  });
});

// ── normalizeLang (emails.py) ───────────────────────────────────────────────
describe('normalizeLang', () => {
  it.each([
    ['ru', 'ru'],
    ['RU', 'ru'],
    ['ru-RU', 'ru'],
    ['en', 'en'],
    ['EN', 'en'],
    ['en-US', 'en'],
    ['en_US', 'en'],
    ['', 'ru'],
    [null, 'ru'],
    ['fr', 'ru'], // unrecognized → defaults to ru
  ])('%s → %s', (input, out) => {
    expect(EmailVerifyService.normalizeLang(input as string)).toBe(out);
  });
});

// ── verifyEnabled / gateActive ──────────────────────────────────────────────
describe('verifyEnabled / gateActive', () => {
  it('EMAIL_VERIFY_ENABLED defaults to on; 0/false/no/off — off', () => {
    const s = svc(mkPrisma(null));
    expect(s.verifyEnabled()).toBe(true);
    for (const off of ['0', 'false', 'no', 'off', 'OFF']) {
      process.env.EMAIL_VERIFY_ENABLED = off;
      expect(s.verifyEnabled()).toBe(false);
    }
    process.env.EMAIL_VERIFY_ENABLED = '1';
    expect(s.verifyEnabled()).toBe(true);
  });
  it('gateActive = enabled AND mailConfigured', () => {
    const s = svc(mkPrisma(null));
    expect(s.gateActive()).toBe(false); // mail not configured
    process.env.RESEND_API_KEY = 'x';
    expect(s.gateActive()).toBe(true);
    process.env.EMAIL_VERIFY_ENABLED = '0';
    expect(s.gateActive()).toBe(false);
  });
});

// ── sendUserCode — gates (app.py:2214-2253) ─────────────────────────────────
describe('sendUserCode', () => {
  it('verification disabled → skipped disabled (soft)', async () => {
    process.env.EMAIL_VERIFY_ENABLED = '0';
    const r = await svc(mkPrisma(null)).sendUserCode(1, 'ru', { send: okSend });
    expect(r).toEqual({ ok: 'skipped', reason: 'disabled' } as SendResult);
  });
  it('mail not configured → skipped mail_off (soft)', async () => {
    const r = await svc(mkPrisma(null)).sendUserCode(1, 'ru', { send: okSend });
    expect(r).toEqual({ ok: 'skipped', reason: 'mail_off' } as SendResult);
  });
  it('user not found → no_user 404', async () => {
    process.env.RESEND_API_KEY = 'x';
    const r = await svc(mkPrisma(null)).sendUserCode(1, 'ru', { send: okSend });
    expect(r).toEqual({ error: 'no_user', status: 404 });
  });
  it('already verified (tgId) → verified, email NOT sent', async () => {
    process.env.RESEND_API_KEY = 'x';
    const send = jest.fn(okSend);
    const p = mkPrisma({ email: 'a@b.com', tgId: 5n, googleId: null, emailVerifiedAt: null, verifySentAt: null });
    const r = await svc(p).sendUserCode(1, 'ru', { send });
    expect(r).toEqual({ ok: 'verified' });
    expect(send).not.toHaveBeenCalled();
    expect(p.user.update).not.toHaveBeenCalled();
  });
  it('no email → no_email 400', async () => {
    process.env.RESEND_API_KEY = 'x';
    const p = mkPrisma({ email: '', tgId: null, googleId: null, emailVerifiedAt: null, verifySentAt: null });
    const r = await svc(p).sendUserCode(1, 'ru', { send: okSend });
    expect(r).toEqual({ error: 'no_email', status: 400 });
  });
  it('cooldown (verifySentAt just now) → cooldown 429', async () => {
    process.env.RESEND_API_KEY = 'x';
    const p = mkPrisma({
      email: 'a@b.com',
      tgId: null,
      googleId: null,
      emailVerifiedAt: null,
      verifySentAt: new Date(Date.now() - 5000),
    });
    const r = await svc(p).sendUserCode(1, 'ru', { send: okSend });
    expect(r).toMatchObject({ error: 'cooldown', status: 429 });
    if ('retryAfterS' in r) expect(r.retryAfterS).toBeGreaterThan(0);
  });
  it('success: writes a 6-digit code + timestamp, sends the email to the address', async () => {
    process.env.RESEND_API_KEY = 'x';
    process.env.PUBLIC_BASE_URL = 'https://ideata.io';
    const send = jest.fn(okSend);
    const p = mkPrisma({ email: 'a@b.com', tgId: null, googleId: null, emailVerifiedAt: null, verifySentAt: null });
    const r = await svc(p).sendUserCode(7, 'en', { send });
    expect(r).toEqual({ ok: 'sent' });
    const data = p.user.update.mock.calls[0][0].data;
    expect(data.verifyCode).toMatch(/^\d{6}$/);
    expect(data.verifySentAt).toBeInstanceOf(Date);
    const msg = send.mock.calls[0][0] as MailMessage;
    expect(msg.to).toBe('a@b.com');
    expect(msg.subject).toContain('email'); // en subject
    expect(msg.text).toContain(data.verifyCode); // code inside the email
    expect(msg.text).toContain('/api/public/auth/verify-email'); // confirmation link
  });
  it('send failure → send_failed 502', async () => {
    process.env.RESEND_API_KEY = 'x';
    const p = mkPrisma({ email: 'a@b.com', tgId: null, googleId: null, emailVerifiedAt: null, verifySentAt: null });
    const r = await svc(p).sendUserCode(1, 'ru', { send: async () => ({ sent: false, error: 'boom' }) });
    expect(r).toEqual({ error: 'send_failed', status: 502 });
  });
});

// ── confirmUser — TTL, wrong code, idempotency, LOCK (audit fix #2) ─────────
describe('confirmUser', () => {
  const fresh = () => new Date(Date.now() - 60_000); // 1 min ago — within TTL
  const stale = () => new Date(Date.now() - (CODE_TTL_MIN + 1) * 60_000);

  it('correct code within TTL → verified + sets emailVerifiedAt', async () => {
    const p = mkPrisma({ emailVerifiedAt: null, tgId: null, googleId: null, verifyCode: '123456', verifySentAt: fresh() });
    const r = await svc(p).confirmUser(1, '123456');
    expect(r).toEqual({ ok: 'verified' } as ConfirmResult);
    expect(p.user.update.mock.calls[0][0].data).toMatchObject({ verifyCode: null });
    expect(p.user.update.mock.calls[0][0].data.emailVerifiedAt).toBeInstanceOf(Date);
  });
  it('code expired (verifySentAt older than TTL) → bad_code 400', async () => {
    const p = mkPrisma({ emailVerifiedAt: null, tgId: null, googleId: null, verifyCode: '123456', verifySentAt: stale() });
    const r = await svc(p).confirmUser(1, '123456');
    expect(r).toEqual({ error: 'bad_code', status: 400 });
    expect(p.user.update).not.toHaveBeenCalled();
  });
  it('wrong code → bad_code 400', async () => {
    const p = mkPrisma({ emailVerifiedAt: null, tgId: null, googleId: null, verifyCode: '123456', verifySentAt: fresh() });
    const r = await svc(p).confirmUser(1, '000000');
    expect(r).toEqual({ error: 'bad_code', status: 400 });
  });
  it('already verified → verified idempotently (no update)', async () => {
    const p = mkPrisma({ emailVerifiedAt: new Date(), tgId: null, googleId: null, verifyCode: null, verifySentAt: fresh() });
    const r = await svc(p).confirmUser(1, 'whatever');
    expect(r).toEqual({ ok: 'verified' });
    expect(p.user.update).not.toHaveBeenCalled();
  });
  it('after MAX_VERIFY_ATTEMPTS failures — locked out (429 locked)', async () => {
    const p = mkPrisma({ emailVerifiedAt: null, tgId: null, googleId: null, verifyCode: '123456', verifySentAt: fresh() });
    const s = svc(p);
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i++) {
      const r = await s.confirmUser(42, '000000');
      expect(r).toMatchObject({ error: 'bad_code' });
    }
    const locked = await s.confirmUser(42, '000000');
    expect(locked).toMatchObject({ error: 'locked', status: 429 });
    if ('retryAfterS' in locked) expect(locked.retryAfterS).toBeGreaterThan(0);
    // even the CORRECT code is refused while locked (brute-force closed off)
    const stillLocked = await s.confirmUser(42, '123456');
    expect(stillLocked).toMatchObject({ error: 'locked' });
  });
  it('a successful check resets the attempt counter', async () => {
    const p = mkPrisma({ emailVerifiedAt: null, tgId: null, googleId: null, verifyCode: '123456', verifySentAt: fresh() });
    const s = svc(p);
    await s.confirmUser(9, '000000'); // 1st miss
    await s.confirmUser(9, '000000'); // 2nd miss
    const good = await s.confirmUser(9, '123456');
    expect(good).toEqual({ ok: 'verified' });
    // counter reset: MAX-1 more misses again don't lock
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS - 1; i++) {
      const r = await s.confirmUser(9, '000000');
      expect(r).toMatchObject({ error: 'bad_code' });
    }
  });
});

// ── confirmByAddress — link from email (storage.py:1347-1369) ───────────────
describe('confirmByAddress', () => {
  const fresh = () => new Date(Date.now() - 60_000);
  it('match (email+code, within TTL) → true + sets emailVerifiedAt', async () => {
    const p = mkPrisma(null, { findFirst: [{ id: 3 }] });
    const ok = await svc(p).confirmByAddress('A@B.com', '123456');
    expect(ok).toBe(true);
    expect(p.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 3 } }),
    );
  });
  it('no match, but the address is already verified → true (idempotent)', async () => {
    // 1st findFirst (lookup by code) → null; 2nd (verified check) → a row
    const p = mkPrisma(null, { findFirst: [null, { id: 4 }] });
    const ok = await svc(p).confirmByAddress('a@b.com', '999999');
    expect(ok).toBe(true);
    expect(p.user.update).not.toHaveBeenCalled();
  });
  it('no match and not verified → false', async () => {
    const p = mkPrisma(null, { findFirst: [null, null] });
    const ok = await svc(p).confirmByAddress('a@b.com', '999999');
    expect(ok).toBe(false);
  });
  it('empty email → false without a DB query', async () => {
    const p = mkPrisma(null);
    const ok = await svc(p).confirmByAddress('', '123456');
    expect(ok).toBe(false);
    expect(p.user.findFirst).not.toHaveBeenCalled();
  });
  it('link-based brute-force gets locked out after MAX_VERIFY_ATTEMPTS', async () => {
    const p = mkPrisma(null, { findFirst: new Array(20).fill(null) });
    const s = svc(p);
    for (let i = 0; i < MAX_VERIFY_ATTEMPTS; i++) {
      expect(await s.confirmByAddress('x@y.com', '000000')).toBe(false);
    }
    const callsBefore = p.user.findFirst.mock.calls.length;
    // locked out: the next attempt doesn't reach the DB
    expect(await s.confirmByAddress('x@y.com', '123456')).toBe(false);
    expect(p.user.findFirst.mock.calls.length).toBe(callsBefore);
  });
});
