/**
 * "Content factory": takes a run's finished article and repackages it for the
 * format of EACH social network (Telegram / VK / Threads / Dzen). One LLM call
 * per platform using its profile (platformProfiles.ts), then DETERMINISTIC
 * format constraints: character-limit clipping, post-count limit, hashtag
 * top-up/trim, article link. LLM sets the voice, determinism guarantees the format.
 *
 * adaptForPlatform() publishes nothing — it returns ready text for preview cards.
 * Actual publishing happens in the connectors below (Telegram so far). See
 * controllers/crosspost.controller.ts.
 */
import type { AppSettings } from './appSettings'
import type { LLM } from './llm'
import { todayLine } from './llm'
import { platformProfile, type PlatformProfile } from './pipeline/platformProfiles'
import { WRITING_RULES } from './pipeline/draft'
import { updateRun, type RunRow } from './store'
import { tgConfig, tgDelete, tgPublishArticle, tgPublishSocial, type TgMedia, type TgResult } from './tgPublish'
import { bskyDeleteMany, bskyPublishThread } from './blueskyPublish'
import { mastodonDeleteMany, mastodonPublishThread } from './mastodonPublish'
import { readLocalMedia, type CrosspostMedia, type MediaFile } from './crosspostMedia'

export interface AdaptResult {
  platform: string // platform key (tg/vk/threads/dzen)
  label: string // human-readable name
  emoji: string
  format: 'plain' | 'markdown'
  posts: string[] // ready posts (single element for single-post platforms)
  hashtags: string[] // hashtags applied (already inserted into the post text)
  charCount: number // characters in the longest post (for the limit indicator)
  charLimit: number
  thread: boolean
  warnings: string[] // what had to be trimmed deterministically (clipping/post-count limit)
  mock: boolean // response from mock LLM (no key) — warn the UI that this is a placeholder
}

/** Link to the full article for the CTA (siteUrl + slug). Empty if there's no data. */
function articleUrl(run: RunRow, s: AppSettings): string {
  const base = (s.siteUrl || '').replace(/\/+$/, '')
  const slug = (run.blog_slug || '').trim()
  return base && slug ? `${base}/blog/${slug}` : ''
}

/** Article body in markdown, capped in size (so we don't bloat the LLM context). */
function sourceBody(run: RunRow): string {
  const md = (run.body_md || '').trim()
  if (md) return md.slice(0, 12000)
  // fallback: crudely strip HTML tags if markdown is empty
  return (run.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12000)
}

/** Normalize a hashtag: strip spaces/#, coerce to #single_word. */
function normHashtag(raw: string): string {
  const t = String(raw || '').trim().replace(/^#+/, '').replace(/\s+/g, '_')
  const cleaned = t.replace(/[^\p{L}\p{N}_]/gu, '')
  return cleaned ? '#' + cleaned : ''
}

/** Unique valid hashtags, up to max. */
function pickHashtags(raw: unknown, max: number): string[] {
  if (max <= 0 || !Array.isArray(raw)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const h of raw) {
    const tag = normHashtag(String(h))
    const low = tag.toLowerCase()
    if (tag && !seen.has(low)) { seen.add(low); out.push(tag); if (out.length >= max) break }
  }
  return out
}

/**
 * Safety-net clipping if a post still exceeds the hard limit. Cuts at the END
 * of the last complete sentence/paragraph (./!/?/…/line break) so the text
 * doesn't break off mid-word. An ellipsis is only appended if no complete
 * boundary was found within the limit at all (very rare). Normally the model
 * stays within budget on its own (see textBudget/completeness in the prompt),
 * and we don't end up here.
 */
function clampPost(text: string, limit: number): { text: string, clipped: boolean } {
  const t = (text || '').trim()
  if (t.length <= limit) return { text: t, clipped: false }
  const slice = t.slice(0, limit)
  // index of the end of the last complete sentence/paragraph within the limit
  const boundary = Math.max(
    slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '),
    slice.lastIndexOf('.\n'), slice.lastIndexOf('!\n'), slice.lastIndexOf('?\n'),
    slice.lastIndexOf('…'), slice.lastIndexOf('\n'),
  )
  if (boundary > limit * 0.5) {
    return { text: slice.slice(0, boundary + 1).trim(), clipped: true }
  }
  // no complete boundary found — cut at a word and append an ellipsis
  const sp = slice.lastIndexOf(' ')
  const cut = sp > limit * 0.5 ? slice.slice(0, sp) : slice.slice(0, limit - 1)
  return { text: cut.trimEnd() + '…', clipped: true }
}

/** System prompt for the repackager: brand voice + anti-slop + platform format. */
function adaptSystem(s: AppSettings, p: PlatformProfile): string {
  return `${s.persona}\n`
    + `Ты ведёшь соцсети бренда ${s.brand} и переупаковываешь готовую статью в НАТИВНЫЙ пост `
    + `для площадки «${p.label}». Тон бренда: ${s.tone}. Язык: ${s.language}. ${todayLine()}\n`
    + `${p.guide}\n${WRITING_RULES}\n`
    + 'ДЛИНА ПОСТА = объёму исходной статьи, а НЕ лимиту площадки. Лимит символов — '
    + 'это верхний потолок, а не цель: короткая заметка → короткий пост, большой '
    + 'разбор → развёрнутый. НИКОГДА не раздувай текст ради объёма — без воды, '
    + 'общих слов, повторов и «наполнителя». Лучше сильный короткий пост, чем '
    + 'растянутый до лимита.\n'
    + 'Не выдумывай фактов, цифр и функций, которых нет в исходной статье. '
    + 'Не копируй абзацы дословно — переписывай под площадку.'
}

/**
 * Repackage a run's article for a single platform. Returns ready posts with
 * format constraints already applied. LLM errors propagate outward (the caller
 * catches per platform, so one failure doesn't take down the rest).
 */
export async function adaptForPlatform(
  run: RunRow,
  platformKey: string,
  llm: LLM,
  s: AppSettings,
): Promise<AdaptResult> {
  const p = platformProfile(platformKey, s.language)
  if (!p) throw new Error(`unknown platform: ${platformKey}`)

  const title = (run.title || '').trim()
  const body = sourceBody(run)
  if (!title || !body) throw new Error('title and article text are required')

  const url = articleUrl(run, s)
  const wantThread = p.thread && p.maxPosts > 1

  // Budget for the post TEXT itself (below the hard limit), so that the
  // deterministically appended hashtags and link don't push the text past the
  // limit and trigger the safety-net clip. Appends only go into the last post,
  // so we size the reserve for that one; applying it a bit conservatively to
  // every post in the thread is safer.
  const linkReserve = p.appendLink && url ? url.length + 6 : 0
  const tagReserve = p.hashtags.max > 0 ? p.hashtags.max * 16 : 0
  const textBudget = Math.max(160, p.charLimit - linkReserve - tagReserve)

  const shape = wantThread
    ? `Верни от 2 до ${Math.min(p.maxPosts, 5)} постов треда. Каждый пост — ЗАКОНЧЕННЫЙ текст `
      + `(законченные предложения, не обрывай на полуслове), длиной до ${textBudget} символов.`
    : `Верни ОДИН ЗАКОНЧЕННЫЙ пост (законченные предложения, доведи мысль до конца, `
      + `не обрывай на полуслове), длиной до ${textBudget} символов.`

  const prompt =
    `ИСХОДНАЯ СТАТЬЯ.\nЗаголовок: ${title}\n\n${body}\n\n`
    + `ЗАДАЧА: сделай нативный пост для «${p.label}» по правилам стиля выше. ${shape}\n`
    + `Объём подгоняй под содержание статьи (лимит ${textBudget} — это потолок, не цель), но `
    + 'ОБЯЗАТЕЛЬНО заверши текст: никаких оборванных фраз, «висящих» списков и многоточий-обрывов.\n'
    + (p.hashtags.max > 0
      ? `Подбери ${p.hashtags.min}–${p.hashtags.max} релевантных хэштегов (без символа # в JSON).\n`
      : 'Хэштеги не нужны (пустой массив).\n')
    + 'Верни СТРОГО JSON без пояснений и ```-ограждений:\n'
    + '{"posts": ["текст поста", ...], "hashtags": ["тег", ...]}'

  // Output token budget with headroom ABOVE textBudget, so the model has room to
  // finish the text instead of hitting the token limit mid-word. Russian is
  // roughly 1 token per ~1.4 characters; plus headroom for the JSON wrapper and
  // "finish the sentence".
  const expectChars = textBudget * (wantThread ? Math.min(p.maxPosts, 5) : 1)
  const maxTokens = Math.min(6000, Math.max(800, Math.ceil(expectChars / 1.4) + 600))

  const raw = await llm.json(prompt, {
    system: adaptSystem(s, p),
    strong: true,
    maxTokens,
    temperature: 0.8,
  })

  const warnings: string[] = []

  // --- deterministic format constraints on top of the LLM response --------------- //
  let posts: string[] = Array.isArray(raw?.posts)
    ? raw.posts.map((x: unknown) => String(x ?? '').trim()).filter(Boolean)
    : []
  // single text instead of an array (the LLM sometimes does this)
  if (!posts.length && typeof raw?.text === 'string') posts = [raw.text.trim()]
  if (!posts.length) throw new Error('LLM returned no post text')

  // post-count limit
  if (posts.length > p.maxPosts) {
    warnings.push(`thread trimmed to ${p.maxPosts} posts (LLM returned ${posts.length})`)
    posts = posts.slice(0, p.maxPosts)
  }

  const hashtags = pickHashtags(raw?.hashtags, p.hashtags.max)

  // hashtags and the link go into the LAST post, then each is clipped to the limit
  const lastIdx = posts.length - 1
  if (hashtags.length && !containsHashtags(posts[lastIdx])) {
    posts[lastIdx] = `${posts[lastIdx]}\n\n${hashtags.join(' ')}`
  }
  if (p.appendLink && url && !posts[lastIdx].includes(url)) {
    posts[lastIdx] = `${posts[lastIdx]}\n\n👉 ${url}`
  }

  let clippedAny = false
  posts = posts.map((post) => {
    const { text, clipped } = clampPost(post, p.charLimit)
    if (clipped) clippedAny = true
    return text
  })
  if (clippedAny) warnings.push(`text trimmed to the ${p.charLimit}-character limit`)

  const charCount = posts.reduce((m, x) => Math.max(m, x.length), 0)

  return {
    platform: p.key,
    label: p.label,
    emoji: p.emoji,
    format: p.format,
    posts,
    hashtags,
    charCount,
    charLimit: p.charLimit,
    thread: p.thread,
    warnings,
    mock: llm.isMock,
  }
}

/** Does the text already have hashtags? (so we don't duplicate when appending). */
function containsHashtags(text: string): boolean {
  return /(^|\s)#[\p{L}\p{N}_]{2,}/u.test(text || '')
}

// --- Publish connector: Telegram ------------------------------------------- //
// The adapted TG post is published through the EXISTING tgPublishArticle (empty
// title, body = adapted text): reuses the battle-tested splitting logic (≤4096),
// idempotency (tg_msgids_json/tg_chat_id), edit-in-place, and removal. The cover
// goes as a separate photo. IMPORTANT: the message-id storage is shared with the
// full-article auto-crosspost in publishRunToBlog — "last action wins" (the
// adapted post replaces the full article in the channel, and vice versa). For
// TG this is fine: there's only one channel.

// The attachment type and disk file reading live in crosspostMedia.ts: they're
// called not only by this module but also by the Bluesky/Mastodon connectors.
export type { CrosspostMedia }

export interface CrosspostPublishResult {
  platform: string
  ok: boolean
  telegram?: TgResult
  messageIds: number[]
  chatId: string
  error?: string
  /** Not all attachments made it through, but the text did (album limit, Telegram rejection). Not a publish error */
  mediaError?: string
}

/** Relative /blogwriter/... → absolute URL (Telegram/social networks fetch the file themselves). */
function absMediaUrl(url: string): string | undefined {
  const raw = (url || '').trim()
  if (!raw) return undefined
  if (/^https?:\/\//.test(raw)) return raw
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  return base ? base + raw : undefined // without PUBLIC_BASE_URL the local path is unreachable for Telegram
}

/** Channel message-ids saved on the run (tg_msgids_json). */
function parseMsgIds(raw: string | undefined): number[] {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.filter((n) => typeof n === 'number' && n > 0) : []
  } catch { return [] }
}

/** Run's cover_url → absolute URL for the channel photo (local path → PUBLIC_BASE_URL). */
function tgCoverUrl(coverUrl: string): string | undefined {
  const raw = (coverUrl || '').trim()
  if (!raw) return undefined
  if (/^https?:\/\//.test(raw)) return raw
  const file = raw.split(/[?#]/)[0].split('/').filter(Boolean).pop()
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  return file && base ? `${base}/blogwriter/covers/${file}` : undefined // without the base, Telegram can't reach the local path
}

/**
 * Publish/update the adapted post in the brand's Telegram channel. `posts` is
 * ready text (from the preview, possibly edited in the UI); for TG this is a
 * single post, but we join the array in case there are several. Idempotent:
 * message-ids are stored on the run.
 */
export async function publishAdaptedTelegram(
  id: string,
  run: RunRow,
  posts: string[],
  s: AppSettings,
  media: CrosspostMedia[] = [],
): Promise<CrosspostPublishResult> {
  const tg = tgConfig(s)
  if (!tg.token || !tg.channel) {
    return { platform: 'tg', ok: false, messageIds: [], chatId: '', error: 'bot token or channel not set (Blog settings → Telegram)' }
  }
  // We do NOT filter the post order: media's postIndex points at a position in
  // this array, and dropping an empty post would send attachments to the wrong place.
  const list = (posts || []).map((x) => String(x || '').trim())
  const text = list.filter(Boolean).join('\n\n').trim()
  // absolute URLs of uploaded media (Telegram fetches the file by URL)
  const tgMedia: TgMedia[] = (media || []).flatMap((m): TgMedia[] => {
    const url = absMediaUrl(m.url)
    return url ? [{ url, type: m.type === 'video' ? 'video' : 'image', postIndex: m.postIndex }] : []
  })
  if (!text && !tgMedia.length) return { platform: 'tg', ok: false, messageIds: [], chatId: '', error: 'empty post: no text and no media' }

  const prevIds = parseMsgIds(run.tg_msgids_json)
  // with media — the album/caption path (media is tied to its own post); without
  // media — the previous path (run cover + edit-in-place, to avoid hitting the 48h delete limit).
  const res: TgResult = tgMedia.length
    ? await tgPublishSocial({ token: tg.token, channel: tg.channel, posts: list, media: tgMedia, prevMessageIds: prevIds, prevChatId: run.tg_chat_id })
    : await tgPublishArticle({
        token: tg.token,
        channel: tg.channel,
        title: '', // the title is already inside the adapted text (hook on the first line)
        bodyHtml: text, // plain text: toTelegramHtml escapes special characters, no tags present
        coverUrl: tgCoverUrl(run.cover_url),
        prevMessageIds: prevIds,
        prevChatId: run.tg_chat_id,
      })
  await updateRun(id, {
    tg_msgids_json: JSON.stringify(res.messageIds || []),
    tg_chat_id: res.chatId || run.tg_chat_id || '',
  })
  return {
    platform: 'tg', ok: res.ok, telegram: res,
    messageIds: res.messageIds || [], chatId: res.chatId || '',
    error: res.ok ? undefined : res.error,
    mediaError: mediaNote(res.mediaError),
  }
}

/** Remove the adapted post from the Telegram channel (delete messages, clear state). */
export async function unpublishAdaptedTelegram(
  id: string,
  run: RunRow,
  s: AppSettings,
): Promise<{ platform: string, ok: boolean, removed: number, leftover: number }> {
  const prevIds = parseMsgIds(run.tg_msgids_json)
  const token = (s.tgBotToken || '').trim()
  let leftover: number[] = []
  if (prevIds.length && token) {
    try { leftover = await tgDelete(prevIds, run.tg_chat_id || tgConfig(s).channel, token) }
    catch { leftover = prevIds /* network failed — treat all as not deleted, don't lose the ids */ }
  }
  await updateRun(id, {
    tg_msgids_json: JSON.stringify(leftover),
    tg_chat_id: leftover.length ? (run.tg_chat_id || '') : '',
  })
  return { platform: 'tg', ok: leftover.length === 0, removed: prevIds.length - leftover.length, leftover: leftover.length }
}


// --- Crosspost state per platform ------------------------------------------ //
// X, Bluesky, and Mastodon store the ids of published posts here: without them,
// republishing would create duplicates, and removal would be impossible.

/** Crosspost state per platform: what's published and where to look for it. */
export interface CrosspostState {
  /** post ids (X thread — one per post) */
  ids?: string[]
  /** link to what's published */
  url?: string
  /** page path for platforms where finding your own post isn't possible (Telegraph) */
  path?: string
}

/** Parse the run's crosspost_json. Broken JSON is not a reason to fail publishing. */
export function crosspostState(run: RunRow): Record<string, CrosspostState> {
  try {
    const v = JSON.parse(run.crosspost_json || '{}')
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, CrosspostState> : {}
  } catch { return {} }
}

/** Write the state of one platform without clobbering the others. */
export async function saveCrosspostState(id: string, run: RunRow, platform: string, state: CrosspostState | null): Promise<void> {
  const all = crosspostState(run)
  if (state && (state.ids?.length || state.url)) all[platform] = state
  else delete all[platform]
  await updateRun(id, { crosspost_json: JSON.stringify(all) })
}


// --- Composer drafts -------------------------------------------------------- //
// Collected adaptations and their attached media used to live ONLY in the
// frontend's memory: an F5 or switching tabs wiped them out, and the user paid
// for a repeat LLM run. We store them on the run as one JSON blob — for the same
// reason as crosspost_json: a new platform shouldn't require a new column.

/** Composer draft: what's been collected per platform and what media is attached to it. */
export interface CrosspostDrafts {
  /** adaptation result keyed by platform (same as what POST crosspost returns) */
  adapts: Record<string, AdaptResult>
  /** attachments keyed by platform (URLs of our uploaded files + postIndex) */
  media: Record<string, CrosspostMedia[]>
  /** ISO timestamp of the last write — the UI shows "draft from …" */
  updatedAt?: string
}

/** Parse the run's crosspost_drafts_json. Broken/empty JSON → null (no draft). */
export function crosspostDrafts(run: RunRow): CrosspostDrafts | null {
  try {
    const v = JSON.parse(run.crosspost_drafts_json || '')
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null
    const adapts = v.adapts && typeof v.adapts === 'object' && !Array.isArray(v.adapts) ? v.adapts : {}
    const media = v.media && typeof v.media === 'object' && !Array.isArray(v.media) ? v.media : {}
    if (!Object.keys(adapts).length && !Object.keys(media).length) return null
    return { adapts, media, updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : undefined }
  } catch { return null }
}

/**
 * Write the draft. merge=true layers the given platforms on top of the previous
 * ones (this is how adaptation building preserves state: rebuilding Telegram
 * leaves Bluesky untouched), merge=false replaces everything (this is how the
 * frontend's autosave preserves state, since it sends the composer's full
 * current state).
 */
export async function saveCrosspostDrafts(
  id: string,
  run: RunRow,
  patch: { adapts?: Record<string, AdaptResult>; media?: Record<string, CrosspostMedia[]> },
  merge = true,
): Promise<CrosspostDrafts> {
  const prev = merge ? crosspostDrafts(run) : null
  const next: CrosspostDrafts = {
    adapts: { ...(prev?.adapts || {}), ...(patch.adapts || {}) },
    media: { ...(prev?.media || {}), ...(patch.media || {}) },
    updatedAt: new Date().toISOString(),
  }
  await updateRun(id, { crosspost_drafts_json: JSON.stringify(next) })
  return next
}


// --- Publish connectors: Bluesky and Mastodon ------------------------------ //
// Both networks support threads and real deletion, so the logic is identical:
// remove the previous thread before publishing, store ids in crosspost_json.

export interface ThreadPublishResult {
  platform: string
  ok: boolean
  /** ids/URIs of published posts (partial — if the thread got cut off) */
  ids: string[]
  url?: string
  error?: string
  /**
   * Not all media made it through, but the text did. Not a publish error: the UI
   * shows this as a warning ("post went out, media didn't attach: …"), not red.
   */
  mediaError?: string
}

/** Join media failure reasons into one string for the UI (empty → undefined). */
// exported: X and LinkedIn are published from the controller (services are
// obtained via DI), but they're required to build mediaError the same way as
// the connectors here
export function mediaNote(...parts: Array<string | undefined>): string | undefined {
  const list = parts.filter((x): x is string => !!x && !!x.trim())
  return list.length ? list.join('; ') : undefined
}

/**
 * The "publish new first, then remove old" order isn't cosmetic: with the
 * reverse order, any publish error (token expired, rate limit, network) would
 * leave the platform with NO post at all, and the run with no links to the
 * deleted thread. State is written in finally: if the new thread breaks off
 * midway, its ids still need to be removable, and if it didn't go up at all,
 * the link to the old one should stay in place.
 */
export async function publishAdaptedBluesky(
  id: string,
  run: RunRow,
  posts: string[],
  s: AppSettings,
  media: CrosspostMedia[] = [],
): Promise<ThreadPublishResult> {
  const prevState = crosspostState(run).bluesky
  const prev = prevState?.ids || []
  // bytes are read from disk: Bluesky only accepts an uploaded blob, not a URL
  const local = readLocalMedia(media)
  const res = await bskyPublishThread(posts, s, local.files)
  try {
    if (prev.length && res.uris.length) await bskyDeleteMany(prev, s)
  } finally {
    await saveCrosspostState(id, run, 'bluesky',
      res.uris.length ? { ids: res.uris, url: res.url } : (prevState ?? null))
  }
  return {
    platform: 'bluesky', ok: res.ok, ids: res.uris, url: res.url,
    error: res.ok ? undefined : res.error,
    mediaError: mediaNote(local.errors.join('; '), res.mediaError),
  }
}

export async function unpublishAdaptedBluesky(id: string, run: RunRow, s: AppSettings) {
  const prev = crosspostState(run).bluesky?.ids || []
  if (!prev.length) return { platform: 'bluesky', ok: true, removed: 0, leftover: 0 }
  const del = await bskyDeleteMany(prev, s)
  await saveCrosspostState(id, run, 'bluesky', del.leftover.length ? { ids: del.leftover } : null)
  return {
    platform: 'bluesky', ok: del.ok, removed: del.removed, leftover: del.leftover.length,
    error: del.ok ? undefined : 'some posts could not be deleted — check the feed on Bluesky',
  }
}

export async function publishAdaptedMastodon(
  id: string,
  run: RunRow,
  posts: string[],
  s: AppSettings,
  media: CrosspostMedia[] = [],
): Promise<ThreadPublishResult> {
  // order and try/finally — see publishAdaptedBluesky above
  const prevState = crosspostState(run).mastodon
  const prev = prevState?.ids || []
  const local = readLocalMedia(media)
  const res = await mastodonPublishThread(posts, s, local.files)
  try {
    if (prev.length && res.ids.length) await mastodonDeleteMany(prev, s)
  } finally {
    await saveCrosspostState(id, run, 'mastodon',
      res.ids.length ? { ids: res.ids, url: res.url } : (prevState ?? null))
  }
  return {
    platform: 'mastodon', ok: res.ok, ids: res.ids, url: res.url,
    error: res.ok ? undefined : res.error,
    mediaError: mediaNote(local.errors.join('; '), res.mediaError),
  }
}

export async function unpublishAdaptedMastodon(id: string, run: RunRow, s: AppSettings) {
  const prev = crosspostState(run).mastodon?.ids || []
  if (!prev.length) return { platform: 'mastodon', ok: true, removed: 0, leftover: 0 }
  const del = await mastodonDeleteMany(prev, s)
  await saveCrosspostState(id, run, 'mastodon', del.leftover.length ? { ids: del.leftover } : null)
  return {
    platform: 'mastodon', ok: del.ok, removed: del.removed, leftover: del.leftover.length,
    error: del.ok ? undefined : 'some posts could not be deleted — check the feed on Mastodon',
  }
}


// --- Connectors on top of DI services: X and LinkedIn ----------------------- //
// Their connections live in the main database and are obtained by services via
// DI, while this module is plain, without a container. So the service is passed
// as a PARAMETER: the logic (the "publish first, then remove" order, state in
// crosspost_json) is the same for the controller and the auto-post scheduler —
// they must not diverge.

/** What the connector needs from XService (nothing wider — it's not the whole service). */
export interface XPublisher {
  publishThread(brandId: number, posts: string[], media?: MediaFile[]): Promise<{ ok: boolean, ids: string[], url?: string, error?: string, mediaError?: string }>
  deleteMany(brandId: number, ids: string[]): Promise<{ ok: boolean, removed: number, leftover: string[] }>
}

/** What the connector needs from LinkedinService. */
export interface LinkedinPublisher {
  publish(brandId: number, text: string, media?: MediaFile[]): Promise<{ ok: boolean, id?: string, url?: string, error?: string, mediaError?: string }>
}

/**
 * A thread on X from the OAuth-linked account. The old thread is removed ONLY
 * after the new one publishes successfully; state is written in finally — see
 * publishAdaptedBluesky.
 */
export async function publishAdaptedX(
  id: string,
  run: RunRow,
  posts: string[],
  brandId: number,
  x: XPublisher,
  media: CrosspostMedia[] = [],
) {
  const prevState = crosspostState(run).x
  const prev = prevState?.ids || []
  // bytes are read from disk: X only accepts an uploaded file, not a URL
  const local = readLocalMedia(media)
  const res = await x.publishThread(brandId, posts, local.files)
  try {
    if (prev.length && res.ids.length) await x.deleteMany(brandId, prev)
  } finally {
    // ids are saved even on error: a broken-off thread still needs to be removable
    await saveCrosspostState(id, run, 'x', res.ids.length ? { ids: res.ids, url: res.url } : (prevState ?? null))
  }
  return {
    platform: 'x', ok: res.ok, mode: 'api', ids: res.ids, url: res.url, error: res.error,
    mediaError: mediaNote(local.errors.join('; '), res.mediaError),
  }
}

export async function unpublishAdaptedX(id: string, run: RunRow, brandId: number, x: XPublisher) {
  const prev = crosspostState(run).x?.ids || []
  if (!prev.length) return { platform: 'x', ok: true, removed: 0, leftover: 0 }
  const del = await x.deleteMany(brandId, prev)
  await saveCrosspostState(id, run, 'x', del.leftover.length ? { ids: del.leftover } : null)
  return { platform: 'x', ok: del.ok, removed: del.removed, leftover: del.leftover.length }
}

/**
 * A LinkedIn post. Their API has no threads, so posts are joined into one entry —
 * and attachments are collected from ALL postIndex values, since there's only
 * one post on that side anyway.
 */
export async function publishAdaptedLinkedin(
  id: string,
  run: RunRow,
  posts: string[],
  brandId: number,
  linkedin: LinkedinPublisher,
  media: CrosspostMedia[] = [],
) {
  const text = (posts || []).map((x) => String(x || '').trim()).filter(Boolean).join('\n\n')
  const local = readLocalMedia(media)
  const res = await linkedin.publish(brandId, text, local.files)
  await saveCrosspostState(id, run, 'linkedin', res.ok && res.id ? { ids: [res.id], url: res.url } : null)
  return {
    platform: 'linkedin', ok: res.ok, ids: res.id ? [res.id] : [], url: res.url, error: res.error,
    mediaError: mediaNote(local.errors.join('; '), res.mediaError),
  }
}
