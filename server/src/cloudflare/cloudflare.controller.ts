import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import type { SessionUser } from '../auth/auth.service';
import { LoginGuard } from '../auth/login.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import { BrandsService } from '../brands/brands.service';
import { CloudflareService, CfZone } from './cloudflare.service';

function normDomain(raw: string): string {
  return String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
}
function pickZone(zones: CfZone[], domain: string): CfZone | null {
  if (!zones.length) return null;
  const d = normDomain(domain);
  return zones.find((z) => z.name.toLowerCase() === d) || zones.find((z) => d && z.name.toLowerCase().includes(d)) || zones[0];
}

@Controller('cloudflare')
export class CloudflareController {
  constructor(
    private readonly cf: CloudflareService,
    private readonly brands: BrandsService,
  ) {}

  private async resolveBrand(userId: number, brandId?: string) {
    if (brandId && /^\d+$/.test(brandId)) return this.brands.getForUser(userId, Number(brandId));
    return this.brands.activeForUser(userId);
  }

  @Get('status')
  @UseGuards(LoginGuard)
  async status(@CurrentUser() user: SessionUser, @Query('brandId') brandId?: string) {
    const brand = await this.resolveBrand(user.i, brandId);
    if (!brand) return { enabled: this.cf.enabled, connected: false, brand: null };
    const conn = await this.cf.getConnection(brand.id);
    return {
      enabled: this.cf.enabled,
      connected: !!conn,
      brand: { id: brand.id, domain: brand.domain, name: brand.name },
      zoneId: conn?.zoneId ?? null,
      zoneName: conn?.zoneName ?? null,
    };
  }

  // ── Connect via token: verify → list zones → auto-pick by domain ─────────
  @Post('connect')
  @UseGuards(LoginGuard)
  async connect(@CurrentUser() user: SessionUser, @Body() body: any) {
    const brand = await this.resolveBrand(user.i, body?.brandId ? String(body.brandId) : undefined);
    if (!brand) return { ok: false, error: 'no_brand' };
    const token = String(body?.token || '').trim();
    if (!token) return { ok: false, error: 'token_required' };
    let ok = false;
    try {
      ok = await this.cf.verifyToken(token);
    } catch {
      return { ok: false, error: 'verify_failed' };
    }
    if (!ok) return { ok: false, error: 'token_invalid' };
    let zones: CfZone[] = [];
    try {
      zones = await this.cf.listZones(token);
    } catch {
      return { ok: false, error: 'zones_failed' };
    }
    if (!zones.length) return { ok: false, error: 'no_zones' };
    const zone = pickZone(zones, brand.domain)!;
    await this.cf.upsertConnection({
      brandId: brand.id,
      userId: user.i,
      token,
      zoneId: zone.id,
      zoneName: zone.name,
    });
    return { ok: true, zoneId: zone.id, zoneName: zone.name, zones };
  }

  @Get('zones')
  @UseGuards(LoginGuard)
  async zones(@CurrentUser() user: SessionUser, @Query('brandId') brandId?: string) {
    const brand = await this.resolveBrand(user.i, brandId);
    if (!brand) return { ok: false, error: 'no_brand', zones: [] };
    const conn = await this.cf.getConnection(brand.id);
    if (!conn) return { ok: false, error: 'not_connected', zones: [] };
    try {
      const zones = await this.cf.listZones(this.cf.tokenOf(conn));
      return { ok: true, current: conn.zoneId, zones };
    } catch {
      return { ok: false, error: 'cloudflare', reconnect: true, zones: [] };
    }
  }

  @Post('zone')
  @UseGuards(LoginGuard)
  async zone(@CurrentUser() user: SessionUser, @Body() body: any) {
    const brand = await this.resolveBrand(user.i, body?.brandId ? String(body.brandId) : undefined);
    if (!brand) return { ok: false, error: 'no_brand' };
    const conn = await this.cf.getConnection(brand.id);
    if (!conn) return { ok: false, error: 'not_connected' };
    const zoneId = String(body?.zoneId || '');
    if (!zoneId) return { ok: false, error: 'zone_required' };
    const zones = await this.cf.listZones(this.cf.tokenOf(conn)).catch(() => [] as CfZone[]);
    const chosen = zones.find((z) => z.id === zoneId);
    if (!chosen) return { ok: false, error: 'zone_not_found' };
    await this.cf.setZone(brand.id, chosen.id, chosen.name);
    return { ok: true, zoneId: chosen.id, zoneName: chosen.name };
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
    const conn = await this.cf.getConnection(brand.id);
    if (!conn) return { ok: false, connected: false };
    try {
      const data = await this.cf.getReport(conn, period);
      return { ok: true, connected: true, zoneName: conn.zoneName, ...data };
    } catch (e) {
      const msg = (e as Error).message || '';
      const reconnect = /401|403|9109|authentication/i.test(msg);
      return { ok: false, connected: true, error: 'cloudflare', reconnect, detail: msg.slice(0, 200) };
    }
  }

  @Post('disconnect')
  @UseGuards(LoginGuard)
  async disconnect(@CurrentUser() user: SessionUser, @Body() body: any) {
    const brand = await this.resolveBrand(user.i, body?.brandId ? String(body.brandId) : undefined);
    if (!brand) return { ok: false, error: 'no_brand' };
    await this.cf.disconnect(brand.id);
    return { ok: true };
  }
}
