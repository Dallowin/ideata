/**
 * "Blog voice" from the brand's WEBSITE: crawl the domain's pages, collect the
 * text, and have the LLM compose a voice (brand/tone/persona/requirements/categories)
 * instead of manual presets. Tied to the active brand's domain.
 */
import * as cheerio from 'cheerio'
import { LLM } from './llm'
import { resolveSettings, type AppSettings } from './appSettings'
import { allSettings, saveSettings } from './store'
import { blogPrisma } from './prisma'
import { fetchArticle, htmlToText } from './search'
import { safeFetchHtml } from './safeFetch'
import { pl } from './lang'

// pages that best describe the brand (about / product / services / pricing…)
const KEY_HINTS = [
  'about', 'about-us', 'o-nas', 'о-нас', 'company', 'kompani', 'team', 'product', 'products',
  'feature', 'features', 'solution', 'solutions', 'pricing', 'price', 'tarif', 'тариф', 'цен',
  'service', 'services', 'услуг', 'how-it-works', 'how', 'faq', 'use-case', 'cases', 'case',
  'platform', 'possib', 'возможности', 'для-бизнеса', 'business', 'docs', 'start', 'why',
]

function baseUrl(domain: string): string {
  const d = String(domain || '').trim().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
  return 'https://' + d
}

/**
 * The user sets the brand domain (onboarding/settings), so the crawl goes
 * through safeFetch: a public-host check on every redirect hop, a body-size
 * limit, HTML only. Without it a "brand domain" of 192.168.0.5 would turn the
 * crawl into an internal-network scanner, with the result ending up in the LLM
 * and the settings form.
 */
async function fetchHtml(url: string, timeoutMs: number): Promise<string> {
  return safeFetchHtml(url, { timeoutMs })
}

function internalLinks(html: string, base: string): string[] {
  let host: string
  try { host = new URL(base).host.replace(/^www\./, '') } catch { return [] }
  const $ = cheerio.load(html)
  const set = new Set<string>()
  $('a[href]').each((_, a) => {
    const href = $(a).attr('href') || ''
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:')) return
    try {
      const u = new URL(href, base)
      if (u.host.replace(/^www\./, '') !== host) return
      if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|mp4|css|js|ico|xml|json)$/i.test(u.pathname)) return
      set.add(u.origin + u.pathname.replace(/\/+$/, ''))
    } catch { /* skip malformed */ }
  })
  return [...set]
}

function rankPage(url: string): number {
  const p = url.toLowerCase()
  let s = 0
  for (const h of KEY_HINTS) if (p.includes(h)) s += 2
  try { s -= (new URL(url).pathname.split('/').filter(Boolean).length) * 0.4 } catch { /* ignore */ }
  return s
}

export interface CrawlResult { text: string; pages: string[]; base: string }

/** Crawl the brand domain: homepage + up to maxPages key pages → concatenated text. */
export async function crawlBrand(domain: string, opts: { maxPages?: number; timeoutMs?: number } = {}): Promise<CrawlResult> {
  const maxPages = Math.min(Math.max(opts.maxPages ?? 10, 1), 15)
  const timeoutMs = opts.timeoutMs ?? 12_000
  const base = baseUrl(domain)

  const homeHtml = await fetchHtml(base, timeoutMs)
  const homeText = homeHtml ? htmlToText(homeHtml) : ''

  const candidates = internalLinks(homeHtml, base).filter(u => u !== base && u !== base + '/')
  const chosen = candidates.sort((a, b) => rankPage(b) - rankPage(a)).slice(0, maxPages - 1)
  const pages = [base, ...chosen]

  // each page also goes through safeFetch (inside fetchArticle → download):
  // the links come from someone else's markup, and it's only "internal" by hostname
  const texts = await Promise.all(pages.map(async (u, i) => {
    if (i === 0) return homeText
    try { return await fetchArticle(u, timeoutMs) } catch { return '' }
  }))

  const blocks: string[] = []
  const okPages: string[] = []
  pages.forEach((u, i) => {
    const t = (texts[i] || '').trim()
    if (t.length < 60) return
    okPages.push(u)
    blocks.push(`## ${u}\n${t.slice(0, 2500)}`)
  })
  return { text: blocks.join('\n\n').slice(0, 16_000), pages: okPages, base }
}

export interface BrandVoice {
  brand: string
  description: string
  language: string
  tone: string
  persona: string
  requirements: string
  categories: string
}

/** The LLM composes the blog voice from the collected site text. */
export async function composeVoice(domain: string, crawl: CrawlResult, llm: LLM, s: AppSettings): Promise<BrandVoice> {
  const promptRu
    = `Ниже текст со страниц сайта ${crawl.base} (бренд «${s.brand || domain}»). Внимательно `
    + 'проанализируй бренд: что за продукт/сервис, для кого, позиционирование, ключевые темы, '
    + 'тон общения. На основе ИМЕННО ЭТОГО составь «голос блога» для AEO-статей под этот бренд.\n\n'
    + 'Верни СТРОГО JSON:\n'
    + '{\n'
    + '  "brand": "короткое название бренда",\n'
    + '  "description": "1-2 предложения: что это за бренд и что он делает",\n'
    + '  "language": "язык статей одним словом (русский|английский|…)",\n'
    + '  "tone": "тон блога — как писать (1-2 предложения, конкретно под этот бренд)",\n'
    + '  "persona": "ПОДРОБНЫЙ структурированный system-промпт агента-редактора под ЭТОТ бренд. '
    + 'Формат — markdown-документ с разделами через заголовки (каждый # с новой строки, внутри — абзацы и списки):\\n'
    + '# Роль — кто агент, чем владеет end-to-end (исследование, нарратив, заголовки, читательский опыт, аналитика);\\n'
    + '# Контекст — для кого пишет, форматы (лонгриды 1500-4000 слов), ограничения и критерий успеха под ЭТОТ бренд и его аудиторию;\\n'
    + '# Обязанности — маркированный список задач (ресёрч, драфт, заголовки, структура, AEO-подача);\\n'
    + '# Принципы — как пишет: от вопроса читателя, аутлайн-первым, короткие абзацы, каждый факт с источником, переходы, SEO как ограничение;\\n'
    + '# Рабочий процесс — нумерованные шаги Intake→Research→Outline→Draft→Polish→Self-check;\\n'
    + '# Планка качества — критерии готовности материала.\\n'
    + 'Всё КОНКРЕТНО под продукт/аудиторию этого бренда и с упором на попадание в AI-выдачу (цитируемый ответ, определения, списки, сущности). НЕ вставляй разделы про тон, факты, рубрики — они отдельные поля.",\n'
    + '  "requirements": "жёсткие требования к каждой статье (обязательные ссылки, фактчекинг, дисклеймеры/гардрейлы), или пустая строка",\n'
    + '  "categories": "5-8 рубрик блога через запятую, релевантных бренду"\n'
    + '}\n\n'
    + `ТЕКСТ САЙТА:\n${crawl.text}`
  const promptEn
    = `Below is the text from the pages of the site ${crawl.base} (brand "${s.brand || domain}"). Carefully `
    + 'analyze the brand: what product/service it is, who it is for, positioning, key topics, '
    + "tone of voice. Based on EXACTLY THIS, compose a \"blog voice\" for AEO articles for this brand.\n\n"
    + 'Return STRICTLY JSON:\n'
    + '{\n'
    + '  "brand": "short brand name",\n'
    + '  "description": "1-2 sentences: what this brand is and what it does",\n'
    + '  "language": "the articles\' language in one word (russian|english|…)",\n'
    + '  "tone": "blog tone — how to write (1-2 sentences, specific to this brand)",\n'
    + '  "persona": "A DETAILED structured system prompt for the editor-agent for THIS brand. '
    + 'Format — a markdown document with sections under headings (each # on a new line, with paragraphs and lists inside):\\n'
    + '# Role — who the agent is, what it owns end-to-end (research, narrative, headlines, reader experience, analytics);\\n'
    + '# Context — who it writes for, formats (long-reads 1500-4000 words), constraints and the success criterion for THIS brand and its audience;\\n'
    + '# Responsibilities — a bulleted list of tasks (research, draft, headlines, structure, AEO framing);\\n'
    + '# Principles — how it writes: starting from the reader\'s question, outline-first, short paragraphs, every fact with a source, transitions, SEO as a constraint;\\n'
    + '# Workflow — numbered steps Intake→Research→Outline→Draft→Polish→Self-check;\\n'
    + '# Quality bar — criteria for the material being ready.\\n'
    + 'Everything SPECIFIC to this brand\'s product/audience and focused on landing in AI answers (a citable answer, definitions, lists, entities). Do NOT insert sections about tone, facts, categories — those are separate fields.",\n'
    + '  "requirements": "hard requirements for every article (mandatory links, fact-checking, disclaimers/guardrails), or an empty string",\n'
    + '  "categories": "5-8 blog categories, comma-separated, relevant to the brand"\n'
    + '}\n\n'
    + `SITE TEXT:\n${crawl.text}`
  const prompt = pl(s.language, promptRu, promptEn)
  const systemRu
    = 'Ты — бренд-аналитик и контент-стратег. По материалам сайта точно определяешь суть '
    + 'бренда и составляешь БОГАТЫЙ структурированный голос блога (persona — как большой system-промпт '
    + 'агента с разделами Роль/Контекст/Обязанности/Принципы/Рабочий процесс/Планка качества). '
    + 'Пишешь на языке сайта. Возвращаешь только валидный JSON.'
  const systemEn
    = 'You are a brand analyst and content strategist. From the site\'s materials you precisely identify '
    + 'the brand\'s essence and compose a RICH structured blog voice (persona — like a large agent system prompt '
    + 'with Role/Context/Responsibilities/Principles/Workflow/Quality bar sections). '
    + 'You write in the site\'s language. You return only valid JSON.'
  const system = pl(s.language, systemRu, systemEn)
  const data: any = await llm.json(prompt, { system, strong: true, maxTokens: 4096 })
  return {
    brand: String(data?.brand ?? s.brand ?? '').trim(),
    description: String(data?.description ?? '').trim(),
    language: String(data?.language ?? s.language ?? '').trim(),
    tone: String(data?.tone ?? '').trim(),
    persona: String(data?.persona ?? '').trim(),
    requirements: String(data?.requirements ?? '').trim(),
    categories: String(data?.categories ?? '').trim(),
  }
}

/**
 * Fallback "crawl" for when the brand's site can't be parsed (bot protection /
 * JS rendering / down): hand the LLM the brand data from onboarding and ask it
 * to use its OWN knowledge of the brand/domain. Name+domain are always present,
 * so a voice gets composed either way — better a knowledge-specific one than an
 * eternal neutral default.
 */
export function brandKnowledgeCrawl(brand: {
  domain: string
  name?: string | null
  description?: string | null
  topics?: unknown
  geo?: string | null
}, lang: string = 'ru'): CrawlResult {
  const topics = Array.isArray(brand.topics) ? (brand.topics as unknown[]).join(', ') : ''
  const lines = [
    pl(lang, `Бренд: ${brand.name || brand.domain} (домен ${brand.domain})`, `Brand: ${brand.name || brand.domain} (domain ${brand.domain})`),
    brand.description
      ? pl(lang, `Описание из онбординга: ${brand.description}`, `Description from onboarding: ${brand.description}`)
      : '',
    topics ? pl(lang, `Темы блога: ${topics}`, `Blog topics: ${topics}`) : '',
    brand.geo ? pl(lang, `Регион: ${brand.geo}`, `Region: ${brand.geo}`) : '',
    pl(
      lang,
      'Сайт бренда недоступен для краула. Составь голос по данным выше и своим знаниям '
        + 'об этом бренде/домене (если он тебе известен); факты, которых не знаешь, не выдумывай.',
      'The brand\'s site is unreachable for crawling. Compose the voice from the data above and your own '
        + 'knowledge of this brand/domain (if you know it); don\'t make up facts you don\'t know.',
    ),
  ].filter(Boolean)
  return {
    text: `## ${brand.domain} (${pl(lang, 'сайт не спарсился — данные бренда', 'site did not parse — brand data')})\n${lines.join('\n')}`,
    pages: [],
    base: baseUrl(brand.domain),
  }
}

// --- Default voice: each brand gets its OWN ---------------------------------- //

const inflight = new Map<number, Promise<boolean>>()
const lastAttempt = new Map<number, number>()
const RETRY_MS = 30 * 60_000 // don't retry a failed attempt (site down, etc.) more often than this

/** Does the brand already have its own saved voice (per-brand tone+persona)? */
export async function hasBrandVoice(brandId: number): Promise<boolean> {
  if (!brandId) return false
  const own = await allSettings(brandId)
  return !!(own.persona && own.tone)
}

/**
 * Guarantee the brand its OWN voice: if a per-brand voice isn't saved yet, crawl
 * the brand's site and compose a voice with the LLM (the same path as the manual
 * "voice/analyze", just by default). Never throws; false means composing failed
 * (no domain / no LLM key / empty site), in which case the pipeline runs on
 * neutral defaults. onCompose fires only when generation actually starts (for
 * progress reporting).
 */
export async function ensureBrandVoice(brandId: number, onCompose?: () => void): Promise<boolean> {
  try {
    if (!brandId) return false
    if (await hasBrandVoice(brandId)) return true
    const running = inflight.get(brandId)
    if (running) {
      onCompose?.() // generation is already running (started by another call) — the message is honest
      return running
    }
    if (Date.now() - (lastAttempt.get(brandId) ?? 0) < RETRY_MS) return false
    const job = composeAndSave(brandId, onCompose)
      .catch(() => false)
      .finally(() => inflight.delete(brandId))
    inflight.set(brandId, job)
    return await job
  } catch {
    return false // the "never throws" contract — including pre-checks (DB down, etc.)
  }
}

async function composeAndSave(brandId: number, onCompose?: () => void): Promise<boolean> {
  const brand = await blogPrisma().brand.findUnique({ where: { id: brandId } })
  if (!brand?.domain) return false
  const s = await resolveSettings(brandId)
  const llm = new LLM(s)
  if (llm.isMock) return false // no LLM key — stay on neutral defaults
  // stamp the throttle AFTER the free pre-checks: "no domain/key" shouldn't burn
  // the 30-minute window — as soon as an admin sets a key, compose runs right away
  lastAttempt.set(brandId, Date.now())
  onCompose?.()

  let crawl = await crawlBrand(brand.domain)
  if (!crawl.text) crawl = brandKnowledgeCrawl(brand, s.language)

  const voice = await composeVoice(brand.domain, crawl, llm, s)
  if (!voice.persona || !voice.tone) return false
  // the user may have saved their OWN voice while the crawl+LLM was running (minutes) — don't overwrite it
  if (await hasBrandVoice(brandId)) return true
  await saveSettings({
    brand: voice.brand,
    tone: voice.tone,
    persona: voice.persona,
    requirements: voice.requirements,
    categories: voice.categories,
    language: voice.language,
  }, brandId)
  return true
}
