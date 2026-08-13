/**
 * Validate an address that the USER entered and that OUR server will connect to.
 *
 * The approach is borrowed from Postiz (bluesky.provider.ts): before logging into
 * an arbitrary instance, they require a "public HTTPS address". The reason isn't
 * tidiness but SSRF: the address comes to us from a form, the request goes out
 * from the backend, and without validation any user could make our server reach
 * into our own network — Postgres at 192.168.0.5, the scraper, or
 * 169.254.169.254 for cloud metadata tokens. They'd see the response in the error text.
 *
 * Where this matters for us: the WordPress site URL, the Mastodon instance, the
 * ingest receiver's base URL — anything typed in by hand and later fetched by the server.
 *
 * The check isn't absolute: a hostname can still resolve to a private IP (DNS
 * rebinding). This is a first line of defense, like everyone has; full protection
 * would mean resolving the address and checking the IP right before connecting,
 * which needs its own agent and is overkill here.
 */

const PRIVATE_HOST = [
  /^localhost$/i,
  /^127\./,
  /^0\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local: cloud metadata lives here too
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i, // ULA fc00::/7
  /^\[?fe80:/i, // link-local IPv6
]

export interface SafeUrlCheck {
  ok: boolean
  /** normalized address without a trailing slash (when ok) */
  url?: string
  error?: string
}

export function checkPublicHttpsUrl(raw: string): SafeUrlCheck {
  const value = String(raw || '').trim()
  if (!value) return { ok: false, error: 'address is not set' }

  let u: URL
  try {
    u = new URL(value.includes('://') ? value : `https://${value}`)
  } catch {
    return { ok: false, error: 'address could not be parsed as a URL' }
  }

  if (u.protocol !== 'https:') {
    return { ok: false, error: 'https is required: over http secrets travel in plain text' }
  }
  if (u.username || u.password) {
    return { ok: false, error: 'a username and password inside the address are not supported' }
  }
  const host = u.hostname
  if (PRIVATE_HOST.some((re) => re.test(host))) {
    return { ok: false, error: 'the address points into the internal network — we do not make such requests' }
  }
  // no dot in the name means it's an internal hostname like "intranet" — also rejected
  if (!host.includes('.')) {
    return { ok: false, error: 'a public domain name is required' }
  }

  return { ok: true, url: u.origin + u.pathname.replace(/\/+$/, '') }
}
