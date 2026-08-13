import {
  BadRequestException,
  Controller,
  Get,
  Logger,
  Query,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { LoginGuard } from '../auth/login.guard';
import { InternalClient } from './internal.client';
import { cleanDomain } from './clean-domain';
import { HttpDetailFilter } from '../common/http-detail.filter';
import { DiscoverService } from '../discover/discover.service';

/**
 * "Monitoring" tabs — a port of api_discover_* from FastAPI.
 *
 * competitors/keywords/domain now go straight to DataForSEO/Keys.so
 * (see src/discover) — previously the request took a detour through Python just
 * for a plain outbound HTTP call; that extra hop only added latency and a failure
 * point. If the new path fails for reasons OTHER than data (network, timeout,
 * exception), it falls back to the old Python channel, so the first few days after
 * the switch don't break the tab because of an unproven client. An empty response
 * (domain not in the index) doesn't count as a failure — it's a valid result.
 *
 * traffic is still entirely in Python for now: it mixes in Similarweb via a
 * RapidAPI wrapper with a separate proxy layer — a migration step of its own.
 */
@UseFilters(HttpDetailFilter)
@Controller('api/public/discover')
@UseGuards(LoginGuard)
export class DiscoverController {
  private readonly log = new Logger('DiscoverController');

  constructor(
    private readonly internal: InternalClient,
    private readonly discover: DiscoverService,
  ) {}

  private domainOr400(domain: string): string {
    const d = cleanDomain(domain);
    if (!d || !d.includes('.')) throw new BadRequestException('domain required');
    return d;
  }

  private async withFallback<T>(label: string, run: () => Promise<T>, fallback: () => any) {
    try {
      return await run();
    } catch (e) {
      this.log.warn(`${label}: new path failed, falling back to Python — ${e}`);
      return fallback();
    }
  }

  @Get('competitors')
  competitors(@Query('domain') domain = '') {
    const d = this.domainOr400(domain);
    return this.withFallback(
      'competitors',
      () => this.discover.competitors(d),
      () => this.internal.discover('competitors', `domain=${encodeURIComponent(d)}`),
    );
  }

  @Get('keywords')
  keywords(@Query('q') q = '') {
    const query = (q || '').trim();
    if (!query) throw new BadRequestException('q required');
    return this.withFallback(
      'keywords',
      () => this.discover.keywords(query),
      () => this.internal.discover('keywords', `q=${encodeURIComponent(query)}`),
    );
  }

  @Get('traffic')
  traffic(@Query('domain') domain = '') {
    const d = this.domainOr400(domain);
    return this.internal.discover('traffic', `domain=${encodeURIComponent(d)}`);
  }

  @Get('domain')
  domain(@Query('domain') domain = '') {
    const d = this.domainOr400(domain);
    return this.withFallback(
      'domain',
      () => this.discover.domainProfile(d),
      () => this.internal.discover('domain', `domain=${encodeURIComponent(d)}`),
    );
  }
}
