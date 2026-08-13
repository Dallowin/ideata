/**
 * Our-side contract for the Insane blog API (/blog/ingest): types + DTO validation.
 * Upstream hides error details (disableErrorMessages) → we validate ourselves BEFORE sending,
 * so we can show a clear per-field message instead of a bare 400.
 */
import { LANGUAGES } from '../languages'

/** Blog locales (the same set as on insane.gg). */
export const BLOG_LOCALES = LANGUAGES.map(l => l.code)
export const DEFAULT_LOCALE = 'ru'
export type BlogLocale = string

export type BlogStatus = 'draft' | 'published'
export const BLOG_STATUSES: BlogStatus[] = ['draft', 'published']

/** Body of BlogIngestPostDto (POST /blog/ingest, PUT /blog/ingest/:id). */
export interface BlogIngestPayload {
  title: string // REQUIRED. ≤ 500
  bodyHtml: string // REQUIRED.
  sourceId?: string // ≤ 200, idempotency key (in our case — the run id)
  slug?: string // ≤ 200, unique (conflict → 409)
  locale?: string // ≤ 10, default ru
  status?: BlogStatus // default draft
  topic?: string // ≤ 500
  category?: string // ≤ 100
  author?: string // ≤ 200
  bodyMd?: string
  coverImageUrl?: string // http/https — the blog will download and re-upload to R2
  coverUrl?: string // ≤ 1000, ready-made CDN URL
  wordCount?: number // int ≥ 0
}

/** Response of POST /blog/ingest. */
export interface BlogIngestResult {
  id: number
  slug: string
  status: BlogStatus
}

/** Field length limits from the contract (in characters). */
export const BLOG_LIMITS = {
  title: 500,
  sourceId: 200,
  slug: 200,
  locale: 10,
  topic: 500,
  category: 100,
  author: 200,
  coverUrl: 1000,
} as const

const isHttpUrl = (v: string) => /^https?:\/\/\S+$/i.test(v.trim())

/**
 * Validates the DTO against the contract. `partial` — for PUT (title/bodyHtml aren't required,
 * but are validated if provided). Returns a "field → message" map (empty = ok).
 */
export function validateIngest(
  p: Partial<BlogIngestPayload>,
  opts: { partial?: boolean } = {},
): Record<string, string> {
  const errors: Record<string, string> = {}
  const { partial = false } = opts

  // title
  if (!partial || p.title !== undefined) {
    const t = (p.title ?? '').trim()
    if (!t) errors.title = 'Title is required'
    else if (t.length > BLOG_LIMITS.title) errors.title = `Title ≤ ${BLOG_LIMITS.title} characters`
  }
  // bodyHtml
  if (!partial || p.bodyHtml !== undefined) {
    const b = (p.bodyHtml ?? '').trim()
    if (!b) errors.bodyHtml = 'Article body (bodyHtml) is required'
  }
  // string length limits
  const lim: Array<[keyof typeof BLOG_LIMITS, string | undefined, string]> = [
    ['sourceId', p.sourceId, 'sourceId'],
    ['slug', p.slug, 'slug'],
    ['topic', p.topic, 'Topic'],
    ['category', p.category, 'Category'],
    ['author', p.author, 'Author'],
    ['coverUrl', p.coverUrl, 'coverUrl'],
  ]
  for (const [key, val, label] of lim) {
    if (val !== undefined && val.length > (BLOG_LIMITS as any)[key]) {
      errors[key] = `${label} ≤ ${(BLOG_LIMITS as any)[key]} characters`
    }
  }
  // locale
  if (p.locale !== undefined && p.locale !== '' && !BLOG_LOCALES.includes(p.locale)) {
    errors.locale = `Locale must be one of: ${BLOG_LOCALES.join(', ')}`
  }
  // status
  if (p.status !== undefined && !BLOG_STATUSES.includes(p.status)) {
    errors.status = 'Status must be draft or published'
  }
  // coverImageUrl
  if (p.coverImageUrl !== undefined && p.coverImageUrl !== '' && !isHttpUrl(p.coverImageUrl)) {
    errors.coverImageUrl = 'coverImageUrl must be an http/https URL'
  }
  // wordCount
  if (p.wordCount !== undefined && (!Number.isInteger(p.wordCount) || p.wordCount < 0)) {
    errors.wordCount = 'wordCount must be an integer ≥ 0'
  }
  return errors
}

/** Drop empty/undefined fields so PUT doesn't overwrite values with emptiness. */
export function pruneEmpty<T extends Record<string, any>>(obj: T): Partial<T> {
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && v.trim() === '') continue
    out[k] = v
  }
  return out as Partial<T>
}
