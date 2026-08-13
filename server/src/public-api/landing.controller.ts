import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  Post,
  Req,
  UseFilters,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { InternalClient } from './internal.client';
import { HttpDetailFilter } from '../common/http-detail.filter';

// The public (anonymous) jobs log must not leak raw exceptions: not just
// "ERROR:", but also deep jobs' "FAILED: {exc}", the traceback header, its frames
// (`File "...", line N`), and lines like `ValueError: ...`. Frontend steppers
// only read stage markers from the log; the error fact comes from status.
export function stripSensitiveLog(raw: string): string {
  return (raw || '')
    .split('\n')
    .filter((line) => {
      const s = line.trim();
      return !(
        line.includes('ERROR') ||
        line.includes('FAILED') ||
        line.includes('Traceback') ||
        /^File ".*", line \d+/.test(s) ||
        /^[A-Za-z_.]*(Error|Exception)\b.*:/.test(s)
      );
    })
    .join('\n');
}

/**
 * Anonymous landing routes — a port of api_public_analyze_domain and
 * api_public_job from FastAPI. Both are anonymous by design (the "analyze a
 * domain" flow from the homepage): analyze_domain attributes the job to a
 * logged-in user on a best-effort basis (for per-user quota), jobs/{id} returns
 * the log without ERROR lines — raw exception text isn't meant for anonymous id scanning.
 */
@UseFilters(HttpDetailFilter)
@Controller('api/public')
export class LandingController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly internal: InternalClient,
  ) {}

  @Post('analyze_domain')
  analyzeDomain(
    @Body() payload: { domain?: string } | undefined,
    @Req() req: Request,
  ) {
    const user = this.auth.userFromRequest(req);
    return this.internal.startAnalyzeDomain({
      domain: String(payload?.domain || ''),
      user_id: user?.i || null,
    });
  }

  @Get('jobs/:id')
  async job(@Param('id', ParseIntPipe) id: number) {
    const job = await this.prisma.scrapeJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('job not found');
    const log = stripSensitiveLog(job.log || '');
    return {
      status: job.status,
      log,
      found_count: job.foundCount,
      analyzed_count: job.analyzedCount,
    };
  }
}
