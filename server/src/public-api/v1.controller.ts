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
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { ApiKeyGuard, CurrentApiKey } from './api-key.guard';
import { SiteAnalysisService } from './site-analysis.service';
import { SiteAnalyticService } from '../site-analytic/site-analytic.service';
import { siteAnalysisV1View } from './site-analysis-view';
import { HttpDetailFilter } from '../common/http-detail.filter';

type Facts = Record<string, unknown>;

/**
 * The read half of the token API v1 (a port of api_v1.py). POST /analyze launches
 * the NATIVE SiteAnalyticService.runAnalysis pipeline (the same single launch
 * channel as the dashboard's /site_analytic) — Python is no longer involved.
 * Paths and response shapes match openapi.json (web/public) 1:1, which external
 * consumers read: {id, status, cached[, coalesced]} — job_id is optional.
 */
@UseFilters(HttpDetailFilter)
@Controller('api/public/v1')
@UseGuards(ApiKeyGuard)
export class V1Controller {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analyses: SiteAnalysisService,
    private readonly siteAnalytic: SiteAnalyticService,
  ) {}

  private async getOr404(analysisId: number, req: Request) {
    const key = CurrentApiKey(req);
    return this.analyses.getVisibleOr404(analysisId, key.userId ?? undefined);
  }

  @Post('analyze')
  analyze(
    @Body()
    payload: {
      domain?: string;
      compare?: string;
      geo?: string;
      refresh?: boolean;
    },
    @Req() req: Request,
  ) {
    const key = CurrentApiKey(req);
    return this.siteAnalytic.runAnalysis({
      domain: String(payload?.domain || ''),
      compare: payload?.compare ?? null,
      geo: payload?.geo || '',
      refresh: !!payload?.refresh,
      userId: key.userId ?? null,
    });
  }

  @Get('jobs/:id')
  async job(@Param('id', ParseIntPipe) id: number) {
    const job = await this.prisma.scrapeJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('job not found');
    return { status: job.status, log: job.log || '' };
  }

  @Get('analyses')
  async list(@Req() req: Request) {
    const key = CurrentApiKey(req);
    const rows = await this.analyses.listForUser(key.userId ?? -1);
    return {
      items: rows.map((r) => ({
        id: r.id,
        domain: r.domain,
        geo: r.geo,
        status: r.status,
        created_at: r.created_at,
        finished_at: r.finished_at,
      })),
      total: rows.length,
    };
  }

  @Get('analyses/:id')
  async get(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const sa = await this.getOr404(id, req);
    return siteAnalysisV1View(sa);
  }

  @Get('analyses/:id/ai-visibility')
  async aiVisibility(
    @Param('id', ParseIntPipe) id: number,
    @Req() req: Request,
  ) {
    const sa = await this.getOr404(id, req);
    const f = (sa.facts ?? {}) as Facts;
    return {
      id: sa.id,
      domain: sa.domain,
      status: sa.status,
      ai_visibility: {
        share_of_voice: f.sovSelf,
        engines: f.aiPlatforms,
        brands: f.aiBrands,
        est_impressions: f.estImpressions,
        found_not_cited: f.foundNotCited,
        citations: f.citations,
        cite_sources: f.citeSources,
        prompt_intents: f.promptIntents,
        snapshot_status: f.aeoStatus,
      },
    };
  }

  @Get('analyses/:id/prompts')
  async prompts(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const sa = await this.getOr404(id, req);
    const f = (sa.facts ?? {}) as Facts;
    return { id: sa.id, domain: sa.domain, prompts: f.aiPromptsRows ?? [] };
  }

  @Get('analyses/:id/guide')
  async guide(@Param('id', ParseIntPipe) id: number, @Req() req: Request) {
    const sa = await this.getOr404(id, req);
    const f = (sa.facts ?? {}) as Facts;
    return {
      id: sa.id,
      domain: sa.domain,
      guide: f.aeoGuide,
      plan: f.plan,
      priorities: f.priorities,
    };
  }
}
