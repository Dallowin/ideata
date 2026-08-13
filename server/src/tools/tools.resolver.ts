import { UnauthorizedException } from '@nestjs/common';
import {
  Args,
  Context,
  Field,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { ToolsService } from './tools.service';

@ObjectType()
export class BuildPromptResult {
  @Field() text: string;
  @Field() kind: string;
  @Field() cached: boolean;
}

@ObjectType()
export class ResearchResult {
  @Field() note: string;
  @Field() cached: boolean;
}

@ObjectType()
export class UrlAnalysisResult {
  @Field() json: string;
}

@ObjectType()
export class AiDraftResult {
  @Field() markdown: string;
  @Field() slug: string;
  @Field() filename: string;
}

@ObjectType()
export class BlogSettingsType {
  @Field() aiPrompt: string;
  @Field() aiApiKey: string;
  @Field() aiModel: string;
}

@ObjectType()
export class AiModelType {
  @Field() id: string;
  @Field() label: string;
}

@ObjectType()
export class AiModelsResult {
  @Field(() => [AiModelType]) models: AiModelType[];
  @Field() default: string;
}

@Resolver()
export class ToolsResolver {
  constructor(
    private readonly svc: ToolsService,
    private readonly auth: AuthService,
  ) {}

  private requireUser(ctx: any) {
    const user = this.auth.userFromRequest(ctx.req);
    if (!user) throw new UnauthorizedException('Telegram authorization required');
    return user;
  }

  // The costly on-demand LLM features stay behind a Telegram login,
  // mirroring the old FastAPI gating.
  @Mutation(() => BuildPromptResult)
  buildPrompt(
    @Args('projectId', { type: () => Int }) projectId: number,
    @Args('kind', { defaultValue: 'mvp' }) kind: string,
    @Context() ctx: any,
  ) {
    this.requireUser(ctx);
    return this.svc.buildPrompt(projectId, kind);
  }

  @Mutation(() => ResearchResult)
  research(
    @Args('projectId', { type: () => Int }) projectId: number,
    @Context() ctx: any,
  ) {
    this.requireUser(ctx);
    return this.svc.research(projectId);
  }

  @Mutation(() => UrlAnalysisResult)
  async analyzeUrl(@Args('url') url: string) {
    const json = await this.svc.analyzeUrl(url);
    return { json };
  }

  // AI draft of a blog post (markdown for content/blog/<slug>.md). Login-gated.
  // projectId — if given, the AI reads analysis data from the backend as source material.
  @Mutation(() => AiDraftResult)
  aiDraftPost(
    @Args('topic', { nullable: true }) topic: string,
    @Args('slug', { nullable: true }) slug: string,
    @Args('projectId', { type: () => Int, nullable: true }) projectId: number,
    @Args('model', { nullable: true }) model: string,
    @Context() ctx: any,
  ) {
    this.requireUser(ctx);
    return this.svc.aiDraftPost(topic, slug, projectId, model);
  }

  // selectable AI models for blog drafts — login-gated
  @Query(() => AiModelsResult)
  aiModels(@Context() ctx: any) {
    this.requireUser(ctx);
    return this.svc.aiModels();
  }

  // blog AI settings (key + prompt template + default model) — login-gated
  @Query(() => BlogSettingsType)
  blogSettings(@Context() ctx: any) {
    this.requireUser(ctx);
    return this.svc.getBlogSettings();
  }

  @Mutation(() => BlogSettingsType)
  setBlogSettings(
    @Args('aiPrompt') aiPrompt: string,
    @Args('aiApiKey', { nullable: true }) aiApiKey: string,
    @Args('aiModel', { nullable: true }) aiModel: string,
    @Context() ctx: any,
  ) {
    this.requireUser(ctx);
    return this.svc.setBlogSettings(aiPrompt, aiApiKey, aiModel);
  }
}
