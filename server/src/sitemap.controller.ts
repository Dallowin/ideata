import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from './prisma/prisma.service';

const BASE = process.env.PUBLIC_SITE_URL?.replace(/\/$/, '') ?? 'https://ideata.io';

@Controller()
export class SitemapController {
  constructor(private prisma: PrismaService) {}

  @Get('sitemap.xml')
  async sitemap(@Res() res: Response) {
    const rows = await this.prisma.product.findMany({
      select: { id: true },
      orderBy: [{ opportunityScore: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
      take: 50000,
    });
    const parts = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      `<url><loc>${BASE}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
      ...rows.map(
        (r) => `<url><loc>${BASE}/projects/${r.id}</loc><changefreq>weekly</changefreq></url>`,
      ),
      '</urlset>',
    ];
    res.type('application/xml').send(parts.join(''));
  }
}
