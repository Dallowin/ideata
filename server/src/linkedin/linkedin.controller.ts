/**
 * LinkedIn connection routes: status / start OAuth / callback / disconnect.
 * Structure mirrors ThreadsController: state+brandId+next in a short-lived
 * httpOnly cookie (CSRF), return only to our own pages (open-redirect guard).
 */
import { Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { AuthService } from '../auth/auth.service';
import type { SessionUser } from '../auth/auth.service';
import { LoginGuard } from '../auth/login.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { BrandsService } from '../brands/brands.service';
import { LinkedinService } from './linkedin.service';

const OAUTH_COOKIE = 'li_oauth';
/**
 * OAuth cookie domain. Authorization starts on app.ideata.io, but the
 * callback lands on ideata.io — these are DIFFERENT hosts, and a host-only
 * cookie simply won't reach the second one: state would come back empty and
 * the exchange would fail with a "state" error. The session works precisely
 * because its cookie is set on .ideata.io — we use the same domain.
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

@Controller('linkedin')
export class LinkedinController {
  constructor(
    private readonly linkedin: LinkedinService,
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
    if (!brand) return { enabled: await this.linkedin.enabled(), connected: false, brand: null };
    const conn = await this.linkedin.getConnection(brand.id);
    return {
      enabled: await this.linkedin.enabled(),
      connected: !!conn,
      brand: { id: brand.id, domain: brand.domain, name: brand.name },
      name: conn?.name ?? null,
      // never expose the token — only the expiry, to show it in the UI
      expiresAt: conn?.expiresAt ?? null,
    };
  }

  // ── Start OAuth: redirect to LinkedIn ─────────────────────────────────────
  @Get('connect')
  @UseGuards(LoginGuard)
  async connect(
    @CurrentUser() user: SessionUser,
    @Res() res: Response,
    @Query('brandId') brandId?: string,
    @Query('next') next?: string,
  ) {
    const dest = safeNext(next);
    if (!(await this.linkedin.enabled())) return res.redirect(`${dest}?linkedin_error=disabled`);

    const brand = await this.resolveBrand(user.i, brandId);
    if (!brand) return res.redirect(`${dest}?linkedin_error=no_brand`);

    const state = randomBytes(16).toString('hex');
    res.cookie(OAUTH_COOKIE, `${state}|${brand.id}|${dest}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      domain: COOKIE_DOMAIN,
      maxAge: 10 * 60 * 1000,
    });
    return res.redirect(await this.linkedin.authUrl(state));
  }

  // ── Callback: code → tokens → profile → save ──────────────────────────────
  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const cookie = (req as any).cookies?.[OAUTH_COOKIE] as string | undefined;
    res.clearCookie(OAUTH_COOKIE, { domain: COOKIE_DOMAIN });
    const [savedState, savedBrandId, savedNext] = (cookie ?? '').split('|');
    const dest = safeNext(savedNext);
    const fail = (code: string) => res.redirect(`${dest}?linkedin_error=${code}`);

    const user = this.auth.userFromRequest(req);
    if (!user) return fail('auth');
    // Pass the denial reason through as-is: 'denied' looks the same whether
    // the user clicked "Cancel" or LinkedIn rejected the request over an
    // unapproved scope, and those are fixed in completely different places.
    if (req.query.error) {
      const code = String(req.query.error).replace(/[^a-z_]/gi, '').slice(0, 40);
      return fail(code || 'denied');
    }
    if (!cookie || !req.query.code || req.query.state !== savedState) return fail('state');

    const brand = await this.brands.getForUser(user.i, Number(savedBrandId));
    if (!brand) return fail('no_brand');

    try {
      const tokens = await this.linkedin.exchangeCode(req.query.code as string);
      const profile = await this.linkedin.me(tokens.accessToken);
      await this.linkedin.upsertConnection({
        brandId: brand.id,
        userId: user.i,
        memberUrn: profile.urn,
        name: profile.name || null,
        tokens,
      });
      return res.redirect(`${dest}?linkedin_connected=1`);
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
    await this.linkedin.disconnect(brand.id);
    return { ok: true };
  }
}
