import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TeamResolver } from './team.resolver';
import { TeamService } from './team.service';

/**
 * Account team (stage 5a): GraphQL myTeam + invite/member mutations.
 * PlanService is global (PlansModule); PrismaService is global. AuthModule
 * provides AuthService for reading the session in the resolver.
 */
@Module({
  imports: [AuthModule],
  providers: [TeamService, TeamResolver],
  exports: [TeamService],
})
export class TeamModule {}
