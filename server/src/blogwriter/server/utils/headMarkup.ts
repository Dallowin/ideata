/**
 * Head markup for an article: title/description, Open Graph, Twitter, and JSON-LD.
 *
 * Why. The blog writer would write an article and stop there: only the title and
 * body went into the publish. No meta description, no markup - and it's exactly
 * that markup that decides whether the article lands in a rich result and whether
 * an AI engine can pull a quote from it. Our own audits of live sites show that
 * the markup is missing most of the time.
 *
 * We compute it DETERMINISTICALLY, without an LLM: titles and descriptions are
 * assembled from existing text, FAQ is extracted from question-shaped subheadings.
 * This costs nothing, doesn't invent facts, and works the same regardless of the model.
 */

/** Limits beyond which Google truncates the result (characters, not pixels - an approximation). */
export const TITLE_MAX = 60
export const DESC_MAX = 160

export interface ArticleInput {
  title: string
  /** article body in markdown (preferred) or HTML */
  body: string
  excerpt?: string
  url?: string
  coverUrl?: string
  author?: string
  siteName?: string
  locale?: string
  publishedAt?: string
  updatedAt?: string
}

export interface HeadMarkup {
  titles: string[]
  descriptions: string[]
  og: Record<string, string>
  twitter: Record<string, string>
  jsonLd: Record<string, unknown>[]
  faqCount: number
  /** ready-made block to insert into <head> */
  html: string
}

const strip = (s: string): string =>
  String(s || '')
    .replace(/<[^>]+>/g, ' ')            // html tags
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // markdown images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links -> text
    .replace(/[*_`#>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Truncate on a word boundary, no "..." mid-word. */
export function clampWords(text: string, max: number): string {
  const t = strip(text)
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const at = cut.lastIndexOf(' ')
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[,;:.\s]+$/, '')}…`
}

/** First substantial paragraph - the basis for the description. */
function firstParagraph(body: string): string {
  const blocks = String(body || '')
    .split(/\n{2,}/)
    .map((b) => strip(b))
    .filter((b) => b.length > 40 && !/^(#|\||!\[)/.test(b))
  return blocks[0] || ''
}

/**
 * Questions from subheadings + their answer (text up to the next heading) -> FAQPage.
 * We only take real questions: ending in "?" or starting with a question word.
 */
export function extractFaq(body: string, limit = 8): { q: string; a: string }[] {
  const lines = String(body || '').split('\n')
  const out: { q: string; a: string }[] = []
  // NOTE: \b doesn't work here - in JS it's an ASCII boundary, and there is none
  // after Cyrillic: /^чем\b/ doesn't match "Чем отличается...". Hence the explicit lookahead.
  const isQuestion = (s: string) =>
    /\?\s*$/.test(s) ||
    /^(как|почему|зачем|что|чем|где|когда|сколько|стоит ли|можно ли|нужно ли|how|why|what|when|where|which|is|are|can|should)(?=[\s,:—-]|$)/i.test(s)

  for (let i = 0; i < lines.length; i += 1) {
    const m = /^#{2,4}\s+(.+?)\s*$/.exec(lines[i] || '')
    if (!m) continue
    const q = strip(m[1])
    if (!q || !isQuestion(q)) continue
    const buf: string[] = []
    for (let j = i + 1; j < lines.length && !/^#{1,6}\s/.test(lines[j] || ''); j += 1) {
      const t = strip(lines[j] || '')
      if (t) buf.push(t)
      if (buf.join(' ').length > 600) break
    }
    const a = buf.join(' ').trim()
    if (a.length >= 40) out.push({ q, a: clampWords(a, 600) })
    if (out.length >= limit) break
  }
  return out
}

/** Title variants: the original, truncated to the limit, and "title - site". */
function titleVariants(title: string, siteName?: string): string[] {
  const base = strip(title)
  const out = [clampWords(base, TITLE_MAX)]
  if (siteName && base.length + siteName.length + 3 <= TITLE_MAX) {
    out.push(`${base} — ${siteName}`)
  }
  const short = base.split(/[:—-]/)[0]?.trim()
  if (short && short !== base && short.length >= 20) out.push(clampWords(short, TITLE_MAX))
  return [...new Set(out.filter(Boolean))]
}

export function buildHeadMarkup(a: ArticleInput): HeadMarkup {
  const title = strip(a.title)
  const para = firstParagraph(a.body)
  const descBase = strip(a.excerpt || '') || para
  const descriptions = [...new Set([
    clampWords(descBase, DESC_MAX),
    para && para !== descBase ? clampWords(para, DESC_MAX) : '',
  ].filter(Boolean))]

  const titles = titleVariants(title, a.siteName)
  const desc = descriptions[0] || ''
  const faq = extractFaq(a.body)

  const og: Record<string, string> = {
    'og:type': 'article',
    'og:title': titles[0] || title,
    'og:description': desc,
  }
  if (a.url) og['og:url'] = a.url
  if (a.coverUrl) og['og:image'] = a.coverUrl
  if (a.siteName) og['og:site_name'] = a.siteName
  if (a.locale) og['og:locale'] = a.locale

  const twitter: Record<string, string> = {
    'twitter:card': a.coverUrl ? 'summary_large_image' : 'summary',
    'twitter:title': titles[0] || title,
    'twitter:description': desc,
  }
  if (a.coverUrl) twitter['twitter:image'] = a.coverUrl

  const article: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: clampWords(title, 110),   // schema.org recommends <=110
    description: desc,
  }
  if (a.url) article.mainEntityOfPage = { '@type': 'WebPage', '@id': a.url }
  if (a.coverUrl) article.image = a.coverUrl
  if (a.author) article.author = { '@type': 'Person', name: strip(a.author) }
  if (a.siteName) article.publisher = { '@type': 'Organization', name: a.siteName }
  if (a.publishedAt) article.datePublished = a.publishedAt
  if (a.updatedAt) article.dateModified = a.updatedAt

  const jsonLd: Record<string, unknown>[] = [article]
  if (faq.length >= 2) {
    jsonLd.push({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: faq.map((f) => ({
        '@type': 'Question',
        name: f.q,
        acceptedAnswer: { '@type': 'Answer', text: f.a },
      })),
    })
  }

  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  const html = [
    `<title>${esc(titles[0] || title)}</title>`,
    `<meta name="description" content="${esc(desc)}">`,
    ...Object.entries(og).map(([k, v]) => `<meta property="${k}" content="${esc(v)}">`),
    ...Object.entries(twitter).map(([k, v]) => `<meta name="${k}" content="${esc(v)}">`),
    ...jsonLd.map((d) => `<script type="application/ld+json">${JSON.stringify(d)}</script>`),
  ].join('\n')

  return { titles, descriptions, og, twitter, jsonLd, faqCount: faq.length, html }
}
