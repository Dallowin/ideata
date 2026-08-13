/**
 * Search for similar posts + extract clean text (port of blog_agent/search.py).
 * - search: DuckDuckGo HTML (no key needed), cheerio parsing, graceful fallback to [];
 * - extraction: @mozilla/readability + jsdom, falling back to a crude tag strip.
 */
import * as cheerio from 'cheerio'
import { safeFetchHtml } from './safeFetch'

export interface SearchHit {
  url: string
  title: string
  snippet: string
}

const UA = 'Mozilla/5.0 (compatible; IdeataBlogWriter/1.0)'
// a source article longer than a megabyte isn't an article; readability still
// works off the start of the document
const MAX_ARTICLE_BYTES = 1024 * 1024

export async function ddgSearch(query: string, limit = 8): Promise<SearchHit[]> {
  let hits = await ddgHtml(query, limit)
  if (!hits.length) hits = await ddgLite(query, limit)
  if (!hits.length) {
    // DDG often fails to find long sentence-style queries — trim down to keywords
    const short = shortenQuery(query)
    if (short && short !== query) {
      hits = await ddgHtml(short, limit)
      if (!hits.length) hits = await ddgLite(short, limit)
    }
  }
  return hits
}

/** Strip stop words and keep up to 6 meaningful words. */
export function shortenQuery(query: string): string {
  const STOP = new Set([
    'как', 'что', 'чем', 'или', 'для', 'это', 'такое', 'при', 'по', 'на', 'не', 'из',
    'до', 'и', 'в', 'с', 'о', 'у', 'к', 'за', 'от', 'помогает', 'может', 'нужно', 'почему',
  ])
  return (query.toLowerCase().match(/[\p{L}\p{N}-]+/gu) || [])
    .filter(w => w.length >= 3 && !STOP.has(w))
    .slice(0, 6)
    .join(' ')
}

async function ddgHtml(query: string, limit: number): Promise<SearchHit[]> {
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const $ = cheerio.load(await res.text())
    const hits: SearchHit[] = []
    $('.result').each((_, el) => {
      const a = $(el).find('a.result__a').first()
      const href = unwrapDdgUrl(a.attr('href') || '')
      if (!href) return
      hits.push({
        url: href,
        title: a.text().trim(),
        snippet: $(el).find('.result__snippet').text().trim(),
      })
    })
    return hits.slice(0, limit)
  } catch {
    return []
  }
}

/** Backup endpoint: lite.duckduckgo.com (different markup, gets rate-limited less). */
async function ddgLite(query: string, limit: number): Promise<SearchHit[]> {
  try {
    const res = await fetch('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const $ = cheerio.load(await res.text())
    const hits: SearchHit[] = []
    $('a.result-link').each((_, el) => {
      const href = unwrapDdgUrl($(el).attr('href') || '')
      if (!href) return
      hits.push({ url: href, title: $(el).text().trim(), snippet: '' })
    })
    return hits.slice(0, limit)
  } catch {
    return []
  }
}

/** DDG wraps links as /l/?uddg=<encoded-url>. */
function unwrapDdgUrl(href: string): string {
  const m = href.match(/uddg=([^&]+)/)
  if (m) { try { href = decodeURIComponent(m[1]) } catch { /* keep raw */ } }
  return /^https?:\/\//.test(href) ? href : ''
}

export interface FetchedArticle {
  text: string
  author?: string // byline (source E-E-A-T signal)
  publishedAt?: string // ISO publish date, if found
  siteName?: string
}

/** Return the article's main text. Empty string on failure. */
export async function fetchArticle(url: string, timeoutMs = 20_000): Promise<string> {
  return (await fetchArticleFull(url, timeoutMs)).text
}

/**
 * Article text + E-E-A-T metadata (byline, publish date, publication).
 * Readability extracts these anyway — we used to just discard them.
 */
export async function fetchArticleFull(url: string, timeoutMs = 20_000): Promise<FetchedArticle> {
  const html = await download(url, timeoutMs)
  if (!html) return { text: '' }
  try {
    const [{ JSDOM }, { Readability }] = await Promise.all([
      import('jsdom'),
      import('@mozilla/readability'),
    ])
    const dom = new JSDOM(html, { url })
    const article = new Readability(dom.window.document).parse()
    const text = article?.textContent?.trim()
    if (text) {
      return {
        text: text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n'),
        author: article?.byline?.trim() || undefined,
        publishedAt: normalizeDate(article?.publishedTime) || extractMetaDate(html),
        siteName: article?.siteName?.trim() || undefined,
      }
    }
  } catch {
    // readability couldn't handle it — fall back to crude extraction
  }
  return { text: crudeExtract(html), publishedAt: extractMetaDate(html) }
}

/** Publish date from meta tags (article:published_time, datePublished). */
export function extractMetaDate(html: string): string | undefined {
  const m = html.match(/(?:property|name|itemprop)=["'](?:article:published_time|datePublished|date)["'][^>]*content=["']([^"']+)["']/i)
    || html.match(/content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["'](?:article:published_time|datePublished)["']/i)
  return normalizeDate(m?.[1])
}

/** Normalize a date to YYYY-MM-DD; garbage → undefined. */
export function normalizeDate(raw?: string | null): string | undefined {
  if (!raw) return undefined
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10)
}

/**
 * Download the source page. The URL here comes from search results and from
 * the request body (references/extract, brand crawl) — i.e. it's externally
 * controlled, so we go strictly through safeFetch: host check on every redirect
 * hop, a body size limit, and rejecting anything that isn't HTML (there's
 * nothing to parse an archive/video as an article, and pulling them in full is
 * a way to eat up worker memory).
 */
async function download(url: string, timeoutMs: number): Promise<string> {
  return safeFetchHtml(url, {
    timeoutMs,
    maxBytes: MAX_ARTICLE_BYTES,
    headers: { 'User-Agent': UA },
  })
}

function crudeExtract(html: string): string {
  let s = html.replace(/<(script|style|nav|footer|header|aside)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  s = s.replace(/<[^>]+>/g, ' ')
  s = s.replace(/\s+/g, ' ')
  return s.trim().slice(0, 8000)
}

/** Strip HTML tags, return flat text (for the linter/word count). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .trim()
}
