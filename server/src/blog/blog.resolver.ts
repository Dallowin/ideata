import { UnauthorizedException } from '@nestjs/common';
import {
  Args,
  Context,
  Field,
  InputType,
  Int,
  Mutation,
  ObjectType,
  Query,
  Resolver,
} from '@nestjs/graphql';
import { AuthService } from '../auth/auth.service';
import { BlogService } from './blog.service';

@ObjectType()
export class BlogPostType {
  @Field(() => Int) id: number;
  @Field() slug: string;
  @Field() title: string;
  @Field({ nullable: true }) excerpt?: string;
  @Field() body: string;
  @Field({ nullable: true }) coverUrl?: string;
  @Field(() => [String]) tags: string[];
  @Field() source: string;
  @Field() status: string;
  @Field({ nullable: true }) publishedAt?: string;
  @Field() createdAt: string;
}

@InputType()
export class BlogPostInput {
  @Field(() => Int, { nullable: true }) id?: number;
  @Field() slug: string;
  @Field() title: string;
  @Field({ nullable: true }) excerpt?: string;
  @Field() body: string;
  @Field({ nullable: true }) coverUrl?: string;
  @Field(() => [String], { nullable: true }) tags?: string[];
  @Field({ defaultValue: 'draft' }) status: string;
}

const toGql = (p: any): BlogPostType => ({
  ...p,
  tags: Array.isArray(p.tags) ? p.tags : [],
  publishedAt: p.publishedAt ? new Date(p.publishedAt).toISOString() : null,
  createdAt: new Date(p.createdAt).toISOString(),
});

@Resolver()
export class BlogResolver {
  constructor(
    private readonly svc: BlogService,
    private readonly auth: AuthService,
  ) {}

  private requireUser(ctx: any) {
    const user = this.auth.userFromRequest(ctx.req);
    if (!user) throw new UnauthorizedException('Authorization required');
    return user;
  }

  // public
  @Query(() => [BlogPostType])
  async blogPosts() {
    return (await this.svc.published()).map(toGql);
  }

  @Query(() => BlogPostType, { nullable: true })
  async blogPost(@Args('slug') slug: string, @Context() ctx: any) {
    const p = await this.svc.bySlug(slug);
    if (!p) return null;
    // Drafts are NOT public: only served to a logged-in user (the blog admin
    // panel edits them), everyone else gets it as if the post didn't exist.
    // Without this check any draft was readable by direct slug: this is how
    // CS2 drafts for insane.gg stayed accessible on ideata.io even though
    // they weren't in the /blog listing.
    if (p.status !== 'published' && !this.auth.userFromRequest(ctx.req)) return null;
    return toGql(p);
  }

  // admin (login-gated)
  @Query(() => [BlogPostType])
  async blogPostsAll(@Context() ctx: any) {
    this.requireUser(ctx);
    return (await this.svc.all()).map(toGql);
  }

  @Mutation(() => BlogPostType)
  async upsertBlogPost(@Args('input') input: BlogPostInput, @Context() ctx: any) {
    this.requireUser(ctx);
    return toGql(await this.svc.upsert(input));
  }

  @Mutation(() => Boolean)
  async deleteBlogPost(@Args('id', { type: () => Int }) id: number, @Context() ctx: any) {
    this.requireUser(ctx);
    return this.svc.remove(id);
  }
}
