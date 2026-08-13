import { Global, Module } from '@nestjs/common';
import { PlanService } from './plans.service';

/**
 * Foundation of the plan system (stage 0): a single PlanService on top of the
 * shared `user_plans`/`plans` tables. @Global — so gates and limits (stage 2:
 * brand limit in BrandsService, blog access in PlanGuard, daily post limit in
 * the blog writer) can inject PlanService without importing the module into
 * every feature module (same as PrismaService). PrismaService is global
 * (PrismaModule).
 */
@Global()
@Module({
  providers: [PlanService],
  exports: [PlanService],
})
export class PlansModule {}
