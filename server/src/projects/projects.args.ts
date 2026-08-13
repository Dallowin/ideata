import { ArgsType, Field, Int } from '@nestjs/graphql';

@ArgsType()
export class ProjectsArgs {
  @Field({ nullable: true }) search?: string;
  @Field(() => [String], { nullable: true }) source?: string[];
  @Field(() => [String], { nullable: true }) category?: string[];
  @Field(() => [String], { nullable: true }) playType?: string[];
  @Field(() => [String], { nullable: true }) localCompetition?: string[];
  @Field(() => [String], { nullable: true }) buildEffort?: string[];
  @Field(() => Int, { nullable: true }) minOpp?: number;
  // deep analysis filters
  @Field(() => Int, { nullable: true }) minDeepScore?: number;
  @Field(() => [String], { nullable: true }) verdictLabel?: string[]; // GO/INVESTIGATE/PASS

  @Field({ nullable: true, defaultValue: 'opportunityScore' }) sort?: string;
  @Field({ nullable: true, defaultValue: 'desc' }) order?: string;
  @Field(() => Int, { nullable: true, defaultValue: 1 }) page?: number;
  @Field(() => Int, { nullable: true, defaultValue: 30 }) pageSize?: number;
}
