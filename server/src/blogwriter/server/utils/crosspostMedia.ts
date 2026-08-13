/**
 * Crosspost media: reading uploaded files FROM DISK.
 *
 * Telegram fetches the file itself by URL, but Bluesky, Mastodon, X, and
 * LinkedIn can't do that — they need bytes UPLOADED to their own upload
 * endpoint. Bytes are taken from data/crosspost-media rather than an HTTP
 * request to our own host: PUBLIC_BASE_URL isn't always set, from the outside
 * the path may be blocked by nginx, and hitting ourselves over the network for
 * our own file is an unnecessary point of failure.
 *
 * The file name comes from the UI, so we validate it as a basename and check
 * that after joining, the path stays inside the directory — otherwise this
 * would read other people's files.
 */
import { readFileSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { dataDir } from './store'

/**
 * A media attachment for a post (URL of a file we've already uploaded + type).
 *
 * postIndex is the number of the THREAD post the attachment belongs to. The
 * field may be absent (old client, announcement) — then 0, i.e. the first
 * post: exactly the behavior that existed before per-post media.
 */
export interface CrosspostMedia { url: string; type: 'image' | 'video'; postIndex?: number }

/** A media file read from disk — ready to upload to the social network. */
export interface MediaFile {
  name: string
  mime: string
  type: 'image' | 'video'
  postIndex: number // which thread post it's attached to (0 — first)
  bytes: Buffer
}

/**
 * Cap on attachments for the WHOLE thread. A thread can have up to 8 posts,
 * each with its own attachments, so the overall cap is noticeably higher than
 * platforms' per-post limits — those are checked later, in the connectors.
 */
export const MEDIA_CAP = 30

/** Post number from an attachment: not a number/garbage/negative → 0 (first post). */
export function mediaPostIndex(raw: unknown): number {
  const n = Math.trunc(Number(raw))
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * Distribute attachments across thread posts. Indexes beyond the thread are
 * clamped to the last post: silently losing an image is worse than attaching
 * it to the wrong post, and a "post count shrank after editing the text"
 * mismatch is a routine occurrence in the UI. Returns an array of length
 * postCount, where i is post i's attachments in order.
 */
export function groupMediaByPost<T extends { postIndex?: number }>(list: T[] | undefined, postCount: number): T[][] {
  const groups: T[][] = Array.from({ length: Math.max(1, postCount) }, () => [])
  for (const m of list || []) {
    const idx = Math.min(mediaPostIndex(m?.postIndex), groups.length - 1)
    groups[idx]!.push(m)
  }
  return groups
}

/** ext → MIME. Single source of truth for both serving the file and uploading to social networks. */
export const MEDIA_MIME: Record<string, string> = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
}

/** Directory with uploaded crosspost media. */
function mediaDir(): string {
  return resolve(join(dataDir(), 'crosspost-media'))
}

/**
 * File name from our URL /blogwriter/crosspost-media/<name>. Returns empty if
 * the name fails validation: only [a-zA-Z0-9_.-] and no '..'.
 */
export function mediaFileName(url: string): string {
  const raw = String(url || '').split(/[?#]/)[0]!.trim()
  const base = raw.split('/').filter(Boolean).pop() || ''
  if (!/^[a-zA-Z0-9_.-]+$/.test(base) || base.includes('..')) return ''
  return base
}

/** What was read successfully and what went wrong (text for the warning field in the UI). */
export interface LocalMediaRead {
  files: MediaFile[]
  errors: string[]
}

/**
 * Read uploaded media from disk. Never throws: a broken entry is skipped and
 * explained in words — the post text matters more than the attachment.
 */
export function readLocalMedia(list: CrosspostMedia[] | undefined, max = MEDIA_CAP): LocalMediaRead {
  const dir = mediaDir()
  const files: MediaFile[] = []
  const errors: string[] = []

  for (const m of (list || []).slice(0, max)) {
    const name = mediaFileName(m?.url || '')
    if (!name) { errors.push('broken media link'); continue }

    const path = resolve(join(dir, name))
    // after resolve, the path must stay inside the directory — otherwise it's a traversal
    if (path !== dir && !path.startsWith(dir + sep)) {
      errors.push(`${name}: path outside the media directory`)
      continue
    }

    const ext = name.split('.').pop()?.toLowerCase() || ''
    const mime = MEDIA_MIME[ext]
    if (!mime) { errors.push(`${name}: unsupported file type`); continue }

    try {
      if (!statSync(path).isFile()) { errors.push(`${name}: not a file`); continue }
      files.push({
        name, mime,
        type: m.type === 'video' ? 'video' : 'image',
        postIndex: mediaPostIndex(m?.postIndex),
        bytes: readFileSync(path),
      })
    } catch {
      errors.push(`${name}: file not found on disk`)
    }
  }

  return { files, errors }
}
