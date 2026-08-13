/**
 * Crossposts an article announcement to Bluesky (AT Protocol) using the brand's app password.
 *
 * Why Bluesky right after dev.to: the protocol is open, publishing your own
 * content is a standard scenario, there's no app review, no fees. Of the
 * mainstream social networks, it's the only one you can post to programmatically
 * without working around anything.
 *
 * Authorization is an app password (Settings → App Passwords), NOT the main
 * account password: it can be revoked with one click and doesn't grant access
 * to changing the email.
 *
 * Idempotency without a new DB column — the same trick as dev.to: before
 * publishing we check our latest feed for a post linking to this article.
 * Found one — don't post again. Not worth adding a migration to the shared
 * schema (where db push wipes out the scraper's tables) for a single field.
 */
import type { AppSettings } from './appSettings'
import { groupMediaByPost, type MediaFile } from './crosspostMedia'

const HOST = 'https://bsky.social'
const TIMEOUT_MS = 15_000
const LIMIT = 300 // post limit in graphemes

export interface BskyConfig {
  handle: string
  appPassword: string
  enabled: boolean
  ready: boolean
}

export function bskyConfig(s: AppSettings): BskyConfig {
  const handle = (s.blueskyHandle || '').trim().replace(/^@/, '')
  const appPassword = (s.blueskyAppPassword || '').trim()
  return {
    handle, appPassword,
    enabled: !!s.blueskyEnabled,
    ready: !!(s.blueskyEnabled && handle && appPassword),
  }
}

export interface BskyResult {
  attempted: boolean
  ok: boolean
  uri?: string
  /** true — the post already existed, didn't publish a second time */
  skipped?: boolean
  error?: string
}

async function call(path: string, init: RequestInit = {}, token?: string) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    return await fetch(`${HOST}/xrpc/${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
      signal: ctrl.signal,
    })
  } catch (e: any) {
    return { error: e?.name === 'AbortError' ? 'timeout (15s)' : (e?.message || 'network error') } as const
  } finally {
    clearTimeout(t)
  }
}

async function session(cfg: BskyConfig): Promise<{ jwt: string; did: string } | { error: string }> {
  const r = await call('com.atproto.server.createSession', {
    method: 'POST',
    body: JSON.stringify({ identifier: cfg.handle, password: cfg.appPassword }),
  })
  if ('error' in r) return { error: r.error }
  if (!r.ok) {
    return { error: r.status === 401
      ? 'handle or app password rejected (401). You need an app password from Bluesky settings, not the main password'
      : `HTTP ${r.status}` }
  }
  try {
    const b = (await r.json()) as { accessJwt: string; did: string }
    return { jwt: b.accessJwt, did: b.did }
  } catch {
    return { error: 'Bluesky response is not JSON' }
  }
}

/**
 * Announcement text. Built deterministically, without an LLM: title + link.
 * Repackaging via a model exists in the content factory, but there's no reason
 * to spend tokens on an announcement for every publish — and it would still
 * need to be truncated to the limit anyway.
 */
export function bskyText(title: string, url: string, excerpt?: string): string {
  const tail = url ? `\n\n${url}` : ''
  const room = LIMIT - [...tail].length
  const head = (title || '').trim()
  const lead = (excerpt || '').trim()
  let body = head
  if (lead && [...head].length + [...lead].length + 2 <= room) body = `${head}\n\n${lead}`
  const chars = [...body]
  if (chars.length > room) body = chars.slice(0, Math.max(0, room - 1)).join('').trimEnd() + '…'
  return body + tail
}

/** A link in Bluesky is only clickable with facet markup using BYTE positions. */
function linkFacet(text: string, url: string) {
  if (!url) return undefined
  const bytes = Buffer.from(text, 'utf8')
  const idx = bytes.indexOf(Buffer.from(url, 'utf8'))
  if (idx < 0) return undefined
  return [{
    index: { byteStart: idx, byteEnd: idx + Buffer.byteLength(url, 'utf8') },
    features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
  }]
}

/** Already posted this article? We search for the link in our recent feed. */
async function alreadyPosted(did: string, jwt: string, url: string): Promise<string | null> {
  if (!url) return null
  const r = await call(`app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(did)}&limit=50`, {}, jwt)
  if ('error' in r || !r.ok) return null
  try {
    const b = (await r.json()) as { feed?: Array<{ post?: { uri?: string; record?: { text?: string } } }> }
    const hit = (b.feed || []).find((x) => String(x.post?.record?.text || '').includes(url))
    return hit?.post?.uri || null
  } catch {
    return null
  }
}

export async function bskyPublish(
  a: { title: string; url: string; excerpt?: string },
  s: AppSettings,
): Promise<BskyResult> {
  const cfg = bskyConfig(s)
  if (!cfg.handle || !cfg.appPassword) return { attempted: false, ok: false, error: 'handle or app password not set' }

  const ses = await session(cfg)
  if ('error' in ses) return { attempted: true, ok: false, error: ses.error }

  const existing = await alreadyPosted(ses.did, ses.jwt, a.url)
  if (existing) return { attempted: true, ok: true, uri: existing, skipped: true }

  const text = bskyText(a.title, a.url, a.excerpt)
  const r = await call('com.atproto.repo.createRecord', {
    method: 'POST',
    body: JSON.stringify({
      repo: ses.did,
      collection: 'app.bsky.feed.post',
      record: {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: new Date().toISOString(),
        facets: linkFacet(text, a.url),
      },
    }),
  }, ses.jwt)
  if ('error' in r) return { attempted: true, ok: false, error: r.error }
  if (!r.ok) return { attempted: true, ok: false, error: `HTTP ${r.status}` }
  try {
    const b = (await r.json()) as { uri?: string }
    return { attempted: true, ok: true, uri: b.uri }
  } catch {
    return { attempted: true, ok: true }
  }
}

/** Remove the announcement: unlike dev.to, here the record is actually deleted. */
export async function bskyDelete(url: string, s: AppSettings): Promise<BskyResult> {
  const cfg = bskyConfig(s)
  if (!cfg.handle || !cfg.appPassword) return { attempted: false, ok: false, error: 'handle or app password not set' }
  const ses = await session(cfg)
  if ('error' in ses) return { attempted: true, ok: false, error: ses.error }
  const uri = await alreadyPosted(ses.did, ses.jwt, url)
  if (!uri) return { attempted: true, ok: true } // nothing to remove
  const rkey = uri.split('/').pop()
  const r = await call('com.atproto.repo.deleteRecord', {
    method: 'POST',
    body: JSON.stringify({ repo: ses.did, collection: 'app.bsky.feed.post', rkey }),
  }, ses.jwt)
  if ('error' in r) return { attempted: true, ok: false, error: r.error }
  if (!r.ok) return { attempted: true, ok: false, error: `HTTP ${r.status}` }
  return { attempted: true, ok: true }
}

/** Access check: create a session and forget it right away. Doesn't publish anything. */
export async function bskyTest(s: AppSettings): Promise<BskyResult> {
  const cfg = bskyConfig(s)
  if (!cfg.handle || !cfg.appPassword) return { attempted: false, ok: false, error: 'handle or app password not set' }
  const ses = await session(cfg)
  if ('error' in ses) return { attempted: true, ok: false, error: ses.error }
  return { attempted: true, ok: true, uri: `https://bsky.app/profile/${cfg.handle}` }
}

// --- Thread for the composer --------------------------------------------------- //
// The article announcement (bskyPublish) is a single record with a link. The
// composer sends something different: an arbitrary thread of edited posts, and
// the posts in it need to be replies.
//
// Threading in Bluesky isn't like everywhere else: a reply requires TWO
// pointers — root (the first post of the thread) and parent (the previous one).
// Both are uri+cid pairs, and cid is only returned in createRecord's response,
// so they can only be remembered as we go.

/** Link to a post by its at://-URI: bsky.app wants the rkey at the end. */
export function bskyPostUrl(handle: string, uri: string): string {
  const rkey = uri.split('/').pop() || ''
  return handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : ''
}

export interface BskyThreadResult {
  attempted: boolean
  ok: boolean
  /** at://-URIs of published posts in order (partial — if the thread broke off) */
  uris: string[]
  url?: string
  error?: string
  /** not all media made it — the text was still published (not fatal) */
  mediaError?: string
}

// --- Media in a thread --------------------------------------------------------- //
// Bluesky can't fetch a file by URL: an image has to be uploaded as a blob
// (com.atproto.repo.uploadBlob) and the resulting link attached in an embed. The
// embed lives ON THE RECORD, not the thread, so we distribute images across
// posts (media.postIndex) and build a separate embed for each post — it used to
// be that all media landed on the first post, and "the image for the second
// point" ended up in the wrong place. Video isn't supported here: it has its
// own lexicon and its own upload service, that's a separate task.

/** The PDS blob ceiling is ~1 MB. Above that the server returns BlobTooLarge. */
const BLOB_LIMIT = 976_560
/** The platform's hard limit: 4 images PER POST (not per thread). */
const MAX_IMAGES = 4

/** Upload an image's bytes and get a blob reference for the embed. */
async function uploadBlob(file: MediaFile, jwt: string): Promise<{ blob: unknown } | { error: string }> {
  // Content-Type here is the file's actual MIME type: overriding the json header from call()
  const r = await call('com.atproto.repo.uploadBlob', {
    method: 'POST',
    body: new Uint8Array(file.bytes),
    headers: { 'Content-Type': file.mime },
  }, jwt)
  if ('error' in r) return { error: r.error }
  if (!r.ok) return { error: `HTTP ${r.status}` }
  const b = (await r.json().catch(() => ({}))) as { blob?: unknown }
  if (!b.blob) return { error: 'Bluesky didn\'t return a file reference' }
  return { blob: b.blob }
}

/**
 * Image embed for a SINGLE thread post. Returns both the embed and an
 * explanation of what didn't make it: a failed media upload shouldn't block
 * the text from being published.
 */
async function imagesEmbed(files: MediaFile[], jwt: string, postNo: number): Promise<{ embed?: unknown; error?: string }> {
  const notes: string[] = []
  const where = `post ${postNo}` // without the number, a warning about the thread is hard to place
  const images = files.filter((f) => f.type === 'image')
  const skippedVideo = files.length - images.length
  if (skippedVideo) notes.push(`${where}: Bluesky doesn't support video — ${skippedVideo} skipped`)
  if (images.length > MAX_IMAGES) notes.push(`${where}: more than ${MAX_IMAGES} images — extras dropped`)

  const blobs: unknown[] = []
  for (const f of images.slice(0, MAX_IMAGES)) {
    if (f.bytes.length > BLOB_LIMIT) {
      notes.push(`${f.name}: larger than ${Math.round(BLOB_LIMIT / 1024)} KB — Bluesky won't accept this file`)
      continue
    }
    const up = await uploadBlob(f, jwt)
    if ('error' in up) { notes.push(`${f.name}: ${up.error}`); continue }
    blobs.push(up.blob)
  }

  return {
    embed: blobs.length
      ? { $type: 'app.bsky.embed.images', images: blobs.map((image) => ({ alt: '', image })) }
      : undefined,
    error: notes.length ? notes.join('; ') : undefined,
  }
}

export async function bskyPublishThread(posts: string[], s: AppSettings, media: MediaFile[] = []): Promise<BskyThreadResult> {
  const cfg = bskyConfig(s)
  if (!cfg.handle || !cfg.appPassword) return { attempted: false, ok: false, uris: [], error: 'handle or app password not set' }
  const list = (posts || []).map((x) => String(x || '').trim()).filter(Boolean)
  if (!list.length) return { attempted: false, ok: false, uris: [], error: 'empty thread' }
  const tooLong = list.findIndex((x) => [...x].length > 300)
  if (tooLong >= 0) {
    return { attempted: false, ok: false, uris: [], error: `post ${tooLong + 1} is longer than 300 characters — Bluesky won't accept it` }
  }

  const ses = await session(cfg)
  if ('error' in ses) return { attempted: true, ok: false, uris: [], error: ses.error }

  // distribute attachments across thread posts: each post gets its own embed
  const byPost = groupMediaByPost(media, list.length)
  const mediaNotes: string[] = []

  const uris: string[] = []
  let root: { uri: string; cid: string } | null = null
  let parent: { uri: string; cid: string } | null = null

  for (let i = 0; i < list.length; i++) {
    const text = list[i]!
    // make the link in the text clickable: without a facet it stays plain text
    const url = (text.match(/https?:\/\/\S+/) || [])[0] || ''
    // upload this post's blobs right before its record: a failed upload doesn't
    // cancel the text publish, it just adds a line to mediaError
    let embed: unknown
    if (byPost[i]!.length) {
      const built = await imagesEmbed(byPost[i]!, ses.jwt, i + 1)
      embed = built.embed
      if (built.error) mediaNotes.push(built.error)
    }
    const mediaError = mediaNotes.length ? mediaNotes.join('; ') : undefined
    const r = await call('com.atproto.repo.createRecord', {
      method: 'POST',
      body: JSON.stringify({
        repo: ses.did,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text,
          createdAt: new Date().toISOString(),
          facets: url ? linkFacet(text, url) : undefined,
          ...(embed ? { embed } : {}),
          ...(root && parent ? { reply: { root, parent } } : {}),
        },
      }),
    }, ses.jwt)

    if ('error' in r || !r.ok) {
      const err = 'error' in r ? r.error : `HTTP ${r.status}`
      return {
        attempted: true, ok: false, uris,
        url: uris[0] ? bskyPostUrl(cfg.handle, uris[0]) : undefined,
        error: uris.length ? `${err} — thread broke off at post ${i + 1} of ${list.length}` : err,
        mediaError,
      }
    }
    const b = (await r.json().catch(() => ({}))) as { uri?: string; cid?: string }
    if (!b.uri || !b.cid) return { attempted: true, ok: false, uris, error: 'Bluesky didn\'t return a link to the post', mediaError }
    uris.push(b.uri)
    parent = { uri: b.uri, cid: b.cid }
    if (!root) root = parent
  }
  return {
    attempted: true, ok: true, uris, url: bskyPostUrl(cfg.handle, uris[0]!),
    mediaError: mediaNotes.length ? mediaNotes.join('; ') : undefined,
  }
}

/** Delete the thread's posts. From the end: deleting the root before its replies makes no sense. */
export async function bskyDeleteMany(uris: string[], s: AppSettings): Promise<{ ok: boolean; removed: number; leftover: string[] }> {
  const cfg = bskyConfig(s)
  const list = (uris || []).filter(Boolean)
  if (!list.length) return { ok: true, removed: 0, leftover: [] }
  const ses = await session(cfg)
  if ('error' in ses) return { ok: false, removed: 0, leftover: list }

  const leftover: string[] = []
  for (const uri of [...list].reverse()) {
    const rkey = uri.split('/').pop()
    const r = await call('com.atproto.repo.deleteRecord', {
      method: 'POST',
      body: JSON.stringify({ repo: ses.did, collection: 'app.bsky.feed.post', rkey }),
    }, ses.jwt)
    if ('error' in r || !r.ok) leftover.push(uri)
  }
  return { ok: leftover.length === 0, removed: list.length - leftover.length, leftover }
}
