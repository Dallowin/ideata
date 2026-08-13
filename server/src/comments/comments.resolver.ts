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
import { CommentsService } from './comments.service';

@ObjectType()
export class Comment {
  @Field(() => Int) id: number;
  @Field(() => Int, { nullable: true }) parentId?: number | null;
  @Field(() => Int) userId: number;
  @Field() userName: string;
  @Field() body: string;
  @Field() createdAt: string;
  @Field() isDeleted: boolean;
}

@Resolver(() => Comment)
export class CommentsResolver {
  constructor(
    private readonly svc: CommentsService,
    private readonly auth: AuthService,
  ) {}

  private requireUser(ctx: any) {
    const user = this.auth.userFromRequest(ctx.req);
    if (!user) throw new UnauthorizedException('Authorization via Telegram required');
    return user;
  }

  @Query(() => [Comment], { name: 'comments' })
  comments(@Args('projectId', { type: () => Int }) projectId: number) {
    return this.svc.list(projectId);
  }

  @Mutation(() => Comment)
  addComment(
    @Args('projectId', { type: () => Int }) projectId: number,
    @Args('body') body: string,
    @Args('parentId', { type: () => Int, nullable: true }) parentId: number | null,
    @Context() ctx: any,
  ) {
    return this.svc.add(this.requireUser(ctx), projectId, body, parentId);
  }

  @Mutation(() => Boolean)
  deleteComment(@Args('id', { type: () => Int }) id: number, @Context() ctx: any) {
    return this.svc.remove(this.requireUser(ctx), id);
  }
}
