/**
 * Crossposts an article to dev.to (Forem) using the brand's personal API key.
 *
 * Why dev.to is first in the "channel queue": it's the only platform of this
 * size where publishing by key is official, free, and — most importantly —
 * supports canonical_url. The copy doesn't compete with the original in search
 * results, it points to it; that's the entire point of crossposting.
 *
 * Idempotency WITHOUT a new DB column. Telegram message ids live on the run
 * (tg_msgids_json), but we don't want to add a migration to the shared schema
 * just for dev.to: db push on this schema is a known landmine (it wipes out the
 * scraper's tables). Instead, before publishing we ask dev.to for our list of
 * articles and look for the one whose canonical_url matches our address.
 * Matched — PUT (update), no match — POST (create). An extra request is
 * cheaper than a risky migration.
 */
import type { AppSettings } from './appSettings'
import { htmlToMarkdown } from './markdown'

const API = 'https://dev.to/api'
const TIMEOUT_MS = 20_000

export interface DevtoConfig {
  apiKey: string
  enabled: boolean
  ready: boolean // enabled + key is set
}

export function devtoConfig(s: AppSettings): DevtoConfig {
  const apiKey = (s.devtoApiKey || '').trim()
  return { apiKey, enabled: !!s.devtoEnabled, ready: !!(s.devtoEnabled && apiKey) }
}

export interface DevtoResult {
  attempted: boolean
  ok: boolean
  status?: number
  id?: number
  url?: string
  /** true — updated an existing article instead of creating a new one */
  updated?: boolean
  error?: string
}

/** Human-readable message from the response code: Forem's error body is often empty. */
function messageFor(status?: number, fallback?: string): string {
  const map: Record<number, string> = {
    401: 'key rejected (401) — check the API key in dev.to settings',
    403: 'key rejected (403)',
    404: 'article not found (404)',
    422: 'dev.to rejected the article (422): usually the tags — only letters and digits are allowed, up to 4',
    429: 'too many requests (429) — dev.to is rate-limiting publications, try again in a minute',
  }
  return (status && map[status]) || fallback || (status ? `HTTP ${status}` : 'network error')
}

async function devFetch(apiKey: string, path: string, init: RequestInit = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(`${API}${path}`, {
      ...init,
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: ctrl.signal,
    })
  } catch (e: any) {
    return { error: e?.name === 'AbortError' ? 'timeout (20s)' : (e?.message || 'network error') } as const
  } finally {
    clearTimeout(t)
  }
}

/**
 * dev.to tags: letters and digits only, up to 4, lowercase. The platform
 * rejects hyphens and spaces with a 422 and no clear message — so we clean
 * them up here instead of relying on the user.
 */
export function devtoTags(...raw: (string | undefined)[]): string[] {
  const out: string[] = []
  for (const chunk of raw) {
    for (const word of String(chunk || '').split(/[\s,;/|]+/)) {
      const tag = word.toLowerCase().replace(/[^a-z0-9]/g, '')
      if (tag.length >= 2 && tag.length <= 30 && !out.includes(tag)) out.push(tag)
      if (out.length === 4) return out
    }
  }
  return out
}

/** Find our own article with the same canonical — means we already published it. */
async function findByCanonical(apiKey: string, canonical: string): Promise<number | null> {
  if (!canonical) return null
  const r = await devFetch(apiKey, '/articles/me/all?per_page=100')
  if ('error' in r || !r.ok) return null
  try {
    const list = (await r.json()) as Array<{ id: number; canonical_url?: string }>
    const norm = (u: string) => String(u || '').replace(/\/+$/, '')
    return list.find((a) => norm(a.canonical_url || '') === norm(canonical))?.id ?? null
  } catch {
    return null
  }
}

export interface DevtoArticle {
  title: string
  bodyMd: string
  /** HTML body: fallback for when the article's markdown is empty (translations/import) */
  bodyHtml?: string
  canonicalUrl: string
  tags: string[]
  coverUrl?: string
  /** false — goes out as a draft (dev.to keeps it in the "Dashboard") */
  published: boolean
}

/**
 * Publish (or update) an article on dev.to. Doesn't throw: the error is
 * returned in the result so crosspost failures don't break the native
 * publish — the same approach already used for ingest and Telegram.
 */
export async function devtoPublishArticle(a: DevtoArticle, s: AppSettings): Promise<DevtoResult> {
  const cfg = devtoConfig(s)
  if (!cfg.apiKey) return { attempted: false, ok: false, error: 'dev.to API key not set' }
  // dev.to only accepts markdown. body_md can be empty for translations and
  // imports — in that case we build it from HTML, otherwise an empty article would go out.
  const bodyMd = a.bodyMd.trim() || await htmlToMarkdown(a.bodyHtml || '')
  if (!a.title.trim() || !bodyMd.trim()) {
    return { attempted: false, ok: false, error: 'the article has no title or text' }
  }

  const payload = {
    article: {
      title: a.title.trim().slice(0, 250),
      body_markdown: bodyMd,
      published: a.published,
      canonical_url: a.canonicalUrl || undefined,
      tags: a.tags,
      main_image: a.coverUrl && /^https?:\/\//.test(a.coverUrl) ? a.coverUrl : undefined,
    },
  }

  const existing = await findByCanonical(cfg.apiKey, a.canonicalUrl)
  const r = existing
    ? await devFetch(cfg.apiKey, `/articles/${existing}`, { method: 'PUT', body: JSON.stringify(payload) })
    : await devFetch(cfg.apiKey, '/articles', { method: 'POST', body: JSON.stringify(payload) })

  if ('error' in r) return { attempted: true, ok: false, error: r.error }
  if (!r.ok) return { attempted: true, ok: false, status: r.status, error: messageFor(r.status) }
  try {
    const body = (await r.json()) as { id?: number; url?: string }
    return { attempted: true, ok: true, status: r.status, id: body.id, url: body.url, updated: !!existing }
  } catch {
    // body isn't JSON — the publish still went through (Forem responds 201/200)
    return { attempted: true, ok: true, status: r.status, updated: !!existing }
  }
}

/**
 * Unpublish an article. Forem's API has no deletion — we switch it to a
 * draft, the closest available equivalent: the public page disappears.
 */
export async function devtoUnpublish(canonicalUrl: string, s: AppSettings): Promise<DevtoResult> {
  const cfg = devtoConfig(s)
  if (!cfg.apiKey) return { attempted: false, ok: false, error: 'dev.to API key not set' }
  const existing = await findByCanonical(cfg.apiKey, canonicalUrl)
  if (!existing) return { attempted: true, ok: true } // nothing to publish in the first place
  const r = await devFetch(cfg.apiKey, `/articles/${existing}`, {
    method: 'PUT',
    body: JSON.stringify({ article: { published: false } }),
  })
  if ('error' in r) return { attempted: true, ok: false, error: r.error }
  if (!r.ok) return { attempted: true, ok: false, status: r.status, error: messageFor(r.status) }
  return { attempted: true, ok: true, status: r.status, id: existing }
}

/** Key check: fetch our own profile. No risk of publishing anything. */
export async function devtoTest(s: AppSettings): Promise<DevtoResult> {
  const cfg = devtoConfig(s)
  if (!cfg.apiKey) return { attempted: false, ok: false, error: 'dev.to API key not set' }
  const r = await devFetch(cfg.apiKey, '/users/me')
  if ('error' in r) return { attempted: true, ok: false, error: r.error }
  if (!r.ok) return { attempted: true, ok: false, status: r.status, error: messageFor(r.status) }
  try {
    const me = (await r.json()) as { username?: string }
    return { attempted: true, ok: true, status: r.status, url: me.username ? `https://dev.to/${me.username}` : undefined }
  } catch {
    return { attempted: true, ok: true, status: r.status }
  }
}
