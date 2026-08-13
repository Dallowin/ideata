import { Module, OnModuleInit } from '@nestjs/common';
import { ThreadsModule } from '../threads/threads.module';
import { LinkedinModule } from '../linkedin/linkedin.module';
import { XModule } from '../x/x.module';
import { AuthModule } from '../auth/auth.module';
import { PlanGuard } from '../auth/plan.guard';
import { LoginGuard } from '../auth/login.guard';
import { BrandsModule } from '../brands/brands.module';
import { PrismaService } from '../prisma/prisma.service';
import { PlanService } from '../plans/plans.service';
import { BlogBrandContext } from './brand-context';
import { LlmRateGuard } from './llm-rate.guard';
import { PostQuotaService } from './post-quota';
import { PublishScheduler } from './publish-scheduler';
import { setBlogPrisma } from './server/utils/prisma';
import { setOpusGate } from './server/utils/appSettings';
import { AeoController } from './controllers/aeo.controller';
import { ContentController } from './controllers/content.controller';
import { CoversController } from './controllers/covers.controller';
import { CrosspostController } from './controllers/crosspost.controller';
import { IdeataController } from './controllers/ideata.controller';
import { MediaController } from './controllers/media.controller';
import { PlanController } from './controllers/plan.controller';
import { PublicPostsController } from './controllers/public-posts.controller';
import { PublishController } from './controllers/publish.controller';
import { RunsController } from './controllers/runs.controller';
import { SettingsController } from './controllers/settings.controller';
import { PreviewBgController } from './controllers/preview-bg.controller';

/**
 * Blog-writer tool ported from the standalone Nitro app. The pipeline/util code
 * lives as plain modules under ./server/utils (reaching Prisma via the accessor
 * set here at init); these controllers expose it under the `blogwriter/` prefix,
 * gated by PlanGuard — admin OR a paid pro/scale plan (except for the public
 * covers/posts endpoints). Access to a specific run/brand is additionally
 * checked by ownership in BlogBrandContext.assertRunAccess.
 */
@Module({
  imports: [AuthModule, BrandsModule, ThreadsModule, LinkedinModule, XModule],
  controllers: [
    RunsController,
    CoversController,
    MediaController,
    AeoController,
    ContentController,
    PlanController,
    SettingsController,
    PublishController,
    CrosspostController,
    IdeataController,
    PublicPostsController,
    PreviewBgController,
  ],
  // PublishScheduler sets up its own minute interval in its own onModuleInit —
  // it's enough that it's registered here. Nest calls the provider hook
  // BEFORE the module's own hook, but the first tick still happens a minute later, so
  // setBlogPrisma below manages to run before the first DB access.
  providers: [PlanGuard, LoginGuard, LlmRateGuard, BlogBrandContext, PostQuotaService, PublishScheduler],
})
export class BlogwriterModule implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
  ) {}

  async onModuleInit() {
    // let the ported plain modules reach Prisma
    setBlogPrisma(this.prisma);
    // Opus gate: the ported resolveSettings (plain module) doesn't see DI, so
    // we feed it the decision "is this user allowed Opus" via the same pattern as
    // setBlogPrisma. The standalone copy doesn't set the hook — there's no plan gating there.
    // Allow Opus for admins (users.isAdmin) and plans with limits.opus (scale).
    setOpusGate(async (ownerUserId: number) => {
      try {
        const u = await this.prisma.user.findUnique({
          where: { id: ownerUserId },
          select: { isAdmin: true },
        });
        if (u?.isAdmin) return true;
      } catch {
        /* no user/DB — fall back to the plan check */
      }
      return (await this.plans.resolveLimits(ownerUserId)).opus;
    });
    // crash recovery: runs left 'running' by a restart can't resume (in-memory
    // registry is gone) → mark them errored so the UI offers "Restart".
    try {
      await this.prisma.blogRun.updateMany({
        where: { status: 'running' },
        data: { status: 'error', error: 'interrupted by a server restart — restart the phase', updated_at: new Date().toISOString() },
      });
    } catch {
      // blog_runs table may not exist yet (before the migration is applied)
    }
  }
}
