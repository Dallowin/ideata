import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectsArgs } from './projects.args';

const REVENUE_SOURCES = ['trustmrr', 'indiehackers'];

const SOURCE_LABELS: Record<string, string> = {
  hackernews: 'Hacker News',
  producthunt: 'Product Hunt',
  ycombinator: 'Y Combinator',
  betalist: 'BetaList',
  indiehackers: 'Indie Hackers',
  scrolllaunch: 'ScrollLaunch',
  trustmrr: 'TrustMRR ($/mo)',
};

// Accept both camelCase and snake_case sort keys (the front sends snake_case).
const SORT_ALIAS: Record<string, string> = {
  opportunityScore: 'opportunityScore',
  opportunity_score: 'opportunityScore',
  upvotes: 'upvotes',
  scrapedAt: 'scrapedAt',
  scraped_at: 'scrapedAt',
  globalScore: 'globalScore',
  global_score: 'globalScore',
  localScore: 'localScore',
  local_score: 'localScore',
  deepScore: 'deepScore',
  deep_score: 'deepScore',
};

// Prisma rejects the `{ sort, nulls }` object form on non-nullable columns;
// scrapedAt is NOT NULL, so it must use the plain SortOrder form.
const NON_NULLABLE_SORTS = new Set(['scrapedAt']);

const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : null);
// Structured JSON columns are exposed to GraphQL as stringified JSON.
const js = (v: unknown) => (v == null ? null : JSON.stringify(v));

function toProject(row: any) {
  return {
    ...row,
    media: arr(row.media),
    tags: arr(row.tags),
    localCompetitors: arr(row.localCompetitors),
    badReviews: arr(row.badReviews),
    deepScoreBreakdown: js(row.deepScoreBreakdown),
    marketCeiling: js(row.marketCeiling),
    unitEconomics: js(row.unitEconomics),
    revenueEstimate: js(row.revenueEstimate),
    stopFactors: js(row.stopFactors),
    demandGeo: js(row.demandGeo),
    socialSignals: js(row.socialSignals),
    searchVolumeRegions: js(row.searchVolumeRegions),
    competitorData: js(row.competitorData),
    isRevenue: REVENUE_SOURCES.includes(row.source) && !!row.upvotes,
  };
}

@Injectable()
export class ProjectsService {
  constructor(private prisma: PrismaService) {}

  private whereOf(a: ProjectsArgs): Prisma.ProductWhereInput {
    const w: Prisma.ProductWhereInput = {};
    const inList = (v?: string[]) =>
      v && v.length ? { in: v.filter(Boolean) } : undefined;
    if (a.source?.length) w.source = inList(a.source);
    if (a.category?.length) w.category = inList(a.category);
    if (a.playType?.length) w.playType = inList(a.playType);
    if (a.localCompetition?.length) w.localCompetition = inList(a.localCompetition);
    if (a.buildEffort?.length) w.buildEffort = inList(a.buildEffort);
    if (a.minOpp != null) w.opportunityScore = { gte: a.minOpp };
    if (a.minDeepScore != null) w.deepScore = { gte: a.minDeepScore };
    if (a.verdictLabel?.length) w.deepVerdictLabel = inList(a.verdictLabel);
    if (a.search) {
      const s = a.search;
      w.OR = [
        { name: { contains: s, mode: 'insensitive' } },
        { tagline: { contains: s, mode: 'insensitive' } },
        { summary: { contains: s, mode: 'insensitive' } },
        { gap: { contains: s, mode: 'insensitive' } },
        { websiteUrl: { contains: s, mode: 'insensitive' } },
      ];
    }
    return w;
  }

  async list(a: ProjectsArgs) {
    const page = Math.max(1, a.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, a.pageSize ?? 30));
    const sort = SORT_ALIAS[a.sort ?? ''] ?? 'opportunityScore';
    const order = a.order === 'asc' ? 'asc' : 'desc';
    const where = this.whereOf(a);

    const [total, items] = await this.prisma.$transaction([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: [
          NON_NULLABLE_SORTS.has(sort)
            ? { [sort]: order }
            : { [sort]: { sort: order, nulls: 'last' } },
          { id: 'desc' },
        ],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: items.map(toProject),
      total,
      page,
      pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async one(id: number) {
    const row = await this.prisma.product.findUnique({ where: { id } });
    return row ? toProject(row) : null;
  }

  async facets() {
    const [sources, categories] = await Promise.all([
      this.prisma.product.findMany({
        select: { source: true },
        distinct: ['source'],
      }),
      this.prisma.product.findMany({
        where: { category: { not: null } },
        select: { category: true },
        distinct: ['category'],
        orderBy: { category: 'asc' },
      }),
    ]);
    return {
      sources: sources.map((s) => ({
        name: s.source,
        label: SOURCE_LABELS[s.source] ?? s.source,
      })),
      categories: categories.map((c) => c.category!).filter(Boolean),
      playTypes: [
        { value: 'local', label: 'Локальный клон' },
        { value: 'global', label: 'Мировой билд' },
        { value: 'both', label: 'Оба пути' },
        { value: 'weak', label: 'Слабая' },
      ],
      localCompetition: [
        { value: 'none', label: 'Свободно' },
        { value: 'few', label: 'Мало' },
        { value: 'crowded', label: 'Тесно' },
      ],
      buildEffort: [
        { value: 'weekend', label: 'Выходные' },
        { value: 'weeks', label: 'Недели' },
        { value: 'serious', label: 'Серьёзно' },
      ],
      sorts: [
        { value: 'opportunityScore', label: 'По возможности' },
        { value: 'deepScore', label: 'По глубокому баллу' },
        { value: 'upvotes', label: 'По голосам/выручке' },
        { value: 'scrapedAt', label: 'По свежести' },
        { value: 'globalScore', label: 'Global-балл' },
        { value: 'localScore', label: 'Local-балл' },
      ],
      verdictLabels: [
        { value: 'GO', label: 'GO — делать' },
        { value: 'INVESTIGATE', label: 'INVESTIGATE — копать' },
        { value: 'PASS', label: 'PASS — мимо' },
      ],
    };
  }
}
