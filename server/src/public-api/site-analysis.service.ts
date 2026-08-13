import { Injectable, NotFoundException } from '@nestjs/common';
import type { SiteAnalysis } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Access to site_analyses rows using the scrapper's privacy model
 * (Storage._SA_VISIBLE): an analysis is private if its owner registered that
 * domain as their own brand — meaning it's an audit of their own site. Analyses
 * of others' or neutral domains are shared. A foreign private audit returns 404
 * (not 403), so as not to confirm the id exists.
 */
@Injectable()
export class SiteAnalysisService {
  constructor(private readonly prisma: PrismaService) {}

  async isPrivate(sa: SiteAnalysis): Promise<boolean> {
    if (!sa.userId) return false;
    const brand = await this.prisma.brand.findFirst({
      where: { domain: sa.domain, userId: sa.userId },
      select: { id: true },
    });
    return !!brand;
  }

  async getVisibleOr404(
    analysisId: number,
    viewerUserId: number | undefined,
  ): Promise<SiteAnalysis> {
    const sa = await this.prisma.siteAnalysis.findUnique({
      where: { id: analysisId },
    });
    if (!sa) throw new NotFoundException('analysis not found');
    if (sa.userId !== (viewerUserId ?? null) && (await this.isPrivate(sa))) {
      throw new NotFoundException('analysis not found');
    }
    return sa;
  }

  /**
   * Lightweight "My analyses" list — matches the Storage.list_site_analyses
   * contract: one analysis per (domain, geo) (the most recent by id), only visible
   * statuses (done/running/queued — error rows are hidden), sorted by recency
   * (finished_at→created_at), limited to 60. No facts/llm_outputs.
   */
  async listForUser(userId: number): Promise<
    Array<{
      id: number;
      domain: string;
      compare: string | null;
      geo: string;
      status: string;
      created_at: Date;
      finished_at: Date | null;
    }>
  > {
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: number;
        domain: string;
        compare_domain: string | null;
        geo: string;
        status: string;
        created_at: Date;
        finished_at: Date | null;
      }>
    >`
      SELECT * FROM (
        SELECT DISTINCT ON (domain, geo)
          id, domain, compare_domain, geo, status, created_at, finished_at
        FROM site_analyses
        WHERE user_id = ${userId}
          AND status IN ('done', 'running', 'queued')
        ORDER BY domain, geo, id DESC
      ) t
      ORDER BY COALESCE(finished_at, created_at) DESC
      LIMIT 60`;
    return rows.map((r) => ({
      id: r.id,
      domain: r.domain,
      compare: r.compare_domain,
      geo: r.geo,
      status: r.status,
      created_at: r.created_at,
      finished_at: r.finished_at,
    }));
  }
}
