/**
 * Content tools: generating topic ideas and searching/parsing reference articles.
 * Port of the blog-writer h3 endpoints: topics.post.ts, references/search.post.ts,
 * references/extract.post.ts. Calls the flat pipeline modules directly.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Post,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PlanGuard } from '../../auth/plan.guard';
import { LlmRateGuard } from '../llm-rate.guard';
import { resolveSettings } from '../server/utils/appSettings';
import { getBrandCache, setBrandCache } from '../server/utils/store';
import { BlogBrandContext } from '../brand-context';

const TOPIC_IDEAS_KEY = 'topicIdeas:v1'; // per-brand cache of topic ideas
const COMPETITOR_IDEAS_KEY = 'competitorIdeas:v1'; // per-brand cache of ideas from competitor blogs
import { LLM } from '../server/utils/llm';
import { generateTopics } from '../server/utils/pipeline/topics';
import { competitorTopicIdeas } from '../server/utils/pipeline/competitorTopics';
import { findArticles, extractKeyPoints } from '../server/utils/pipeline/research';
import { fetchArticle } from '../server/utils/search';
import type { Source } from '../server/utils/pipeline/types';
import { listPlanItems, listRuns } from '../server/utils/store';

@Controller('blogwriter')
@UseGuards(PlanGuard)
export class ContentController {
  constructor(private readonly brandCtx: BlogBrandContext) {}

  /** Generate article topic ideas: { seed?, n? } → { topics } (ephemeral, for the /new wizard). */
  @Post('topics')
  @UseGuards(LlmRateGuard)
  @HttpCode(200)
  async topics(@Req() req: Request, @Body() body: { seed?: string; n?: number }) {
    const seed = String(body?.seed ?? '');
    const n = Math.min(Math.max(Number(body?.n) || 8, 3), 14);
    const s = await resolveSettings(await this.brandCtx.brandId(req));
    const llm = new LLM(s);
    const topics = await generateTopics(seed, llm, s, n);
    return { topics, brand: s.brand, mock: llm.isMock };
  }

  /**
   * Cached topic ideas for the active brand (from the DB, no generation/tokens).
   * The "Topic ideas" page loads this on entry — served ready-made.
   */
  @Get('topics/ideas')
  async topicIdeas(@Req() req: Request) {
    const brandId = await this.brandCtx.brandId(req);
    const s = await resolveSettings(brandId);
    const mock = new LLM(s).isMock;
    // don't serve the cache in mock mode (old fake data may be stuck there) — the frontend will regenerate
    const cached = brandId && !mock ? await getBrandCache<any[]>(brandId, TOPIC_IDEAS_KEY) : null;
    return { topics: cached || [], brand: s.brand, mock };
  }

  /**
   * Generate topic ideas and SAVE them to the brand cache. append=true — append to
   * the accumulated list ("More" button), otherwise replace it. Returns the full list.
   */
  @Post('topics/ideas')
  @HttpCode(200)
  async generateTopicIdeas(@Req() req: Request, @Body() body: { seed?: string; n?: number; append?: boolean }) {
    await this.brandCtx.assertBrandMutate(req); // viewer can't write ideas to the brand cache
    const brandId = await this.brandCtx.brandId(req);
    const s = await resolveSettings(brandId);
    const llm = new LLM(s);
    const n = Math.min(Math.max(Number(body?.n) || 8, 3), 14);
    const fresh = await generateTopics(String(body?.seed ?? ''), llm, s, n);
    let list = fresh;
    // don't cache mock output (no LLM key) — otherwise fake data would later look
    // "already there" as if real; once a key is set, the first real generation fills the cache.
    if (brandId && !llm.isMock) {
      if (body?.append) {
        const prev = (await getBrandCache<any[]>(brandId, TOPIC_IDEAS_KEY)) || [];
        const seen = new Set(prev.map((t) => t?.title));
        list = [...prev, ...fresh.filter((t) => !seen.has(t?.title))];
      }
      await setBrandCache(brandId, TOPIC_IDEAS_KEY, list);
    }
    return { topics: list, brand: s.brand, mock: llm.isMock };
  }

  /**
   * Remove a bad idea from the brand cache ("Hide" button on the card). Ideas are
   * easy to regenerate with the "More" button, so we remove it for good. Matched by
   * title (titles are unique within the cache — deduped in generateTopicIdeas). No
   * brand/cache (mock) — a silent ok: the list lives ephemerally on the client, nothing to clean up.
   */
  @Delete('topics/ideas')
  async removeTopicIdea(@Req() req: Request, @Body() body: { title?: string }) {
    await this.brandCtx.assertBrandMutate(req); // viewer can't remove ideas from the cache
    const brandId = await this.brandCtx.brandId(req);
    const title = String(body?.title ?? '').trim();
    if (!brandId || !title) return { ok: true, topics: [] };
    const prev = (await getBrandCache<any[]>(brandId, TOPIC_IDEAS_KEY)) || [];
    const list = prev.filter((t) => String(t?.title ?? '') !== title);
    if (list.length !== prev.length) await setBrandCache(brandId, TOPIC_IDEAS_KEY, list);
    return { ok: true, topics: list };
  }

  /**
   * Cached ideas from competitor blogs (from the DB, no parsing/tokens).
   * Competitors come from Ideata's tools: Brand.competitors + AeoTracker.
   */
  @Get('topics/competitors')
  async competitorIdeas(@Req() req: Request) {
    const brandId = await this.brandCtx.brandId(req);
    const s = await resolveSettings(brandId);
    const mock = new LLM(s).isMock;
    const cached = brandId && !mock
      ? await getBrandCache<any>(brandId, COMPETITOR_IDEAS_KEY)
      : null;
    return {
      ideas: cached?.ideas || [],
      competitors: cached?.competitors || [],
      scannedAt: cached?.scannedAt || '',
      brand: s.brand,
      mock,
    };
  }

  /**
   * Scan competitors and generate ideas: their blogs get parsed
   * (RSS → HTML → sitemap), the LLM picks magnet topics and repackages them for our
   * brand. Existing ideas/plan/articles guard against duplicates. The result is cached.
   */
  @Post('topics/competitors')
  @UseGuards(LlmRateGuard)
  @HttpCode(200)
  async scanCompetitors(@Req() req: Request, @Body() body: { n?: number }) {
    const brandId = await this.brandCtx.brandId(req);
    if (!brandId) {
      throw new BadRequestException('an active brand is required: competitors are taken from its onboarding and AEO trackers');
    }
    const s = await resolveSettings(brandId);
    const llm = new LLM(s);
    const n = Math.min(Math.max(Number(body?.n) || 10, 3), 20);

    // "what we already have": article titles + plan slots + accumulated ideas
    const [runs, plan, ideasCache] = await Promise.all([
      listRuns(brandId, false),
      listPlanItems(brandId),
      getBrandCache<any[]>(brandId, TOPIC_IDEAS_KEY),
    ]);
    const ourTitles = [
      ...runs.map((r) => r.title || r.topic),
      ...plan.map((p) => p.title),
      ...(ideasCache || []).map((t) => String(t?.title ?? '')),
    ].filter(Boolean);

    const { ideas, blogs, competitors } = await competitorTopicIdeas(brandId, ourTitles, llm, s, n);
    const scannedAt = new Date().toISOString();
    if (!llm.isMock) {
      await setBrandCache(brandId, COMPETITOR_IDEAS_KEY, { ideas, competitors, scannedAt });
    }
    return {
      ideas,
      competitors,
      scannedAt,
      // parsing summary — shows which blog couldn't be read
      blogs: blogs.map((b) => ({ domain: b.domain, posts: b.posts.length, source: b.source })),
      brand: s.brand,
      mock: llm.isMock,
    };
  }

  /** Remove a competitor-scan idea from the brand cache ("Hide" button). */
  @Delete('topics/competitors')
  async removeCompetitorIdea(@Req() req: Request, @Body() body: { title?: string }) {
    const brandId = await this.brandCtx.brandId(req);
    const title = String(body?.title ?? '').trim();
    if (!brandId || !title) return { ok: true, ideas: [] };
    const cached = (await getBrandCache<any>(brandId, COMPETITOR_IDEAS_KEY)) || {};
    const prev: any[] = cached.ideas || [];
    const ideas = prev.filter((t) => String(t?.title ?? '') !== title);
    if (ideas.length !== prev.length) {
      await setBrandCache(brandId, COMPETITOR_IDEAS_KEY, { ...cached, ideas });
    }
    return { ok: true, ideas };
  }

  /**
   * Search for real reference articles on a topic (without a run).
   * { topic, queries?, fetchN? } → { queries, articles } (fan-out across queries).
   */
  @Post('references/search')
  @UseGuards(LlmRateGuard)
  @HttpCode(200)
  async referencesSearch(
    @Req() req: Request,
    @Body() body: { topic?: string; queries?: string[]; fetchN?: number },
  ) {
    const topic = String(body?.topic ?? '').trim();
    if (!topic) throw new BadRequestException('topic is required');

    const s = await resolveSettings(await this.brandCtx.brandId(req));
    const llm = new LLM(s);
    const customQueries = Array.isArray(body?.queries)
      ? body.queries
          .map(String)
          .map((q) => q.trim())
          .filter(Boolean)
          .slice(0, 8)
      : undefined;
    const fetchN = Math.min(Math.max(Number(body?.fetchN) || s.maxSources, 1), 12);

    const { queries, sources } = await findArticles(topic, llm, s, {
      queries: customQueries,
      fetchN,
    });
    return { queries, articles: sources, mock: llm.isMock };
  }

  /**
   * Parse a single candidate from the results on demand: text + key points.
   * { url, topic } → { url, title, keyPoints, chars }.
   */
  @Post('references/extract')
  @UseGuards(LlmRateGuard)
  @HttpCode(200)
  async referencesExtract(
    @Req() req: Request,
    @Body() body: { url?: string; topic?: string; title?: string },
  ) {
    const url = String(body?.url ?? '').trim();
    const topic = String(body?.topic ?? '').trim();
    if (!/^https?:\/\//.test(url)) {
      throw new BadRequestException('a valid url is required');
    }

    const s = await resolveSettings(await this.brandCtx.brandId(req));
    const llm = new LLM(s);

    const text = llm.isMock
      ? `Демо-текст статьи ${url}. Тезис 1. Тезис 2.`
      : await fetchArticle(url, s.fetchTimeoutMs);
    if (!text || text.length < 200) {
      throw new UnprocessableEntityException(
        'failed to parse the article (empty or protected)',
      );
    }
    const src: Source = {
      url,
      title: String(body?.title ?? url),
      text,
      keyPoints: [],
      fetched: true,
    };
    const keyPoints = await extractKeyPoints(topic || src.title, src, llm);
    return { url, title: src.title, keyPoints, chars: text.length };
  }
}
