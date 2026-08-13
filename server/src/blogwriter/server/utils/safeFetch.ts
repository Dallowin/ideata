/**
 * The single point through which the blog writer visits addresses coming FROM THE
 * USER (a link in the editor, a brand domain, search results, an article's source).
 *
 * The reason is the same as in safeUrl.ts, but here the protection is complete,
 * not just a "first line of defense": the request goes out from a server that sits
 * on the internal network next to Postgres (192.168.0.5), the scraper, and cloud
 * metadata. So:
 *   - http/https only;
 *   - we resolve the host OURSELVES and reject every private/loopback/link-local address;
 *   - redirects are followed manually (redirect:'manual') - otherwise a single 302
 *     to 127.0.0.1 would bypass the host check;
 *   - the body is read with a byte limit and a shared deadline, so a link to a
 *     four-gigabyte ISO can't hang the worker.
 *
 * This used to live inside unfurl.ts and only worked for link unfurling; search.ts
 * (article download) and brandVoice.ts (brand site crawl) fetched anything with
 * redirect:'follow'. The module was extracted so everyone shares the same barrier.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export const DEFAULT_MAX_BYTES = 512 * 1024
export const DEFAULT_TIMEOUT_MS = 8_000
export const DEFAULT_MAX_REDIRECTS = 3

/** A plausible UA: without it, half the sites return a stub with no content. */
export const BOT_UA = 'Mozilla/5.0 (compatible; IdeataBot/1.0; +https://ideata.io)'

/** Private/service ranges our server must not connect to. */
export function isPrivateIp(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const o = ip.split('.').map(Number)
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true
    const [a, b] = o
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 192 && b === 0) return true // 192.0.0.0/24 IETF
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return true // benchmark
    if (a >= 224) return true // multicast + reserved + broadcast
    return false
  }
  if (v === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, '')
    // v4-mapped (::ffff:10.0.0.1) - check the embedded IPv4
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isPrivateIp(mapped[1])
    if (s === '::' || s === '::1') return true
    if (/^f[cd][0-9a-f]{2}:/.test(s)) return true // fc00::/7 ULA
    if (/^fe[89ab][0-9a-f]:/.test(s)) return true // fe80::/10 link-local
    if (s.startsWith('64:ff9b:')) return true // NAT64
    return false
  }
  return true // couldn't parse it - treat it as dangerous
}

/**
 * Check that the URL is safe to visit. Throws on any doubt.
 * The "resolve -> connect" race (TOCTOU) still exists here: fetch resolves the
 * name again. This is a deliberate trade-off - it can't be closed without our own
 * HTTP agent.
 */
export async function assertPublicUrl(u: URL): Promise<void> {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('http and https only')
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new Error('empty host')
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error('internal address')
    return
  }
  if (/(^|\.)localhost$/i.test(host) || /\.internal$/i.test(host) || /\.local$/i.test(host)) {
    throw new Error('internal address')
  }
  const addrs = await lookup(host, { all: true, verbatim: true })
  if (!addrs.length) throw new Error('host does not resolve')
  // a single private address is enough to reject: otherwise a domain with two
  // A records (a public one and 127.0.0.1) gets through every other time
  if (addrs.some((a) => isPrivateIp(a.address))) throw new Error('internal address')
}

/** true - the address will pass assertPublicUrl (doesn't throw; for filtering link lists). */
export async function isPublicUrl(raw: string | URL): Promise<boolean> {
  try {
    await assertPublicUrl(raw instanceof URL ? raw : new URL(String(raw)))
    return true
  } catch {
    return false
  }
}

/** Read no more than maxBytes of the body and cut the connection. */
export async function readLimited(res: Response, maxBytes = DEFAULT_MAX_BYTES): Promise<string> {
  const reader = res.body?.getReader()
  if (!reader) return ''
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      const buf = Buffer.from(value)
      chunks.push(buf)
      total += buf.length
    }
  } catch {
    /* cut off partway through - parse whatever we got */
  }
  try { await reader.cancel() } catch { /* already closed */ }
  return Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8')
}

export interface SafeFetchOptions {
  timeoutMs?: number
  maxRedirects?: number
  headers?: Record<string, string>
  accept?: string
}

export interface SafeFetchHit {
  res: Response
  /** final address after all redirects (every hop passed the host check) */
  url: URL
}

/**
 * A request to a user-supplied address with a host check on EVERY redirect hop.
 * null - not allowed to go, or didn't make it (internal address, timeout, malformed
 * URL, non-2xx response, ran out of redirects). Read the response body only via readLimited.
 */
export async function safeFetch(rawUrl: string | URL, opts: SafeFetchOptions = {}): Promise<SafeFetchHit | null> {
  let current: URL
  try {
    current = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl || '').trim())
  } catch {
    return null
  }
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  // one deadline for the whole redirect chain, not a separate timeout per hop
  const signal = AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      await assertPublicUrl(current)
      const res = await fetch(current, {
        redirect: 'manual',
        signal,
        headers: {
          'user-agent': BOT_UA,
          ...(opts.accept ? { accept: opts.accept } : {}),
          ...opts.headers,
        },
      })

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location')
        try { await res.body?.cancel() } catch { /* already closed */ }
        if (!loc) return null
        current = new URL(loc, current) // the next iteration will re-run the host check
        continue
      }
      if (!res.ok) {
        try { await res.body?.cancel() } catch { /* already closed */ }
        return null
      }
      return { res, url: current }
    }
  } catch {
    return null // timeout, DNS, internal address, connection drop - all equally "didn't work"
  }
  return null // ran out of redirects
}

/** true - content-type looks like HTML/XML (for handlers that need a document, not a file). */
export function isHtmlLike(contentType: string | null): boolean {
  const ct = (contentType || '').toLowerCase()
  if (!ct) return true // server didn't say - try parsing it as a document
  return ct.includes('html') || ct.includes('xml')
}

/**
 * Download an HTML document from a user-supplied address. An empty string means
 * it didn't work, or it's not a document (parsing an image/archive/video as an
 * article is pointless, and pulling them in fully is a way to eat the worker's memory).
 */
export async function safeFetchHtml(
  rawUrl: string,
  opts: SafeFetchOptions & { maxBytes?: number } = {},
): Promise<string> {
  const hit = await safeFetch(rawUrl, { accept: 'text/html,application/xhtml+xml', ...opts })
  if (!hit) return ''
  if (!isHtmlLike(hit.res.headers.get('content-type'))) {
    try { await hit.res.body?.cancel() } catch { /* already closed */ }
    return ''
  }
  return readLimited(hit.res, opts.maxBytes ?? DEFAULT_MAX_BYTES)
}
