import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
  UseFilters,
} from '@nestjs/common';
import type { Request } from 'express';
import { HttpDetailFilter } from '../common/http-detail.filter';
import { AuthService } from '../auth/auth.service';
import { cleanDomain } from '../public-api/clean-domain';
import { AuditService, SiteUnreachableError } from './audit.service';
import { AuditThrottleService } from './audit-throttle.service';

/**
 * Free domain tech audit — port of api_public_site_audit from FastAPI.
 *
 * Synchronous: without deep checks it finishes in a few seconds, so no queue
 * is needed. deep=true adds PageSpeed (30-60 s), page crawling and link
 * pinging — it has a stricter limit and can only be requested by a logged-in
 * user, otherwise this becomes a free crawler for other people's sites from
 * our IP.
 *
 * Response codes are replicated verbatim: the frontend (`www/app/pages/tools/site-audit.vue`
 * and the report page) distinguishes 400 "tell the user this text", 429
 * "rate limited", and 503 "try again".
 */
@UseFilters(HttpDetailFilter)
@Controller('api/public/tools')
export class AuditController {
  private readonly log = new Logger('SiteAudit');

  constructor(
    private readonly audit: AuditService,
    private readonly throttle: AuditThrottleService,
    private readonly auth: AuthService,
  ) {}

  // 200, not the POST default of 201: the Python endpoint answers 200, and
  // the frontend is entitled to rely on that — the contract can't change.
  @Post('site_audit')
  @HttpCode(HttpStatus.OK)
  async siteAudit(@Body() body: Record<string, unknown>, @Req() req: Request) {
    const domain = cleanDomain(String(body?.domain ?? ''));
    if (!domain || !domain.includes('.')) {
      throw new BadRequestException('Please specify a domain — e.g. ideata.io');
    }

    // Anonymous users get the fast version, not a 401.
    let deep = Boolean(body?.deep);
    if (deep && !this.auth.userFromRequest(req)) deep = false;

    const ip = this.throttle.clientIp(req);
    const cost = deep ? 3 : 1; // deep is more expensive — spend several window slots
    for (let i = 0; i < cost; i++) {
      if (!this.throttle.allow(`audit:${ip}`)) {
        throw new HttpException(
          `The limit of ${this.throttle.limit} checks per hour has been reached. `
          + 'Try again later or sign in to your account.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    let result;
    try {
      result = await this.audit.audit(domain, { deep });
    } catch (e) {
      // Site doesn't exist / blocked by an anti-bot — this is a response to
      // the user, not a failure: the text explains what happened and what to do.
      if (e instanceof SiteUnreachableError) throw new BadRequestException(e.message);
      this.log.warn(`${domain} failed: ${e}`);
      throw new ServiceUnavailableException('The check failed. Please try again.');
    }
    if (result === null) {
      throw new BadRequestException('Please specify a domain — e.g. ideata.io');
    }
    return result;
  }
}
