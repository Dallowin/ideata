import { Module } from '@nestjs/common';
import { GraphQLModule } from '@nestjs/graphql';
import { ApolloDriver, ApolloDriverConfig } from '@nestjs/apollo';
import { join } from 'path';
import { AuthModule } from './auth/auth.module';
import { BlogModule } from './blog/blog.module';
import { BlogwriterModule } from './blogwriter/blogwriter.module';
import { BrandsModule } from './brands/brands.module';
import { CommentsModule } from './comments/comments.module';
import { MetrikaModule } from './metrika/metrika.module';
import { ThreadsModule } from './threads/threads.module';
import { LinkedinModule } from './linkedin/linkedin.module';
import { XModule } from './x/x.module';
import { GscModule } from './gsc/gsc.module';
import { CloudflareModule } from './cloudflare/cloudflare.module';
import { PlansModule } from './plans/plans.module';
import { CreditsModule } from './credits/credits.module';
import { TeamModule } from './team/team.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProjectsModule } from './projects/projects.module';
import { SitemapController } from './sitemap.controller';
import { ToolsModule } from './tools/tools.module';
import { PublicApiModule } from './public-api/public-api.module';
import { AuditModule } from './audit/audit.module';
import { AssistantModule } from './assistant/assistant.module';

@Module({
  imports: [
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: join(process.cwd(), 'src/schema.gql'),
      sortSchema: true,
      playground: false,
      introspection: true,
      // Resolvers read the session cookie from the request (me/comments/tools).
      context: ({ req, res }: any) => ({ req, res }),
    }),
    PrismaModule,
    PlansModule,
    CreditsModule,
    TeamModule,
    ProjectsModule,
    AuthModule,
    CommentsModule,
    ToolsModule,
    BlogModule,
    BlogwriterModule,
    BrandsModule,
    MetrikaModule,
    ThreadsModule,
    LinkedinModule,
    XModule,
    GscModule,
    CloudflareModule,
    PublicApiModule,
    AuditModule,
    AssistantModule,
  ],
  controllers: [SitemapController],
})
export class AppModule {}
