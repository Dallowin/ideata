/**
 * Crossposts articles to a Telegram channel via the USER'S OWN BOT (per-brand).
 * The user sets up their own bot (@BotFather), adds it as an ADMIN to the channel
 * with posting rights, and enters the bot token + channel in the blog writer
 * settings (@username or -100…id). On publish we send the full article text to
 * the channel (Telegram HTML, split into messages ≤4096 chars); on republish we
 * delete the previous messages and resend; on unpublish/delete — delete. The
 * message_ids and resolved chat_id are stored on the run (tg_msgids_json /
 * tg_chat_id) — that's what makes idempotency and correct deletion work even
 * after the channel changes.
 *
 * IMPORTANT: this is NOT the platform login bot (env TELEGRAM_BOT_TOKEN, auth
 * widget). The token here is the user's own, stored in per-brand settings as a
 * secret (like extPublishToken). Each brand posts to its own channel with its
 * own bot.
 */
import type { AppSettings } from './appSettings'
import { groupMediaByPost } from './crosspostMedia'

const API = 'https://api.telegram.org'
const MSG_LIMIT = 4096 // sendMessage text limit
const TIMEOUT_MS = 20_000

export interface TgConfig {
  token: string
  channel: string // @username | -100…id
  enabled: boolean
  ready: boolean // enabled + token + channel are set
}

export function tgConfig(s: AppSettings): TgConfig {
  const token = (s.tgBotToken || '').trim()
  const channel = normalizeChannel(s.tgChannel || '')
  return { token, channel, enabled: !!s.tgPublishEnabled, ready: !!(s.tgPublishEnabled && token && channel) }
}

/**
 * Normalize the channel input to what the Bot API accepts as chat_id:
 * @username | -100…id | https://t.me/username | t.me/username | username → @username.
 */
export function normalizeChannel(raw: string): string {
  let c = (raw || '').trim()
  if (!c) return ''
  // t.me/<username> link → @username (private t.me/+hash links aren't supported — returned as-is)
  const m = c.match(/(?:https?:\/\/)?t\.me\/(?!\+)([A-Za-z0-9_]{3,})/i)
  if (m) return '@' + m[1]
  if (c.startsWith('@')) return c
  if (/^-?\d+$/.test(c)) return c // numeric chat_id (-100…)
  if (/^[A-Za-z0-9_]{3,}$/.test(c)) return '@' + c // bare username
  return c
}

export interface TgResult {
  attempted: boolean
  ok: boolean // article text delivered (cover image is best-effort, doesn't affect ok)
  sent?: number // how many messages actually went out
  messageIds?: number[] // ids of sent messages (for later removal)
  chatId?: string // resolved numeric chat_id (from Telegram's response)
  error?: string
  status?: number
  coverError?: string // cover image failed to send (not fatal: text still went out)
  /** not all attachments made it (album limit, Telegram rejection) — text still went out */
  mediaError?: string
}

// --- HTML → Telegram-HTML --------------------------------------------------- //
// Telegram HTML only understands a narrow set of tags: b/strong, i/em, u, ins, s/strike/
// del, a, code, pre, blockquote, tg-spoiler. Everything else (h1-6, ul/li, p, img,
// table…) makes sendMessage fail with 400 "can't parse entities". So we build the
// text ourselves: headings → bold line, li → "• ", p/br → line break, images/
// tables stripped out, links/bold/italic kept; any raw <,>,& is escaped.

const ALLOWED_TAG = /^(?:<\/?(?:b|i|u|s|code|pre)>|<a href="[^"]*">|<\/a>)$/

function escapeHtml(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Decode common HTML entities into characters (in text segments, before re-escaping). */
function decodeEntities(t: string): string {
  return t
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/&bull;/g, '•')
    .replace(/&quot;/g, '"').replace(/&apos;|&#0*39;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => { try { return String.fromCodePoint(parseInt(h, 16)) } catch { return '' } })
    .replace(/&#(\d+);/g, (_m, d) => { try { return String.fromCodePoint(Number(d)) } catch { return '' } })
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&') // amp last, otherwise &amp;lt; would unpack twice
}

/** Escape text while leaving already-inserted allowed tags untouched. */
function escapeKeepingTags(s: string): string {
  return s.split(/(<[^>]+>)/g).map((p) => {
    if (/^<[^>]+>$/.test(p) && ALLOWED_TAG.test(p)) return p // allowed tag — leave as-is
    return escapeHtml(decodeEntities(p)) // text (or foreign tag-like junk) — escape it
  }).join('')
}

/** Strip all tags and unpack entities entirely — for the plain-text fallback on 400. */
export function stripToPlain(html: string): string {
  const noTags = (html || '').replace(/<[^>]+>/g, '')
  return decodeEntities(noTags).replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim()
}

/** Article body HTML → safe Telegram HTML (paragraphs separated by \n\n). */
export function toTelegramHtml(input: string): string {
  let s = input || ''
  s = s.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, '')
  // headings → separate bold line
  s = s.replace(/<\s*h[1-6][^>]*>/gi, '\n\n<b>').replace(/<\s*\/\s*h[1-6]\s*>/gi, '</b>\n\n')
  // list items → "• …"
  s = s.replace(/<\s*li[^>]*>/gi, '\n• ').replace(/<\s*\/\s*li\s*>/gi, '')
  // line breaks
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n')
  // closing block tags → paragraph break
  s = s.replace(/<\s*\/\s*(p|div|ul|ol|blockquote|figure|figcaption|section|article|table|tr|thead|tbody)\s*>/gi, '\n\n')
  // strong/em → b/i
  s = s.replace(/<\s*strong[^>]*>/gi, '<b>').replace(/<\s*\/\s*strong\s*>/gi, '</b>')
  s = s.replace(/<\s*em[^>]*>/gi, '<i>').replace(/<\s*\/\s*em\s*>/gi, '</i>')
  s = s.replace(/<\s*del[^>]*>/gi, '<s>').replace(/<\s*\/\s*del\s*>/gi, '</s>')
  s = s.replace(/<\s*strike[^>]*>/gi, '<s>').replace(/<\s*\/\s*strike\s*>/gi, '</s>')
  // Strip attributes from bare b/i/u/s/code/pre tags (<code class="language-js">, <b class>,
  // <pre …>) → plain <tag>, otherwise escapeKeepingTags won't recognize them as allowed
  // and will escape them as text (the channel would show the literal "<code class=…>").
  s = s.replace(/<\s*(b|i|u|s|code|pre)(?:\s[^>]*)?>/gi, (_m, tag) => `<${String(tag).toLowerCase()}>`)
  s = s.replace(/<\s*\/\s*(b|i|u|s|code|pre)\s*>/gi, (_m, tag) => `</${String(tag).toLowerCase()}>`)
  // links: for valid <a href> keep only href (strip other attributes)
  s = s.replace(/<\s*a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>/gi, (_m, href) => `<a href="${escapeAttr(String(href))}">`)
  // Protect valid <a href="…">…</a> pairs, and strip any remaining <a…>/</a> (without href,
  // unpaired) — otherwise a stray </a> without an opening tag makes parse_mode HTML return 400.
  const links: string[] = []
  s = s.replace(/<a href="[^"]*">[\s\S]*?<\/a>/gi, (m) => { links.push(m); return `%%%L${links.length - 1}%%%` })
  s = s.replace(/<\/?a\b[^>]*>/gi, '')
  s = s.replace(/%%%L(\d+)%%%/g, (_m, i) => links[Number(i)] || '')
  // images — strip entirely
  s = s.replace(/<\s*img[^>]*>/gi, '')
  // any REMAINING tag not on the whitelist — strip the tag, keep the text
  s = s.replace(/<\s*\/?\s*(?!(?:b|i|u|s|a|code|pre)\b)[a-z][a-z0-9]*[^>]*>/gi, '')
  // escape raw text, leave allowed tags untouched
  s = escapeKeepingTags(s)
  // normalize whitespace/blank lines
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim()
  return s
}

/**
 * Split text into chunks ≤limit at paragraph boundaries (\n\n) — so allowed tags
 * (b/i/a) don't get torn across messages. A paragraph longer than the limit (rare)
 * is hard-split, after first stripping tags so entities don't get broken.
 */
export function splitMessage(text: string, limit = MSG_LIMIT): string[] {
  const paras = text.split(/\n{2,}/)
  const parts: string[] = []
  let cur = ''
  const flush = () => { if (cur.trim()) parts.push(cur.trim()); cur = '' }
  for (const raw of paras) {
    const p = raw.trim()
    if (!p) continue
    if (p.length > limit) {
      flush()
      // Paragraph longer than the limit (rare): strip tags (to avoid breaking a
      // balanced pair) and escape the WHOLE thing, then split the escaped string at
      // safe boundaries — without breaking &entity; (otherwise parse_mode=HTML would
      // return 400) and preferably at a space. Escaping inflates the length (& → &amp;),
      // so we split the escaped string itself, guaranteeing each chunk stays ≤ limit.
      const esc = escapeHtml(stripToPlain(p))
      let i = 0
      while (i < esc.length) {
        let end = Math.min(i + limit, esc.length)
        if (end < esc.length) {
          const tail = esc.slice(Math.max(i, end - 8), end) // entity ≤ 8 chars
          const amp = tail.lastIndexOf('&')
          if (amp >= 0 && !tail.slice(amp).includes(';')) end -= (tail.length - amp) // an unfinished &…; — back off to the &
          const sp = esc.lastIndexOf(' ', end)
          if (sp > i + limit * 0.5) end = sp // softly snap to a word boundary
        }
        if (end <= i) end = Math.min(i + limit, esc.length) // guard against infinite loop
        const piece = esc.slice(i, end).trim()
        if (piece) parts.push(piece)
        i = end
      }
      continue
    }
    if (!cur) cur = p
    else if (cur.length + 2 + p.length <= limit) cur += '\n\n' + p
    else { flush(); cur = p }
  }
  flush()
  return parts
}

// --- Bot API ---------------------------------------------------------------- //

interface TgApiResp { ok: boolean; result?: any; description?: string; error_code?: number; parameters?: { retry_after?: number } }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Single Bot API call (no retries). Doesn't throw — returns {ok, result|description, status}. */
async function tgFetch(token: string, method: string, body: Record<string, unknown>): Promise<TgApiResp & { status?: number }> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    let j: TgApiResp = { ok: false }
    try { j = (await r.json()) as TgApiResp } catch { /* not JSON — fall back to status below */ }
    return { ...j, status: r.status }
  } catch (e: any) {
    return { ok: false, description: e?.name === 'AbortError' ? 'timeout (20s)' : (e?.message || 'network error') }
  } finally {
    clearTimeout(t)
  }
}

/**
 * Bot API call with flood-limit handling: on 429 we wait parameters.retry_after
 * (Telegram tells us how long) and retry — up to `retries` times. This matters
 * for the "full text" feature: a long article is split into many messages, and
 * consecutive sendMessage calls run into the ~20/min limit per channel.
 */
async function tgApi(token: string, method: string, body: Record<string, unknown>, retries = 2): Promise<TgApiResp & { status?: number }> {
  let resp = await tgFetch(token, method, body)
  for (let i = 0; i < retries && resp.error_code === 429; i++) {
    const wait = Math.min(Math.max(resp.parameters?.retry_after || 1, 1), 60)
    await sleep(wait * 1000)
    resp = await tgFetch(token, method, body)
  }
  return resp
}

/** Human-readable message based on Telegram's response. */
function messageFor(r: { status?: number; error_code?: number; description?: string }): string {
  const code = r.error_code || r.status
  const d = (r.description || '').toLowerCase()
  if (code === 401) return 'bot token rejected (401) — check the token from @BotFather'
  if (d.includes('chat not found')) return 'channel not found — check the @username or numeric id (-100…)'
  if (d.includes('not enough rights') || d.includes('need administrator') || (code === 403 && d.includes('chat')))
    return 'bot is not a channel admin or lacks posting rights — add the bot as an administrator'
  if (d.includes("bot can't initiate") || d.includes('bot is not a member'))
    return 'bot is not in the channel — add the bot as a channel administrator'
  if (d.includes("can't parse entities")) return 'text markup error (HTML parsing)'
  return r.description || (code ? `Telegram HTTP ${code}` : 'network error')
}

/**
 * Delete channel messages. Returns the ids that could NOT be deleted (deleteMessage
 * returned ok:false — e.g. a message older than 48h, which the Bot API refuses to
 * delete). The caller keeps these ids so it doesn't lose "live" messages or report a
 * false "removed".
 * Already-deleted ('message to delete not found') counts as success (it's not in the channel anymore).
 */
export async function tgDelete(messageIds: number[], chatId: string, token: string): Promise<number[]> {
  const failed: number[] = []
  if (!token || !chatId || !messageIds?.length) return failed
  for (const mid of messageIds) {
    if (!mid) continue
    const r = await tgApi(token, 'deleteMessage', { chat_id: chatId, message_id: mid })
    if (!r.ok && !/to delete not found|message identifier is not specified/i.test(r.description || '')) failed.push(mid)
  }
  return failed
}

/** Bold title + body → text chunks ≤4096 (cover image goes as a separate photo without a caption). */
function buildParts(title: string, bodyHtml: string): string[] {
  const body = toTelegramHtml(bodyHtml || '')
  const withTitle = title ? `<b>${escapeHtml(title)}</b>\n\n${body}` : body
  return splitMessage(withTitle)
}

/** Send a single text chunk; on 400 (broken markup) — fall back to plain text. */
async function sendPart(token: string, chatId: string, text: string): Promise<TgApiResp & { status?: number }> {
  let r = await tgApi(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
  if (!r.ok && (r.error_code === 400 || r.status === 400)) {
    r = await tgApi(token, 'sendMessage', { chat_id: chatId, text: stripToPlain(text).slice(0, MSG_LIMIT), disable_web_page_preview: true })
  }
  return r
}

/**
 * Update the previous publication IN PLACE (editMessage*), without deleting — this
 * works around the 48h deleteMessage limit and avoids duplicate messages. Only
 * applicable if the message count matches (cover? + N parts). Any failure editing
 * the text → null (the caller falls back to delete+resend). Cover image is
 * best-effort (its failure doesn't fail the overall result).
 */
async function editInPlace(o: {
  token: string; chatId: string; prevIds: number[]; parts: string[]; hasCover: boolean; cover: string
}): Promise<TgResult | null> {
  const { token, chatId, prevIds, parts, hasCover, cover } = o
  const notModified = (d?: string) => /not modified/i.test(d || '')
  let idx = 0
  let coverError: string | undefined

  if (hasCover) {
    const mid = prevIds[idx++]
    const r = await tgApi(token, 'editMessageMedia', { chat_id: chatId, message_id: mid, media: { type: 'photo', media: cover } })
    if (!r.ok && !notModified(r.description)) coverError = messageFor(r) // cover image wasn't updated — not critical
  }

  for (const part of parts) {
    const mid = prevIds[idx++]
    if (!mid) return null
    let r = await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: mid, text: part, parse_mode: 'HTML', disable_web_page_preview: true })
    if (!r.ok && (r.error_code === 400 || r.status === 400) && !notModified(r.description)) {
      r = await tgApi(token, 'editMessageText', { chat_id: chatId, message_id: mid, text: stripToPlain(part).slice(0, MSG_LIMIT), disable_web_page_preview: true })
    }
    if (!r.ok && !notModified(r.description)) return null // couldn't update the text → fall back to delete+resend
  }

  return { attempted: true, ok: true, sent: prevIds.length, messageIds: prevIds, chatId, ...(coverError ? { coverError } : {}) }
}

/** Resend the article from scratch: cover image as a separate photo (best-effort) + text chunks. */
async function sendFresh(o: {
  token: string; channel: string; parts: string[]; hasCover: boolean; cover: string; prevChatId?: string
}): Promise<TgResult> {
  const { token, channel, parts, hasCover, cover } = o
  const sentIds: number[] = []
  let chatId = ''
  let firstErr: { status?: number; msg: string } | null = null
  let coverError: string | undefined
  const take = (r: TgApiResp & { status?: number }) => {
    if (r.ok && r.result?.message_id) {
      sentIds.push(r.result.message_id)
      if (!chatId && r.result?.chat?.id != null) chatId = String(r.result.chat.id)
      return true
    }
    return false
  }

  // cover image as a separate photo WITHOUT a caption (title is always in the text)
  // — best-effort, its failure (large/unreachable URL) does NOT block delivery of the article text.
  if (hasCover) {
    const r = await tgApi(token, 'sendPhoto', { chat_id: channel, photo: cover })
    if (!take(r)) coverError = messageFor(r)
  }

  for (const part of parts) {
    const r = await sendPart(token, channel, part)
    if (!take(r) && !firstErr) firstErr = { status: r.error_code || r.status, msg: messageFor(r) }
  }

  const ok = !firstErr && sentIds.length > 0
  const res: TgResult = { attempted: true, ok, sent: sentIds.length, messageIds: sentIds, chatId: chatId || o.prevChatId || '' }
  if (firstErr) { res.error = firstErr.msg; res.status = firstErr.status }
  else if (!ok) res.error = 'nothing to send'
  if (coverError) res.coverError = coverError
  return res
}

/**
 * Publish/update the article in the channel. Full text (bold title + body), split
 * into messages ≤4096; cover image as a separate photo without a caption
 * (best-effort). Idempotent: if the message count of the previous publication
 * matches — edit IN PLACE (no deletion → no 48h limit or duplicates); otherwise —
 * remove the previous ones (as many as possible) and resend, returning any
 * still-live undeleted ids in messageIds so they aren't orphaned. The caller
 * persists messageIds+chatId.
 */
export async function tgPublishArticle(a: {
  token: string
  channel: string
  title: string
  bodyHtml: string
  coverUrl?: string
  prevMessageIds?: number[]
  prevChatId?: string
}): Promise<TgResult> {
  const token = (a.token || '').trim()
  const channel = normalizeChannel(a.channel)
  if (!token || !channel) return { attempted: false, ok: false, error: 'bot token or channel not set' }

  const title = (a.title || '').trim()
  const cover = (a.coverUrl || '').trim()
  const hasCover = /^https?:\/\//.test(cover)
  const prevIds = (a.prevMessageIds || []).filter((n) => typeof n === 'number' && n > 0)
  const parts = buildParts(title, a.bodyHtml)
  const wantCount = (hasCover ? 1 : 0) + parts.length

  // same structure + previous chat known → edit in place (no delete)
  if (prevIds.length > 0 && prevIds.length === wantCount && a.prevChatId) {
    const edited = await editInPlace({ token, chatId: a.prevChatId, prevIds, parts, hasCover, cover })
    if (edited) return edited
    // couldn't edit — fall back to delete+resend
  }

  // remove the previous ones (as many as succeeded), resend; keep any still-live
  // undeleted ids in messageIds so they aren't orphaned (removeRun/next resend will clean them up)
  const leftover = prevIds.length ? await tgDelete(prevIds, a.prevChatId || channel, token) : []
  const res = await sendFresh({ token, channel, parts, hasCover, cover, prevChatId: a.prevChatId })
  if (leftover.length) res.messageIds = [...leftover, ...(res.messageIds || [])]
  return res
}

export interface TgMedia { url: string; type: 'image' | 'video'; postIndex?: number }

/** Text delivery error (unlike media, this is fatal for the post). */
type TextErr = { status?: number; msg: string } | null

/** Caption limit for a photo/video/album. A text message has 4096 (MSG_LIMIT). */
const CAPTION_LIMIT = 1024
/** How many files Telegram accepts in a single sendMediaGroup. */
const ALBUM_MAX = 10

/** File type for the Bot API, determined by URL extension: we have no way to get the MIME type. */
function tgKind(m: TgMedia): 'video' | 'photo' {
  if (m.type === 'video') return 'video'
  const ext = (m.url || '').split(/[?#]/)[0]!.split('.').pop()?.toLowerCase() || ''
  return ['mp4', 'mov', 'webm'].includes(ext) ? 'video' : 'photo'
}

/**
 * Publish a social post with media (content factory). Posts arrive as an array
 * (usually just one for TG, but we can also split a thread from a thread-based
 * platform), media comes with a postIndex, i.e. tied to a SPECIFIC post. For each post:
 *  - no media → text messages ≤4096;
 *  - 1 file + text ≤1024 → photo/video WITH CAPTION (one tidy post);
 *  - 2..10 files → ALBUM sendMediaGroup, caption on the FIRST element (Bot API
 *    only reads caption from there); text longer than 1024 doesn't fit the caption —
 *    then the album goes without it, and the text follows as a separate message;
 *  - >10 files → first 10 (the platform's hard limit), the rest is explained in
 *    mediaError: an attachment that didn't make it isn't reason to consider the post failed.
 * Idempotency — delete+resend (a media group can't be reliably edited in place):
 * remove the previous ones, resend; keep any still-live undeleted ids in messageIds.
 * Media is only taken from an absolute http(s) URL — Telegram fetches the file itself.
 */
export async function tgPublishSocial(a: {
  token: string
  channel: string
  posts: string[]
  media: TgMedia[]
  prevMessageIds?: number[]
  prevChatId?: string
}): Promise<TgResult> {
  const token = (a.token || '').trim()
  const channel = normalizeChannel(a.channel)
  if (!token || !channel) return { attempted: false, ok: false, error: 'bot token or channel not set' }

  const texts = (a.posts || []).map((x) => toTelegramHtml(String(x || '')))
  const media = (a.media || []).filter((m) => /^https?:\/\//.test(m?.url || ''))
  const prevIds = (a.prevMessageIds || []).filter((n) => typeof n === 'number' && n > 0)
  // there may be no posts at all (a post made only of images) — keep at least one bucket
  const byPost = groupMediaByPost(media, texts.length || 1)

  // remove the previous ones (as many as succeeded) — then send again
  const leftover = prevIds.length ? await tgDelete(prevIds, a.prevChatId || channel, token) : []

  const sentIds: number[] = []
  let chatId = ''
  let firstErr: TextErr = null
  const mediaNotes: string[] = []
  const takeOne = (r: TgApiResp & { status?: number }): boolean => {
    if (r.ok && r.result?.message_id) {
      sentIds.push(r.result.message_id)
      if (!chatId && r.result?.chat?.id != null) chatId = String(r.result.chat.id)
      return true
    }
    return false
  }
  const takeMany = (r: TgApiResp & { status?: number }): boolean => {
    if (r.ok && Array.isArray(r.result) && r.result.length) {
      for (const m of r.result) {
        if (m?.message_id) { sentIds.push(m.message_id); if (!chatId && m?.chat?.id != null) chatId = String(m.chat.id) }
      }
      return true
    }
    return false
  }
  /** Text in messages ≤4096. Returns the error instead of writing past the caller — otherwise it'd be invisible to the caller. */
  const sendText = async (html: string): Promise<TextErr> => {
    let err: TextErr = null
    for (const part of splitMessage(html)) {
      const r = await sendPart(token, channel, part)
      if (!takeOne(r) && !err) err = { status: r.error_code || r.status, msg: messageFor(r) }
    }
    return err
  }
  /** A single photo/video, optionally with a caption; on 400 — fall back to plain. */
  const sendSingle = async (m: TgMedia, caption: string) => {
    const kind = tgKind(m)
    const method = kind === 'video' ? 'sendVideo' : 'sendPhoto'
    const body: Record<string, unknown> = { chat_id: channel, [kind]: m.url }
    let r = await tgApi(token, method, caption ? { ...body, caption, parse_mode: 'HTML' } : body)
    if (!r.ok && (r.error_code === 400 || r.status === 400) && caption) {
      r = await tgApi(token, method, { ...body, caption: stripToPlain(caption).slice(0, CAPTION_LIMIT) })
    }
    return r
  }
  /** Album; the Bot API only reads the caption from the first element. */
  const sendAlbum = async (files: TgMedia[], caption: string) => {
    const items = files.map((m, i) => ({
      type: tgKind(m),
      media: m.url,
      ...(i === 0 && caption ? { caption, parse_mode: 'HTML' } : {}),
    }))
    let r = await tgApi(token, 'sendMediaGroup', { chat_id: channel, media: items })
    if (!r.ok && (r.error_code === 400 || r.status === 400) && caption) {
      const plain = items.map((it, i) => (i === 0 ? { ...it, caption: stripToPlain(caption).slice(0, CAPTION_LIMIT), parse_mode: undefined } : it))
      r = await tgApi(token, 'sendMediaGroup', { chat_id: channel, media: plain })
    }
    return r
  }

  for (let i = 0; i < Math.max(texts.length, 1); i++) {
    const html = texts[i] || ''
    const files = byPost[i] || []
    const no = texts.length > 1 ? `post ${i + 1}: ` : '' // in a single post the number just gets in the way

    if (!files.length) {
      if (html) firstErr = firstErr || await sendText(html)
      continue
    }
    if (files.length > ALBUM_MAX) {
      mediaNotes.push(`${no}more than ${ALBUM_MAX} files — Telegram only takes the first ${ALBUM_MAX} into an album`)
    }
    const pick = files.slice(0, ALBUM_MAX)
    const fits = !!html && html.length <= CAPTION_LIMIT // long text doesn't fit in the caption

    if (pick.length === 1) {
      const r = await sendSingle(pick[0]!, fits ? html : '')
      const okMedia = takeOne(r)
      if (!okMedia) mediaNotes.push(`${no}${messageFor(r)}`)
      // text must not be lost along with the attachment: the caption would have gone with it
      if (html && (!fits || !okMedia)) firstErr = firstErr || await sendText(html)
      continue
    }
    const r = await sendAlbum(pick, fits ? html : '')
    const okMedia = takeMany(r)
    if (!okMedia) mediaNotes.push(`${no}${messageFor(r)}`)
    // text follows the album: it didn't fit in the caption (or the album didn't go out at all)
    if (html && (!fits || !okMedia)) firstErr = firstErr || await sendText(html)
  }

  const mediaError = mediaNotes.length ? mediaNotes.join('; ') : undefined
  const ok = !firstErr && sentIds.length > 0
  const res: TgResult = { attempted: true, ok, sent: sentIds.length, messageIds: [...leftover, ...sentIds], chatId: chatId || a.prevChatId || '' }
  if (firstErr) { res.error = firstErr.msg; res.status = firstErr.status }
  else if (!ok) res.error = mediaError || 'nothing to send'
  if (mediaError) res.mediaError = mediaError // not all media made it, but the text went out — not fatal
  return res
}

/** Crosspost test: send a short message to the channel and delete it right away (checks bot permissions). */
export async function tgTest(s: AppSettings): Promise<TgResult> {
  const cfg = tgConfig(s)
  if (!cfg.token) return { attempted: false, ok: false, error: 'bot token not set' }
  if (!cfg.channel) return { attempted: false, ok: false, error: 'channel not set' }
  const resp = await tgApi(cfg.token, 'sendMessage', {
    chat_id: cfg.channel,
    text: '✅ <b>Ideata</b> connected to the channel — crossposting works.',
    parse_mode: 'HTML', disable_web_page_preview: true,
  })
  if (!resp.ok || !resp.result?.message_id) {
    return { attempted: true, ok: false, error: messageFor(resp), status: resp.error_code || resp.status }
  }
  const chatId = resp.result?.chat?.id != null ? String(resp.result.chat.id) : cfg.channel
  // delete the test message (this also verifies delete permission)
  await tgDelete([resp.result.message_id], chatId, cfg.token)
  return { attempted: true, ok: true, status: resp.status, chatId }
}
