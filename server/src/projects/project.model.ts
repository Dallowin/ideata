import { ObjectType, Field, Int, Float } from '@nestjs/graphql';

@ObjectType()
export class Project {
  @Field(() => Int) id: number;
  @Field() name: string;
  @Field() source: string;
  @Field({ nullable: true }) category?: string;
  @Field({ nullable: true }) tagline?: string;
  @Field({ nullable: true }) summary?: string;
  @Field({ nullable: true }) descriptionRu?: string;
  @Field({ nullable: true }) fullDescription?: string;
  @Field({ nullable: true }) iconUrl?: string;
  @Field({ nullable: true }) imageUrl?: string;
  @Field(() => [String], { nullable: true }) media?: string[];
  @Field({ nullable: true }) websiteUrl?: string;
  @Field({ nullable: true }) sourceUrl?: string;
  @Field(() => [String], { nullable: true }) tags?: string[];
  @Field({ nullable: true }) postedAt?: string;
  @Field(() => Int, { nullable: true }) upvotes?: number;
  @Field(() => Int, { nullable: true }) numComments?: number;

  // analysis (v3)
  @Field(() => Int, { nullable: true }) opportunityScore?: number;
  @Field(() => Int, { nullable: true }) adaptationScore?: number;
  @Field(() => Int, { nullable: true }) localScore?: number;
  @Field(() => Int, { nullable: true }) globalScore?: number;
  @Field({ nullable: true }) playType?: string;
  @Field({ nullable: true }) localCompetition?: string;
  @Field({ nullable: true }) competitorStrength?: string;
  @Field(() => [String], { nullable: true }) localCompetitors?: string[];
  @Field({ nullable: true }) gap?: string;
  @Field({ nullable: true }) whyFail?: string;
  @Field({ nullable: true }) whyNow?: string;
  @Field({ nullable: true }) marketAnalysis?: string;
  @Field({ nullable: true }) monetization?: string;
  @Field({ nullable: true }) buildEffort?: string;
  @Field({ nullable: true }) localizationDifficulty?: string;
  @Field({ nullable: true }) targetMarketAnalog?: string;
  @Field() analyzed: boolean;

  // ── deep analysis (grounded) ──────────────────────────────────────────
  // Scalars are typed; structured JSON columns are exposed as stringified
  // JSON (the front JSON.parses them) to avoid a JSON-scalar dependency.
  @Field(() => Int, { nullable: true }) deepScore?: number;
  @Field({ nullable: true }) deepVerdictLabel?: string; // GO/INVESTIGATE/PASS
  @Field({ nullable: true }) deepVerdict?: string;
  @Field({ nullable: true }) deepAnalysisMode?: string;
  @Field({ nullable: true }) deepAnalyzedAt?: string;
  // demand
  @Field(() => Int, { nullable: true }) searchVolume?: number;
  @Field({ nullable: true }) trendDirection?: string;
  @Field({ nullable: true }) serpOccupancy?: string;
  @Field(() => Int, { nullable: true }) serpResultsYandex?: number;
  @Field({ nullable: true }) demandNote?: string;
  // competitors
  @Field(() => Int, { nullable: true }) competitorTrafficMax?: number;
  @Field({ nullable: true }) tractionStrength?: string;
  @Field({ nullable: true }) competitorsNote?: string;
  @Field(() => [String], { nullable: true }) badReviews?: string[];
  // finance
  @Field({ nullable: true }) ceilingPass?: boolean;
  @Field({ nullable: true }) financeConfidence?: string;
  @Field({ nullable: true }) financeNote?: string;
  // per-dimension text
  @Field({ nullable: true }) dimMarket?: string;
  @Field({ nullable: true }) dimRisks?: string;
  @Field({ nullable: true }) dimWhyNow?: string;
  @Field({ nullable: true }) dimCisFeasibility?: string;
  @Field({ nullable: true }) dimEffort?: string;
  // structured JSON, stringified
  @Field({ nullable: true }) deepScoreBreakdown?: string;
  @Field({ nullable: true }) marketCeiling?: string;
  @Field({ nullable: true }) unitEconomics?: string;
  @Field({ nullable: true }) revenueEstimate?: string;
  @Field({ nullable: true }) stopFactors?: string;
  @Field({ nullable: true }) demandGeo?: string;
  @Field({ nullable: true }) socialSignals?: string;
  @Field({ nullable: true }) searchVolumeRegions?: string;
  @Field({ nullable: true }) competitorData?: string;

  // computed: trustmrr/indiehackers carry real monthly revenue in `upvotes`
  @Field() isRevenue: boolean;
}

@ObjectType()
export class ProjectsPage {
  @Field(() => [Project]) items: Project[];
  @Field(() => Int) total: number;
  @Field(() => Int) page: number;
  @Field(() => Int) pageSize: number;
  @Field(() => Int) pages: number;
}

@ObjectType()
export class SourceFacet {
  @Field() name: string;
  @Field() label: string;
}

@ObjectType()
export class Facet {
  @Field() value: string;
  @Field() label: string;
}

@ObjectType()
export class Facets {
  @Field(() => [SourceFacet]) sources: SourceFacet[];
  @Field(() => [String]) categories: string[];
  @Field(() => [Facet]) playTypes: Facet[];
  @Field(() => [Facet]) localCompetition: Facet[];
  @Field(() => [Facet]) buildEffort: Facet[];
  @Field(() => [Facet]) sorts: Facet[];
  @Field(() => [Facet]) verdictLabels: Facet[];
}
