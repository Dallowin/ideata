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
import { TeamService } from './team.service';

@ObjectType()
export class TeamMember {
  @Field(() => Int) userId: number;
  @Field({ nullable: true }) name?: string;
  @Field({ nullable: true }) email?: string;
  @Field() role: string;
  @Field() createdAt: string;
}

@ObjectType()
export class TeamInvite {
  @Field(() => Int) id: number;
  @Field() token: string;
  @Field() role: string;
  @Field({ nullable: true }) email?: string;
  @Field() status: string;
  @Field() createdAt: string;
}

@ObjectType()
export class TeamAccount {
  @Field(() => Int) ownerUserId: number;
  @Field({ nullable: true }) ownerName?: string;
  @Field() role: string;
}

@ObjectType()
export class MyTeam {
  // null = unlimited seats (pro/scale); a number is the seat cap (owner + members).
  @Field(() => Int, { nullable: true }) seatsLimit?: number | null;
  @Field(() => [TeamMember]) members: TeamMember[];
  @Field(() => [TeamInvite]) invites: TeamInvite[];
  @Field(() => [TeamAccount]) myAccounts: TeamAccount[];
}

@Resolver()
export class TeamResolver {
  constructor(
    private readonly svc: TeamService,
    private readonly auth: AuthService,
  ) {}

  private requireUser(ctx: any) {
    const user = this.auth.userFromRequest(ctx.req);
    if (!user) throw new UnauthorizedException('Authorization required');
    return user;
  }

  @Query(() => MyTeam, { name: 'myTeam' })
  myTeam(@Context() ctx: any) {
    const u = this.requireUser(ctx);
    return this.svc.myTeam(u.i);
  }

  @Mutation(() => TeamInvite, { name: 'createInvite' })
  createInvite(
    @Context() ctx: any,
    @Args('role') role: string,
    @Args('email', { nullable: true }) email?: string,
  ) {
    const u = this.requireUser(ctx);
    return this.svc.createInvite(u.i, role, email ?? null, {
      isAdmin: u.a === true,
    });
  }

  @Mutation(() => Boolean, { name: 'revokeInvite' })
  revokeInvite(
    @Context() ctx: any,
    @Args('id', { type: () => Int }) id: number,
  ) {
    const u = this.requireUser(ctx);
    return this.svc.revokeInvite(u.i, id);
  }

  @Mutation(() => TeamAccount, { name: 'acceptInvite' })
  acceptInvite(@Context() ctx: any, @Args('token') token: string) {
    const u = this.requireUser(ctx);
    return this.svc.acceptInvite(u.i, token);
  }

  @Mutation(() => Boolean, { name: 'removeMember' })
  removeMember(
    @Context() ctx: any,
    @Args('userId', { type: () => Int }) userId: number,
  ) {
    const u = this.requireUser(ctx);
    return this.svc.removeMember(u.i, userId);
  }

  @Mutation(() => TeamMember, { name: 'setMemberRole' })
  setMemberRole(
    @Context() ctx: any,
    @Args('userId', { type: () => Int }) userId: number,
    @Args('role') role: string,
  ) {
    const u = this.requireUser(ctx);
    return this.svc.setMemberRole(u.i, userId, role);
  }
}
