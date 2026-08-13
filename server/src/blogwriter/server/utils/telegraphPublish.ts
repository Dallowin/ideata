/**
 * Publishes an article to Telegra.ph.
 *
 * Telegraph is the simplest channel of them all and the least like the others:
 *
 *  · The token can't be "grabbed from settings" — telegra.ph has no such thing in
 *    its UI at all, it lives in the browser's localStorage. The only reasonable
 *    way to hand it to the user is to create an account on their behalf
 *    (createAccount) and keep the token ourselves. Hence the separate
 *    telegraphCreateAccount() function.
 *  · The article body isn't HTML — it's Telegraph's own node tree with a closed
 *    set of tags. Anything not on that list has to be unwrapped into its
 *    children, otherwise Telegraph silently drops the chunk of text.
 *  · There's no deletion at all — not in the API, not in the UI. The most honest
 *    thing we can do when unpublishing is replace the page content with a
 *    pointer to the original; the link stays alive forever, and the UI needs to
 *    say so honestly.
 *
 * Idempotency: we store the page path in the run's crosspost_json — there's
 * nothing to search by content here, and there's no "my pages" list without the
 * account token.
 */
import * as cheerio from 'cheerio'
import type { AnyNode, Element } from 'domhandler'
import type { AppSettings } from './appSettings'
import { retryFetch } from './retryFetch'

const API = 'https://api.telegra.ph'
const TIMEOUT_MS = 20_000
/** Page title: the platform's hard limit. */
const TITLE_LIMIT = 256

export interface TelegraphConfig {
  token: string
  authorName: string
  authorUrl: string
  enabled: boolean
  ready: boolean
}

export function telegraphConfig(s: AppSettings): TelegraphConfig {
  const token = (s.telegraphToken || '').trim()
  return {
    token,
    authorName: (s.telegraphAuthorName || s.brand || '').trim().slice(0, 128),
    authorUrl: (s.siteUrl || '').trim().slice(0, 512),
    enabled: !!s.telegraphEnabled,
    ready: !!(s.telegraphEnabled && token),
  }
}

/** Telegraph node: either bare text or a tag with children. */
export type TphNode = string | { tag: string; attrs?: Record<string, string>; children?: TphNode[] }

/**
 * Tags Telegraph accepts. This list is closed: see the format description in
 * their docs. Everything else is unwrapped into its children so the text isn't lost.
 */
const ALLOWED = new Set([
  'a', 'aside', 'b', 'blockquote', 'br', 'code', 'em', 'figcaption', 'figure',
  'h3', 'h4', 'hr', 'i', 'iframe', 'img', 'li', 'ol', 'p', 'pre', 's', 'strong',
  'u', 'ul', 'video',
])
/** What we replace tags with when there's an obvious equivalent. */
const REMAP: Record<string, string> = {
  h1: 'h3', h2: 'h3', h5: 'h4', h6: 'h4',
  div: 'p', section: 'p', article: 'p',
  strike: 's', del: 's', ins: 'u', mark: 'b', small: 'i',
  table: 'pre', // Telegraph can't do tables: a monospace block beats nothing
}
/** Tags we drop along with their content. */
const DROP = new Set(['script', 'style', 'noscript', 'head', 'meta', 'link', 'svg', 'form', 'button', 'input'])
/** Which attributes Telegraph even looks at. */
const KEEP_ATTRS: Record<string, string[]> = { a: ['href'], img: ['src'], iframe: ['src'], video: ['src'] }

/** Convert the article HTML into a Telegraph node tree. */
export function htmlToNodes(html: string): TphNode[] {
  const $ = cheerio.load(String(html || ''), null, false)

  const walk = (nodes: AnyNode[]): TphNode[] => {
    const out: TphNode[] = []
    for (const n of nodes) {
      if (n.type === 'text') {
        const text = (n as unknown as { data: string }).data
        if (text.trim()) out.push(text)
        else if (text.includes(' ') && out.length) out.push(' ') // don't glue words together
        continue
      }
      if (n.type !== 'tag') continue
      const el = n as Element
      const name = el.name.toLowerCase()
      if (DROP.has(name)) continue

      const children = walk(el.children as AnyNode[])
      const tag = ALLOWED.has(name) ? name : REMAP[name]
      // unknown tag: unwrap into its children, text matters more than the wrapper
      if (!tag) { out.push(...children); continue }

      const attrs: Record<string, string> = {}
      for (const key of KEEP_ATTRS[tag] || []) {
        const v = el.attribs?.[key]
        if (v) attrs[key] = v
      }
      const node: TphNode = { tag }
      if (Object.keys(attrs).length) node.attrs = attrs
      if (children.length) node.children = children
      // an empty, meaningless tag (except self-contained ones) — don't send it
      if (!children.length && !Object.keys(attrs).length && !['br', 'hr'].includes(tag)) continue
      out.push(node)
    }
    return out
  }

  const nodes = walk($.root().children().toArray() as AnyNode[])
  return nodes.length ? nodes : ['']
}

export interface TelegraphResult {
  attempted: boolean
  ok: boolean
  /** page path — used later to edit it (Telegraph has no equivalent of search) */
  path?: string
  url?: string
  updated?: boolean
  error?: string
}

async function tphCall(method: string, payload: Record<string, unknown>): Promise<{ ok: true; result: any } | { ok: false; error: string }> {
  const out = await retryFetch(async () => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
    try {
      return await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(t)
    }
  }, { method: 'POST' })

  if ('netError' in out) return { ok: false, error: out.netError === 'timeout' ? 'timeout (20s)' : out.netError }
  type TphEnvelope = { ok?: boolean; result?: any; error?: string }
  let body: TphEnvelope | null = null
  try { body = (await out.res.json()) as TphEnvelope } catch { /* handled below */ }
  if (!body) return { ok: false, error: `Telegraph returned non-JSON (HTTP ${out.res.status})` }
  // Telegraph always returns 200, and puts failures in the ok/error field
  if (!body.ok) return { ok: false, error: telegraphError(body.error || '') }
  return { ok: true, result: body.result }
}

/** Their error codes are in Latin letters with no explanation; we translate the ones we've seen. */
function telegraphError(raw: string): string {
  const map: Record<string, string> = {
    'ACCESS_TOKEN_INVALID': 'Telegraph token rejected — create a new account',
    'PAGE_NOT_FOUND': 'page not found — its address may have changed',
    'TITLE_TOO_LONG': 'title longer than 256 characters',
    'CONTENT_TOO_BIG': 'article too large for Telegraph (limit is around 64 KB)',
    'CONTENT_TEXT_REQUIRED': 'empty content',
    'AUTHOR_NAME_TOO_LONG': 'author name longer than 128 characters',
  }
  return map[raw] || (raw ? `Telegraph: ${raw}` : 'Telegraph rejected the request')
}

/**
 * Create a Telegraph account and get a token. The only way to obtain one:
 * telegra.ph's UI has no token, it lives in the browser's localStorage.
 */
export async function telegraphCreateAccount(shortName: string, authorName: string, authorUrl: string) {
  const r = await tphCall('createAccount', {
    short_name: (shortName || 'ideata').slice(0, 32),
    author_name: (authorName || '').slice(0, 128),
    author_url: (authorUrl || '').slice(0, 512),
  })
  if (!r.ok) return { ok: false as const, error: r.error }
  return {
    ok: true as const,
    token: String(r.result?.access_token || ''),
    // the link is one-time use: it lets the account be claimed in a browser
    authUrl: String(r.result?.auth_url || ''),
  }
}

export interface TelegraphArticle {
  title: string
  bodyHtml: string
  /** path of an already-created page — then we update it instead of creating a second one */
  path?: string
}

export async function telegraphPublish(a: TelegraphArticle, s: AppSettings): Promise<TelegraphResult> {
  const cfg = telegraphConfig(s)
  if (!cfg.token) return { attempted: false, ok: false, error: 'Telegraph token not set — create an account in the channel settings' }
  const title = (a.title || '').trim().slice(0, TITLE_LIMIT)
  if (!title) return { attempted: false, ok: false, error: 'no title' }

  const payload = {
    access_token: cfg.token,
    title,
    author_name: cfg.authorName,
    author_url: cfg.authorUrl,
    content: htmlToNodes(a.bodyHtml),
    return_content: false,
  }
  const r = a.path
    ? await tphCall('editPage', { ...payload, path: a.path })
    : await tphCall('createPage', payload)
  if (!r.ok) return { attempted: true, ok: false, error: r.error }
  return {
    attempted: true, ok: true,
    path: String(r.result?.path || a.path || ''),
    url: String(r.result?.url || ''),
    updated: !!a.path,
  }
}

/**
 * "Unpublish" an article. Telegraph has no deletion — not in the API, not in the
 * UI — so the most honest thing we can do is replace the content with a pointer
 * to the original. The link stays live forever — the UI must say so, not claim "deleted".
 */
export async function telegraphUnpublish(path: string, originalUrl: string, s: AppSettings): Promise<TelegraphResult> {
  const cfg = telegraphConfig(s)
  if (!cfg.token) return { attempted: false, ok: false, error: 'Telegraph token not set' }
  if (!path) return { attempted: true, ok: true }
  const link: TphNode = originalUrl
    ? { tag: 'p', children: ['Article moved: ', { tag: 'a', attrs: { href: originalUrl }, children: [originalUrl] }] }
    : { tag: 'p', children: ['This article has been unpublished.'] }
  const r = await tphCall('editPage', {
    access_token: cfg.token,
    path,
    title: 'Article unpublished',
    author_name: cfg.authorName,
    author_url: cfg.authorUrl,
    content: [link],
    return_content: false,
  })
  if (!r.ok) return { attempted: true, ok: false, error: r.error }
  return { attempted: true, ok: true, path, url: String(r.result?.url || '') }
}

/** Token check: fetch account info. Doesn't publish anything. */
export async function telegraphTest(s: AppSettings): Promise<TelegraphResult & { shortName?: string }> {
  const cfg = telegraphConfig(s)
  if (!cfg.token) return { attempted: false, ok: false, error: 'Telegraph token not set' }
  const r = await tphCall('getAccountInfo', {
    access_token: cfg.token,
    fields: ['short_name', 'author_name', 'page_count'],
  })
  if (!r.ok) return { attempted: true, ok: false, error: r.error }
  return { attempted: true, ok: true, shortName: String(r.result?.short_name || '') }
}
