/**
 * X connection routes: status / start OAuth / callback / disconnect.
 * Structure mirrors LinkedinController, but the cookie also carries the
 * PKCE verifier: X requires it when exchanging the code, and there's nowhere
 * else to keep it between the start and the callback.
 */
import { Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { AuthService } from '../auth/auth.service';
import type { SessionUser } from '../auth/auth.service';
import { LoginGuard } from '../auth/login.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { BrandsService } from '../brands/brands.service';
import { XService, makePkce } from './x.service';

const OAUTH_COOKIE = 'x_oauth';
/**
 * Cookie domain. Authorization starts on app.ideata.io, but the callback
 * lands on ideata.io — different hosts, so a host-only cookie won't reach
 * the second one and state would come back empty. LinkedIn and Threads
 * already tripped on this.
 */
const COOKIE_DOMAIN = (process.env.COOKIE_DOMAIN ?? '').trim() || undefined;

// Integrations page in the NEW dashboard (app repo). The legacy /app/blog/...
// path stayed in the old web/ dashboard and returns 404 in the new one —
// that's where redirects here came from.
const APP_INTEGRATION = '/blog/integration';

// Only allow returning to our own pages (open-redirect guard): '/blog' is
// the new dashboard, '/app' is the legacy path of the old one.
function safeNext(next?: string): string {
  const n = (next ?? '').trim();
  return n.startsWith('/blog') || n.startsWith('/app') ? n : APP_INTEGRATION;
}

@Controller('x')
export class XController {
  constructor(
    private readonly x: XService,
    private readonly brands: BrandsService,
    private readonly auth: AuthService,
  ) {}

  private async resolveBrand(userId: number, brandId?: string) {
    if (brandId && /^\d+$/.test(brandId)) {
      return this.brands.getForUser(userId, Number(brandId));
    }
    return this.brands.activeForUser(userId);
  }

  // ── Connection status ─────────────────────────────────────────────────────
  @Get('status')
  @UseGuards(LoginGuard)
  async status(@CurrentUser() user: SessionUser, @Query('brandId') brandId?: string) {
    const brand = await this.resolveBrand(user.i, brandId);
    if (!brand) return { enabled: await this.x.enabled(), connected: false, brand: null };
    const conn = await this.x.getConnection(brand.id);
    return {
      enabled: await this.x.enabled(),
      connected: !!conn,
      brand: { id: brand.id, domain: brand.domain, name: brand.name },
      username: conn?.username ?? null,
      // never expose the token — only the expiry, to show it in the UI
      expiresAt: conn?.expiresAt ?? null,
    };
  }

  // ── Start OAuth: redirect to X ────────────────────────────────────────────
  @Get('connect')
  @UseGuards(LoginGuard)
  async connect(
    @CurrentUser() user: SessionUser,
    @Res() res: Response,
    @Query('brandId') brandId?: string,
    @Query('next') next?: string,
  ) {
    const dest = safeNext(next);
    if (!(await this.x.enabled())) return res.redirect(`${dest}?x_error=disabled`);

    const brand = await this.resolveBrand(user.i, brandId);
    if (!brand) return res.redirect(`${dest}?x_error=no_brand`);

    const state = randomBytes(16).toString('hex');
    const { verifier, challenge } = makePkce();
    // put the verifier here too: it's needed when exchanging the code, and
    // there's nowhere else to keep it between the two requests. The cookie
    // is httpOnly and lives for 10 minutes.
    res.cookie(OAUTH_COOKIE, `${state}|${brand.id}|${dest}|${verifier}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      domain: COOKIE_DOMAIN,
      maxAge: 10 * 60 * 1000,
    });
    return res.redirect(await this.x.authUrl(state, challenge));
  }

  // ── Callback: code + verifier → tokens → profile → save ──────────────────
  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const cookie = (req as any).cookies?.[OAUTH_COOKIE] as string | undefined;
    res.clearCookie(OAUTH_COOKIE, { domain: COOKIE_DOMAIN });
    const [savedState, savedBrandId, savedNext, verifier] = (cookie ?? '').split('|');
    const dest = safeNext(savedNext);
    const fail = (code: string) => res.redirect(`${dest}?x_error=${code}`);

    const user = this.auth.userFromRequest(req);
    if (!user) return fail('auth');
    // pass the denial reason through as-is: "cancelled" and "no permission"
    // are fixed in different places but look the same
    if (req.query.error) {
      const code = String(req.query.error).replace(/[^a-z_]/gi, '').slice(0, 40);
      return fail(code || 'denied');
    }
    if (!cookie || !verifier || !req.query.code || req.query.state !== savedState) return fail('state');

    const brand = await this.brands.getForUser(user.i, Number(savedBrandId));
    if (!brand) return fail('no_brand');

    try {
      const tokens = await this.x.exchangeCode(req.query.code as string, verifier);
      const profile = await this.x.me(tokens.accessToken);
      await this.x.upsertConnection({
        brandId: brand.id,
        userId: user.i,
        xUserId: profile.id,
        username: profile.username || null,
        tokens,
      });
      return res.redirect(`${dest}?x_connected=1`);
    } catch {
      return fail('exchange');
    }
  }

  // ── Disconnect ─────────────────────────────────────────────────────────────
  @Post('disconnect')
  @UseGuards(LoginGuard)
  async disconnect(@CurrentUser() user: SessionUser, @Query('brandId') brandId?: string) {
    const brand = await this.resolveBrand(user.i, brandId);
    if (!brand) return { ok: false };
    await this.x.disconnect(brand.id);
    return { ok: true };
  }
}
