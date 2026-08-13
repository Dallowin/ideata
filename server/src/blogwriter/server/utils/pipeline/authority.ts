/**
 * Domain-based source authority heuristic (0..10, no network calls).
 * Needed so parsing and citations favor primary sources (research, official
 * docs, statistics) over SEO blogs.
 * Base score 5, boosted by domain type, penalized for obvious content farms.
 */

/** Primary-source domains: research, statistics, official data. */
const HIGH_AUTHORITY = new Set([
  'wikipedia.org',
  'statista.com',
  'pewresearch.org',
  'gartner.com',
  'mckinsey.com',
  'nielsen.com',
  'similarweb.com',
  'semrush.com',
  'ahrefs.com',
  'searchengineland.com',
  'searchenginejournal.com',
  'github.com',
  'arxiv.org',
  'nature.com',
  'sciencedirect.com',
  'hbr.org',
  'steamcommunity.com',
  'steampowered.com',
  'valvesoftware.com',
])

/** Signals of content farms/aggregators — cite these last. */
const LOW_AUTHORITY_HINTS = [/^blog\.|\.blogspot\./, /medium\.com$/, /dzen\.ru$/, /vc\.ru$/, /pikabu\.ru$/]

export function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase() } catch { return '' }
}

export function authorityScore(url: string): number {
  const dom = domainOf(url)
  if (!dom) return 0
  // government/educational/international-organization TLDs
  if (/\.(gov|edu|int)(\.[a-z]{2})?$/.test(dom) || /\.(gov|edu)\.[a-z]{2}$/.test(dom)) return 9
  // known primary sources (including subdomains: docs.github.com → github.com)
  const base = dom.split('.').slice(-2).join('.')
  if (HIGH_AUTHORITY.has(dom) || HIGH_AUTHORITY.has(base)) return 8
  // official product documentation
  if (/^(docs|developer|developers|support|help)\./.test(dom)) return 7
  if (LOW_AUTHORITY_HINTS.some(re => re.test(dom))) return 3
  return 5
}
