/**
 * Publishes an article to a WordPress blog.
 *
 * WordPress has two worlds, and it's not two different channels but two ways
 * to access the same thing:
 *
 *  · 'app'   — application password (Application Passwords, core since 5.6).
 *              Works on ANY self-hosted site instantly, without plugins or app
 *              registration. We write directly to /wp-json/wp/v2/posts.
 *  · 'oauth' — OAuth via WordPress.com. Covers both wordpress.com-hosted blogs
 *              and self-hosted sites connected to Jetpack: those sites show up
 *              in the same /me/sites, and publishing goes through
 *              public-api.wordpress.com. Requires a registered app (client
 *              id/secret in env).
 *
 * Idempotency — without a dedicated DB column, same as dev.to and Bluesky: we
 * search the site for a post with the same slug. Found one — update, no match — create.
 */
import type { AppSettings } from './appSettings'
import { checkPublicHttpsUrl } from './safeUrl'

const TIMEOUT_MS = 20_000
const DOTCOM = 'https://public-api.wordpress.com/rest/v1.1'

export interface WpConfig {
  mode: 'app' | 'oauth'
  siteUrl: string
  user: string
  appPassword: string
  oauthToken: string
  enabled: boolean
  ready: boolean
}

export function wpConfig(s: AppSettings): WpConfig {
  const mode = s.wpMode === 'oauth' ? 'oauth' : 'app'
  // The address comes from a form, and the request goes out from our server —
  // so we only allow public https. Otherwise the "site address" field could be
  // used to knock on our own internal network (see safeUrl.ts).
  const checked = checkPublicHttpsUrl(s.wpSiteUrl || '')
  const siteUrl = checked.ok ? checked.url! : ''
  const user = (s.wpUser || '').trim()
  const appPassword = (s.wpAppPassword || '').trim()
  const oauthToken = (s.wpOauthToken || '').trim()
  const ready = !!s.wpEnabled && !!siteUrl && (mode === 'oauth' ? !!oauthToken : !!(user && appPassword))
  return { mode, siteUrl, user, appPassword, oauthToken, enabled: !!s.wpEnabled, ready }
}

/** Why the address was rejected — otherwise "not set" would lie when it's set but bad. */
function siteUrlError(s: AppSettings): string {
  const c = checkPublicHttpsUrl(s.wpSiteUrl || '')
  return c.ok ? 'site address not set' : `site address: ${c.error}`
}

export interface WpResult {
  attempted: boolean
  ok: boolean
  status?: number
  id?: number
  url?: string
  updated?: boolean
  error?: string
}

function messageFor(status?: number, fallback?: string): string {
  const map: Record<number, string> = {
    401: 'access rejected (401) — check the login and application password',
    403: 'access forbidden (403): the user lacks publishing rights',
    404: 'REST API not found (404) — /wp-json is disabled on the site or the address is wrong',
    409: 'slug conflict (409)',
  }
  return (status && map[status]) || fallback || (status ? `HTTP ${status}` : 'network error')
}

/** The site host in the format WordPress.com REST expects (site slug). */
const siteSlug = (siteUrl: string) =>
  encodeURIComponent(siteUrl.replace(/^https?:\/\//, '').replace(/\/+$/, ''))

async function wpFetch(cfg: WpConfig, path: string, init: RequestInit = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  const base = cfg.mode === 'oauth'
    ? `${DOTCOM}/sites/${siteSlug(cfg.siteUrl)}`
    : `${cfg.siteUrl}/wp-json/wp/v2`
  const auth = cfg.mode === 'oauth'
    ? { Authorization: `Bearer ${cfg.oauthToken}` }
    // Application Password: plain Basic auth. WordPress shows spaces in the
    // password for readability and ignores them itself — we strip them, otherwise Basic auth wouldn't match
    : { Authorization: 'Basic ' + Buffer.from(`${cfg.user}:${cfg.appPassword.replace(/\s+/g, '')}`).toString('base64') }
  try {
    return await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...auth, ...(init.headers as Record<string, string> | undefined) },
      signal: ctrl.signal,
    })
  } catch (e: any) {
    return { error: e?.name === 'AbortError' ? 'timeout (20s)' : (e?.message || 'network error') } as const
  } finally {
    clearTimeout(t)
  }
}

/** Already published? We search for a post with the same slug — no state stored. */
async function findBySlug(cfg: WpConfig, slug: string): Promise<number | null> {
  if (!slug) return null
  const path = cfg.mode === 'oauth'
    ? `/posts/slug:${encodeURIComponent(slug)}`
    : `/posts?slug=${encodeURIComponent(slug)}&status=publish,draft&per_page=1`
  const r = await wpFetch(cfg, path)
  if ('error' in r || !r.ok) return null
  try {
    const body = await r.json()
    if (cfg.mode === 'oauth') return (body as { ID?: number }).ID ?? null
    const list = body as Array<{ id: number }>
    return Array.isArray(list) && list[0] ? list[0].id : null
  } catch {
    return null
  }
}

export interface WpArticle {
  title: string
  bodyHtml: string
  slug: string
  excerpt?: string
  status: 'publish' | 'draft'
}

export async function wpPublish(a: WpArticle, s: AppSettings): Promise<WpResult> {
  const cfg = wpConfig(s)
  if (!cfg.siteUrl) return { attempted: false, ok: false, error: siteUrlError(s) }
  if (cfg.mode === 'oauth' && !cfg.oauthToken) return { attempted: false, ok: false, error: 'site not connected via OAuth' }
  if (cfg.mode === 'app' && !(cfg.user && cfg.appPassword)) {
    return { attempted: false, ok: false, error: 'login or application password not set' }
  }

  const existing = await findBySlug(cfg, a.slug)
  const payload = cfg.mode === 'oauth'
    ? { title: a.title, content: a.bodyHtml, slug: a.slug, excerpt: a.excerpt || '', status: a.status }
    : { title: a.title, content: a.bodyHtml, slug: a.slug, excerpt: a.excerpt || '', status: a.status }

  const path = cfg.mode === 'oauth'
    ? (existing ? `/posts/${existing}` : '/posts/new')
    : (existing ? `/posts/${existing}` : '/posts')

  const r = await wpFetch(cfg, path, { method: 'POST', body: JSON.stringify(payload) })
  if ('error' in r) return { attempted: true, ok: false, error: r.error }
  if (!r.ok) return { attempted: true, ok: false, status: r.status, error: messageFor(r.status) }
  try {
    const b = (await r.json()) as { id?: number; ID?: number; link?: string; URL?: string }
    return {
      attempted: true, ok: true, status: r.status,
      id: b.id ?? b.ID, url: b.link ?? b.URL, updated: !!existing,
    }
  } catch {
    return { attempted: true, ok: true, status: r.status, updated: !!existing }
  }
}

/** Unpublish: switch it to a draft (deleting someone else's content isn't our business). */
export async function wpUnpublish(slug: string, s: AppSettings): Promise<WpResult> {
  const cfg = wpConfig(s)
  if (!cfg.siteUrl) return { attempted: false, ok: false, error: siteUrlError(s) }
  const existing = await findBySlug(cfg, slug)
  if (!existing) return { attempted: true, ok: true }
  const r = await wpFetch(cfg, `/posts/${existing}`, {
    method: 'POST',
    body: JSON.stringify({ status: 'draft' }),
  })
  if ('error' in r) return { attempted: true, ok: false, error: r.error }
  if (!r.ok) return { attempted: true, ok: false, status: r.status, error: messageFor(r.status) }
  return { attempted: true, ok: true, status: r.status, id: existing }
}

/** Access check: ask the site about itself, without publishing anything. */
export async function wpTest(s: AppSettings): Promise<WpResult> {
  const cfg = wpConfig(s)
  if (!cfg.siteUrl) return { attempted: false, ok: false, error: siteUrlError(s) }
  const r = await wpFetch(cfg, cfg.mode === 'oauth' ? '' : '/users/me?context=edit')
  if ('error' in r) return { attempted: true, ok: false, error: r.error }
  if (!r.ok) return { attempted: true, ok: false, status: r.status, error: messageFor(r.status) }
  return { attempted: true, ok: true, status: r.status, url: cfg.siteUrl }
}
