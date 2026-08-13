// Where the user is allowed to be sent back after login/logout/OAuth callback.
//
// This function used to live as two copies (account.controller + auth.controller),
// and both let through any string starting with a slash. That's an open redirect:
// "//evil.com" and "/\evil.com" are protocol-relative URLs — the browser follows
// them to a foreign domain while the link still looks like ours. Verified in prod:
// GET /tg/logout?next=//example.com returned 302 Location: //example.com.
//
// Rule: either a TRUE relative path (one slash, followed by neither a slash nor a
// backslash), or an absolute http(s) URL on ideata.io / *.ideata.io.

const DEFAULT_NEXT = process.env.PUBLIC_SITE_URL ?? 'https://ideata.io/';

function isOwnHost(hostname: string): boolean {
  return hostname === 'ideata.io' || hostname.endsWith('.ideata.io');
}

export function safeNext(next?: string | null): string {
  // \s also strips control characters (\t, \n, \r) used to disguise "//".
  const n = (next ?? '').trim();
  if (!n) return DEFAULT_NEXT;

  // Relative path: "/app", "/r/abc". Reject "//host" and "/\host".
  if (n.startsWith('/')) {
    return /^\/[/\\]/.test(n) ? DEFAULT_NEXT : n;
  }

  try {
    const u = new URL(n);
    // http(s) only: javascript:, data: and the like must not get through here.
    if ((u.protocol === 'https:' || u.protocol === 'http:') && isOwnHost(u.hostname)) {
      return n;
    }
  } catch {
    /* not a URL — fall back to the default */
  }
  return DEFAULT_NEXT;
}

export { DEFAULT_NEXT };
