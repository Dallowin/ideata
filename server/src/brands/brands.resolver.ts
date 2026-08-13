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
import { BrandsService } from './brands.service';

@ObjectType()
export class Brand {
  @Field(() => Int) id: number;
  @Field() domain: string;
  @Field({ nullable: true }) name?: string;
  @Field({ nullable: true }) description?: string;
  @Field(() => [String]) competitors: string[];
  @Field() geo: string;
  @Field() language: string;
  @Field(() => [String]) topics: string[];
  @Field(() => [String]) aliases: string[];
  @Field() isActive: boolean;
  @Field() createdAt: string;
  // Team (phase 5a): the brand account's owner and the current user's role on it.
  @Field(() => Int) ownerUserId: number;
  @Field({ nullable: true }) ownerName?: string;
  @Field() myRole: string; // 'owner' | 'editor' | 'viewer'
}

@Resolver(() => Brand)
export class BrandsResolver {
  constructor(
    private readonly svc: BrandsService,
    private readonly auth: AuthService,
  ) {}

  private requireUser(ctx: any) {
    const user = this.auth.userFromRequest(ctx.req);
    if (!user) throw new UnauthorizedException('Authorization required');
    return user;
  }

  @Query(() => [Brand], { name: 'myBrands' })
  myBrands(@Context() ctx: any) {
    const u = this.requireUser(ctx);
    return this.svc.listForUser(u.i);
  }

  @Mutation(() => Brand, { name: 'createBrand' })
  createBrand(
    @Context() ctx: any,
    @Args('domain') domain: string,
    @Args('name', { nullable: true }) name?: string,
    @Args('competitors', { type: () => [String], nullable: true })
    competitors?: string[],
    @Args('description', { nullable: true }) description?: string,
    @Args('geo', { nullable: true }) geo?: string,
    @Args('language', { nullable: true }) language?: string,
    @Args('topics', { type: () => [String], nullable: true })
    topics?: string[],
    @Args('aliases', { type: () => [String], nullable: true })
    aliases?: string[],
  ) {
    const u = this.requireUser(ctx);
    return this.svc.create(
      u.i,
      {
        domain,
        name,
        competitors,
        description,
        geo,
        language,
        topics,
        aliases,
      },
      { isAdmin: u.a === true },
    );
  }

  // Brand patch — used by later steps of the onboarding wizard (region/language/
  // topics are saved onto an already-created brand). Every field is optional.
  @Mutation(() => Brand, { name: 'updateBrand' })
  updateBrand(
    @Context() ctx: any,
    @Args('id', { type: () => Int }) id: number,
    @Args('name', { nullable: true }) name?: string,
    @Args('description', { nullable: true }) description?: string,
    @Args('competitors', { type: () => [String], nullable: true })
    competitors?: string[],
    @Args('geo', { nullable: true }) geo?: string,
    @Args('language', { nullable: true }) language?: string,
    @Args('topics', { type: () => [String], nullable: true })
    topics?: string[],
    @Args('aliases', { type: () => [String], nullable: true })
    aliases?: string[],
  ) {
    const u = this.requireUser(ctx);
    return this.svc.update(
      u.i,
      id,
      {
        name,
        description,
        competitors,
        geo,
        language,
        topics,
        aliases,
      },
      { isAdmin: u.a === true },
    );
  }

  @Mutation(() => Boolean, { name: 'deleteBrand' })
  deleteBrand(@Context() ctx: any, @Args('id', { type: () => Int }) id: number) {
    const u = this.requireUser(ctx);
    return this.svc.remove(u.i, id, { isAdmin: u.a === true });
  }

  @Mutation(() => Boolean, { name: 'setActiveBrand' })
  setActiveBrand(
    @Context() ctx: any,
    @Args('id', { type: () => Int }) id: number,
  ) {
    const u = this.requireUser(ctx);
    return this.svc.setActive(u.i, id);
  }
}
