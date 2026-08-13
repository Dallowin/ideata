/**
 * Topic ideas from competitors' blogs. Competitors come from Ideata's TOOLS,
 * not from LLM guesswork: Brand.competitors (onboarding) + AeoTracker.competitors
 * (brand AEO monitoring). Their blogs are parsed (RSS → HTML index → sitemap),
 * and the LLM picks the strongest topics and repackages them for our brand
 * (its own angle, not a copy of the title) in TopicIdea format.
 */
import * as cheerio from 'cheerio'
import { aeoScore } from '../../../shared/aeo/scoring'
import type { AppSettings } from '../appSettings'
import { pl } from '../lang'
import { coerceArray, todayLine, type LLM } from '../llm'
import { blogPrisma } from '../prisma'

export interface CompetitorPost {
  url: string
  title: string
  publishedAt?: string
}

export interface CompetitorBlog {
  domain: string
  posts: CompetitorPost[]
  source: 'rss' | 'html' | 'sitemap' | 'none'
}

export interface CompetitorIdea {
  title: string
  angle: string
  intent: string
  keyword: string
  queries: string[]
  category: string
  score: number
  source: { domain: string, url: string, title: string } // whose post inspired this
}

const UA = 'Mozilla/5.0 (compatible; IdeataBlogWriter/1.0)'

// --- Step 1: competitors from tools --------------------------------------------- //

/** Extract a domain from a string/object of any shape ("https://x.com/", {domain}, a name). */
function toDomain(raw: unknown): string {
  let s = ''
  if (typeof raw === 'string') s = raw
  else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>
    s = String(o.domain ?? o.url ?? o.site ?? o.name ?? '')
  }
  s = s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#\s]/)[0]
  // no dot means it's a brand name, not a domain — nothing to fetch
  return s.includes('.') ? s : ''
}

/** Brand competitors: onboarding (Brand.competitors) + AEO trackers. */
export async function getBrandCompetitors(brandId: number): Promise<string[]> {
  const p = blogPrisma()
  const out = new Set<string>()
  try {
    const brand = await p.brand.findUnique({ where: { id: brandId } })
    for (const c of (Array.isArray(brand?.competitors) ? brand.competitors as unknown[] : [])) {
      const d = toDomain(c)
      if (d) out.add(d)
    }
    // trackers: own by brandId + by brand domain (legacy trackers without brandId)
    const trackers = await p.aeoTracker.findMany({
      where: brand?.domain
        ? { OR: [{ brandId }, { domain: brand.domain }] }
        : { brandId },
    })
    for (const t of trackers) {
      for (const c of (Array.isArray(t.competitors) ? t.competitors as unknown[] : [])) {
        const d = toDomain(c)
        if (d) out.add(d)
      }
    }
    // don't count the brand itself as a competitor
    if (brand?.domain) out.delete(toDomain(brand.domain))
  } catch {
    // no tables/rows — return whatever we managed to collect
  }
  return [...out].slice(0, 8)
}

// --- Step 2: parse a competitor's blog -------------------------------------------- //

async function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    })
    return res.ok ? await res.text() : ''
  } catch {
    return ''
  }
}

const FEED_PATHS = ['/feed', '/rss', '/feed.xml', '/rss.xml', '/atom.xml', '/blog/feed', '/blog/rss.xml']
const INDEX_PATHS = ['/blog', '/articles', '/news', '/guides', '/blog/']
const POST_PATH_RE = /\/(blog|article|articles|news|post|posts|guide|guides)\//i

/** RSS/Atom → posts (the cleanest source: title + link + date). */
function parseFeed(xml: string, cap: number): CompetitorPost[] {
  if (!xml.includes('<item') && !xml.includes('<entry')) return []
  const $ = cheerio.load(xml, { xmlMode: true })
  const posts: CompetitorPost[] = []
  $('item, entry').each((_, el) => {
    if (posts.length >= cap) return
    const node = $(el)
    const title = node.find('title').first().text().trim()
    const link = node.find('link').first().attr('href') || node.find('link').first().text().trim()
    const date = node.find('pubDate, published, updated').first().text().trim()
    if (!title || !link || !/^https?:\/\//.test(link)) return
    const d = date ? new Date(date) : null
    posts.push({
      url: link,
      title,
      publishedAt: d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(0, 10) : undefined,
    })
  })
  return posts
}

/** Blog HTML index → links that look like posts (same-host + a meaningful title). */
function parseIndex(html: string, domain: string, cap: number): CompetitorPost[] {
  const $ = cheerio.load(html)
  const seen = new Set<string>()
  const posts: CompetitorPost[] = []
  $('a[href]').each((_, el) => {
    if (posts.length >= cap) return
    const a = $(el)
    let href = a.attr('href') || ''
    if (href.startsWith('/')) href = `https://${domain}${href}`
    let host = ''
    try { host = new URL(href).hostname.replace(/^www\./, '') } catch { return }
    if (host !== domain) return
    const path = href.replace(/^https?:\/\/[^/]+/, '')
    // the link leads to a post, not a category/pagination page
    if (!POST_PATH_RE.test(path) || /\/(tag|category|page|author)\//i.test(path)) return
    if (path.replace(/\/$/, '').split('/').filter(Boolean).length < 2) return
    const title = a.text().replace(/\s+/g, ' ').trim()
    if (title.length < 15 || title.length > 200) return
    const clean = href.split(/[?#]/)[0]
    if (seen.has(clean)) return
    seen.add(clean)
    posts.push({ url: clean, title })
  })
  return posts
}

/** sitemap.xml → post URLs; the title is reconstructed from the slug (fallback). */
async function parseSitemap(domain: string, cap: number): Promise<CompetitorPost[]> {
  const xml = await fetchText(`https://${domain}/sitemap.xml`)
  if (!xml) return []
  const $ = cheerio.load(xml, { xmlMode: true })
  // sitemapindex → take up to 2 nested sitemaps (priority to ones with blog/post in the name)
  let locs = $('url > loc').map((_, el) => $(el).text().trim()).get()
  if (!locs.length) {
    const maps = $('sitemap > loc').map((_, el) => $(el).text().trim()).get()
    const picked = [...maps.filter(m => /blog|post|article/i.test(m)), ...maps].slice(0, 2)
    for (const m of picked) {
      const sub = await fetchText(m)
      if (!sub) continue
      const $$ = cheerio.load(sub, { xmlMode: true })
      locs.push(...$$('url > loc').map((_, el) => $$(el).text().trim()).get())
    }
  }
  const posts: CompetitorPost[] = []
  for (const loc of locs) {
    if (posts.length >= cap) break
    if (!POST_PATH_RE.test(loc)) continue
    const slug = loc.replace(/\/$/, '').split('/').pop() || ''
    const title = decodeURIComponent(slug).replace(/[-_]+/g, ' ').trim()
    if (title.length < 10) continue
    posts.push({ url: loc, title })
  }
  return posts
}

/** Fetch a competitor's blog: RSS → HTML index → sitemap. */
export async function discoverBlog(domain: string, cap = 20): Promise<CompetitorBlog> {
  for (const path of FEED_PATHS) {
    const posts = parseFeed(await fetchText(`https://${domain}${path}`), cap)
    if (posts.length >= 3) return { domain, posts, source: 'rss' }
  }
  for (const path of INDEX_PATHS) {
    const html = await fetchText(`https://${domain}${path}`)
    if (!html) continue
    const posts = parseIndex(html, domain, cap)
    if (posts.length >= 3) return { domain, posts, source: 'html' }
  }
  const posts = await parseSitemap(domain, cap)
  if (posts.length >= 3) return { domain, posts, source: 'sitemap' }
  return { domain, posts: [], source: 'none' }
}

// --- Step 3: LLM picks topics and repackages them for our brand -------------------- //

export async function pickCompetitorIdeas(
  blogs: CompetitorBlog[],
  ourTitles: string[],
  llm: LLM,
  s: AppSettings,
  n = 10,
): Promise<CompetitorIdea[]> {
  const withPosts = blogs.filter(b => b.posts.length)
  if (!withPosts.length) return []

  const blogsCtx = withPosts.map(b =>
    `${pl(s.language, 'КОНКУРЕНТ', 'COMPETITOR')} ${b.domain}:\n${b.posts.slice(0, 15).map(p =>
      `- ${p.title}${p.publishedAt ? ` (${p.publishedAt})` : ''} | ${p.url}`).join('\n')}`,
  ).join('\n\n')
  const avoid = ourTitles.slice(0, 60)
  const avoidLine = avoid.length
    ? `${pl(s.language, 'У нас уже есть эти темы — не повторяй и не перефразируй их:', 'We already have these topics — do not repeat or rephrase them:')}\n${avoid.map(t => `- ${t}`).join('\n')}\n`
    : ''
  const categories = String(s.categories || '').split(',').map(c => c.trim()).filter(Boolean)
  const catLine = categories.length
    ? `${pl(s.language, `Рубрики блога: ${categories.join(', ')}. Каждой идее проставь category из списка.`, `Blog categories: ${categories.join(', ')}. Set the category field on each idea from this list.`)}\n`
    : `${pl(s.language, 'Поле category оставь пустой строкой.', 'Leave the category field as an empty string.')}\n`

  const prompt
    = pl(s.language,
      `Ниже свежие посты из блогов конкурентов ${s.brand}. Отбери ${n} САМЫХ сильных тем, `
      + `на которых ${s.brand} может собрать трафик из AI-выдачи: трендовые, с явным спросом, `,
      `Below are recent posts from ${s.brand}'s competitor blogs. Pick the ${n} strongest topics `
      + `${s.brand} can use to capture traffic from AI search results: trending, with clear demand, `,
    )
    + pl(s.language,
      'где мы можем ответить глубже или под своим углом. Слабые/узкобрендовые посты пропусти.\n',
      'where we can answer more deeply or with our own angle. Skip weak/narrowly-branded posts.\n',
    )
    + pl(s.language,
      'ЗАГОЛОВОК НЕ КОПИРУЙ — сформулируй СВОЮ тему по мотивам (свой угол, наш бренд).\n',
      'DO NOT COPY THE TITLE — come up with your OWN topic inspired by it (your own angle, our brand).\n',
    )
    + `${todayLine()}\n`
    + catLine + avoidLine
    + pl(s.language,
      'Для каждой верни: title, angle (чем цепляет, 1 строка), '
      + 'intent (informational|howto|comparison|best|definition|news), keyword, '
      + 'queries (2-4 AEO-запроса), category, source_url (URL поста-вдохновителя из списка), '
      + 'source_title (его заголовок).\n',
      'For each, return: title, angle (what makes it compelling, 1 line), '
      + 'intent (informational|howto|comparison|best|definition|news), keyword, '
      + 'queries (2-4 AEO queries), category, source_url (URL of the inspiring post from the list), '
      + 'source_title (its title).\n',
    )
    + pl(s.language,
      'Верни JSON-массив объектов {title, angle, intent, keyword, queries, category, source_url, source_title}.\n\n',
      'Return a JSON array of objects {title, angle, intent, keyword, queries, category, source_url, source_title}.\n\n',
    )
    + blogsCtx
  const system
    = `${s.persona}\n`
    + pl(s.language,
      `Ты конкурентный контент-аналитик блога ${s.brand}: находишь у конкурентов `
      + `темы-магниты и превращаешь их в идеи, где ${s.brand} ответит лучше. Язык: ${s.language}.`,
      `You are a competitive content analyst for ${s.brand}'s blog: you find `
      + `magnet topics from competitors and turn them into ideas where ${s.brand} can answer better. Language: ${s.language}.`,
    )

  const urlToDomain = new Map<string, string>()
  for (const b of withPosts) for (const p of b.posts) urlToDomain.set(p.url, b.domain)

  const ideas: CompetitorIdea[] = []
  try {
    const data = await llm.json(prompt, { system, strong: true, maxTokens: 500 + n * 200 })
    for (const item of coerceArray(data)) {
      const title = String(item?.title ?? '').trim()
      if (!title) continue
      const queries = (Array.isArray(item?.queries) ? item.queries : [])
        .map(String).map((q: string) => q.trim()).filter(Boolean).slice(0, 4)
      const srcUrl = String(item?.source_url ?? '').trim()
      ideas.push({
        title,
        angle: String(item?.angle ?? '').trim(),
        intent: String(item?.intent ?? 'informational'),
        keyword: String(item?.keyword ?? '').trim(),
        queries,
        category: String(item?.category ?? '').trim(),
        score: queries.length ? Math.round((queries.reduce((a, q) => a + aeoScore(q), 0) / queries.length) * 10) / 10 : 0,
        source: {
          domain: urlToDomain.get(srcUrl) || toDomain(srcUrl),
          url: srcUrl,
          title: String(item?.source_title ?? '').trim(),
        },
      })
    }
  } catch {
    // best-effort: return whatever was parsed
  }

  // dedup by title (and against our topics) + sort by AEO score
  const ours = new Set(ourTitles.map(t => t.toLowerCase()))
  const seen = new Set<string>()
  const out = ideas.filter((i) => {
    const k = i.title.toLowerCase()
    if (ours.has(k) || seen.has(k)) return false
    seen.add(k)
    return true
  })
  out.sort((a, b) => b.score - a.score)
  return out
}

/** Full pass: competitors from tools → parse blogs → ideas. */
export async function competitorTopicIdeas(
  brandId: number,
  ourTitles: string[],
  llm: LLM,
  s: AppSettings,
  n = 10,
): Promise<{ ideas: CompetitorIdea[], blogs: CompetitorBlog[], competitors: string[] }> {
  const competitors = await getBrandCompetitors(brandId)
  if (!competitors.length) return { ideas: [], blogs: [], competitors: [] }
  const blogs = await Promise.all(competitors.map(d => discoverBlog(d)))
  const ideas = llm.isMock
    ? mockIdeas(blogs, n)
    : await pickCompetitorIdeas(blogs, ourTitles, llm, s, n)
  return { ideas, blogs, competitors }
}

/** Mock mode: deterministic ideas from real fetched titles. */
function mockIdeas(blogs: CompetitorBlog[], n: number): CompetitorIdea[] {
  const out: CompetitorIdea[] = []
  for (const b of blogs) {
    for (const p of b.posts) {
      if (out.length >= n) return out
      out.push({
        title: `Наш разбор: ${p.title.slice(0, 80)}`,
        angle: 'глубже и с нашими данными',
        intent: 'informational',
        keyword: p.title.split(' ').slice(0, 3).join(' ').toLowerCase(),
        queries: [`что такое ${p.title.slice(0, 40).toLowerCase()}`],
        category: '',
        score: 5,
        source: { domain: b.domain, url: p.url, title: p.title },
      })
    }
  }
  return out
}
