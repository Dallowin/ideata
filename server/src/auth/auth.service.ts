import { Injectable } from '@nestjs/common';
import { createHash, createHmac, timingSafeEqual, randomBytes, scryptSync } from 'crypto';
import type { Request, Response } from 'express';
import { PrismaService } from '../prisma/prisma.service';

// Session payload kept tiny — it travels in a cookie on every request.
export interface SessionUser {
  i: number; // users.id (DB primary key — what comments reference)
  t: number; // telegram id
  n: string; // display name
  a: boolean; // is admin
}

const COOKIE_NAME = '_cw';
const SESSION_MAX_AGE_S = 7 * 24 * 3600;

const b64url = (buf: Buffer) => buf.toString('base64url');

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService) {
    // Mirrors scrapper (web/auth.py): a default/empty secret in production means
    // _cw sessions can be forged (anyone can mint a=true for themselves and pass
    // every gate in the api + scrapper admin). Fail fast at startup instead of
    // running with a hole. Local development (no NODE_ENV=production and no
    // COOKIE_DOMAIN) still works on the default as before.
    const secret = process.env.SESSION_SECRET ?? 'insecure-change-me';
    const isProd =
      process.env.NODE_ENV === 'production' ||
      !!(process.env.COOKIE_DOMAIN ?? '').trim();
    if (isProd && ['', 'insecure-change-me', 'change-me'].includes(secret.trim())) {
      throw new Error(
        'SESSION_SECRET is not set or is the default: _cw session cookies can be forged. ' +
          'Set a real SESSION_SECRET in the environment.',
      );
    }
  }

  private botToken = process.env.TELEGRAM_BOT_TOKEN ?? '';
  private secret = process.env.SESSION_SECRET ?? 'insecure-change-me';
  private cookieDomain = (process.env.COOKIE_DOMAIN ?? '').trim();
  private adminIds = new Set(
    (process.env.TELEGRAM_ALLOWED_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => /^\d+$/.test(s))
      .map(Number),
  );
  // Admins by e-mail (ADMIN_EMAILS, comma-separated) — an optional override.
  // In self-host, the FIRST registered user becomes the owner (see registerEmail):
  // they configure the instance and get isAdmin=true; invited users are regular.
  private adminEmails = new Set(
    (process.env.ADMIN_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

  private isAdminEmail(email: string | null | undefined): boolean {
    return !!email && this.adminEmails.has(email.trim().toLowerCase());
  }

  get botUsername(): string {
    return process.env.TELEGRAM_BOT_USERNAME ?? '';
  }

  /** HMAC check from https://core.telegram.org/widgets/login#checking-authorization */
  verifyTelegramHash(params: Record<string, string>): boolean {
    if (!this.botToken || !params.hash) return false;
    const dataCheck = Object.keys(params)
      .filter((k) => k !== 'hash')
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('\n');
    const secret = createHash('sha256').update(this.botToken).digest();
    const computed = createHmac('sha256', secret).update(dataCheck).digest('hex');
    const a = Buffer.from(computed);
    const b = Buffer.from(params.hash);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  isFresh(authDate: string, maxAgeS = 86400): boolean {
    const ts = Number(authDate);
    return Number.isFinite(ts) && Date.now() / 1000 - ts < maxAgeS;
  }

  /** Create/refresh the users row for a verified Telegram login. */
  async upsertUser(p: Record<string, string>) {
    const tgId = BigInt(p.id);
    const name =
      [p.first_name, p.last_name].filter(Boolean).join(' ') || p.username || 'Аноним';
    const isAdmin = this.adminIds.has(Number(p.id));
    return this.prisma.user.upsert({
      where: { tgId },
      create: {
        tgId,
        username: p.username || null,
        name,
        photoUrl: p.photo_url || null,
        isAdmin,
      },
      update: {
        username: p.username || null,
        name,
        photoUrl: p.photo_url || null,
        isAdmin,
      },
    });
  }

  // --- session token: b64url(json).b64url(hmac), expiry inside payload ----
  sign(user: SessionUser): string {
    const payload = b64url(
      Buffer.from(JSON.stringify({ ...user, e: Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_S })),
    );
    const sig = b64url(createHmac('sha256', this.secret).update(payload).digest());
    return `${payload}.${sig}`;
  }

  verify(token: string | undefined): SessionUser | null {
    if (!token) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = b64url(createHmac('sha256', this.secret).update(payload).digest());
    const a = Buffer.from(expected);
    const b = Buffer.from(sig);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (!data?.e || data.e < Date.now() / 1000) return null;
      // i is required to be users.id: without a valid number, guards/filters
      // (`where: { userId: user.i }`) in Prisma would silently drop the filter.
      if (!Number.isInteger(data.i) || data.i <= 0) return null;
      return { i: data.i, t: data.t, n: data.n, a: !!data.a };
    } catch {
      return null;
    }
  }

  userFromRequest(req: Request | undefined): SessionUser | null {
    const cookies = (req as any)?.cookies as Record<string, string> | undefined;
    return this.verify(cookies?.[COOKIE_NAME]);
  }

  setCookie(res: Response, token: string): void {
    res.cookie(COOKIE_NAME, token, {
      maxAge: SESSION_MAX_AGE_S * 1000,
      httpOnly: true,
      sameSite: 'lax',
      domain: this.cookieDomain || undefined,
      secure: !!this.cookieDomain,
    });
  }

  clearCookie(res: Response): void {
    res.clearCookie(COOKIE_NAME, { domain: this.cookieDomain || undefined });
  }

  // --- session payload from any users row (Telegram, email or Google) ------
  sessionFor(user: { id: number; tgId?: bigint | null; name?: string | null; isAdmin?: boolean | null }): SessionUser {
    return {
      i: user.id,
      t: user.tgId != null ? Number(user.tgId) : 0,
      n: user.name || 'Аккаунт',
      a: !!user.isAdmin,
    };
  }

  // --- email + password (scrypt: "scrypt$<saltHex>$<hashHex>") -------------
  private hashPassword(password: string): string {
    const salt = randomBytes(16);
    const dk = scryptSync(password, salt, 64);
    return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`;
  }

  private verifyPassword(password: string, stored: string | null | undefined): boolean {
    const [scheme, saltHex, hashHex] = (stored ?? '').split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const dk = scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
    const a = Buffer.from(hashHex, 'hex');
    return a.length === dk.length && timingSafeEqual(a, dk);
  }

  async registerEmail(email: string, password: string) {
    const e = (email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('Invalid email');
    if ((password || '').length < 8) throw new Error('Password must be at least 8 characters');
    const existing = await this.prisma.user.findUnique({ where: { email: e } });
    if (existing) throw new Error('This email is already registered');
    // self-host: the FIRST registered user = instance owner (isAdmin=true),
    // so they can configure keys/integrations. Invited users after that are regular.
    const firstUser = (await this.prisma.user.count()) === 0;
    return this.prisma.user.create({
      data: {
        email: e,
        passwordHash: this.hashPassword(password),
        name: e.split('@')[0],
        isAdmin: firstUser || this.isAdminEmail(e),
      },
    });
  }

  async loginEmail(email: string, password: string) {
    const e = (email || '').trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email: e } });
    if (!user || !user.passwordHash) return null;
    if (!this.verifyPassword(password, user.passwordHash)) return null;
    // keep admin flag in sync with the allow-list (promote; never demote here).
    if (this.isAdminEmail(e) && !user.isAdmin) {
      return this.prisma.user.update({ where: { id: user.id }, data: { isAdmin: true } });
    }
    return user;
  }

  // --- Google OAuth (manual authorization-code flow) ----------------------
  private googleClientId = (process.env.GOOGLE_CLIENT_ID ?? '').trim();
  private googleClientSecret = (process.env.GOOGLE_CLIENT_SECRET ?? '').trim();
  private googleRedirectUri = (process.env.GOOGLE_REDIRECT_URI ?? '').trim();

  get googleEnabled(): boolean {
    return !!(this.googleClientId && this.googleClientSecret && this.googleRedirectUri);
  }

  googleAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.googleClientId,
      redirect_uri: this.googleRedirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  async exchangeGoogleCode(
    code: string,
  ): Promise<{ sub: string; email?: string; name?: string; picture?: string }> {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.googleClientId,
        client_secret: this.googleClientSecret,
        redirect_uri: this.googleRedirectUri,
        grant_type: 'authorization_code',
      }),
    });
    if (!tokenRes.ok) throw new Error('Google token exchange failed');
    const token: any = await tokenRes.json();
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!infoRes.ok) throw new Error('Google userinfo failed');
    const p: any = await infoRes.json();
    return { sub: p.sub, email: p.email, name: p.name, picture: p.picture };
  }

  async upsertGoogleUser(profile: { sub: string; email?: string; name?: string; picture?: string }) {
    const googleId = profile.sub;
    const email = (profile.email || '').trim().toLowerCase() || null;
    const name = profile.name || (email ? email.split('@')[0] : 'Google-аккаунт');
    // match an existing account by googleId, then by email (link), else create
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ googleId }, ...(email ? [{ email }] : [])] },
    });
    if (existing) {
      return this.prisma.user.update({
        where: { id: existing.id },
        data: {
          googleId,
          name,
          photoUrl: profile.picture || existing.photoUrl,
          email: existing.email || email,
          // promote to admin if allow-listed; never silently demote an existing
          // admin (e.g. one granted via Telegram).
          isAdmin: existing.isAdmin || this.isAdminEmail(existing.email || email),
        },
      });
    }
    return this.prisma.user.create({
      data: {
        googleId,
        email,
        name,
        photoUrl: profile.picture || null,
        isAdmin: this.isAdminEmail(email),
      },
    });
  }
}
