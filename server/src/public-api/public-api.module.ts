import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { SiteAnalyticController } from './site-analytic.controller';
import { AccountPlanController } from './account-plan.controller';
import { AeoController } from './aeo.controller';
import { TeardownController } from './teardown.controller';
import { LandingController } from './landing.controller';
import { DiscoverController } from './discover.controller';
import { V1Controller } from './v1.controller';
import { ApiKeyGuard } from './api-key.guard';
import { SiteAnalysisService } from './site-analysis.service';
import { InternalClient } from './internal.client';
import { DiscoverModule } from '../discover/discover.module';
import { AeoModule } from '../aeo/aeo.module';
import { SiteAnalyticModule } from '../site-analytic/site-analytic.module';

/**
 * Public REST API for the dashboard and the token API v1 — a migration of
 * /api/public/* from the FastAPI scrapper. Reads go through Prisma against the
 * shared database; self-contained writes (keys, bot-hit) also live here. Launching
 * site_analytic and AEO tracker provisioning are NATIVE. Remaining Python
 * launches (analyze_domain — deep product analysis and discover) are proxied
 * to the scrapper's internal channel (InternalClient → /internal/*): api owns
 * auth/plan/ownership.
 */
@Module({
  imports: [AuthModule, DiscoverModule, AeoModule, SiteAnalyticModule],
  controllers: [
    SiteAnalyticController,
    AccountPlanController,
    AeoController,
    TeardownController,
    LandingController,
    DiscoverController,
    V1Controller,
  ],
  providers: [ApiKeyGuard, SiteAnalysisService, InternalClient],
})
export class PublicApiModule {}
