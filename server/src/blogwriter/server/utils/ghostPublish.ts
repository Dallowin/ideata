/**
 * Publishes an article to a Ghost blog via the Admin API.
 *
 * Ghost has its own authentication: the Admin API key looks like
 * `<id>:<secret-hex>`, and it doesn't sign the request directly — a
 * short-lived JWT is issued based on it (HS256, kid = id, aud = '/admin/',
 * ttl 5 minutes). We sign it ourselves via node:crypto: HS256 is just
 * HMAC-SHA256 over base64url(header).base64url(payload), not worth pulling in
 * jsonwebtoken as a dependency for that.
 *
 * Idempotency without a dedicated column — by slug, like WordPress. But Ghost
 * has its own quirk: PUT requires the `updated_at` of the last known version,
 * otherwise it returns 409 (protection against overwriting someone else's
 * edit). So before updating we don't just look up the id, we also fetch updated_at.
 */
import { createHmac } from 'node:crypto'
import type { AppSettings } from './appSettings'
import { checkPublicHttpsUrl } from './safeUrl'
import { retryFetch } from './retryFetch'

const TIMEOUT_MS = 20_000
const JWT_TTL_SEC = 5 * 60

export interface GhostConfig {
  siteUrl: string
  keyId: string
  keySecret: string
  enabled: boolean
  ready: boolean
}

/** Parse the Admin API key `id:secret`. A malformed key returns empty parts, not an exception. */
export function parseAdminKey(raw: string): { id: string; secret: string } {
  const [id = '', secret = ''] = String(raw || '').trim().split(':')
  // secret must be hex: it's what actually signs the JWT
  return /^[0-9a-f]+$/i.test(secret) && id ? { id, secret } : { id: '', secret: '' }
}

export function ghostConfig(s: AppSettings): GhostConfig {
  const checked = checkPublicHttpsUrl(s.ghostSiteUrl || '')
  const siteUrl = checked.ok ? checked.url! : ''
  const { id, secret } = parseAdminKey(s.ghostAdminKey || '')
  return {
    siteUrl, keyId: id, keySecret: secret,
    enabled: !!s.ghostEnabled,
    ready: !!(s.ghostEnabled && siteUrl && id && secret),
  }
}

function siteUrlError(s: AppSettings): string {
  const c = checkPublicHttpsUrl(s.ghostSiteUrl || '')
  return c.ok ? 'site address not set' : `site address: ${c.error}`
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/** JWT for the Admin API. Lives 5 minutes — issued on every request, not cached. */
export function ghostToken(keyId: string, keySecret: string, nowSec = Math.floor(Date.now() / 1000)): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: keyId }))
  const payload = b64url(JSON.stringify({ iat: nowSec, exp: nowSec + JWT_TTL_SEC, aud: '/admin/' }))
  const data = `${header}.${payload}`
  const sig = b64url(createHmac('sha256', Buffer.from(keySecret, 'hex')).update(data).digest())
  return `${data}.${sig}`
}

export interface GhostResult {
  attempted: boolean
  ok: boolean
  status?: number
  id?: string
  url?: string
  updated?: boolean
  error?: string
}

function messageFor(status?: number, detail?: string): string {
  const map: Record<number, string> = {
    401: 'key rejected (401) — check the Admin API key (id:secret format)',
    403: 'access forbidden (403): the integration lacks publishing rights',
    404: 'Admin API not found (404) — check the Ghost site address',
    409: 'version conflict (409): the article was edited directly in Ghost — refresh the page and try again',
    422: 'Ghost rejected the article (422)',
  }
  return (status && map[status]) || detail || (status ? `HTTP ${status}` : 'network error')
}

/** Error text from Ghost's response body: it puts it in errors[0].message. */
function detailOf(body: unknown): string {
  const b = body as { errors?: Array<{ message?: string; context?: string }> } | null
  const e = b?.errors?.[0]
  return [e?.message, e?.context].filter(Boolean).join(' — ')
}

async function ghostFetch(cfg: GhostConfig, path: string, init: RequestInit = {}) {
  const method = (init.method || 'GET').toUpperCase()
  const out = await retryFetch(async () => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      return await fetch(`${cfg.siteUrl}/ghost/api/admin${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Ghost ${ghostToken(cfg.keyId, cfg.keySecret)}`,
          'Accept-Version': 'v5.0',
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(t)
    }
  }, { method })
  if ('netError' in out) return { error: out.netError === 'timeout' ? 'timeout (20s)' : out.netError } as const
  let body: unknown = null
  try { body = await out.res.json() } catch { /* an empty body happens sometimes */ }
  return { res: out.res, body } as const
}

/** Is there already a post with this slug — and what's its updated_at (needed for PUT). */
async function findBySlug(cfg: GhostConfig, slug: string): Promise<{ id: string; updatedAt: string } | null> {
  if (!slug) return null
  const r = await ghostFetch(cfg, `/posts/slug/${encodeURIComponent(slug)}/?formats=html`)
  if ('error' in r || !r.res.ok) return null
  const p = (r.body as { posts?: Array<{ id?: string; updated_at?: string }> } | null)?.posts?.[0]
  return p?.id ? { id: p.id, updatedAt: p.updated_at || '' } : null
}

export interface GhostArticle {
  title: string
  bodyHtml: string
  slug: string
  excerpt?: string
  /** address of the original: the copy should link to it rather than compete with it in search results */
  canonicalUrl?: string
  status: 'published' | 'draft'
}

export async function ghostPublish(a: GhostArticle, s: AppSettings): Promise<GhostResult> {
  const cfg = ghostConfig(s)
  if (!cfg.siteUrl) return { attempted: false, ok: false, error: siteUrlError(s) }
  if (!cfg.keyId || !cfg.keySecret) {
    return { attempted: false, ok: false, error: 'Admin API key not set (expected id:secret format, secret in hex)' }
  }

  const existing = await findBySlug(cfg, a.slug)
  const post: Record<string, unknown> = {
    title: a.title,
    html: a.bodyHtml,
    slug: a.slug,
    status: a.status,
    ...(a.excerpt ? { custom_excerpt: a.excerpt.slice(0, 300) } : {}),
    ...(a.canonicalUrl ? { canonical_url: a.canonicalUrl } : {}),
    // updated_at is required when updating: without it Ghost returns 409
    ...(existing ? { updated_at: existing.updatedAt } : {}),
  }

  const r = existing
    ? await ghostFetch(cfg, `/posts/${existing.id}/?source=html`, { method: 'PUT', body: JSON.stringify({ posts: [post] }) })
    : await ghostFetch(cfg, '/posts/?source=html', { method: 'POST', body: JSON.stringify({ posts: [post] }) })

  if ('error' in r) return { attempted: true, ok: false, error: r.error }
  if (!r.res.ok) return { attempted: true, ok: false, status: r.res.status, error: messageFor(r.res.status, detailOf(r.body)) }
  const saved = (r.body as { posts?: Array<{ id?: string; url?: string }> } | null)?.posts?.[0]
  return { attempted: true, ok: true, status: r.res.status, id: saved?.id, url: saved?.url, updated: !!existing }
}

/** Unpublish: switch to draft — deleting someone else's content isn't our business. */
export async function ghostUnpublish(slug: string, s: AppSettings): Promise<GhostResult> {
  const cfg = ghostConfig(s)
  if (!cfg.siteUrl) return { attempted: false, ok: false, error: siteUrlError(s) }
  const existing = await findBySlug(cfg, slug)
  if (!existing) return { attempted: true, ok: true }
  const r = await ghostFetch(cfg, `/posts/${existing.id}/`, {
    method: 'PUT',
    body: JSON.stringify({ posts: [{ status: 'draft', updated_at: existing.updatedAt }] }),
  })
  if ('error' in r) return { attempted: true, ok: false, error: r.error }
  if (!r.res.ok) return { attempted: true, ok: false, status: r.res.status, error: messageFor(r.res.status, detailOf(r.body)) }
  return { attempted: true, ok: true, status: r.res.status, id: existing.id }
}

/** Connectivity check: ask the site about itself. Doesn't publish anything. */
export async function ghostTest(s: AppSettings): Promise<GhostResult & { title?: string }> {
  const cfg = ghostConfig(s)
  if (!cfg.siteUrl) return { attempted: false, ok: false, error: siteUrlError(s) }
  if (!cfg.keyId || !cfg.keySecret) {
    return { attempted: false, ok: false, error: 'Admin API key not set (expected id:secret format, secret in hex)' }
  }
  const r = await ghostFetch(cfg, '/site/')
  if ('error' in r) return { attempted: true, ok: false, error: r.error }
  if (!r.res.ok) return { attempted: true, ok: false, status: r.res.status, error: messageFor(r.res.status, detailOf(r.body)) }
  const site = (r.body as { site?: { title?: string; url?: string } } | null)?.site
  return { attempted: true, ok: true, status: r.res.status, title: site?.title, url: site?.url || cfg.siteUrl }
}
