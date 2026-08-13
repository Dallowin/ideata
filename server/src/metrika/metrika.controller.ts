import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { AuthService } from '../auth/auth.service';
import type { SessionUser } from '../auth/auth.service';
import { LoginGuard } from '../auth/login.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { BrandsService } from '../brands/brands.service';
import { MetrikaService, MetrikaCounter } from './metrika.service';

const OAUTH_COOKIE = 'ym_oauth';
const APP_TRAFFIC = '/app/traffic';

function normDomain(raw: string): string {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0];
}

// Only allow returning to our own pages (open-redirect guard).
function safeNext(next?: string): string {
  const n = (next ?? '').trim();
  if (n.startsWith('/app')) return n;
  return APP_TRAFFIC;
}

// Counter closest to the brand's domain; otherwise the first one.
function pickCounter(counters: MetrikaCounter[], domain: string): MetrikaCounter | null {
  if (!counters.length) return null;
  const d = normDomain(domain);
  return (
    counters.find((c) => normDomain(c.site) === d) ||
    counters.find((c) => d && normDomain(c.site).includes(d)) ||
    counters[0]
  );
}

@Controller('metrika')
export class MetrikaController {
  constructor(
    private readonly metrika: MetrikaService,
    private readonly brands: BrandsService,
    private readonly auth: AuthService,
  ) {}

  // Brand from ?brandId (with ownership check) or the user's active brand.
  private async resolveBrand(userId: number, brandId?: string) {
    if (brandId && /^\d+$/.test(brandId)) {
      return this.brands.getForUser(userId, Number(brandId));
    }
    return this.brands.activeForUser(userId);
  }

  // ── Connection status for the active/specified brand ──────────────────────
  @Get('status')
  @UseGuards(LoginGuard)
  async status(@CurrentUser() user: SessionUser, @Query('brandId') brandId?: string) {
    const enabled = await this.metrika.enabled();
    const brand = await this.resolveBrand(user.i, brandId);
    if (!brand) return { enabled, connected: false, brand: null };
    const conn = await this.metrika.getConnection(brand.id);
    return {
      enabled,
      connected: !!conn,
      brand: { id: brand.id, domain: brand.domain, name: brand.name },
      counterId: conn?.counterId ?? null,
      counterName: conn?.counterName ?? null,
      siteUrl: conn?.siteUrl ?? null,
    };
  }

  // ── Start OAuth: redirect to Yandex ───────────────────────────────────────
  @Get('connect')
  @UseGuards(LoginGuard)
  async connect(
    @CurrentUser() user: SessionUser,
    @Res() res: Response,
    @Query('brandId') brandId?: string,
    @Query('next') next?: string,
  ) {
    const dest = safeNext(next);
    if (!(await this.metrika.enabled())) {
      return res.redirect(`${dest}?metrika_error=disabled`);
    }
    const brand = await this.resolveBrand(user.i, brandId);
    if (!brand) return res.redirect(`${dest}?metrika_error=no_brand`);

    const state = randomBytes(16).toString('hex');
    // state + brandId + next in a short-lived httpOnly cookie (CSRF protection).
    res.cookie(OAUTH_COOKIE, `${state}|${brand.id}|${dest}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 10 * 60 * 1000,
    });
    return res.redirect(await this.metrika.authUrl(state));
  }

  // ── Callback from Yandex: code exchange, counter selection, save ─────────
  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const cookie = (req as any).cookies?.[OAUTH_COOKIE] as string | undefined;
    res.clearCookie(OAUTH_COOKIE);
    const [savedState, savedBrandId, savedNext] = (cookie ?? '').split('|');
    const dest = safeNext(savedNext);
    const fail = (code: string) => res.redirect(`${dest}?metrika_error=${code}`);

    const user = this.auth.userFromRequest(req);
    if (!user) return fail('auth');
    if (!cookie || !req.query.code || req.query.state !== savedState) return fail('state');

    const brand = await this.brands.getForUser(user.i, Number(savedBrandId));
    if (!brand) return fail('no_brand');

    try {
      const tokens = await this.metrika.exchangeCode(req.query.code as string);
      const counters = await this.metrika.listCounters(tokens.access_token);
      if (!counters.length) return fail('no_counters');
      const counter = pickCounter(counters, brand.domain)!;
      await this.metrika.upsertConnection({
        brandId: brand.id,
        userId: user.i,
        counter,
        tokens,
      });
      return res.redirect(`${dest}?connected=1`);
    } catch (e) {
      return fail('exchange');
    }
  }

  // ── List of counters for the connected brand (for the picker in Integrations) ──
  @Get('counters')
  @UseGuards(LoginGuard)
  async counters(@CurrentUser() user: SessionUser, @Query('brandId') brandId?: string) {
    const brand = await this.resolveBrand(user.i, brandId);
    if (!brand) return { ok: false, error: 'no_brand', counters: [] };
    const conn = await this.metrika.getConnection(brand.id);
    if (!conn) return { ok: false, error: 'not_connected', counters: [] };
    try {
      const counters = await this.metrika.listCounters(conn.accessToken);
      return { ok: true, current: conn.counterId, counters };
    } catch {
      return { ok: false, error: 'metrika', reconnect: true, counters: [] };
    }
  }

  // ── Change the counter of a connected brand ───────────────────────────────
  @Post('counter')
  @UseGuards(LoginGuard)
  async counter(@CurrentUser() user: SessionUser, @Body() body: any) {
    const brand = await this.resolveBrand(user.i, body?.brandId ? String(body.brandId) : undefined);
    if (!brand) return { ok: false, error: 'no_brand' };
    const conn = await this.metrika.getConnection(brand.id);
    if (!conn) return { ok: false, error: 'not_connected' };
    const counters = await this.metrika.listCounters(conn.accessToken).catch(() => []);
    const chosen = counters.find((c) => c.id === String(body?.counterId));
    if (!chosen) return { ok: false, error: 'counter_not_found' };
    await this.metrika.setCounter(brand.id, chosen);
    return { ok: true, counterId: chosen.id, counterName: chosen.name, siteUrl: chosen.site };
  }

  // ── Tab data (AI traffic, filtered by assistant referrers) ───────────────
  @Get('report')
  @UseGuards(LoginGuard)
  async report(
    @CurrentUser() user: SessionUser,
    @Query('brandId') brandId?: string,
    @Query('period') period = '30d',
    @Query('scope') scope?: string,
  ) {
    const brand = await this.resolveBrand(user.i, brandId);
    if (!brand) return { ok: false, connected: false, error: 'no_brand' };
    const conn = await this.metrika.getConnection(brand.id);
    if (!conn) return { ok: false, connected: false };
    try {
      const data = await this.metrika.getReport(conn, period, scope === 'all' ? 'all' : 'ai');
      return {
        ok: true,
        connected: true,
        counterId: conn.counterId,
        counterName: conn.counterName,
        siteUrl: conn.siteUrl,
        ...data,
      };
    } catch (e) {
      const msg = (e as Error).message || '';
      const reconnect = /401|403/.test(msg);
      return { ok: false, connected: true, error: 'metrika', reconnect, detail: msg.slice(0, 200) };
    }
  }

  // ── Disconnect the counter from the brand ─────────────────────────────────
  @Post('disconnect')
  @UseGuards(LoginGuard)
  async disconnect(@CurrentUser() user: SessionUser, @Body() body: any) {
    const brand = await this.resolveBrand(user.i, body?.brandId ? String(body.brandId) : undefined);
    if (!brand) return { ok: false, error: 'no_brand' };
    await this.metrika.disconnect(brand.id);
    return { ok: true };
  }
}
