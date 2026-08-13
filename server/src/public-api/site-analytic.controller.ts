import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { LoginGuard, PaidPlanGuard } from '../auth/login.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { SiteAnalysisService } from './site-analysis.service';
import { SiteAnalyticService } from '../site-analytic/site-analytic.service';
import { HttpDetailFilter } from '../common/http-detail.filter';
import { siteAnalysisView } from './site-analysis-view';

/**
 * AI analyst, ported from FastAPI (api_public_site_analytic_*): reads go
 * through Prisma, launching (POST) goes through the NATIVE SiteAnalyticService
 * pipeline (collect→normalize→LLM layer→AEO snapshot→guide) with
 * caching/coalescing/quota/plan limit inside runAnalysis. The Python channel for
 * site_analytic is no longer called (this is now the single copy of the launch logic).
 */
@UseFilters(HttpDetailFilter)
@Controller('api/public/site_analytic')
export class SiteAnalyticController {
  constructor(
    private readonly analyses: SiteAnalysisService,
    private readonly siteAnalytic: SiteAnalyticService,
  ) {}

  @Post()
  @UseGuards(PaidPlanGuard)
  start(
    @Body()
    payload: {
      domain?: string;
      compare?: string;
      geo?: string;
      refresh?: boolean;
    },
    @CurrentUser() user: SessionUser,
  ) {
    return this.siteAnalytic.runAnalysis({
      domain: String(payload?.domain || ''),
      compare: payload?.compare ?? null,
      geo: payload?.geo || '',
      refresh: !!payload?.refresh,
      userId: user.i || null,
      isAdmin: user.a === true,
    });
  }

  @Get()
  @UseGuards(LoginGuard)
  async list(@CurrentUser() user: SessionUser) {
    const items = await this.analyses.listForUser(user.i);
    return { items, total: items.length };
  }

  @Get(':id')
  @UseGuards(LoginGuard)
  async get(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: SessionUser,
  ) {
    const sa = await this.analyses.getVisibleOr404(id, user.i);
    return siteAnalysisView(sa);
  }
}
