/**
 * Auto-publish articles to an external blog over the REST ingest API (ported from
 * standalone blogApi.ts + blogPublish.ts). In settings, the user provides the BASE
 * URL of their blog API plus an auth header with a token; on publish we do an
 * idempotent upsert, on unpublish we delete. Full contract (see UI
 * "Settings" -> "Auto-publish" -> API docs):
 *
 *   Base URL: <extPublishUrl>            Auth: <extPublishAuthHeader>: <extPublishToken>
 *   POST   {base}/blog/ingest            - upsert a post (idempotent by sourceId, then slug)
 *   PUT    {base}/blog/ingest/:id        - partial update (by id, obtained from ingest)
 *   DELETE {base}/blog/ingest/:id        - delete a post by id
 *   DELETE {base}/blog/ingest?sourceId=  - delete by our sourceId (when we don't store id)
 *   POST   {base}/blog/ingest/:id/cover  - upload a cover image as bytes (multipart) -> { id, coverUrl }
 *
 * We use POST /blog/ingest (upsert by sourceId = run id) + coverImageUrl in the
 * body; on unpublish - DELETE ?sourceId. PUT/cover are documented as part of the
 * contract so the receiver stays compatible with both modes.
 */
import {
  pruneEmpty, validateIngest,
  type BlogIngestPayload, type BlogIngestResult, type BlogStatus,
} from '../../shared/blog/dto'
import type { AppSettings } from './appSettings'
import { blogPrisma } from './prisma'
import { checkPublicHttpsUrl } from './safeUrl'

export interface ExtConfig {
  base: string
  header: string
  token: string
  enabled: boolean
  ready: boolean // enabled + base + token are set
}

export function extConfig(s: AppSettings): ExtConfig {
  const base = (s.extPublishUrl || '').replace(/\/+$/, '')
  const header = (s.extPublishAuthHeader || 'Authorization').trim() || 'Authorization'
  const token = (s.extPublishToken || '').trim()
  return { base, header, token, enabled: !!s.extPublishEnabled, ready: !!(s.extPublishEnabled && base && token) }
}

/**
 * Does the base URL point at Ideata ITSELF? Then there's no need to make an HTTP
 * call to ourselves (we don't have a /blog/ingest receiver, that would 404) - we
 * publish directly to the native blog instead (publish.ts already writes BlogPost).
 * Our own hosts: *.ideata.io + PUBLIC_BASE_URL + SELF_HOST. An empty base is
 * treated as "no external target set" (not self).
 */
export function isSelfHost(base: string): boolean {
  const b = (base || '').trim().toLowerCase()
  if (!b) return false
  let host = b
  try { host = new URL(b.includes('://') ? b : `https://${b}`).host } catch { /* use as-is */ }
  host = host.replace(/^www\./, '').split(':')[0]
  const selves = new Set<string>(['ideata.io', 'api.ideata.io'])
  for (const envVar of [process.env.PUBLIC_BASE_URL, process.env.SELF_HOST]) {
    const v = (envVar || '').trim().toLowerCase()
    if (!v) continue
    try { selves.add(new URL(v.includes('://') ? v : `https://${v}`).host.replace(/^www\./, '').split(':')[0]) }
    catch { selves.add(v) }
  }
  return selves.has(host) || host.endsWith('.ideata.io')
}

export interface ExtResult {
  attempted: boolean
  ok: boolean
  status?: number
  id?: number
  slug?: string
  error?: string
  native?: boolean // target is Ideata itself: published directly, without HTTP ingest
  cleaned?: boolean // connection test: whether the test draft was cleaned up afterwards
  leftoverDraft?: boolean // connection test: draft was left on the site (remove manually)
}

/** Human-readable message for a status code (upstream may hide details). */
function messageFor(status?: number, fallback?: string): string {
  const map: Record<number, string> = {
    400: 'validation error or malformed coverImageUrl (400)',
    401: 'token was not accepted (401)',
    403: 'token was rejected (403) - check the header and value',
    404: 'post not found (404)',
    409: 'slug already taken (409)',
  }
  return (status && map[status]) || fallback || (status ? `HTTP ${status}` : 'network error')
}

/**
 * Low-level call to the ingest API with the auth header. Does not throw - returns {res|error}.
 *
 * The base URL comes from the settings form, and the request goes out from our
 * server, so before EVERY call we run it through checkPublicHttpsUrl: the setting
 * could have been saved before the controller-side check existed (or via a direct
 * DB update), and without it auto-publish would be a ready-made SSRF into the
 * internal network with our token.
 */
async function extFetch(cfg: ExtConfig, path: string, init: RequestInit): Promise<Response | { error: string }> {
  const chk = checkPublicHttpsUrl(cfg.base)
  if (!chk.ok) return { error: `receiver address not accepted: ${chk.error}` }
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const headers: Record<string, string> = { [cfg.header]: cfg.token, ...(init.headers as any) }
    return await fetch(`${chk.url}${path}`, { ...init, headers, signal: ctrl.signal })
  } catch (e: any) {
    return { error: e?.name === 'AbortError' ? 'timeout (15s)' : (e?.message || 'network error') }
  } finally {
    clearTimeout(t)
  }
}

/**
 * POST /blog/ingest - idempotent upsert. Returns { id, slug } on success.
 * Settings are REQUIRED and are resolved by the caller per the run's brand: there
 * is no silent fallback to account-wide (brandId=0) - otherwise one brand's config
 * (insane) would apply "by default" to all of them. No config for the brand ->
 * attempted:false.
 */
export async function ingestPost(payload: BlogIngestPayload, s: AppSettings): Promise<ExtResult> {
  const cfg = extConfig(s)
  // Our own domain -> direct: the article is already published natively (publish.ts -> BlogPost),
  // an external HTTP ingest call to ourselves isn't needed (and we don't have a /blog/ingest receiver).
  if (isSelfHost(cfg.base)) return { attempted: true, ok: true, native: true }
  if (!cfg.base || !cfg.token) return { attempted: false, ok: false, error: 'base URL or token not set' }

  const errs = validateIngest(payload)
  if (Object.keys(errs).length) return { attempted: false, ok: false, error: Object.values(errs).join('; ') }

  const r = await extFetch(cfg, '/blog/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(pruneEmpty(payload)),
  })
  if ('error' in r) return { attempted: true, ok: false, error: r.error }
  if (!r.ok) return { attempted: true, ok: false, status: r.status, error: messageFor(r.status) }
  let body: BlogIngestResult | undefined
  try { body = (await r.json()) as BlogIngestResult } catch { /* body isn't JSON - fine, upsert succeeded */ }
  return { attempted: true, ok: true, status: r.status, id: body?.id, slug: body?.slug }
}

/** DELETE /blog/ingest?sourceId=<id> - unpublish a post by our sourceId. Settings - by the run's brand (see ingestPost). */
export async function ingestDelete(sourceId: string, s: AppSettings): Promise<ExtResult> {
  const cfg = extConfig(s)
  // Our own domain -> unpublish is already done natively (removeRunFromBlog -> BlogPost.delete).
  if (isSelfHost(cfg.base)) return { attempted: true, ok: true, native: true }
  if (!cfg.base || !cfg.token) return { attempted: false, ok: false, error: 'base URL or token not set' }
  const r = await extFetch(cfg, `/blog/ingest?sourceId=${encodeURIComponent(sourceId)}`, { method: 'DELETE' })
  if ('error' in r) return { attempted: true, ok: false, error: r.error }
  // 404 = already deleted on the other side -> treat as success
  if (!r.ok && r.status !== 404) return { attempted: true, ok: false, status: r.status, error: messageFor(r.status) }
  return { attempted: true, ok: true, status: r.status }
}

/** Build a BlogIngestPayload from the article's ready fields (sourceId = run id - the idempotency key). */
export function buildIngest(a: {
  sourceId: string
  title: string
  bodyHtml: string
  bodyMd?: string
  slug?: string
  locale?: string
  status: BlogStatus
  topic?: string
  category?: string
  author?: string
  wordCount?: number
  coverImageUrl?: string
}): BlogIngestPayload {
  return pruneEmpty({
    sourceId: a.sourceId,
    title: (a.title || '').trim(),
    bodyHtml: a.bodyHtml,
    bodyMd: a.bodyMd || '',
    slug: a.slug || '',
    locale: a.locale || '',
    status: a.status,
    topic: a.topic || '',
    category: a.category || '',
    author: (a.author || '').trim(),
    ...(a.wordCount && a.wordCount > 0 ? { wordCount: a.wordCount } : {}),
    // absolute http(s) cover image URL - the receiver will download and re-upload it itself
    ...(a.coverImageUrl && /^https?:\/\//.test(a.coverImageUrl) ? { coverImageUrl: a.coverImageUrl } : {}),
  }) as BlogIngestPayload
}

// --- receiver read API (GET /blog/ingest, GET /blog/ingest/:id) ------------ //
// Symmetric to the write contract, same auth header. Used by the import feature
// to "pull the receiver's existing posts into the blog writer".

/** A post on the receiver (shape of BlogPostEntity per the ingest contract). */
export interface ExtRemotePost {
  id: number
  sourceId: string | null // our run id, if the post originated from Ideata
  slug: string
  locale: string
  status: string // draft | published
  title: string
  topic: string
  category: string
  author: string
  bodyHtml: string
  bodyMd: string
  excerpt: string
  coverUrl: string
  wordCount: number
  views: number
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ExtListQuery { status?: string; locale?: string; category?: string; page?: number; limit?: number }
export interface ExtListResult {
  ok: boolean
  status?: number
  items: ExtRemotePost[]
  total: number
  page: number
  limit: number
  error?: string
}

/**
 * Own domain -> read the NATIVE blog (BlogPost) directly, without HTTP. The
 * locale/topic/category/author fields live in tags (see publish.ts), views are
 * taken from the runs linked to the posts (blog_post_id).
 */
async function nativeListAsExt(query: ExtListQuery = {}): Promise<ExtListResult> {
  const limit = Math.min(Math.max(query.limit || 50, 1), 50)
  const page = query.page && query.page > 0 ? query.page : 1
  const where: any = {}
  if (query.status) where.status = query.status
  const total = await blogPrisma().blogPost.count({ where })
  const rows = await blogPrisma().blogPost.findMany({
    where, orderBy: { id: 'desc' }, skip: (page - 1) * limit, take: limit,
  })
  const ids = rows.map((r) => r.id).filter(Boolean)
  const runs = ids.length
    ? await blogPrisma().blogRun.findMany({ where: { blog_post_id: { in: ids } }, select: { blog_post_id: true, views: true } })
    : []
  const viewsByPost = new Map<number, number>()
  for (const r of runs) viewsByPost.set(r.blog_post_id, (viewsByPost.get(r.blog_post_id) || 0) + (r.views || 0))
  const items: ExtRemotePost[] = rows.map((p) => {
    const tags: string[] = Array.isArray(p.tags) ? (p.tags as any[]).map(String) : []
    const pick = (pfx: string) => (tags.find((t) => t.startsWith(`${pfx}:`)) || '').slice(pfx.length + 1)
    return {
      id: p.id, sourceId: null, slug: p.slug, locale: pick('locale'), status: p.status,
      title: p.title, topic: pick('topic'), category: tags.find((t) => !t.includes(':')) || '',
      author: pick('author'), bodyHtml: p.body || '', bodyMd: '', excerpt: p.excerpt || '',
      coverUrl: p.coverUrl || '', wordCount: 0, views: viewsByPost.get(p.id) || 0,
      publishedAt: p.publishedAt ? new Date(p.publishedAt).toISOString() : null,
      createdAt: new Date(p.createdAt).toISOString(), updatedAt: new Date(p.createdAt).toISOString(),
    }
  })
  return { ok: true, status: 200, items, total, page, limit }
}

/** GET /blog/ingest - list of the receiver's posts (including drafts), with bodies. Settings - by brand (see ingestPost). */
export async function ingestListRemote(query: ExtListQuery = {}, s: AppSettings): Promise<ExtListResult> {
  const cfg = extConfig(s)
  const empty = { items: [], total: 0, page: 1, limit: 0 }
  // Own domain -> read the native blog directly (we don't have an HTTP receiver).
  if (isSelfHost(cfg.base)) return await nativeListAsExt(query)
  if (!cfg.base || !cfg.token) return { ok: false, ...empty, error: 'base URL or token not set' }
  const qs = new URLSearchParams()
  if (query.status) qs.set('status', query.status)
  if (query.locale) qs.set('locale', query.locale)
  if (query.category) qs.set('category', query.category)
  qs.set('page', String(query.page && query.page > 0 ? query.page : 1))
  qs.set('limit', String(Math.min(Math.max(query.limit || 50, 1), 50))) // receiver caps limit at 50
  const r = await extFetch(cfg, `/blog/ingest?${qs.toString()}`, { method: 'GET' })
  if ('error' in r) return { ok: false, ...empty, error: r.error }
  if (!r.ok) return { ok: false, ...empty, status: r.status, error: messageFor(r.status) }
  try {
    const body = (await r.json()) as { items?: ExtRemotePost[]; total?: number; page?: number; limit?: number }
    return {
      ok: true, status: r.status,
      items: Array.isArray(body.items) ? body.items : [],
      total: body.total || 0, page: body.page || 1, limit: body.limit || 0,
    }
  } catch {
    return { ok: false, ...empty, status: r.status, error: 'receiver response is not JSON' }
  }
}

/** GET /blog/ingest/:id - a single post in full. Settings - by brand (see ingestPost). */
export async function ingestGetRemote(id: number, s: AppSettings): Promise<{ ok: boolean; post?: ExtRemotePost; status?: number; error?: string }> {
  const cfg = extConfig(s)
  if (!cfg.base || !cfg.token) return { ok: false, error: 'base URL or token not set' }
  const r = await extFetch(cfg, `/blog/ingest/${id}`, { method: 'GET' })
  if ('error' in r) return { ok: false, error: r.error }
  if (!r.ok) return { ok: false, status: r.status, error: messageFor(r.status) }
  try { return { ok: true, status: r.status, post: (await r.json()) as ExtRemotePost } }
  catch { return { ok: false, status: r.status, error: 'receiver response is not JSON' } }
}

/** id of the test post - also the idempotency key and the delete key. */
const TEST_SOURCE_ID = 'ideata-test'

/**
 * Auto-publish test: sends a sample post to the configured ingest API. Settings -
 * by the active brand (see ingestPost).
 *
 * The post goes out as a DRAFT and is deleted right away: previously, "Test
 * connection" would publish an article with status:'published' to the client's
 * live site and not clean it up - the settings test button was silently dumping
 * junk into someone else's blog.
 * cleaned=false + leftoverDraft=true - the draft was left behind, remove it manually.
 */
export async function testExternal(s: AppSettings): Promise<ExtResult> {
  const settings = s
  const cfg = extConfig(settings)
  // Own domain -> publish directly, nothing to check over HTTP: the connection is "native".
  if (isSelfHost(cfg.base)) return { attempted: true, ok: true, native: true, status: 200 }
  if (!cfg.base) return { attempted: false, ok: false, error: 'base URL not set' }
  if (!cfg.token) return { attempted: false, ok: false, error: 'token not set' }
  const payload = buildIngest({
    sourceId: TEST_SOURCE_ID, title: 'Ideata Test Article',
    bodyHtml: '<h2>Heading</h2><p>This is a test post from Ideata Blog-writer - the integration works.</p>',
    slug: 'ideata-test-post', locale: settings.language || 'ru', status: 'draft',
    topic: 'test', category: 'Test',
  })
  const res = await ingestPost(payload, { ...settings, extPublishEnabled: true })
  if (!res.ok) return res
  const del = await ingestDelete(TEST_SOURCE_ID, { ...settings, extPublishEnabled: true })
  return { ...res, cleaned: del.ok, leftoverDraft: !del.ok }
}
