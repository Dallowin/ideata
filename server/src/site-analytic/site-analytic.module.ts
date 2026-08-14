import { Module, type OnModuleInit } from '@nestjs/common';
import { DataForSeoClient } from '../discover/dataforseo.client';
import { KeysSoClient } from '../discover/keysso.client';
import { DiscoverSettings } from '../discover/settings';
import { PrismaService } from '../prisma/prisma.service';
import { SiteAnalyticService } from './site-analytic.service';
import { DefaultSiteCollectors } from './site-collectors';
import { LLM_LAYER } from './llm-layer';
import { LiveLlmLayer } from './live-llm-layer';
import { PrismaSnapshotStore } from './snapshot-store';

/**
 * Native AI analyst (Python → NestJS migration). Exports SiteAnalyticService
 * (analyzeDomain — the single-domain pipeline; runAnalysis — cache/coalescing/
 * write into site_analyses). PrismaService is global; DataForSeo/KeysSo/
 * DiscoverSettings stay as our own providers (same as AeoModule — a second
 * instance of these thin clients alongside DiscoverModule is harmless).
 *
 * The LLM layer (LLM_LAYER) is the live LiveLlmLayer: run_llm_layer (clusters/
 * priorities/plan with number-guard), _run_aeo_snapshot (a real AEO snapshot on
 * top of aeo/*) and content_guide. Gated on an available LLM key via
 * getSettingKey (ANTHROPIC_API_KEY or OPENROUTER_API_KEY): with neither,
 * run_llm_layer leaves facts alone and snapshot/guide → null (the deterministic
 * report is still complete). The unified brand panel and the monitoring seed
 * come from PrismaSnapshotStore.
 */
@Module({
  providers: [
    SiteAnalyticService,
    DefaultSiteCollectors,
    DataForSeoClient,
    KeysSoClient,
    DiscoverSettings,
    {
      provide: LLM_LAYER,
      inject: [DataForSeoClient, PrismaService],
      useFactory: (dfs: DataForSeoClient, prisma: PrismaService) =>
        new LiveLlmLayer({
          snapshot: {
            keywordSuggestions: (seed, limit) => dfs.keywordSuggestions(seed, limit),
            store: new PrismaSnapshotStore(prisma),
          },
        }),
    },
  ],
  exports: [SiteAnalyticService],
})
export class SiteAnalyticModule implements OnModuleInit {
  constructor(private readonly siteAnalytic: SiteAnalyticService) {}

  /**
   * On startup, clear runs left hanging by a restart (they are detached in the
   * process background, so a restart mid-run would leave a row in `running`
   * forever). The age threshold lives inside reapStale so we do not touch a live
   * Python run before the nginx flip.
   */
  async onModuleInit(): Promise<void> {
    await this.siteAnalytic.reapStale();
  }
}
