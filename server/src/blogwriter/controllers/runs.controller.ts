/**
 * Blog-writer runs: pipeline start, status/result, edit, export, continue the
 * step-by-step flow, retry a phase, fact-fix, locale group, translate and SSE progress.
 * Port of the h3 endpoints blog-writer/server/api/runs/** + posts/index.get to NestJS.
 * Store functions became async (Prisma) — all are awaited.
 */
import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  Delete,
  Get,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { marked } from 'marked';
import { PlanGuard } from '../../auth/plan.guard';
import { LlmRateGuard } from '../llm-rate.guard';
import { AuthService } from '../../auth/auth.service';
import { BlogBrandContext } from '../brand-context';
import { PostQuotaService } from '../post-quota';
import { CreditsService } from '../../credits/credits.service';
import { countWords, lint } from '../shared/antislop/patterns';
import { findLanguage } from '../shared/languages';
import { resolveSettings } from '../server/utils/appSettings';
import { LLM } from '../server/utils/llm';
import { getUnifiedCatalog } from '../server/utils/modelCatalog';
import { sourcesContext, writeSection } from '../server/utils/pipeline/draft';
import { launchPhase, startRun, type Phase } from '../server/utils/pipeline/run';
import type { Outline, Source } from '../server/utils/pipeline/types';
import { buildHeadMarkup } from '../server/utils/headMarkup'
import { publicSlug } from '../server/utils/publicPosts';
import { sanitizeArticleHtml } from '../server/utils/htmlSanitize';
import { editMaxTokens, MAX_EDIT_HTML, tooLongMessage } from '../server/utils/editLimits';
import { getRunState, type RunUpdate } from '../server/utils/runRegistry';
import { htmlToText } from '../server/utils/search';
import {
  claimRun,
  deleteRun,
  getRunRow,
  listGroup,
  listRuns,
  updateRun,
} from '../server/utils/store';
import { htmlToMarkdown } from '../server/utils/markdown';
import { removeRunFromBlog } from '../publish';
import { translateRun } from '../server/utils/translate';

const EDITABLE_STATUSES = new Set(['done', 'published']);

/**
 * The model for a one-off article is accepted ONLY from the curated catalog (the
 * same list shown in the composer's selector): an arbitrary slug from the request
 * body would go straight to the provider and either cost unpredictably or crash the run.
 * An unknown/empty value → '' = strong model from the brand settings.
 */
async function catalogModel(id?: string | null): Promise<string> {
  const want = String(id ?? '').trim();
  if (!want) return '';
  try {
    const { models } = await getUnifiedCatalog();
    return models.some((m) => m.id === want) ? want : '';
  } catch {
    return ''; // catalog unavailable — silently fall back to the settings model
  }
}

const parse = (s: string, dflt: any) => {
  try {
    return s ? JSON.parse(s) : dflt;
  } catch {
    return dflt;
  }
};

@Controller('blogwriter')
@UseGuards(PlanGuard)
export class RunsController {
  constructor(
    private readonly brandCtx: BlogBrandContext,
    private readonly quota: PostQuotaService,
    private readonly credits: CreditsService,
    private readonly auth: AuthService,
  ) {}

  /**
   * Credits for the "Start a new topic" UI: balance and how much the article on
   * the selected model will cost (?model=, empty — model from the brand settings).
   * The daily post limit remains, but it's now a technical queue safeguard, not
   * a product quota.
   */
  @Get('credits')
  async creditsInfo(@Req() req: Request, @Query('model') model?: string) {
    const user = this.auth.userFromRequest(req);
    if (!user?.i) throw new BadRequestException('account login required');
    const brandId = await this.brandCtx.brandId(req);
    const s = await resolveSettings(brandId ?? 0, { modelStrong: await catalogModel(model) });
    const [balance, perPost] = await Promise.all([
      this.credits.balance(user.i),
      this.credits.estimatePost(s.modelStrong),
    ]);
    // model — the model the article will actually run on (after the plan's Opus gate)
    return { ...balance, perPost, model: s.modelStrong };
  }

  /** Start article generation: { topic, targetQueries?, mode?, model? } → { runId } (under the active brand). */
  @Post('runs')
  async start(
    @Req() req: Request,
    @Body() body: { topic?: string; targetQueries?: string[]; mode?: string; model?: string },
  ) {
    const topic = String(body?.topic ?? '').trim();
    if (!topic) throw new BadRequestException('topic is required');
    const targetQueries = (Array.isArray(body?.targetQueries) ? body.targetQueries : [])
      .map((q) => String(q).trim())
      .filter(Boolean)
      .slice(0, 20);
    const mode = body?.mode === 'auto' ? 'auto' : 'interactive';
    const model = await catalogModel(body?.model);
    const brandId = await this.brandCtx.brandId(req);
    // A non-admin must have a brand: runs are tied to brand_id, and access to
    // them is later checked by ownership (assertRunAccess). Without a brand the
    // run would end up with brand_id=NULL and become inaccessible even to its own
    // author — hence a brand is required.
    if (!brandId && !this.brandCtx.isAdmin(req)) {
      throw new BadRequestException('Create a brand in onboarding first — articles are tied to a brand');
    }
    // a viewer of the active brand cannot start generation (owner/editor only)
    await this.brandCtx.assertBrandMutate(req);
    // daily post limit — a technical queue safeguard (no limit for admins)
    await this.quota.assertCanStart(req, brandId || undefined);
    // ...and the credits balance pays for the article: don't let generation start
    // if it's clearly not enough. The exact amount is deducted after the fact
    // (sum of the run's llm_usage).
    const user = this.auth.userFromRequest(req);
    if (user?.i) {
      // price is estimated from the model the run will actually use: the one
      // chosen in the composer → (after the Opus gate) → the brand settings model
      const s = await resolveSettings(brandId ?? 0, { modelStrong: model });
      await this.credits.assertEnough(user.i, await this.credits.estimatePost(s.modelStrong));
    }
    const runId = await startRun(topic, targetQueries, mode, brandId || null, model);
    return { runId };
  }

  /** List of drafts/articles for the homepage — only articles of the active brand. */
  @Get('posts')
  async posts(@Req() req: Request) {
    const brandId = await this.brandCtx.brandId(req);
    // STRICTLY by brand: includeUnassigned=false, otherwise runs with brand_id=NULL
    // (e.g. imported from insane without an active brand) leak into all brands.
    // With no active brand (brandId=0) listRuns would return EVERYTHING — for a
    // non-admin that's a leak of other users' drafts, so with no brand we return
    // empty (an admin still sees all runs, including global/imported ones).
    if (!brandId && !this.brandCtx.isAdmin(req)) return [];
    const rows = await listRuns(brandId || null, false);
    return rows.map((r) => {
      let slopScore: number | null = null;
      try {
        slopScore = r.slop_json ? (JSON.parse(r.slop_json).score ?? null) : null;
      } catch {
        /* ignore */
      }
      return {
        id: r.id,
        topic: r.topic,
        title: r.title,
        status: r.status,
        locale: r.locale || '',
        groupId: r.group_id || r.id,
        category: r.category || '',
        author: r.author || '',
        views: r.views || 0,
        wordCount: r.word_count,
        slopScore,
        coverUrl: r.cover_url || null,
        blogStatus: r.blog_status || '',
        error: r.error,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      };
    });
  }

  /**
   * Head markup for an article: title/description variants, Open Graph, Twitter,
   * and JSON-LD (BlogPosting + FAQPage, if the text has question-subheadings).
   *
   * Computed deterministically from the finished text — no model call and no
   * credits deducted. Needed because the blog-writer used to hand off to
   * publishing only the title and body: no description, no markup — and it's
   * exactly that markup that decides whether the article lands in a rich result
   * and whether an AI can pull a quote from it.
   */
  @Get('runs/:id/head-markup')
  async headMarkup(@Param('id') id: string, @Req() req: Request) {
    const row = await getRunRow(id);
    if (!row) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunAccess(req, row);
    const brandId = await this.brandCtx.brandId(req);
    const s = await resolveSettings(brandId ?? 0);
    const site = (s.siteUrl || '').replace(/\/+$/, '');
    return buildHeadMarkup({
      title: row.title || row.topic || '',
      body: row.body_md || row.body_html || '',
      excerpt: (row as any).excerpt || '',
      url: site ? `${site}/blog/${publicSlug(row)}` : '',
      coverUrl: row.cover_url || '',
      author: row.author || '',
      siteName: (s as any).brandName || '',
      locale: row.locale || '',
      publishedAt: (row as any).published_at || row.created_at,
      updatedAt: row.updated_at,
    });
  }

  /** Run status/result: DB row + live stage state from the registry. */
  @Get('runs/:id')
  async get(@Param('id') id: string, @Req() req: Request) {
    const row = await getRunRow(id);
    if (!row) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunAccess(req, row);
    const live = getRunState(id);
    return {
      id: row.id,
      slug: publicSlug(row),
      topic: row.topic,
      status: row.status,
      phase: row.phase,
      mode: row.mode,
      model: row.model || '', // '' — was written by the brand settings model
      locale: row.locale || '',
      groupId: row.group_id || row.id,
      title: row.title,
      category: row.category || '',
      author: row.author || '',
      views: row.views || 0,
      bodyMd: row.body_md,
      bodyHtml: row.body_html,
      outline: parse(row.outline_json, null),
      sources: parse(row.sources_json, []),
      searchQueries: parse(row.search_queries_json, []),
      coverUrl: row.cover_url || null,
      perspectives: parse(row.perspectives_json, []),
      slop: parse(row.slop_json, null),
      eeat: parse(row.eeat_json, null),
      notes: parse(row.notes_json, []),
      targetQueries: parse(row.queries_json, []),
      wordCount: row.word_count,
      error: row.error,
      blog: {
        postId: row.blog_post_id || 0,
        slug: row.blog_slug || '',
        status: row.blog_status || '',
        locale: row.blog_locale || '',
        coverUrl: row.blog_cover_url || '',
        syncedAt: row.blog_synced_at || '',
      },
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      stages: live?.stages ?? null,
    };
  }

  /** Save an edited post: title / bodyHtml / status / category / author. */
  @Patch('runs/:id')
  async patch(
    @Param('id') id: string,
    @Req() req: Request,
    @Body()
    body: { title?: string; bodyHtml?: string; status?: string; category?: string; author?: string },
  ) {
    const row = await getRunRow(id);
    if (!row) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, row);

    const fields: Record<string, any> = {};
    if (typeof body?.title === 'string') fields.title = body.title.trim();
    if (typeof body?.category === 'string') fields.category = body.category.trim();
    if (typeof body?.author === 'string') fields.author = body.author.trim();
    let slop: unknown = parse(row.slop_json, null);
    let wordCount = row.word_count;
    if (typeof body?.bodyHtml === 'string') {
      // The ONLY point where the article body reaches the DB from the browser —
      // hence also the only chance to clean up XSS: the public render outputs
      // the body via v-html with no sanitizer. Downstream code only ever works
      // with clean HTML, including the word count and slop lint (otherwise
      // metrics would be computed on the stripped-out content).
      const clean = sanitizeArticleHtml(body.bodyHtml);
      fields.body_html = clean;
      const text = htmlToText(clean);
      wordCount = countWords(text);
      slop = lint(text);
      fields.word_count = wordCount;
      fields.slop_json = JSON.stringify(slop);
      // keep markdown in sync with the editor — export is built from it
      const md = await htmlToMarkdown(clean);
      if (md) fields.body_md = md; // didn't work out — md stays from the pipeline
    }
    if (body?.status && EDITABLE_STATUSES.has(body.status)) fields.status = body.status;

    await updateRun(id, fields);
    // return recalculated metrics: the frontend used to do one more GET of the
    // run after every save just for slop/wordCount
    return { ok: true, slop, wordCount };
  }

  /**
   * Delete a draft (with all locales of the group). Before deleting, unpublish
   * everything that made it out: otherwise the run row disappears along with its
   * back-refs (blog_slug/blog_post_id), while copies keep living on the brand
   * site and in the blog — with no way left to take them down.
   */
  @Delete('runs/:id')
  async remove(@Param('id') id: string, @Req() req: Request) {
    const row = await getRunRow(id);
    if (!row) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, row);

    const group = await listGroup(row.group_id || row.id);
    const unpublished: Array<{ id: string; locale: string; ok: boolean; error?: string }> = [];
    for (const r of group.filter((x) => x.blog_status)) {
      try {
        const rep = await removeRunFromBlog(r.id);
        unpublished.push({
          id: r.id,
          locale: r.locale || '',
          ok: rep.cleared,
          ...(rep.cleared ? {} : { error: rep.external.error || 'external copy not removed' }),
        });
      } catch (e: any) {
        // one locale that failed to unpublish shouldn't block deleting the rest — collect and continue
        unpublished.push({ id: r.id, locale: r.locale || '', ok: false, error: e?.message || 'removal error' });
      }
    }

    await deleteRun(id);
    return { ok: true, unpublished };
  }

  /**
   * Credits gate for continuing/retrying a run. The next phase involves the same
   * paid model calls as the start: without a gate, an empty balance would go
   * negative (start checked it, but continue/retry didn't).
   */
  private async assertCreditsForPhase(req: Request, row: { brandId?: number | null; model?: string }) {
    const user = this.auth.userFromRequest(req);
    if (!user?.i) return;
    const s = await resolveSettings(row.brandId ?? 0, { modelStrong: row.model || '' });
    await this.credits.assertEnough(user.i, await this.credits.estimatePost(s.modelStrong));
  }

  /**
   * Continue a step-by-step run after a pause:
   * - awaiting_sources: { selectedUrls[], extraUrls[] } → outline phase
   * - awaiting_outline: { outline } → draft phase
   */
  @Post('runs/:id/continue')
  async continue(@Param('id') id: string, @Req() req: Request, @Body() body: any) {
    const row = await getRunRow(id);
    if (!row) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, row);
    await this.assertCreditsForPhase(req, row);

    if (row.status === 'awaiting_sources') {
      const selectedUrls = (Array.isArray(body?.selectedUrls) ? body.selectedUrls : [])
        .map(String)
        .slice(0, 20);
      const extraUrls = (Array.isArray(body?.extraUrls) ? body.extraUrls : [])
        .map(String)
        .map((u: string) => u.trim())
        .filter((u: string) => /^https?:\/\//.test(u))
        .slice(0, 6);
      await updateRun(id, { pending_input_json: JSON.stringify({ selectedUrls, extraUrls }) });
      // claim the run: a double-click on "Continue" would otherwise start the phase twice
      if (!(await claimRun(id, ['awaiting_sources']))) {
        throw new ConflictException('run already continued');
      }
      await launchPhase(id, 'outline');
      return { ok: true, phase: 'outline' };
    }

    if (row.status === 'awaiting_outline') {
      const o = body?.outline;
      const sections = (Array.isArray(o?.sections) ? o.sections : [])
        .map((sec: any) => ({
          heading: String(sec?.heading ?? '').trim(),
          intent: String(sec?.intent ?? '').trim(),
          points: (Array.isArray(sec?.points) ? sec.points : []).map(String).filter(Boolean),
          keywords: (Array.isArray(sec?.keywords) ? sec.keywords : [])
            .map((k: any) =>
              typeof k === 'string'
                ? { word: k.trim(), required: true }
                : { word: String(k?.word ?? '').trim(), required: k?.required !== false },
            )
            .filter((k: any) => k.word),
          topics: (Array.isArray(sec?.topics) ? sec.topics : [])
            .map(String)
            .map((x: string) => x.trim())
            .filter(Boolean),
          estWords: Math.min(1500, Math.max(60, Number(sec?.estWords) || 200)),
        }))
        .filter((sec: any) => sec.heading);
      if (!sections.length) {
        throw new BadRequestException('the outline has no sections');
      }
      const outline: Outline = {
        title: String(o?.title ?? row.topic).trim() || row.topic,
        angle: String(o?.angle ?? '').trim(),
        audience: String(o?.audience ?? '').trim(),
        sections,
      };
      await updateRun(id, { outline_json: JSON.stringify(outline) });
      if (!(await claimRun(id, ['awaiting_outline']))) {
        throw new ConflictException('run already continued');
      }
      await launchPhase(id, 'draft');
      return { ok: true, phase: 'draft' };
    }

    throw new ConflictException(`run is in status ${row.status} — nothing to continue`);
  }

  /** Restart a failed/interrupted run PHASE — from the saved input, not from scratch. */
  @Post('runs/:id/retry')
  async retry(@Param('id') id: string, @Req() req: Request) {
    const row = await getRunRow(id);
    if (!row) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, row);
    if (getRunState(id)?.status === 'running' && row.status === 'running') {
      throw new ConflictException('pipeline is already running');
    }
    await this.assertCreditsForPhase(req, row);
    const phase = (['research', 'outline', 'draft'].includes(row.phase)
      ? row.phase
      : 'research') as Phase;
    // claim the run with a conditional update: two "Retry" clicks in a row would otherwise cost two runs
    if (!(await claimRun(id))) throw new ConflictException('pipeline is already running');
    await launchPhase(id, phase);
    return { ok: true, phase };
  }

  /** Download the article as a Markdown file (current body_md + sources). */
  @Get('runs/:id/export')
  async export(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const row = await getRunRow(id);
    if (!row) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunAccess(req, row);

    let sources: Array<{ url: string; title?: string }> = [];
    try {
      sources = JSON.parse(row.sources_json);
    } catch {
      /* empty */
    }

    // translations and imports have an empty body_md — build markdown from HTML,
    // otherwise the file reaches the user with just a heading
    const bodyMd = row.body_md.trim() || (await htmlToMarkdown(row.body_html));
    const parts = [`# ${row.title || row.topic}`, '', bodyMd];
    if (sources.length) {
      parts.push('', '---', '', '## Источники', '');
      sources.forEach((s, i) => parts.push(`${i + 1}. [${s.title || s.url}](${s.url})`));
    }

    const slug =
      (row.title || row.topic)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'post';
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(slug)}.md"`);
    res.send(parts.join('\n'));
  }

  /**
   * "Remove fabricated data": LLM rewrites the text, eliminating statements
   * flagged by fact-check, without breaking the HTML. { html } → { html, fixed }.
   */
  @Post('runs/:id/factfix')
  @UseGuards(LlmRateGuard)
  async factfix(@Param('id') id: string, @Req() req: Request, @Body() body: { html?: string }) {
    const row = await getRunRow(id);
    if (!row) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, row);
    const html = String(body?.html ?? '');
    if (!html.trim()) throw new BadRequestException('html is required');
    if (html.length > MAX_EDIT_HTML) throw new BadRequestException(tooLongMessage('Текст'));

    let notes: string[] = [];
    try {
      notes = JSON.parse(row.notes_json);
    } catch {
      /* empty */
    }
    if (!notes.length) return { html, fixed: 0 };

    const s = await resolveSettings(row.brandId ?? 0);
    const llm = new LLM(s);
    if (llm.isMock) throw new ConflictException('LLM key required (mock mode)');

    let sources: Source[] = [];
    try {
      sources = JSON.parse(row.sources_json);
    } catch {
      /* empty */
    }
    const srcCtx = sourcesContext(sources.filter((x) => x.fetched));

    const problems = notes
      .slice(0, 15)
      .map((n) => `- ${n}`)
      .join('\n');
    const prompt =
      'Ниже HTML статьи, список претензий факт-чекера (выдуманные цифры, ' +
      'утверждения без источника) и реальные факты из источников. Для каждого ' +
      'проблемного места:\n' +
      '1) если у источников есть подходящий РЕАЛЬНЫЙ факт — замени выдумку им ' +
      'и поставь ссылку <a href="URL источника">название</a> (только URL из списка);\n' +
      '2) если замены нет — убери придуманные числа и «результаты тестов», ' +
      'замени качественной формулировкой по механике, либо выброси предложение.\n' +
      'Смысл и ВСЮ HTML-разметку сохрани. Верни только HTML без пояснений и ```-ограждений.\n\n' +
      `ПРЕТЕНЗИИ:\n${problems}\n\nФАКТЫ ИЗ ИСТОЧНИКОВ:\n${srcCtx}\n\nHTML:\n${html}`;
    const system =
      `Ты редактор блога ${s.brand}, отвечающий за достоверность. ` +
      `Псевдоконкретика хуже честного «данных нет». Язык: ${s.language}.`;
    const out = (
      await llm.complete(prompt, {
        system,
        strong: true,
        maxTokens: editMaxTokens(html),
        temperature: 0.3,
      })
    )
      .trim()
      .replace(/^```(?:html)?\s*/i, '')
      .replace(/```\s*$/, '');

    return { html: out || html, fixed: notes.length };
  }

  /**
   * Regenerate a SINGLE excerpt (section) of a finished article: the LLM rewrites
   * the section from scratch per its outline plan + sources. { index?, heading? } →
   * { index, heading, md, html }. The article body isn't touched on the server —
   * the frontend inserts the excerpt in place of the section in the editor and
   * saves it via a patch.
   */
  @Post('runs/:id/section')
  async regenSection(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: { index?: number; heading?: string; directive?: string },
  ) {
    const row = await getRunRow(id);
    if (!row) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, row);
    const outline = parse(row.outline_json, null) as Outline | null;
    if (!outline?.sections?.length) throw new BadRequestException('no article outline');

    // find the section by index, otherwise by heading (edits made in the editor)
    let idx = Number.isInteger(body?.index) ? Number(body!.index) : -1;
    if ((idx < 0 || idx >= outline.sections.length) && body?.heading) {
      const norm = (t: string) => String(t || '').trim().toLowerCase();
      idx = outline.sections.findIndex((sc) => norm(sc.heading) === norm(body.heading!));
    }
    if (idx < 0 || idx >= outline.sections.length) throw new BadRequestException('section not found');

    const s = await resolveSettings(row.brandId ?? 0);
    const llm = new LLM(s);
    if (llm.isMock) throw new ConflictException('LLM key required (mock mode)');

    const sources = parse(row.sources_json, []);
    // "memory" — headings of the other sections, so the excerpt doesn't duplicate its neighbors
    const others = outline.sections.filter((_, i) => i !== idx).map((sc) => `## ${sc.heading}`);
    // negative prompt from the editor: what to avoid in this excerpt (truncated to keep the prompt from bloating)
    const directive = String(body?.directive || '').trim().slice(0, 600);
    const md = await writeSection(outline, outline.sections[idx], sources, llm, s, others, directive);
    return { index: idx, heading: outline.sections[idx].heading, md, html: String(marked.parse(md)) };
  }

  /**
   * The article's locale group (all translations of one group) for the switcher
   * in the editor. → { groupId, sourceLocale, items: [{ id, locale, status, blog… }] }
   */
  @Get('runs/:id/group')
  async group(@Param('id') id: string, @Req() req: Request) {
    const row = await getRunRow(id);
    if (!row) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunAccess(req, row);

    const groupId = row.group_id || row.id;
    const defaultLocale = findLanguage((await resolveSettings(row.brandId ?? 0)).language)?.code || 'ru';
    const rows = await listGroup(groupId);
    const items = rows.map((r) => ({
      id: r.id,
      locale: r.locale || defaultLocale, // legacy source with no locale → language from settings
      title: r.title || r.topic,
      status: r.status,
      blogStatus: r.blog_status || '',
      blogSlug: r.blog_slug || '',
      wordCount: r.word_count || 0,
      coverUrl: r.cover_url || null,
      isCurrent: r.id === id,
    }));
    const source = items.find((i) => i.id === groupId);
    return { groupId, sourceLocale: source?.locale || defaultLocale, items };
  }

  /**
   * Generate translations of the article into the given locales (LLM), each one
   * a run-draft in the same group. body: { locales: string[] }
   */
  @Post('runs/:id/translate')
  async translate(@Param('id') id: string, @Req() req: Request, @Body() body: { locales?: string[] }) {
    const row = await getRunRow(id);
    if (!row) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, row);
    const locales = Array.isArray(body?.locales) ? body.locales.map(String) : [];
    if (!locales.length) throw new BadRequestException('locales is required');
    return translateRun(id, locales);
  }

  /** SSE pipeline progress: a stage snapshot + live events up to done/error. */
  @Sse('runs/:id/stream')
  stream(@Param('id') id: string, @Req() req: Request): Observable<MessageEvent> {
    return new Observable<MessageEvent>((sub) => {
      let cancelled = false;
      let cleanup: (() => void) | undefined;
      // ownership is checked against the run row BEFORE serving stages — otherwise
      // the stream would leak the status/progress of someone else's run by a guessed id.
      getRunRow(id)
        .then(async (row) => {
          if (cancelled) return;
          await this.brandCtx.assertRunAccess(req, row);

          const state = getRunState(id);
          if (state) {
            sub.next({
              data: { type: 'snapshot', runId: id, status: state.status, stages: state.stages },
            });
            const onUpdate = (u: RunUpdate) => sub.next({ data: u });
            state.emitter.on('update', onUpdate);
            cleanup = () => state.emitter.off('update', onUpdate);
            return;
          }

          // run not in memory (finished/server restart) — return the final state from the DB and close
          if (row) {
            const type =
              row.status === 'error'
                ? 'error'
                : ['done', 'published'].includes(row.status)
                  ? 'done'
                  : 'paused';
            sub.next({ data: { type, runId: id, status: row.status, error: row.error } });
          }
          sub.complete();
        })
        .catch((e) => {
          if (!cancelled) sub.error(e);
        });
      return () => {
        cancelled = true;
        cleanup?.();
      };
    });
  }
}
