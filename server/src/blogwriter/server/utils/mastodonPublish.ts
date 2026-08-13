/**
 * Announces an article on Mastodon.
 *
 * Mastodon is a federation: there's no single API host, each instance has its
 * own. So the user enters the instance address and gets the token there too
 * (Settings → Development → New application, write:statuses scope). No app
 * review, no fees, no restrictions on programmatically publishing your own
 * content — on that front Mastodon is the most honest channel of them all.
 *
 * The instance address comes from a form, and the request goes out from our
 * server — which means SSRF, which means checkPublicHttpsUrl (the same reason
 * as for WordPress).
 *
 * Idempotency without a dedicated column: we search our own feed for a post
 * with our link. Found one — we consider it already announced and don't post again.
 */
import type { AppSettings } from './appSettings'
import { groupMediaByPost, type MediaFile } from './crosspostMedia'
import { checkPublicHttpsUrl } from './safeUrl'
import { retryFetch } from './retryFetch'

const TIMEOUT_MS = 20_000
/**
 * Post character limit. Each instance has its own (mastodon.social is 500, some
 * are 5000), but the only way to find out is by asking. We use a conservative
 * 500: a post under that limit will be accepted everywhere, longer will be
 * rejected with a vague error.
 */
export const TOOT_LIMIT = 500

export interface MastodonConfig {
  instance: string
  token: string
  enabled: boolean
  ready: boolean
}

export function mastodonConfig(s: AppSettings): MastodonConfig {
  const checked = checkPublicHttpsUrl(s.mastodonInstance || '')
  const instance = checked.ok ? checked.url! : ''
  const token = (s.mastodonToken || '').trim()
  return { instance, token, enabled: !!s.mastodonEnabled, ready: !!(s.mastodonEnabled && instance && token) }
}

/** Why the address was rejected — "not set" would lie if it's set but bad. */
function instanceError(s: AppSettings): string {
  const c = checkPublicHttpsUrl(s.mastodonInstance || '')
  return c.ok ? 'instance address not set' : `instance address: ${c.error}`
}

export interface MastodonResult {
  attempted: boolean
  ok: boolean
  status?: number
  id?: string
  url?: string
  /** a post with this link was already in the feed — didn't publish a second time */
  skipped?: boolean
  error?: string
}

function messageFor(status?: number, fallback?: string): string {
  const map: Record<number, string> = {
    401: 'token rejected (401) — check the application token on the instance',
    403: 'this token lacks the write:statuses scope (403)',
    404: 'no Mastodon API at this address (404) — check the instance address',
    422: 'the instance rejected the post (422): usually a character-limit overrun',
    429: 'too many requests (429) — the instance is rate-limiting, try again later',
  }
  return (status && map[status]) || fallback || (status ? `HTTP ${status}` : 'network error')
}

async function mastoFetch(cfg: MastodonConfig, path: string, init: RequestInit = {}) {
  const method = (init.method || 'GET').toUpperCase()
  const out = await retryFetch(async () => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      return await fetch(`${cfg.instance}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.token}`,
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(t)
    }
  }, { method })
  if ('netError' in out) {
    return { error: out.netError === 'timeout' ? 'timeout (20s)' : out.netError } as const
  }
  return { res: out.res } as const
}

/**
 * Announcement text: title and link. The link is never truncated — a cut-off
 * URL is useless; if space is tight, the title is sacrificed instead.
 */
export function tootText(title: string, url: string, lead = ''): string {
  const link = (url || '').trim()
  const tail = link ? `\n\n${link}` : ''
  const room = TOOT_LIMIT - [...tail].length
  const head = (title || '').trim()
  const body = lead.trim() ? `${head}\n\n${lead.trim()}` : head
  const chars = [...body]
  return (chars.length <= room ? body : chars.slice(0, Math.max(0, room - 1)).join('').trimEnd() + '…') + tail
}

/** Who we are on this instance — also doubles as a token check. */
async function whoAmI(cfg: MastodonConfig): Promise<{ id?: string; acct?: string; error?: string; status?: number }> {
  const r = await mastoFetch(cfg, '/api/v1/accounts/verify_credentials')
  if ('error' in r) return { error: r.error }
  if (!r.res.ok) return { error: messageFor(r.res.status), status: r.res.status }
  try {
    const b = (await r.res.json()) as { id?: string; acct?: string }
    return { id: b.id, acct: b.acct }
  } catch { return { error: 'instance responded with non-JSON — is this really Mastodon?' } }
}

/** Already announced? We search our own feed for our link (no state stored). */
async function alreadyPosted(cfg: MastodonConfig, accountId: string, url: string): Promise<string | null> {
  if (!url) return null
  const r = await mastoFetch(cfg, `/api/v1/accounts/${encodeURIComponent(accountId)}/statuses?limit=40&exclude_replies=true`)
  if ('error' in r || !r.res.ok) return null
  try {
    const list = (await r.res.json()) as Array<{ id?: string; content?: string; card?: { url?: string } }>
    const hit = (Array.isArray(list) ? list : []).find(
      (x) => (x.content || '').includes(url) || x.card?.url === url,
    )
    return hit?.id || null
  } catch { return null }
}

export async function mastodonPublish(
  a: { title: string; url: string; lead?: string },
  s: AppSettings,
): Promise<MastodonResult> {
  const cfg = mastodonConfig(s)
  if (!cfg.instance) return { attempted: false, ok: false, error: instanceError(s) }
  if (!cfg.token) return { attempted: false, ok: false, error: 'application token not set' }
  if (!a.url) return { attempted: false, ok: false, error: 'no article URL — nothing to announce' }

  const me = await whoAmI(cfg)
  if (me.error || !me.id) return { attempted: true, ok: false, status: me.status, error: me.error || 'the instance didn\'t tell us who we are' }

  const existing = await alreadyPosted(cfg, me.id, a.url)
  if (existing) return { attempted: true, ok: true, id: existing, skipped: true }

  const r = await mastoFetch(cfg, '/api/v1/statuses', {
    method: 'POST',
    body: JSON.stringify({ status: tootText(a.title, a.url, a.lead), visibility: 'public' }),
  })
  if ('error' in r) return { attempted: true, ok: false, error: r.error }
  if (!r.res.ok) return { attempted: true, ok: false, status: r.res.status, error: messageFor(r.res.status) }
  try {
    const b = (await r.res.json()) as { id?: string; url?: string }
    return { attempted: true, ok: true, status: r.res.status, id: b.id, url: b.url }
  } catch {
    return { attempted: true, ok: true, status: r.res.status }
  }
}

/** Remove the announcement: Mastodon has real deletion, unlike Threads. */
export async function mastodonUnpublish(url: string, s: AppSettings): Promise<MastodonResult> {
  const cfg = mastodonConfig(s)
  if (!cfg.instance || !cfg.token) return { attempted: false, ok: false, error: 'channel not configured' }
  const me = await whoAmI(cfg)
  if (me.error || !me.id) return { attempted: true, ok: false, error: me.error || 'the instance didn\'t tell us who we are' }
  const existing = await alreadyPosted(cfg, me.id, url)
  if (!existing) return { attempted: true, ok: true } // nothing to remove — goal already achieved
  const r = await mastoFetch(cfg, `/api/v1/statuses/${encodeURIComponent(existing)}`, { method: 'DELETE' })
  if ('error' in r) return { attempted: true, ok: false, error: r.error }
  if (!r.res.ok) return { attempted: true, ok: false, status: r.res.status, error: messageFor(r.res.status) }
  return { attempted: true, ok: true, status: r.res.status, id: existing }
}

/** Connectivity check: ask the instance who we are. Doesn't publish anything. */
export async function mastodonTest(s: AppSettings): Promise<MastodonResult & { acct?: string }> {
  const cfg = mastodonConfig(s)
  if (!cfg.instance) return { attempted: false, ok: false, error: instanceError(s) }
  if (!cfg.token) return { attempted: false, ok: false, error: 'application token not set' }
  const me = await whoAmI(cfg)
  if (me.error) return { attempted: true, ok: false, status: me.status, error: me.error }
  return { attempted: true, ok: true, id: me.id, acct: me.acct, url: me.acct ? `${cfg.instance}/@${me.acct}` : cfg.instance }
}

// --- Thread for the composer --------------------------------------------------- //
// mastodonPublish sends an article announcement — a single status with a link.
// The composer needs something different: a thread of edited posts, chained
// together as replies via in_reply_to_id.

export interface MastodonThreadResult {
  attempted: boolean
  ok: boolean
  /** ids of published posts in order (partial — if the thread broke off) */
  ids: string[]
  url?: string
  error?: string
  /** not all media made it — the text was still published (not fatal) */
  mediaError?: string
}

// --- Media in a thread --------------------------------------------------------- //
// Mastodon won't accept a file by URL: first POST /api/v2/media (multipart),
// then media_ids on the status. The instance transcodes video, so the upload can
// return 202 "accepted, processing" — an attachment like that can't be attached
// right away, the instance would return 422. We wait for it to be ready by
// polling /api/v1/media/:id.
//
// media_ids live ON THE STATUS, so we distribute attachments across thread posts
// (media.postIndex): the "4 images OR 1 video" limit is also per-status, not per
// thread. It used to be that all media landed on the first post.

const MEDIA_TIMEOUT_MS = 60_000 // how long we wait for both upload and video processing
const MEDIA_POLL_MS = 2_000
const MAX_ATTACHMENTS = 4 // images per ONE status (video — strictly one, and no images)

/**
 * What we actually attach. Mastodon doesn't mix video with images in one
 * status: if there are images — take up to 4 images, drop video; if it's just
 * video — take the first one.
 */
function pickAttachments(files: MediaFile[]): { pick: MediaFile[]; note?: string } {
  const images = files.filter((f) => f.type === 'image')
  if (!images.length) {
    const videos = files.filter((f) => f.type === 'video')
    return videos.length > 1
      ? { pick: videos.slice(0, 1), note: 'Mastodon only takes one video per post — the rest were skipped' }
      : { pick: videos }
  }
  const note = files.length > images.length
    ? 'video can\'t be mixed with images in one Mastodon post — video skipped'
    : (images.length > MAX_ATTACHMENTS ? `more than ${MAX_ATTACHMENTS} images — extras dropped` : undefined)
  return { pick: images.slice(0, MAX_ATTACHMENTS), note }
}

/** Wait for the instance to finish processing an attachment (202 → 206 → 200). */
async function waitMediaReady(cfg: MastodonConfig, id: string): Promise<string | undefined> {
  const deadline = Date.now() + MEDIA_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, MEDIA_POLL_MS))
    const r = await mastoFetch(cfg, `/api/v1/media/${encodeURIComponent(id)}`)
    if ('error' in r) return r.error
    await r.res.json().catch(() => ({})) // body isn't needed, but the connection still has to be released
    if (r.res.ok && r.res.status !== 206) return undefined // done
    if (r.res.status !== 206) return messageFor(r.res.status)
  }
  return 'the instance didn\'t finish processing the file within a minute'
}

/** Upload a single file. We don't set Content-Type manually — fetch sets the boundary. */
async function uploadMedia(cfg: MastodonConfig, file: MediaFile): Promise<{ id: string } | { error: string }> {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name)

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), MEDIA_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(`${cfg.instance}/api/v2/media`, {
      method: 'POST',
      body: form,
      headers: { Authorization: `Bearer ${cfg.token}` },
      signal: ctrl.signal,
    })
  } catch (e: any) {
    return { error: e?.name === 'AbortError' ? 'upload timeout (60s)' : (e?.message || 'network error') }
  } finally {
    clearTimeout(t)
  }
  if (!res.ok) return { error: messageFor(res.status) }

  const b = (await res.json().catch(() => ({}))) as { id?: string; url?: string | null }
  if (!b.id) return { error: 'the instance didn\'t return an attachment id' }
  // 202 (or an empty url) = file is still processing
  if (res.status === 202 || !b.url) {
    const err = await waitMediaReady(cfg, b.id)
    if (err) return { error: err }
  }
  return { id: b.id }
}

export async function mastodonPublishThread(posts: string[], s: AppSettings, media: MediaFile[] = []): Promise<MastodonThreadResult> {
  const cfg = mastodonConfig(s)
  if (!cfg.instance) return { attempted: false, ok: false, ids: [], error: instanceError(s) }
  if (!cfg.token) return { attempted: false, ok: false, ids: [], error: 'application token not set' }
  const list = (posts || []).map((x) => String(x || '').trim()).filter(Boolean)
  if (!list.length) return { attempted: false, ok: false, ids: [], error: 'empty thread' }

  // distribute attachments across thread posts: media_ids get attached to the status
  const byPost = groupMediaByPost(media, list.length)
  const mediaNotes: string[] = []

  const ids: string[] = []
  let url = ''
  let replyTo = ''
  for (let i = 0; i < list.length; i++) {
    // upload this status's files right before it: it needs the media_ids already,
    // and a failed upload isn't fatal — the status goes out without the attachment, reason in mediaError
    const mediaIds: string[] = []
    if (byPost[i]!.length) {
      const { pick, note } = pickAttachments(byPost[i]!)
      if (note) mediaNotes.push(`post ${i + 1}: ${note}`)
      for (const f of pick) {
        const up = await uploadMedia(cfg, f)
        if ('error' in up) mediaNotes.push(`${f.name}: ${up.error}`)
        else mediaIds.push(up.id)
      }
    }
    const mediaError = mediaNotes.length ? mediaNotes.join('; ') : undefined

    const r = await mastoFetch(cfg, '/api/v1/statuses', {
      method: 'POST',
      body: JSON.stringify({
        status: list[i],
        visibility: 'public',
        ...(mediaIds.length ? { media_ids: mediaIds } : {}),
        ...(replyTo ? { in_reply_to_id: replyTo } : {}),
      }),
    })
    if ('error' in r || !r.res.ok) {
      const err = 'error' in r ? r.error : messageFor(r.res.status)
      return {
        attempted: true, ok: false, ids, url: url || undefined,
        error: ids.length ? `${err} — thread broke off at post ${i + 1} of ${list.length}` : err,
        mediaError,
      }
    }
    const b = (await r.res.json().catch(() => ({}))) as { id?: string; url?: string }
    if (!b.id) return { attempted: true, ok: false, ids, error: 'the instance didn\'t return a post id', mediaError }
    ids.push(b.id)
    replyTo = b.id
    if (!url && b.url) url = b.url
  }
  return {
    attempted: true, ok: true, ids, url: url || undefined,
    mediaError: mediaNotes.length ? mediaNotes.join('; ') : undefined,
  }
}

/** Delete the thread's posts. From the end: replies must be removed before the root. */
export async function mastodonDeleteMany(ids: string[], s: AppSettings): Promise<{ ok: boolean; removed: number; leftover: string[] }> {
  const cfg = mastodonConfig(s)
  const list = (ids || []).filter(Boolean)
  if (!list.length) return { ok: true, removed: 0, leftover: [] }
  if (!cfg.instance || !cfg.token) return { ok: false, removed: 0, leftover: list }

  const leftover: string[] = []
  for (const id of [...list].reverse()) {
    const r = await mastoFetch(cfg, `/api/v1/statuses/${encodeURIComponent(id)}`, { method: 'DELETE' })
    // 404 = the post is already gone: goal achieved
    if ('error' in r || (!r.res.ok && r.res.status !== 404)) leftover.push(id)
  }
  return { ok: leftover.length === 0, removed: list.length - leftover.length, leftover }
}
