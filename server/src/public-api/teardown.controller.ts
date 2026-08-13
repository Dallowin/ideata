import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseIntPipe,
  UseFilters,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HttpDetailFilter } from '../common/http-detail.filter';

// Contract for the public teardown page — a copy of the scrapper's
// _PUBLIC_FIELDS + _TEARDOWN_RAW_KEYS (web/app.py). The page is public (an SEO
// showcase, it's in the sitemap), so it uses a whitelist rather than a session:
// private columns (status/note/favorite) and intermediate LLM output in raw never
// go out. A static SELECT instead of a Prisma select — the frontend expects
// snake_case keys 1:1, and manually mapping ~60 fields camelCase→snake_case would
// be a typo trap.
const PUBLIC_FIELDS = [
  'id', 'name', 'source', 'category', 'tagline', 'description',
  'description_ru', 'summary', 'full_description', 'type', 'upvotes',
  'num_comments', 'rating', 'website_url', 'source_url', 'icon_url',
  'image_url', 'media', 'tags', 'makers', 'posted_at', 'scraped_at',
  'play_type', 'local_score', 'global_score', 'opportunity_score',
  'adaptation_score', 'adaptation_rationale', 'market_analysis',
  'local_competition', 'competitor_strength', 'local_competitors', 'gap',
  'why_fail', 'why_now', 'localization_difficulty', 'monetization',
  'build_effort', 'target_market_analog', 'target_market', 'analysis_mode',
  'build_prompt', 'build_prompt_kind', 'build_prompt_at', 'research_note',
  'research_at',
  'search_volume', 'search_volume_regions', 'trend_direction', 'trend_slope',
  'serp_occupancy', 'serp_results_yandex', 'demand_note', 'demand_geo',
  'social_signals',
  'competitor_data', 'competitor_traffic_max', 'bad_reviews',
  'traction_strength', 'competitors_note',
  'dim_market', 'dim_risks', 'dim_why_now', 'dim_cis_feasibility',
  'dim_effort',
  'deep_score', 'deep_score_breakdown', 'deep_verdict', 'deep_analyzed_at',
  'deep_analysis_mode', 'deep_verdict_label', 'stop_factors',
  'market_ceiling', 'ceiling_pass', 'unit_economics',
  'revenue_estimate', 'finance_confidence', 'finance_note',
  'raw',
] as const;

const TEARDOWN_RAW_KEYS = [
  'traffic', 'seo', 'domain_profile', 'tech', 'whois', 'authority',
  'founder', 'i18n', 'outbound', 'action_plan', 'key_insights',
] as const;

const SELECT_SQL = `SELECT ${PUBLIC_FIELDS.map((f) => `"${f}"`).join(', ')}
  FROM products WHERE id = $1`;

@UseFilters(HttpDetailFilter)
@Controller('api/public/teardown')
export class TeardownController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':id')
  async get(@Param('id', ParseIntPipe) id: number) {
    const rows = await this.prisma.$queryRawUnsafe<
      Array<Record<string, unknown>>
    >(SELECT_SQL, id);
    const proj = rows[0];
    if (!proj) throw new NotFoundException('project not found');
    const rawAll = (proj.raw ?? {}) as Record<string, unknown>;
    const raw: Record<string, unknown> = {};
    for (const k of TEARDOWN_RAW_KEYS) if (k in rawAll) raw[k] = rawAll[k];
    // TrustMRR / Indie Hackers store monthly revenue (USD) in `upvotes`.
    const isRevenue =
      proj.source === 'trustmrr' || proj.source === 'indiehackers';
    return { ...proj, raw, is_revenue: isRevenue };
  }
}
