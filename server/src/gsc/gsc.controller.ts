import { Body, Controller, Get, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { AuthService } from '../auth/auth.service';
import type { SessionUser } from '../auth/auth.service';
import { LoginGuard } from '../auth/login.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { BrandsService } from '../brands/brands.service';
import { GscService, GscSite } from './gsc.service';

const OAUTH_COOKIE = 'gsc_oauth';
const APP_DEST = '/app/integrations';

function normDomain(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^sc-domain:/, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

function safeNext(next?: string): string {
  const n = (next ?? '').trim();
  return n.startsWith('/app') ? n : APP_DEST;
}

// GSC resource closest to the brand's domain; otherwise the first one.
function pickSite(sites: GscSite[], domain: string): GscSite | null {
  if (!sites.length) return null;
  const d = normDomain(domain);
  return (
    sites.find((s) => normDomain(s.siteUrl) === d) ||
    sites.find((s) => d && normDomain(s.siteUrl).includes(d)) ||
    sites[0]
  );
}

@Controller('gsc')
export class GscController {
  constructor(
    private readonly gsc: GscService,
    private readonly brands: BrandsService,
    private readonly auth: AuthService,
  ) {}

  private async resolveBrand(userId: number, brandId?: string) {
    if (brandId && /^\d+$/.test(brandId)) return this.brands.getForUser(userId, Number(brandId));
    return this.brands.activeForUser(userId);
  }

  @Get('status')
  @UseGuards(LoginGuard)
  async status(@CurrentUser() user: SessionUser, @Query('brandId') brandId?: string) {
    const enabled = await this.gsc.enabled();
    const brand = await this.resolveBrand(user.i, brandId);
    if (!brand) return { enabled, connected: false, brand: null };
    const conn = await this.gsc.getConnection(brand.id);
    return {
      enabled,
      connected: !!conn,
      brand: { id: brand.id, domain: brand.domain, name: brand.name },
      siteUrl: conn?.siteUrl ?? null,
    };
  }

  @Get('connect')
  @UseGuards(LoginGuard)
  async connect(
    @CurrentUser() user: SessionUser,
    @Res() res: Response,
    @Query('brandId') brandId?: string,
    @Query('next') next?: string,
  ) {
    const dest = safeNext(next);
    if (!(await this.gsc.enabled())) return res.redirect(`${dest}?gsc_error=disabled`);
    const brand = await this.resolveBrand(user.i, brandId);
    if (!brand) return res.redirect(`${dest}?gsc_error=no_brand`);

    const state = randomBytes(16).toString('hex');
    res.cookie(OAUTH_COOKIE, `${state}|${brand.id}|${dest}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 10 * 60 * 1000,
    });
    return res.redirect(await this.gsc.authUrl(state));
  }

  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const cookie = (req as any).cookies?.[OAUTH_COOKIE] as string | undefined;
    res.clearCookie(OAUTH_COOKIE);
    const [savedState, savedBrandId, savedNext] = (cookie ?? '').split('|');
    const dest = safeNext(savedNext);
    const fail = (code: string) => res.redirect(`${dest}?gsc_error=${code}`);

    const user = this.auth.userFromRequest(req);
    if (!user) return fail('auth');
    if (!cookie || !req.query.code || req.query.state !== savedState) return fail('state');

    const brand = await this.brands.getForUser(user.i, Number(savedBrandId));
    if (!brand) return fail('no_brand');

    try {
      const tokens = await this.gsc.exchangeCode(req.query.code as string);
      const sites = await this.gsc.listSites(tokens.access_token);
      if (!sites.length) return fail('no_sites');
      const site = pickSite(sites, brand.domain)!;
      await this.gsc.upsertConnection({
        brandId: brand.id,
        userId: user.i,
        siteUrl: site.siteUrl,
        tokens,
      });
      return res.redirect(`${dest}?connected=gsc`);
    } catch (e) {
      return fail('exchange');
    }
  }

  @Get('sites')
  @UseGuards(LoginGuard)
  async sites(@CurrentUser() user: SessionUser, @Query('brandId') brandId?: string) {
    const brand = await this.resolveBrand(user.i, brandId);
    if (!brand) return { ok: false, error: 'no_brand', sites: [] };
    const conn = await this.gsc.getConnection(brand.id);
    if (!conn) return { ok: false, error: 'not_connected', sites: [] };
    try {
      const token = conn.accessToken;
      const sites = await this.gsc.listSites(token);
      return { ok: true, current: conn.siteUrl, sites };
    } catch {
      return { ok: false, error: 'gsc', reconnect: true, sites: [] };
    }
  }

  @Post('site')
  @UseGuards(LoginGuard)
  async site(@CurrentUser() user: SessionUser, @Body() body: any) {
    const brand = await this.resolveBrand(user.i, body?.brandId ? String(body.brandId) : undefined);
    if (!brand) return { ok: false, error: 'no_brand' };
    const conn = await this.gsc.getConnection(brand.id);
    if (!conn) return { ok: false, error: 'not_connected' };
    const siteUrl = String(body?.siteUrl || '');
    if (!siteUrl) return { ok: false, error: 'site_required' };
    await this.gsc.setSite(brand.id, siteUrl);
    return { ok: true, siteUrl };
  }

  @Get('report')
  @UseGuards(LoginGuard)
  async report(
    @CurrentUser() user: SessionUser,
    @Query('brandId') brandId?: string,
    @Query('period') period = '30d',
  ) {
    const brand = await this.resolveBrand(user.i, brandId);
    if (!brand) return { ok: false, connected: false, error: 'no_brand' };
    const conn = await this.gsc.getConnection(brand.id);
    if (!conn) return { ok: false, connected: false };
    try {
      const data = await this.gsc.getReport(conn, period);
      return { ok: true, connected: true, siteUrl: conn.siteUrl, ...data };
    } catch (e) {
      const msg = (e as Error).message || '';
      const reconnect = /401|403/.test(msg);
      return { ok: false, connected: true, error: 'gsc', reconnect, detail: msg.slice(0, 200) };
    }
  }

  @Post('disconnect')
  @UseGuards(LoginGuard)
  async disconnect(@CurrentUser() user: SessionUser, @Body() body: any) {
    const brand = await this.resolveBrand(user.i, body?.brandId ? String(body.brandId) : undefined);
    if (!brand) return { ok: false, error: 'no_brand' };
    await this.gsc.disconnect(brand.id);
    return { ok: true };
  }
}
