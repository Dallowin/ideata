import { BadRequestException, Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PlanGuard } from '../../auth/plan.guard';
import { LlmRateGuard } from '../llm-rate.guard';
import { resolveSettings } from '../server/utils/appSettings';
import { getBrandCache, setBrandCache } from '../server/utils/store';
import { BlogBrandContext } from '../brand-context';

const AEO_IDEAS_KEY = 'aeoKeywordsIdeas:v1'; // per-brand cache of AEO keywords
import { LLM } from '../server/utils/llm';
import { getUnifiedCatalog } from '../server/utils/modelCatalog';
import { generateKeywords } from '../server/utils/pipeline/aeo/keywords';
import { MockAnswerEngine, SearchAnswerEngine } from '../server/utils/pipeline/aeo/engines';
import { checkVisibility } from '../server/utils/pipeline/aeo/visibility';
import { htmlToText } from '../server/utils/search';
import { sanitizeArticleHtml } from '../server/utils/htmlSanitize';
import { editMaxTokens, MAX_EDIT_HTML, tooLongMessage } from '../server/utils/editLimits';
import { lint } from '../shared/antislop/patterns';
import { normalizeDashes } from '../shared/antislop/normalize';

/**
 * Fillers that can be removed with no loss of meaning (mock mode and a pre-pass before the LLM).
 * Port of blog-writer/server/api/antislop/rewrite.post.ts.
 */
function deterministicFix(html: string): string {
  let out = normalizeDashes(html); // first, deterministically trim excess dashes
  // openers: "Не секрет, что X" ("It's no secret that X") → "X" (with capitalization)
  out = out.replace(/Не секрет,?\s+что\s+(\p{L})/gu, (_, c: string) => c.toUpperCase());
  out = out.replace(/В современном мире\s+(\p{L})/gu, (_, c: string) => c.toUpperCase());
  // pure fillers — just drop them
  out = out.replace(/\s*Таким образом,\s*(\p{L})/gu, (_, c: string) => ' ' + c.toUpperCase());
  out = out.replace(/таким образом,\s*/gu, '');
  out = out.replace(/Стоит отметить,?\s+что\s+(\p{L})/gu, (_, c: string) => c.toUpperCase());
  out = out.replace(/стоит отметить,?\s+что\s+/gu, '');
  out = out.replace(/Важно (?:понимать|отметить|помнить),?\s+что\s+(\p{L})/gu, (_, c: string) => c.toUpperCase());
  out = out.replace(/Как известно,?\s+(\p{L})/gu, (_, c: string) => c.toUpperCase());
  out = out.replace(/как известно,?\s*/gu, '');
  out = out.replace(/на самом деле,?\s*/gu, '');
  out = out.replace(/по-настоящему\s+/gu, '');
  out = out.replace(/в заключение,?\s*/giu, '');
  return out;
}

@Controller('blogwriter')
@UseGuards(PlanGuard)
export class AeoController {
  constructor(private readonly brandCtx: BlogBrandContext) {}

  /** Generate AEO keywords: { topic } → { keywords } (ephemeral, for the /new wizard). */
  @Post('aeo/keywords')
  async keywords(@Req() req: Request, @Body() body: { topic?: string; perIntent?: number }) {
    const topic = String(body?.topic ?? '').trim();
    if (!topic) throw new BadRequestException('topic is required');
    const s = await resolveSettings(await this.brandCtx.brandId(req));
    const llm = new LLM(s);
    const keywords = await generateKeywords(topic, llm, s, Math.min(Number(body?.perIntent) || 4, 8));
    return { keywords, mock: llm.isMock };
  }

  /**
   * Cached AEO keywords of the active brand (from the DB, no generation). The
   * "Keyword Generator" page loads this on entry — empty on first open → the
   * frontend generates 20 itself (POST below).
   */
  @Get('aeo/keywords/ideas')
  async keywordIdeas(@Req() req: Request) {
    const brandId = await this.brandCtx.brandId(req);
    const s = await resolveSettings(brandId);
    const mock = new LLM(s).isMock;
    // in mock mode we don't return the cache (an old fake might be sitting in it) — the frontend regenerates
    const cached = brandId && !mock ? await getBrandCache<any[]>(brandId, AEO_IDEAS_KEY) : null;
    return { keywords: cached || [], topic: s.brand, mock };
  }

  /**
   * Generate ~20 AEO keywords and SAVE them to the brand cache. Default topic —
   * the brand (first open = "20 variants right away"). append=true — append ("More").
   */
  @Post('aeo/keywords/ideas')
  async generateKeywordIdeas(
    @Req() req: Request,
    @Body() body: { topic?: string; perIntent?: number; append?: boolean },
  ) {
    await this.brandCtx.assertBrandMutate(req); // a viewer doesn't write ideas to the brand cache
    const brandId = await this.brandCtx.brandId(req);
    const s = await resolveSettings(brandId);
    const llm = new LLM(s);
    const topic = String(body?.topic ?? '').trim() || s.brand || 'бренд';
    const perIntent = Math.min(Number(body?.perIntent) || 4, 8);
    const fresh = await generateKeywords(topic, llm, s, perIntent);
    let list = fresh;
    // mock (no key) isn't cached — a fake shouldn't be "served" as the real thing
    if (brandId && !llm.isMock) {
      if (body?.append) {
        const prev = (await getBrandCache<any[]>(brandId, AEO_IDEAS_KEY)) || [];
        const seen = new Set(prev.map((k) => k?.query));
        list = [...prev, ...fresh.filter((k) => !seen.has(k?.query))];
      }
      await setBrandCache(brandId, AEO_IDEAS_KEY, list);
    }
    return { keywords: list, topic, mock: llm.isMock };
  }

  /** AEO visibility checker: { queries[], domains[], engine? } → VisibilityReport. */
  @Post('aeo/visibility')
  async visibility(@Req() req: Request, @Body() body: { queries?: string[]; domains?: string[]; engine?: string }) {
    const queries = (Array.isArray(body?.queries) ? body.queries : [])
      .map((q) => String(q).trim())
      .filter(Boolean)
      .slice(0, 25);
    const domains = (Array.isArray(body?.domains) ? body.domains : [])
      .map((d) => String(d).trim())
      .filter(Boolean)
      .slice(0, 15);
    if (!queries.length || !domains.length) {
      throw new BadRequestException('queries[] and domains[] are required');
    }
    const s = await resolveSettings(await this.brandCtx.brandId(req));
    const useMock = body?.engine === 'mock' || (s.mock && body?.engine !== 'search');
    const engine = useMock ? new MockAnswerEngine() : new SearchAnswerEngine();
    const report = await checkVisibility(queries, domains, engine);
    report.rows.sort((a, b) => b.score - a.score);
    return report;
  }

  /**
   * "Remove clichés" from the editor: { html } → { html }.
   * Real mode — LLM rewrite while preserving the HTML markup;
   * mock — deterministic stripping of fillers that can be removed without an LLM.
   */
  @Post('antislop/rewrite')
  @UseGuards(LlmRateGuard)
  async rewrite(@Req() req: Request, @Body() body: { html?: string }) {
    const html = String(body?.html ?? '');
    if (!html.trim()) throw new BadRequestException('html is required');
    if (html.length > MAX_EDIT_HTML) throw new BadRequestException(tooLongMessage('Текст'));

    const s = await resolveSettings(await this.brandCtx.brandId(req));
    const llm = new LLM(s);

    // Deterministic pre-pass always runs: cheaply removes strippable fillers.
    let out = deterministicFix(html);

    const report = lint(htmlToText(out));
    if (!llm.isMock && report.score > 0) {
      const problems = report.findings
        .slice(0, 20)
        .map((f) => `- «…${f.snippet}…» → ${f.hint}`)
        .join('\n');
      const prompt
        = 'Ниже HTML-фрагмент статьи и список конкретных проблем-штампов.\n'
        + 'Перепиши текст, УБРАВ штампы и сохранив смысл, факты и ВСЮ HTML-разметку '
        + '(теги, атрибуты, структуру не менять). Не добавляй новых клише. '
        + 'Верни только HTML без пояснений и без ```-ограждений.\n\n'
        + `ПРОБЛЕМЫ:\n${problems}\n\nHTML:\n${out}`;
      const system
        = `Ты строгий литредактор блога ${s.brand}. Убиваешь ИИ-штампы, `
        + `оставляешь живой конкретный текст. Язык: ${s.language}.`;
      const rewritten = normalizeDashes((await llm.complete(prompt, {
        system,
        strong: true,
        maxTokens: editMaxTokens(out, 1500),
        temperature: 0.4,
      })).trim().replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, ''));
      // accept the rewrite only if the linter score improved
      if (rewritten && lint(htmlToText(rewritten)).score < report.score) out = rewritten;
    }

    return { html: out, slop: lint(htmlToText(out)) };
  }

  /**
   * AI edit of a selected article fragment:
   * { html, instruction, title?, model?, history? } → { html, usage }.
   * The editor sends the selected chunk here plus the author's instruction
   * ("remove this", "shorten", "add an example") — the LLM rewrites ONLY the
   * fragment, preserving the HTML markup; an empty string in the response means
   * "delete the fragment".
   *
   * model — an explicit model choice from the catalog (the "Ask the agent"
   * panel); empty — the brand settings model. history — previous instructions
   * from the same dialog, so follow-ups ("now shorter") read in context. usage
   * is returned so the editor can show the real cost (tokens + ₽).
   *
   * format:'markdown' — edits plain text rather than an article fragment (agent
   * profile: persona/requirements). In that case the model isn't asked to keep
   * HTML and the response isn't run through the HTML sanitizer. Default — the
   * previous html mode.
   */
  @Post('ai-edit')
  @UseGuards(LlmRateGuard)
  async aiEdit(
    @Req() req: Request,
    @Body() body: {
      html?: string;
      instruction?: string;
      title?: string;
      model?: string;
      history?: string[];
      format?: string;
    },
  ) {
    const html = String(body?.html ?? '').trim();
    const instruction = String(body?.instruction ?? '').trim().slice(0, 500);
    if (!html) throw new BadRequestException('html is required');
    if (!instruction) throw new BadRequestException('instruction is required');
    if (html.length > MAX_EDIT_HTML) throw new BadRequestException(tooLongMessage('Фрагмент'));

    // the model from the UI is accepted only from the curated catalog — an
    // arbitrary slug would go straight to the provider
    const wanted = String(body?.model ?? '').trim();
    let model: string | undefined;
    if (wanted) {
      const { models } = await getUnifiedCatalog();
      if (!models.some((m) => m.id === wanted)) throw new BadRequestException('unknown model');
      model = wanted;
    }

    const s = await resolveSettings(await this.brandCtx.brandId(req));
    const llm = new LLM(s);
    // mock mode (no LLM key): honestly return the fragment unchanged
    if (llm.isMock) return { html, mock: true, usage: null };

    const title = String(body?.title ?? '').trim();
    const history = (Array.isArray(body?.history) ? body.history : [])
      .map((h) => String(h ?? '').trim().slice(0, 300))
      .filter(Boolean)
      .slice(-4);
    const asMarkdown = body?.format === 'markdown';
    const prompt
      = (asMarkdown
        ? 'Ниже фрагмент текста (markdown) и указание автора, что с ним сделать.\n'
          + 'Перепиши фрагмент согласно указанию, сохраняя markdown-разметку того же вида '
          + '(заголовки #, списки -, **жирный**), не добавляй ничего сверх указания. '
          + 'Если указание требует удалить фрагмент целиком — верни пустую строку. '
          + 'Верни ТОЛЬКО итоговый текст без пояснений и без ```-ограждений.\n\n'
        : 'Ниже HTML-фрагмент статьи и указание автора, что с ним сделать.\n'
          + 'Перепиши фрагмент согласно указанию. Сохраняй корректный HTML того же вида '
          + '(те же теги: p, h2, h3, ul, ol, li, strong, a, blockquote), не оборачивай в новые контейнеры '
          + 'и не добавляй ничего сверх указания. '
          + 'Если указание требует удалить фрагмент целиком — верни пустую строку. '
          + 'Верни ТОЛЬКО итоговый HTML без пояснений и без ```-ограждений.\n\n')
      + (history.length ? `РАНЕЕ В ЭТОМ ДИАЛОГЕ: ${history.join(' → ')}\n` : '')
      + `УКАЗАНИЕ: ${instruction}\n`
      + (title ? `СТАТЬЯ: «${title}»\n` : '')
      + `\nФРАГМЕНТ:\n${html}`;
    const system
      = `Ты редактор блога ${s.brand}. Точно выполняешь правки фрагментов статьи, `
      + `не меняя остального смысла. Язык: ${s.language}.`;
    const r = await llm.completeEx(prompt, {
      system,
      strong: true,
      model,
      maxTokens: editMaxTokens(html),
      temperature: 0.4,
    });
    const raw = normalizeDashes(
      r.text.trim().replace(/^```(?:html|markdown|md)?\s*/i, '').replace(/```\s*$/, ''),
    );
    // the editor inserts the model's response into the article and renders it via
    // v-html — we sanitize here, not only on save: before saving it's already
    // seen in the author's browser. In markdown mode this is plain text (agent
    // profile), no HTML is rendered there.
    const out = asMarkdown ? raw : sanitizeArticleHtml(raw);
    return {
      html: out,
      mock: false,
      usage: { model: r.model, tokensIn: r.tokensIn, tokensOut: r.tokensOut, costRub: r.costRub },
    };
  }
}
