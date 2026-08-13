/**
 * Safe link unfurling: fetch the page and pull the og tags for a preview card.
 *
 * All SSRF protection (host resolution, rejecting private addresses, manual
 * redirect handling, body limit, and deadline) lives in safeFetch — the same
 * barrier now also guards the brand crawler and source-article downloads.
 *
 * Any error is not a 500: the caller draws a card from the hostname alone.
 */
import * as cheerio from 'cheerio'
import { isHtmlLike, readLimited, safeFetch } from './safeFetch'

const MAX_BYTES = 512 * 1024
const TIMEOUT_MS = 8_000
const MAX_REDIRECTS = 3

export interface UnfurlResult {
  title: string
  desc: string
  thumb: string
  site: string
}

function meta($: cheerio.CheerioAPI, names: string[]): string {
  for (const n of names) {
    const v = $(`meta[property="${n}"]`).attr('content') || $(`meta[name="${n}"]`).attr('content')
    if (v && v.trim()) return v.trim().slice(0, 500)
  }
  return ''
}

/**
 * Get the page's og description. null means it failed (unreachable, not HTML,
 * internal address): the caller falls back to a card with just the hostname.
 */
export async function unfurl(rawUrl: string): Promise<UnfurlResult | null> {
  const hit = await safeFetch(String(rawUrl || '').trim(), {
    timeoutMs: TIMEOUT_MS,
    maxRedirects: MAX_REDIRECTS,
    accept: 'text/html,application/xhtml+xml',
  })
  if (!hit) return null
  const { res, url: current } = hit

  if (!isHtmlLike(res.headers.get('content-type'))) {
    try { await res.body?.cancel() } catch { /* already closed */ }
    return null
  }

  const html = await readLimited(res, MAX_BYTES)
  if (!html.trim()) return null
  const $ = cheerio.load(html)
  const site = meta($, ['og:site_name']) || current.hostname.replace(/^www\./, '')
  const title = meta($, ['og:title', 'twitter:title']) || $('title').first().text().trim().slice(0, 500)
  const desc = meta($, ['og:description', 'twitter:description', 'description'])
  let thumb = meta($, ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src'])
  // relative og:image shows up more often than we'd like
  if (thumb) {
    try {
      const abs = new URL(thumb, current)
      thumb = abs.protocol === 'http:' || abs.protocol === 'https:' ? abs.toString() : ''
    } catch { thumb = '' }
  }
  return { title, desc, thumb, site }
}
