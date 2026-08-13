/**
 * Public read-only blog API for the external frontend (port of server/api/public/posts/*).
 * NO guard — served publicly, so the result set is tightly scoped:
 *   • only runs actually published to the blog (blog_status='published');
 *   • only from the brand whose site IS our public blog (isNativeBlogBrand).
 * Otherwise this would be an endpoint that says "show me every article from every
 * platform customer, body included" — the filter used to be on run.status, but that also
 * gets set when publishing to SOMEONE ELSE'S blog/social accounts, and isn't scoped by brand at all.
 *
 *   GET blogwriter/public/posts            → list of published posts (?category filters by category)
 *   GET blogwriter/public/posts/:slug      → a single post by slug or id (?track=0 skips the view increment)
 *
 * The absolute base for links/covers is computed from the request (req.protocol + host)
 * and passed into the publicPosts helpers; PUBLIC_BASE_URL (if set) overrides it
 * inside publicBase().
 */
import { Controller, Get, NotFoundException, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { resolveSettings } from '../server/utils/appSettings';
import { isNativeBlogBrand } from '../publish';
import {
  absoluteCover,
  authorOf,
  excerpt,
  publicBase,
  publicSlug,
  readingMinutes,
  relatedPosts,
  shareLinks,
} from '../server/utils/publicPosts';
import { incrementViews, listPublishedRuns, type PublicRunRow } from '../server/utils/store';

@Controller('blogwriter')
export class PublicPostsController {
  /** Absolute origin of the incoming request (`https://host`) for publicBase(). */
  private reqBase(req: Request): string {
    return `${req.protocol}://${req.get('host') ?? ''}`;
  }

  /**
   * Storefront: published runs from the NATIVE blog ONLY, in a single query.
   * Settings are resolved per encountered brand (there are only a handful), and the
   * decision is cached for the duration of the request — the brand's siteUrl is exactly
   * the criterion for "our blog".
   */
  private async nativePublished(): Promise<PublicRunRow[]> {
    const rows = await listPublishedRuns();
    const isNative = new Map<number, boolean>();
    const out: PublicRunRow[] = [];
    for (const r of rows) {
      const brandId = r.brandId ?? 0; // legacy run with no brand → account-wide settings
      let ok = isNative.get(brandId);
      if (ok === undefined) {
        ok = isNativeBlogBrand(await resolveSettings(brandId));
        isNative.set(brandId, ok);
      }
      if (ok) out.push(r);
    }
    return out;
  }

  /**
   * List of PUBLISHED posts (without article bodies).
   * ?category=CS2 filters by category (case-insensitively).
   */
  @Get('public/posts')
  async list(@Req() req: Request, @Query('category') category?: string) {
    const base = publicBase(this.reqBase(req));
    const s = await resolveSettings();
    const cat = category?.trim().toLowerCase();

    return (await this.nativePublished())
      .filter((r) => !cat || (r.category || '').toLowerCase() === cat)
      .map((r) => ({
        id: r.id,
        slug: publicSlug(r),
        title: r.title || r.topic,
        topic: r.topic,
        category: r.category || '',
        author: authorOf(r.author, s.brand, s.language),
        // the body is already in the result set — no second query for the run just for the excerpt
        excerpt: excerpt(r.body_html || ''),
        coverUrl: absoluteCover(r.cover_url, base),
        wordCount: r.word_count,
        readingMinutes: readingMinutes(r.word_count),
        views: r.views || 0,
        publishedAt: r.updated_at,
        createdAt: r.created_at,
      }));
  }

  /**
   * A single PUBLISHED post by slug or id + related + share.
   * Increments the view count by default; ?track=0 skips it (preview/bots).
   */
  @Get('public/posts/:slug')
  async detail(
    @Param('slug') key: string,
    @Req() req: Request,
    @Query('track') track?: string,
  ) {
    const base = publicBase(this.reqBase(req));
    const s = await resolveSettings();

    // one query for everything: the post itself (by id or slug) and related
    const published = await this.nativePublished();
    const row = published.find((r) => r.id === key || publicSlug(r) === key);
    if (!row) throw new NotFoundException('post not found or not published');

    // view count (counted by default; ?track=0 skips it)
    const doTrack = track !== '0';
    const views = doTrack ? await incrementViews(row.id) : row.views || 0;

    const slug = publicSlug(row);
    // canonical post URL (for sharing): siteUrl from settings, otherwise the blog's origin
    const siteBase = (s.siteUrl || base).replace(/\/$/, '');
    const canonicalUrl = `${siteBase}/blog/${slug}`;

    return {
      id: row.id,
      slug,
      title: row.title || row.topic,
      topic: row.topic,
      category: row.category || '',
      author: authorOf(row.author, s.brand, s.language),
      excerpt: excerpt(row.body_html),
      html: row.body_html,
      markdown: row.body_md,
      coverUrl: absoluteCover(row.cover_url, base),
      wordCount: row.word_count,
      readingMinutes: readingMinutes(row.word_count),
      views,
      url: canonicalUrl,
      share: shareLinks(canonicalUrl, row.title || row.topic),
      related: relatedPosts(row, published, base),
      publishedAt: row.updated_at,
      createdAt: row.created_at,
    };
  }
}
