/**
 * Sanitizer for the article body. The only defense against stored XSS: the public
 * render outputs BlogPost.body via v-html WITHOUT any cleanup, and the body comes
 * from the editor - i.e. directly from the user's browser. Anything that slips
 * through here executes for every reader of the blog.
 *
 * That's why the policy is a whitelist, not a blacklist: an unknown tag is
 * unwrapped (its content is kept), an unknown attribute is stripped. Explicitly
 * dangerous containers (script/style/object/...) are removed along with their content.
 *
 * Called twice - on run save (PATCH) and before writing to BlogPost (publish.ts):
 * the body could have ended up in the DB bypassing the editor (import, migration,
 * a direct update), and the second pass catches exactly those cases.
 */
import * as cheerio from 'cheerio'
import { EMBED_HOSTS } from './embedProviders'

/** What is allowed to remain in the article body. */
const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'strong', 'b', 'em', 'i', 's', 'u', 'a', 'br', 'hr', 'img', 'figure',
  'figcaption', 'video', 'audio', 'source', 'iframe', 'div', 'span', 'table',
  'thead', 'tbody', 'tr', 'th', 'td', 'mark', 'sup', 'sub',
  // not part of the contract, but unwrapping them inside a table would break the markup
  'tfoot', 'caption',
  // StarterKit in app/ isn't restricted to certain heading levels, and h5/h6 exist
  // in old articles - unwrapping them would silently turn a heading into a paragraph
  'h5', 'h6',
  // the TipTap table renders colgroup>col with column widths; without them a table
  // with table-layout: fixed collapses to equal columns on the very next save
  'colgroup', 'col',
])

/**
 * Removed ENTIRELY, not unwrapped: their content is executable or
 * deferred-executable (template stores its children as a separate subtree that a
 * regular traversal doesn't reach), so leaving it as text would be pointless.
 */
const DROP_TAGS: ReadonlySet<string> = new Set([
  'script', 'style', 'noscript', 'object', 'embed', 'form', 'input',
  'template', 'link', 'meta', 'base', 'svg', 'math', 'button', 'select',
  'option', 'textarea', 'frame', 'frameset', 'applet',
])

/** Attributes that are harmless on any tag. */
const GLOBAL_ATTRS: ReadonlySet<string> = new Set(['class', 'title', 'dir', 'lang', 'id'])

/** Allowed attributes per tag (everything else is stripped). */
const TAG_ATTRS: Record<string, ReadonlySet<string>> = {
  a: new Set(['href', 'target', 'rel', 'download']),
  img: new Set(['src', 'alt', 'loading', 'width', 'height']),
  video: new Set(['src', 'controls', 'preload', 'playsinline', 'poster', 'width', 'height', 'loop', 'muted']),
  audio: new Set(['src', 'controls', 'preload', 'loop']),
  source: new Set(['src', 'type']),
  iframe: new Set(['src', 'loading', 'frameborder', 'allow', 'allowfullscreen', 'referrerpolicy', 'width', 'height']),
  td: new Set(['colspan', 'rowspan', 'colwidth']),
  th: new Set(['colspan', 'rowspan', 'scope', 'colwidth']),
  ol: new Set(['start', 'reversed', 'type']),
  col: new Set(['span']),
}

/** Attributes carrying links - their values are checked separately. */
const URL_ATTRS: ReadonlySet<string> = new Set(['href', 'src', 'poster'])

/**
 * Strip control characters and invisible spaces: a browser will read
 * `java\0script:` and `java\tscript:` as `javascript:`, but a naive prefix check
 * won't.
 */
function normalizeUrl(raw: string): string {
  return String(raw || '')
    .replace(/[\u0000-\u0020\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f-\u2060\u3000\ufeff]/g, '')
    .trim()
}

/** Link scheme allowed in text: http(s), mailto, tel, or our own relative path. */
function safeHref(raw: string): boolean {
  const v = normalizeUrl(raw)
  if (!v) return false
  if (v.startsWith('//')) return false // protocol-relative - leads off to a foreign host
  if (v.startsWith('/') || v.startsWith('#')) return true
  return /^(https?|mailto|tel):/i.test(v)
}

/**
 * Media source: only an absolute http(s) URL or our own relative path.
 * `data:` is disallowed entirely - it's how you'd smuggle an SVG with a script, or
 * megabytes of base64, into the post body.
 */
function safeMediaSrc(raw: string): boolean {
  const v = normalizeUrl(raw)
  if (!v) return false
  if (v.startsWith('//')) return false
  if (v.startsWith('/')) return true
  return /^https?:/i.test(v)
}

/** The iframe host must be in the provider whitelist (subdomains matched by suffix). */
function embedAllowed(raw: string): boolean {
  const v = normalizeUrl(raw)
  if (!/^https:/i.test(v)) return false // http iframe = mixed content + MITM
  try {
    const host = new URL(v).hostname.toLowerCase()
    return EMBED_HOSTS.some((h) => host === h || host.endsWith('.' + h))
  } catch {
    return false
  }
}

/**
 * The one inline style that survives - the embed container's height
 * (`padding-bottom: 56.25%`): without it the iframe collapses to zero height, and
 * it can't be moved into a class - each video's aspect ratio is different.
 */
function keepEmbedStyle(style: string, className: string): string {
  if (!/(^|\s)bw-embed(\s|$)/.test(className || '')) return ''
  const m = String(style || '').match(/padding-bottom\s*:\s*([\d.]+)%/i)
  if (!m) return ''
  const pct = Number(m[1])
  if (!Number.isFinite(pct) || pct <= 0 || pct > 400) return ''
  return `padding-bottom:${pct}%`
}

/**
 * The second inline style that survives - the table column width on `<col>`:
 * TipTap only stores it there, and removing it would collapse the table into equal columns.
 */
function keepColStyle(style: string): string {
  const m = String(style || '').match(/width\s*:\s*([\d.]+)px/i)
  if (!m) return ''
  const px = Number(m[1])
  if (!Number.isFinite(px) || px <= 0 || px > 4000) return ''
  return `width:${px}px`
}

/** Recursively strip HTML comments (used to hide IE conditional markup and junk). */
function stripComments(nodes: any[]): void {
  for (const n of [...(nodes || [])]) {
    if (n?.type === 'comment') {
      const parent = n.parent
      if (parent?.children) parent.children = parent.children.filter((c: any) => c !== n)
      continue
    }
    if (n?.children?.length) stripComments(n.children)
  }
}

/**
 * Clean up the article body HTML. Input can be anything, output is a fragment
 * made only from the whitelist. An empty/malformed string -> ''.
 */
export function sanitizeArticleHtml(html: string): string {
  const src = String(html ?? '')
  if (!src.trim()) return ''

  let $: cheerio.CheerioAPI
  try {
    // third arg false - a fragment, not a document: we don't want to get <html><body>
    $ = cheerio.load(src, null, false)
  } catch {
    return '' // failed to parse - better empty than an unvalidated string
  }

  // first, cut out dangerous subtrees entirely - so the traversal below never
  // even sees their content
  $([...DROP_TAGS].join(',')).remove()
  stripComments($.root().toArray() as any[])

  // Traversal in document order. Unwrapping doesn't create new nodes (the children
  // were already in the tree and already in this list), so a single pass is
  // enough; nodes detached along with a removed ancestor just run harmlessly.
  for (const node of $('*').toArray()) {
    const el = node as any
    const tag = String(el.tagName || el.name || '').toLowerCase()

    if (DROP_TAGS.has(tag)) { $(el).remove(); continue }
    if (!ALLOWED_TAGS.has(tag)) { $(el).replaceWith($(el).contents()); continue }

    const $el = $(el)
    const allowed = TAG_ATTRS[tag]
    const className = String(el.attribs?.class || '')
    const style = String(el.attribs?.style || '')

    for (const name of Object.keys(el.attribs || {})) {
      const lower = name.toLowerCase()

      // data-* is the source of truth for the media block when re-parsed back into
      // the editor, and they're inert: the browser never executes them
      if (lower.startsWith('data-')) continue

      if (lower === 'style') {
        const keep = tag === 'col' ? keepColStyle(style) : keepEmbedStyle(style, className)
        if (keep) $el.attr('style', keep)
        else $el.removeAttr(name)
        continue
      }

      // on*, srcdoc, formaction, and anything not on the whitelist
      if (!GLOBAL_ATTRS.has(lower) && !allowed?.has(lower)) { $el.removeAttr(name); continue }

      if (URL_ATTRS.has(lower)) {
        const value = String(el.attribs[name] ?? '')
        const ok = tag === 'a' ? safeHref(value) : safeMediaSrc(value)
        if (!ok) $el.removeAttr(name)
        else $el.attr(name, normalizeUrl(value))
      }
    }

    if (tag === 'iframe') {
      // src already passed safeMediaSrc; now enforce the provider whitelist strictly
      const s = String($el.attr('src') || '')
      if (!embedAllowed(s)) { $el.remove(); continue }
      $el.attr('loading', 'lazy')
      $el.attr('frameborder', '0')
      $el.attr('allowfullscreen', 'allowfullscreen')
      if (!$el.attr('allow')) {
        $el.attr('allow', 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen')
      }
      continue
    }

    if (tag === 'a') {
      // target=_blank without noopener gives the opened tab access to window.opener
      if ($el.attr('target') === '_blank') {
        const rel = String($el.attr('rel') || '')
        if (!/noopener/.test(rel)) $el.attr('rel', (rel ? rel + ' ' : '') + 'noopener')
      }
      continue
    }

    if (tag === 'img' || tag === 'video' || tag === 'audio' || tag === 'source') {
      // a tag without a usable source is just an empty hole in the layout
      if (!$el.attr('src')) $el.remove()
    }
  }

  return $.html()
}
