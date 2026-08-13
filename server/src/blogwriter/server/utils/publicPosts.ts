/**
 * Helpers for the public read API of the blog (server/api/public/*): what can be
 * exposed externally — only published posts, with an absolute cover URL, slug, and excerpt.
 */
import type { RunRow } from './store'
import { pl } from './lang'

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

/** Title → url-safe slug (Cyrillic gets transliterated). */
export function slugify(input: string): string {
  return (input || '')
    .toLowerCase()
    .split('')
    .map(c => TRANSLIT[c] ?? c)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'post'
}

/** Stable public post slug: <title-slug>-<first 8 chars of id>. */
export function publicSlug(row: Pick<RunRow, 'id' | 'title' | 'topic'>): string {
  return `${slugify(row.title || row.topic)}-${row.id.slice(0, 8)}`
}

/** First ~200 characters of plain text from the HTML body — for the preview card. */
export function excerpt(html: string, max = 200): string {
  const text = (html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max).trim()}…` : text
}

/** Relative /api/covers/... → absolute URL (for images on a third-party front end). */
export function absoluteCover(coverUrl: string | null | undefined, base: string): string | null {
  if (!coverUrl) return null
  if (/^https?:\/\//.test(coverUrl)) return coverUrl
  return base.replace(/\/$/, '') + coverUrl
}

/**
 * Base for absolute links: PUBLIC_BASE_URL or the incoming request's origin.
 * @param base — absolute request origin (e.g. `${req.protocol}://${req.get('host')}`),
 *   computed by the controller and passed in here; used when PUBLIC_BASE_URL is not set.
 */
export function publicBase(base = ''): string {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL
  return base || ''
}

/** Reading time in minutes (≈180 words/min, minimum 1). */
export function readingMinutes(wordCount: number): number {
  return Math.max(1, Math.round((wordCount || 0) / 180))
}

/** Post author: explicit, or "Редакция {brand}" / "{brand} editorial team" by language. */
export function authorOf(rowAuthor: string, brand: string, lang = 'ru'): string {
  return (rowAuthor || '').trim() || pl(lang, `Редакция ${brand}`, `${brand} editorial team`)
}

/** Related posts: same category first, then filled with recent ones; excludes the post itself. */
export function relatedPosts(
  current: Pick<RunRow, 'id' | 'category'>,
  published: Array<Pick<RunRow, 'id' | 'title' | 'topic' | 'category' | 'cover_url' | 'updated_at'>>,
  base: string,
  n = 4,
): Array<{ id: string, slug: string, title: string, category: string, coverUrl: string | null, publishedAt: string }> {
  const others = published.filter(r => r.id !== current.id)
  const sameCat = current.category
    ? others.filter(r => r.category && r.category.toLowerCase() === current.category.toLowerCase())
    : []
  const rest = others.filter(r => !sameCat.includes(r))
  return [...sameCat, ...rest].slice(0, n).map(r => ({
    id: r.id,
    slug: publicSlug(r),
    title: r.title || r.topic,
    category: r.category || '',
    coverUrl: absoluteCover(r.cover_url, base),
    publishedAt: r.updated_at,
  }))
}

/** Ready-made social-sharing links for a post's URL+title. */
export function shareLinks(url: string, title: string): Record<string, string> {
  const u = encodeURIComponent(url)
  const t = encodeURIComponent(title)
  return {
    x: `https://twitter.com/intent/tweet?url=${u}&text=${t}`,
    telegram: `https://t.me/share/url?url=${u}&text=${t}`,
    vk: `https://vk.com/share.php?url=${u}&title=${t}`,
    whatsapp: `https://api.whatsapp.com/send?text=${t}%20${u}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
  }
}
