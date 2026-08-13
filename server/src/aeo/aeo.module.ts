import { Module } from '@nestjs/common';
import { AeoReadService } from './aeo-read.service';
import { AeoMutationsService } from './mutations';
import { InternalClient } from '../public-api/internal.client';
import { DataForSeoClient } from '../discover/dataforseo.client';
import { KeysSoClient } from '../discover/keysso.client';
import { DiscoverSettings } from '../discover/settings';

/**
 * Native read + mutations for the AEO tracker (a stage of the Python →
 * NestJS migration). Exports AeoReadService (GET :id, shadow/native) and
 * AeoMutationsService (POST :id/prompts, :id/refresh, :id/prompts/mutate,
 * PATCH :id) — injected by the public-api AeoController. PrismaService and
 * PlanService are global (PrismaModule/PlansModule, both @Global), so they
 * need no imports; InternalClient (stateless) is kept as its own provider
 * here — a second instance alongside public-api is harmless.
 */
@Module({
  // DataForSeoClient/KeysSoClient/DiscoverSettings are needed by
  // AeoMutationsService for native suggest (key sources). PrismaService is
  // global; DiscoverSettings is a thin cache wrapper over app_settings — a
  // second instance alongside DiscoverModule is harmless (same as
  // InternalClient).
  providers: [
    AeoReadService,
    AeoMutationsService,
    InternalClient,
    DataForSeoClient,
    KeysSoClient,
    DiscoverSettings,
  ],
  exports: [AeoReadService, AeoMutationsService],
})
export class AeoModule {}
