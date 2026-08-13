/**
 * Telegram login: HMAC-check parity against the LIVE Python and the audit fixes.
 *
 * Goldens were captured from the reference oracle (the Python source, .venv/bin/python)
 * on 2026-08-10 — the same pure function verify_telegram_hash (web/auth.py:114-123):
 *   secret = sha256(BOT_TOKEN); hmac_sha256(secret, "k=v\n..."|sorted).
 * verify_telegram_hash is pure (touches no network/DB), so the value is frozen as
 * a constant instead of being pulled via SSH in CI.
 *
 * We check:
 *   • verifyTelegramHash — matches Python (valid/broken/foreign token), the check
 *     is constant-time (timingSafeEqual) — audit;
 *   • isFresh(auth_date) — freshness;
 *   • PUBLIC login does NOT grant admin: the session is signed a:false, even if
 *     users.is_admin=true (fail-open audit fix);
 *   • upsertUser sets isAdmin=false when TELEGRAM_ALLOWED_IDS is empty
 *     (Nest fail-CLOSED vs. Python's is_allowed fail-open).
 */
import { AuthService } from './auth.service';
import { TelegramLoginController } from './telegram-login.controller';

const TOKEN = '123456:TEST-BOT-TOKEN-abcXYZ';

// Vector #1 (captured from the oracle). auth_date is historical — verifyTelegramHash
// does NOT check freshness, so it doesn't need to be recent for signature parity.
const V1 = {
  id: '777000',
  first_name: 'Adil',
  last_name: 'U',
  username: 'adiloka',
  auth_date: '1700000000',
  photo_url: 'https://t.me/i/x.jpg',
};
const V1_HASH = '8016a64f5acfd13bd410f2d90a6798f5add42ea3d67a8ff85d1b0b86269a9af7';

// Vector #2 — a minimal set of fields.
const V2 = { id: '42', first_name: 'Bob', auth_date: '1699999999' };
const V2_HASH = 'aec1cbd81faf6237817d3fa9e2214ff9108499d839cdaae6c82fdf1e9acce230';

const ENV = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_IDS', 'COOKIE_DOMAIN', 'NODE_ENV'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = {};
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.COOKIE_DOMAIN; // so the constructor doesn't treat the env as prod
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** AuthService with a given environment (field initializers are read in the constructor). */
function mkAuth(env: Record<string, string>, prisma: unknown = {}): AuthService {
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  return new AuthService(prisma as never);
}

// ── verifyTelegramHash — parity with live Python ─────────────────────────────
describe('verifyTelegramHash — HMAC parity with the Python oracle', () => {
  it('valid hash (vector #1) → true', () => {
    const auth = mkAuth({ TELEGRAM_BOT_TOKEN: TOKEN });
    expect(auth.verifyTelegramHash({ ...V1, hash: V1_HASH })).toBe(true);
  });
  it('valid hash (vector #2) → true', () => {
    const auth = mkAuth({ TELEGRAM_BOT_TOKEN: TOKEN });
    expect(auth.verifyTelegramHash({ ...V2, hash: V2_HASH })).toBe(true);
  });
  it('broken hash → false', () => {
    const auth = mkAuth({ TELEGRAM_BOT_TOKEN: TOKEN });
    expect(auth.verifyTelegramHash({ ...V1, hash: V1_HASH.replace(/.$/, '0') })).toBe(false);
  });
  it('tampered field (id) with the same hash → false', () => {
    const auth = mkAuth({ TELEGRAM_BOT_TOKEN: TOKEN });
    expect(auth.verifyTelegramHash({ ...V1, id: '777001', hash: V1_HASH })).toBe(false);
  });
  it('different bot token → false (same payload)', () => {
    const auth = mkAuth({ TELEGRAM_BOT_TOKEN: 'other:token' });
    expect(auth.verifyTelegramHash({ ...V1, hash: V1_HASH })).toBe(false);
  });
  it('no token → false (even with a hash)', () => {
    const auth = mkAuth({ TELEGRAM_BOT_TOKEN: '' });
    expect(auth.verifyTelegramHash({ ...V1, hash: V1_HASH })).toBe(false);
  });
  it('no hash field → false', () => {
    const auth = mkAuth({ TELEGRAM_BOT_TOKEN: TOKEN });
    expect(auth.verifyTelegramHash({ ...V1 })).toBe(false);
  });
});

// ── isFresh ─────────────────────────────────────────────────────────────────
describe('isFresh(auth_date)', () => {
  it('fresh (now) → true', () => {
    const auth = mkAuth({ TELEGRAM_BOT_TOKEN: TOKEN });
    expect(auth.isFresh(String(Math.floor(Date.now() / 1000)))).toBe(true);
  });
  it('old (a day+1s ago) → false', () => {
    const auth = mkAuth({ TELEGRAM_BOT_TOKEN: TOKEN });
    expect(auth.isFresh(String(Math.floor(Date.now() / 1000) - 86401))).toBe(false);
  });
  it('garbage → false', () => {
    const auth = mkAuth({ TELEGRAM_BOT_TOKEN: TOKEN });
    expect(auth.isFresh('nan')).toBe(false);
  });
});

// ── audit fix: fail-CLOSED admin in upsertUser ──────────────────────────────
describe('upsertUser — is_admin by allow-list (Nest fail-CLOSED)', () => {
  it('empty TELEGRAM_ALLOWED_IDS → isAdmin=false (in create and update)', async () => {
    const upsert = jest.fn().mockResolvedValue({ id: 1 });
    const auth = mkAuth(
      { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_IDS: '' },
      { user: { upsert } },
    );
    await auth.upsertUser({ ...V1 });
    const arg = upsert.mock.calls[0][0];
    expect(arg.create.isAdmin).toBe(false);
    expect(arg.update.isAdmin).toBe(false);
  });
  it('id in the allow-list → isAdmin=true (dashboard path still works)', async () => {
    const upsert = jest.fn().mockResolvedValue({ id: 1 });
    const auth = mkAuth(
      { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_IDS: '777000' },
      { user: { upsert } },
    );
    await auth.upsertUser({ ...V1 });
    expect(upsert.mock.calls[0][0].create.isAdmin).toBe(true);
  });
});

// ── audit fix: public login does NOT grant admin ────────────────────────────
describe('TelegramLoginController.publicAuthTelegram — session a:false', () => {
  function mkResReq(query: Record<string, string>) {
    const res = {
      redirect: jest.fn(),
      cookie: jest.fn(),
      clearCookie: jest.fn(),
    } as any;
    const req = { query } as any;
    return { res, req };
  }

  it('valid login by an admin (is_admin=true in DB) → cookie signed a:false', async () => {
    // upsertUser returns an ADMIN — the public login must still strip admin.
    const auth = mkAuth({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_ALLOWED_IDS: '777000' }, {});
    jest.spyOn(auth, 'verifyTelegramHash').mockReturnValue(true);
    jest.spyOn(auth, 'isFresh').mockReturnValue(true);
    jest
      .spyOn(auth, 'upsertUser')
      .mockResolvedValue({ id: 99, tgId: 777000n, name: 'Adil', username: 'adiloka', isAdmin: true } as never);
    const signSpy = jest.spyOn(auth, 'sign');
    const cookieSpy = jest.spyOn(auth, 'setCookie').mockImplementation(() => {});
    const ctrl = new TelegramLoginController(auth);

    const { res, req } = mkResReq({ ...V1, hash: V1_HASH, next: '/app' });
    await ctrl.publicAuthTelegram(req, res);

    expect(signSpy).toHaveBeenCalledTimes(1);
    const payload = signSpy.mock.calls[0][0];
    expect(payload.a).toBe(false); // ← audit fix: NEVER admin from a public login
    expect(payload.i).toBe(99);
    expect(cookieSpy).toHaveBeenCalled();
    expect(res.redirect).toHaveBeenCalledWith('/app');
  });

  it('broken signature → redirect to /public-login with invalid_hash, no cookie', async () => {
    const auth = mkAuth({ TELEGRAM_BOT_TOKEN: TOKEN }, {});
    jest.spyOn(auth, 'verifyTelegramHash').mockReturnValue(false);
    const cookieSpy = jest.spyOn(auth, 'setCookie').mockImplementation(() => {});
    const signSpy = jest.spyOn(auth, 'sign');
    const ctrl = new TelegramLoginController(auth);

    const { res, req } = mkResReq({ ...V1, hash: 'bad' });
    await ctrl.publicAuthTelegram(req, res);

    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('/public-login?error=invalid_hash'));
    expect(cookieSpy).not.toHaveBeenCalled();
    expect(signSpy).not.toHaveBeenCalled();
  });

  it('stale auth_date → redirect auth_expired, no cookie', async () => {
    const auth = mkAuth({ TELEGRAM_BOT_TOKEN: TOKEN }, {});
    jest.spyOn(auth, 'verifyTelegramHash').mockReturnValue(true);
    jest.spyOn(auth, 'isFresh').mockReturnValue(false);
    const cookieSpy = jest.spyOn(auth, 'setCookie').mockImplementation(() => {});
    const ctrl = new TelegramLoginController(auth);

    const { res, req } = mkResReq({ ...V1, hash: V1_HASH });
    await ctrl.publicAuthTelegram(req, res);

    expect(res.redirect).toHaveBeenCalledWith(expect.stringContaining('error=auth_expired'));
    expect(cookieSpy).not.toHaveBeenCalled();
  });

  it('open-redirect in next gets clamped to the default', async () => {
    const auth = mkAuth({ TELEGRAM_BOT_TOKEN: TOKEN }, {});
    jest.spyOn(auth, 'verifyTelegramHash').mockReturnValue(true);
    jest.spyOn(auth, 'isFresh').mockReturnValue(true);
    jest
      .spyOn(auth, 'upsertUser')
      .mockResolvedValue({ id: 1, tgId: 1n, name: 'x', username: null, isAdmin: false } as never);
    jest.spyOn(auth, 'sign').mockReturnValue('tok');
    jest.spyOn(auth, 'setCookie').mockImplementation(() => {});
    const ctrl = new TelegramLoginController(auth);

    const { res, req } = mkResReq({ ...V1, hash: V1_HASH, next: '//evil.com' });
    await ctrl.publicAuthTelegram(req, res);
    // safeNext falls back to the default ideata.io, not the foreign domain
    expect(res.redirect).toHaveBeenCalledWith(expect.not.stringContaining('evil.com'));
  });
});
