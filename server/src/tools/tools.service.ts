import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { LlmService, TARGET_MARKET } from './llm.service';

// Ports of the scraper's core/prompts.py and core/research.py: same context
// block, same kind instructions, results cached on the products row so each
// project pays for the LLM once.

const KINDS = ['mvp', 'landing', 'validation'] as const;

const KIND_INSTRUCTIONS: Record<string, string> = {
  mvp:
    'Сгенерируй ПРОМПТ для AI-сборщика кода (Claude Code / Cursor / ' +
    'Lovable), который построит MVP клона. В промпте: краткое описание ' +
    'продукта, целевой пользователь, 3-5 ключевых экранов, основная ' +
    'фича-петля, предлагаемый стек, и ЧЁТКОЕ УТП-отличие от конкурентов ' +
    '(из поля «щель»). Промпт должен быть готов к вставке, на русском, ' +
    "адресован ИИ-разработчику ('Построй...').",
  landing:
    'Сгенерируй ПРОМПТ для AI-сборщика лендинга: заголовок (hero), ' +
    'подзаголовок, 3 буллета ценности, секция «чем мы лучше» против ' +
    'названных конкурентов, призыв к действию. Дай готовый текст-копирайт ' +
    'под целевой рынок, плюс инструкцию ИИ собрать одностраничник.',
  validation:
    'Сгенерируй ПЛАН ВАЛИДАЦИИ за 7 дней (без написания продукта): где ' +
    'искать первых пользователей на целевом рынке, какие 3 вопроса задать, ' +
    'какой смоук-тест/предзаказ поставить, и какой численный сигнал ' +
    'считать подтверждением спроса. Конкретно и по дням.',
};

// `:online` makes OpenRouter run a live web search for the model. Grok 4.3 is
// the default reasoning model (smart + fresh + cheap output); flash + gpt-4o-mini
// are the fallbacks on rate-limit/outage.
const ONLINE_MODELS = [
  'x-ai/grok-4.3:online',
  'google/gemini-3-flash-preview:online',
  'openai/gpt-4o-mini:online',
];

// User-selectable models for blog drafts. Override via env BLOG_MODELS as
// "id|Label,id2|Label2". A chosen model is tried first, then falls back through
// ONLINE_MODELS so generation still completes if the pick is rate-limited/bad.
const BLOG_MODELS: { id: string; label: string }[] = (
  process.env.BLOG_MODELS ??
  'x-ai/grok-4.3:online|Grok 4.3 (web),' +
    'google/gemini-3-flash-preview:online|Gemini 3 Flash (web),' +
    'openai/gpt-4o-mini:online|GPT-4o mini (web),' +
    'openai/gpt-4o:online|GPT-4o (web),' +
    'anthropic/claude-3.7-sonnet:online|Claude 3.7 Sonnet (web),' +
    'google/gemini-2.5-pro:online|Gemini 2.5 Pro (web),' +
    'deepseek/deepseek-chat:online|DeepSeek (web)'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const [id, label] = s.split('|');
    return { id: (id || '').trim(), label: (label || id || '').trim() };
  })
  .filter((m) => m.id);

const BLOG_MODEL_IDS = new Set(BLOG_MODELS.map((m) => m.id));

const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function ctxBlock(p: any): string {
  const desc = p.fullDescription || p.tagline || p.description || 'н/д';
  const comps = list(p.localCompetitors);
  return (
    `Целевой рынок: ${TARGET_MARKET}\n` +
    `Продукт: ${p.name}\n` +
    `Категория: ${p.category || 'н/д'}\n` +
    `Стратегия (play_type): ${p.playType || 'н/д'} ` +
    '(local = клон-локализация; global = мировой билд)\n' +
    `Описание: ${desc}\n` +
    `Щель/отличие (gap): ${p.gap || 'н/д'}\n` +
    `Локальные конкуренты: ${comps.length ? comps.join(', ') : 'не выявлены'}\n` +
    `Монетизация: ${p.monetization || 'н/д'}\n` +
    `Усилия на клон: ${p.buildEffort || 'н/д'}\n`
  );
}

@Injectable()
export class ToolsService {
  constructor(
    private prisma: PrismaService,
    private llm: LlmService,
  ) {}

  private async project(id: number) {
    const p = await this.prisma.product.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('project not found');
    return p;
  }

  async buildPrompt(projectId: number, kindRaw: string) {
    const kind = (KINDS as readonly string[]).includes(kindRaw) ? kindRaw : 'mvp';
    const p = await this.project(projectId);
    if (p.buildPrompt && p.buildPromptKind === kind)
      return { text: p.buildPrompt, kind, cached: true };

    const prompt =
      'Ты помогаешь предпринимателю быстро запустить продукт.\n\n' +
      `${ctxBlock(p)}\n${KIND_INSTRUCTIONS[kind]}\n\n` +
      'Если стратегия local — учитывай русский интерфейс, локальные ' +
      'платежи (СБП в РФ, Kaspi в Казахстане) и отстройку от названных ' +
      'конкурентов. Если global — пиши под мировой рынок (английский, ' +
      'глобальная дистрибуция).\n' +
      'Верни ТОЛЬКО готовый текст (markdown), без преамбул вроде «вот ваш промпт».';
    const text = (await this.llm.complete(prompt, { maxTokens: 1100 })).trim();

    await this.prisma.product.update({
      where: { id: projectId },
      data: {
        buildPrompt: text,
        buildPromptKind: kind,
        buildPromptAt: new Date().toISOString(),
      },
    });
    return { text, kind, cached: false };
  }

  async research(projectId: number) {
    const p = await this.project(projectId);
    if (p.researchNote) return { note: p.researchNote, cached: true };

    const desc = p.fullDescription || p.tagline || p.description || 'н/д';
    const prompt =
      'Проведи РЕАЛЬНУЮ проверку по интернету (используй веб-поиск). ' +
      `Целевой рынок: ${TARGET_MARKET}.\n\n` +
      `Продукт: ${p.name}\nКатегория: ${p.category || 'н/д'}\n` +
      `Сайт: ${p.websiteUrl || p.sourceUrl || 'н/д'}\nЧто делает: ${desc}\n\n` +
      'Найди КОНКРЕТНЫХ существующих конкурентов/аналогов на этом рынке ' +
      '(реальные названия и сайты, не выдумывай). Для каждого: чем ' +
      'занимается, примерные цены, насколько силён. Затем дай вывод: ' +
      'рынок свободен / есть щель / занят сильными игроками. Если ' +
      'западный аналог ушёл с рынка после 2022 — отметь это как окно.\n\n' +
      'Ответь кратким markdown: список конкурентов (с ссылками, если ' +
      'есть) + абзац «Вывод». На русском. Если ничего не нашёл — честно ' +
      'напиши, что прямых аналогов не обнаружено.';
    const note = (
      await this.llm.complete(prompt, { maxTokens: 900, models: ONLINE_MODELS })
    ).trim();

    await this.prisma.product.update({
      where: { id: projectId },
      data: { researchNote: note, researchAt: new Date().toISOString() },
    });
    return { note, cached: false };
  }

  async analyzeUrl(url: string): Promise<string> {
    const prompt =
      'Ты — аналитик стартапов для рынка СНГ. Зайди на сайт и проведи ' +
      `полный разбор продукта. URL: ${url}\n\n` +
      `Целевой рынок оценки: ${TARGET_MARKET}.\n\n` +
      'Верни ТОЛЬКО валидный JSON (без markdown-обёрток, без пояснений), строго такую структуру:\n' +
      '{\n' +
      '  "name": "название продукта",\n' +
      '  "tagline": "одна строка — что делает продукт",\n' +
      '  "category": "категория (AI/SaaS/Marketplace/Fintech/EdTech/Health/...)",\n' +
      '  "deepScore": 3,\n' +
      '  "deepVerdictLabel": "GO|INVESTIGATE|PASS",\n' +
      '  "localCompetition": "none|few|crowded",\n' +
      '  "buildEffort": "weekend|weeks|serious",\n' +
      '  "dimMarket": "2-3 абзаца: объём рынка СНГ, тренды, спрос",\n' +
      '  "dimWhyNow": "1-2 абзаца: почему именно сейчас",\n' +
      '  "dimRisks": "2-3 абзаца: ключевые риски для СНГ",\n' +
      '  "dimCisFeasibility": "2-3 абзаца: реалистичность запуска в СНГ",\n' +
      '  "dimEffort": "1-2 абзаца: сложность разработки и запуска",\n' +
      '  "deepVerdict": "3-5 абзацев: итоговый вердикт для СНГ, конкретные рекомендации",\n' +
      '  "marketAnalysis": "1-2 абзаца: анализ рынка СНГ, есть ли ниша",\n' +
      '  "gap": "1 предложение: свободная ниша или уникальное преимущество",\n' +
      '  "whyFail": "1-2 предложения: основной риск провала",\n' +
      '  "whyNow": "1-2 предложения: почему сейчас хороший момент",\n' +
      '  "competitorData": "[{\\"name\\":\\"..\\",\\"url\\":\\"..\\",\\"strength\\":\\"entrenched|mixed|weak\\",\\"price_points\\":[\\"..\\"],\\"pricing_model\\":\\"..\\",\\"traffic_monthly\\":0}]",\n' +
      '  "marketCeiling": "{\\"mrr_min\\":100000,\\"mrr_max\\":500000,\\"basis\\":\\"оценка\\"}",\n' +
      '  "unitEconomics": "{\\"cac_min\\":500,\\"cac_max\\":2000,\\"ltv_min\\":3000,\\"ltv_max\\":15000,\\"ltv_cac\\":5,\\"payback_months\\":3,\\"breakeven_customers\\":50}",\n' +
      '  "stopFactors": "{\\"stop_factors\\":[],\\"risk_flags\\":[]}",\n' +
      '  "financeNote": "краткая финансовая модель",\n' +
      '  "websiteUrl": "' + url + '"\n' +
      '}\n\n' +
      'deepScore: 1=очень плохо, 2=плохо, 3=нейтрально, 4=хорошо, 5=отлично для СНГ.\n' +
      'GO=4-5, INVESTIGATE=3, PASS=1-2.\n' +
      'Все строковые поля на русском языке. competitorData, marketCeiling, unitEconomics, stopFactors — строки с валидным JSON внутри.';

    const raw = await this.llm.complete(prompt, {
      maxTokens: 2000,
      models: ONLINE_MODELS,
    });

    // Strip possible markdown fences
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    // Validate it's parseable JSON
    JSON.parse(cleaned);
    return cleaned;
  }

  // AI draft of a blog post: returns finished markdown for content/blog/<slug>.md
  async aiDraftPost(topic: string, slug?: string, projectId?: number, model?: string) {
    const date = new Date().toISOString().slice(0, 10);
    const settings = await this.prisma.blogSettings
      .findUnique({ where: { id: 1 } })
      .catch(() => null);

    // optional: read the backend (a teardown / analysis) as factual source —
    // pull the metric-dense deep-analysis (finance model, demand, competitors,
    // verdict, risks) so the draft is a numbers-driven analysis, not an overview.
    let context = '';
    let titleHint = topic;
    let grounded = false;
    if (projectId) {
      const p: any = await this.prisma.product
        .findUnique({ where: { id: Number(projectId) } })
        .catch(() => null);
      if (p) {
        grounded = true;
        if (!titleHint) titleHint = p.name;
        const t = (s: any, n = 800) => (s ? String(s).slice(0, n) : '');
        const j = (v: any, n = 1000) => {
          if (v == null) return '';
          try {
            return JSON.stringify(v).slice(0, n);
          } catch {
            return '';
          }
        };
        const lines = [
          `Проект: ${p.name}${p.domain || p.websiteUrl ? ` (${p.domain || p.websiteUrl})` : ''}`,
          p.category && `Категория: ${p.category}`,
          (p.tagline || p.summary) && `Суть: ${t(p.tagline || p.summary, 300)}`,
          // verdict / score
          p.deepScore != null && `Deep-score: ${p.deepScore}/5 — вердикт «${p.deepVerdictLabel || ''}»`,
          p.opportunityScore != null && `Оценка возможности: ${p.opportunityScore}/5`,
          p.deepVerdict && `Вердикт аналитика: ${t(p.deepVerdict, 1100)}`,
          p.deepScoreBreakdown && `Разбивка deep-score: ${j(p.deepScoreBreakdown, 300)}`,
          // FINANCE — key figures
          p.revenueEstimate && `Оценка выручки (MRR/выручка, реальные источники): ${j(p.revenueEstimate, 1200)}`,
          p.unitEconomics && `Юнит-экономика (CAC/LTV/окупаемость/проекция): ${j(p.unitEconomics, 1200)}`,
          p.marketCeiling && `Потолок рынка (TAM/модель монетизации): ${j(p.marketCeiling, 1000)}`,
          p.marketConcentration && `Концентрация рынка: ${j(p.marketConcentration, 500)}`,
          (p.financeNote || p.financeConfidence) &&
            `Финансовый комментарий: ${t(p.financeNote, 600)} (уверенность: ${p.financeConfidence || '—'})`,
          // DEMAND
          (p.searchVolume != null || p.trendDirection || p.serpResultsYandex != null) &&
            `Спрос: search_volume=${p.searchVolume ?? '—'}, тренд=${p.trendDirection || '—'} (slope ${p.trendSlope ?? '—'}), ` +
              `SERP Яндекс=${p.serpResultsYandex ?? '—'} / Google=${p.serpResultsGoogle ?? '—'}, занятость SERP=${p.serpOccupancy || '—'}`,
          p.demandGeo && `Гео спроса: ${j(p.demandGeo, 400)}`,
          p.demandNote && `Заметка по спросу: ${t(p.demandNote, 300)}`,
          // COMPETITION
          (p.competitorTrafficMax != null || p.tractionStrength) &&
            `Конкуренция: макс. трафик конкурента=${p.competitorTrafficMax ?? '—'}/мес, сила трекшна=${p.tractionStrength || '—'}`,
          p.competitorData && `Конкуренты (структурно): ${j(p.competitorData, 1200)}`,
          p.competitorsNote && `Заметка по конкурентам: ${t(p.competitorsNote, 400)}`,
          p.badReviews && `Частые жалобы на конкурентов: ${j(p.badReviews, 400)}`,
          p.socialSignals && `Социальные сигналы (HN/обсуждения): ${j(p.socialSignals, 500)}`,
          // RISKS
          p.stopFactors && `Стоп-факторы / риски: ${j(p.stopFactors, 800)}`,
          p.dimRisks && `Риски (разбор): ${t(p.dimRisks, 500)}`,
          // DIMENSIONS
          p.dimMarket && `Рынок: ${t(p.dimMarket, 600)}`,
          (p.dimWhyNow || p.whyNow) && `Почему сейчас: ${t(p.dimWhyNow || p.whyNow, 400)}`,
          p.dimCisFeasibility && `Реализуемость в СНГ: ${t(p.dimCisFeasibility, 400)}`,
          p.dimEffort && `Сложность реализации: ${t(p.dimEffort, 400)}`,
          p.localCompetition && `Конкуренция РФ/СНГ (метка): ${p.localCompetition}`,
          p.marketAnalysis && `Анализ рынка: ${t(p.marketAnalysis, 700)}`,
          // raw SEO granularity (real pages/clicks), if present
          p.raw?.seo?.pages && `SEO-страницы (url/клики/ключи): ${j(p.raw.seo.pages, 600)}`,
        ].filter(Boolean);
        context = `\n\nФАКТУРА РАЗБОРА «${p.name}» — РЕАЛЬНЫЕ ДАННЫЕ. Опирайся ТОЛЬКО на них, числа не выдумывай:\n${lines.join('\n')}\n`;
      }
    }

    const fileSlug =
      (slug || titleHint || topic)
        .toLowerCase()
        .replace(/[^a-z0-9а-я\s-]/gi, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 60) || `post-${date}`;

    // editor-configured "how to write" prompt (source), else a sensible default
    const guide =
      settings?.aiPrompt?.trim() ||
      'Ты — редактор аналитического блога Ideata (конкурентная разведка и разбор ниш по домену). ' +
        'Пишешь для фаундеров, инвесторов и аналитиков на русском: по делу, с выводами, без воды.';

    // when grounded on a teardown, force a vc.ru-style, numbers-driven analysis
    // instead of an encyclopedic "what is X" overview
    const analyticalSpec = grounded
      ? '\n\nЭТО АНАЛИТИЧЕСКАЯ СТАТЬЯ В СТИЛЕ vc.ru НА ОСНОВЕ КОНКРЕТНОГО РАЗБОРА. ЖЁСТКИЕ ТРЕБОВАНИЯ:\n' +
        '- НЕ пиши энциклопедическую справку «что такое <проект> и чем занимается». Это финансово-аналитический разбор бизнеса.\n' +
        '- Опирайся на ЦИФРЫ из фактуры и вставляй их прямо в текст: выручка/MRR, юнит-экономика (CAC, LTV, LTV/CAC, окупаемость), потолок рынка (TAM), трафик конкурентов, спрос/SERP, deep-score. Без конкретных чисел абзац не нужен.\n' +
        '- Структура: 1) цепляющий тезис с главной цифрой; 2) сколько зарабатывает и каков потолок рынка; 3) как устроена экономика (CAC/LTV/окупаемость, со ссылкой на проекцию); 4) спрос и конкуренция в цифрах; 5) почему сейчас и стоит ли заходить — вердикт аналитика; 6) риски и стоп-факторы.\n' +
        '- Тон делового медиа: аналитик, а не маркетолог. 700–1100 слов. Можно таблицы/списки с метриками.\n' +
        '- Каждый крупный тезис подкрепляй числом из фактуры. Чего в фактуре нет — НЕ выдумывай, опусти.\n'
      : '\n\nНапиши экспертную статью по делу, без воды, 500–800 слов.';

    const prompt =
      guide +
      analyticalSpec +
      `\n\nТема/угол статьи: «${titleHint || topic}».` +
      context +
      '\n\nФОРМАТ ВЫВОДА (обязательно соблюдай):\n' +
      '- Верни ТОЛЬКО содержимое markdown-файла, без обёрток в тройные кавычки.\n' +
      '- Сначала YAML-frontmatter между --- с полями: title, description (одно предложение ' +
      `до 160 символов), date: ${date}, tags (2-4 штуки в виде [a, b]).\n` +
      '- Затем тело: подзаголовки уровня ##, списки/таблицы где уместно.\n' +
      '- Не используй слово «щель» (заменяй на «ниша» / «незакрытый спрос»).\n' +
      '- В конце — абзац-CTA со ссылкой [Разобрать домен →](/).';

    // chosen model (arg → saved default) goes first; ONLINE_MODELS stay as
    // fallbacks so a rate-limited/invalid pick still produces a draft
    const picked =
      model && BLOG_MODEL_IDS.has(model)
        ? model
        : settings?.aiModel && BLOG_MODEL_IDS.has(settings.aiModel)
          ? settings.aiModel
          : '';
    const models = picked
      ? [picked, ...ONLINE_MODELS.filter((m) => m !== picked)]
      : ONLINE_MODELS;

    const raw = await this.llm.complete(prompt, {
      maxTokens: 3200,
      models,
      apiKey: settings?.aiApiKey || undefined,
    });
    const markdown = raw
      .replace(/^```(?:markdown|md)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    return { markdown, slug: fileSlug, filename: `content/blog/${fileSlug}.md` };
  }

  // selectable models for blog drafts + current default (saved or first)
  async aiModels() {
    const s = await this.prisma.blogSettings.findUnique({ where: { id: 1 } }).catch(() => null);
    const def = s?.aiModel && BLOG_MODEL_IDS.has(s.aiModel) ? s.aiModel : BLOG_MODELS[0]?.id || '';
    return { models: BLOG_MODELS, default: def };
  }

  // blog AI settings (key + prompt template + default model) — single row
  async getBlogSettings() {
    const s = await this.prisma.blogSettings.findUnique({ where: { id: 1 } }).catch(() => null);
    return {
      aiPrompt: s?.aiPrompt || '',
      aiApiKey: s?.aiApiKey || '',
      aiModel: (s?.aiModel && BLOG_MODEL_IDS.has(s.aiModel) ? s.aiModel : BLOG_MODELS[0]?.id) || '',
    };
  }
  async setBlogSettings(aiPrompt: string, aiApiKey?: string, aiModel?: string) {
    const data: any = { aiPrompt: aiPrompt ?? '' };
    if (aiApiKey !== undefined && aiApiKey !== null) data.aiApiKey = aiApiKey || null;
    if (aiModel !== undefined && aiModel !== null) data.aiModel = aiModel || null;
    await this.prisma.blogSettings.upsert({
      where: { id: 1 },
      update: data,
      create: {
        id: 1,
        aiPrompt: aiPrompt ?? '',
        aiApiKey: aiApiKey || null,
        aiModel: aiModel || null,
      },
    });
    return this.getBlogSettings();
  }
}
