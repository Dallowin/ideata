import { Field, Int, ObjectType, Query, Resolver, Context } from '@nestjs/graphql';
import { AuthService } from './auth.service';

@ObjectType()
export class Me {
  @Field() authed: boolean;
  @Field({ nullable: true }) name?: string;
  @Field(() => Int, { nullable: true }) userId?: number;
  @Field({ nullable: true }) isAdmin?: boolean;
}

@Resolver()
export class AuthResolver {
  constructor(private auth: AuthService) {}

  @Query(() => Me, { name: 'me' })
  me(@Context() ctx: any): Me {
    const user = this.auth.userFromRequest(ctx.req);
    if (!user) return { authed: false };
    return { authed: true, name: user.n, userId: user.i, isAdmin: user.a };
  }
}
