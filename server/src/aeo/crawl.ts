/**
 * Homepage crawl for GROUNDING the prompt generator — deterministic port of the
 * extraction part of core/crawl_audit.py (audit(), _hero_text, _headings).
 *
 * Why: without site context, the OFF-TOPIC INDUSTRY filter (_keywords_about_site
 * in generate.ts) is inert, and unrelated semantics from the keyword provider
 * leak into the first prompt (on ideata.io this let "edgedata" leak in from
 * edge-computing). Hence we grab exactly the fields read by
 * siteVocabulary/productBrief/detectLang/siteSections: title / description / h1
 * / hero_text / headings{h1,h2,h3}.
 *
 * Layers (as throughout the AEO port):
 *   • PURE CORE — parseHomepageContext(html, domain): cheerio parsing WITHOUT
 *     network, byte-for-byte with Python's BeautifulSoup branch (parity in
 *     crawl.spec against the live core/crawl_audit). Three tricky spots here
 *     were verified against the oracle: (1) title does NOT collapse internal
 *     whitespace (get_text(strip=True) with separator ""), only trims edges;
 *     (2) the h1 field is taken from the FULL document BEFORE nav/footer are
 *     stripped (the first h1 may be in the header), while headings are taken
 *     AFTER stripping (matches the order dict computation happens in Python,
 *     where _hero_text decomposes the soup before _headings); (3)
 *     get_text(" ", strip=True) puts a space between nodes —
 *     "<span>ChatGPT</span><span>Alice</span>" becomes "ChatGPT Alice", not
 *     "ChatGPTAlice".
 *   • NETWORK SHELL — crawlHomepage(domain): SSRF gate (checkPublicHttpsUrl —
 *     don't let the request reach the internal network) ON EVERY hop
 *     (redirect:'manual', a third-party 3xx into the internal network is NOT
 *     followed), GET via audit/net-checks.get (shared timeout/UA) with a body
 *     size cap, then the core. Failure-isolated exactly like Python: an
 *     unreachable/broken homepage → null, so suggest doesn't fail, it just
 *     loses grounding.
 */
import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { pyStrip } from './parse';
import type { GenerateContext } from './generate';
import { get as netGet } from '../audit/net-checks';
import { checkPublicHttpsUrl } from '../blogwriter/server/utils/safeUrl';
import { cleanDomain } from '../public-api/clean-domain';

/** Cap on the homepage body size: we parse for order of magnitude, not mirror the site. */
const MAX_HTML_BYTES = 3_000_000;
/** hero_text truncation threshold in code points (Python _HERO_MAX). */
const HERO_MAX = 700;
/** Cap on the h1 field length (Python `[:200]`). */
const H1_MAX = 200;
/** Cap on a single heading's length within headings (Python `[:120]`). */
const HEADING_MAX = 120;
/** How many of the first level headings go into the list (Python `tags[:8]`). */
const HEADINGS_LIMIT = 8;
/** How many of the first h1/h2/p to scan for hero (Python `find_all(..., limit=12)`). */
const HERO_TAG_LIMIT = 12;

/**
 * Whitespace set for Python regex `\s` (== the str.isspace class, verified against
 * parse.ts): needed so `re.sub(r"\s+", " ", …)` collapses exactly the same
 * characters, including \xa0 and \x1c-\x1f, not just the ASCII space.
 */
const PY_WS_CLASS =
  '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a' +
  '\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_WS_RE = new RegExp(`[${PY_WS_CLASS}]+`, 'gu');

/** Python's `re.sub(r"\s+", " ", s)`. */
function collapseWs(s: string): string {
  return s.replace(PY_WS_RE, ' ');
}

/** Python's slice `s[:n]` — by CODE POINTS, not UTF-16 units. */
function cpSlice(s: string, n: number): string {
  if (n <= 0) return '';
  return Array.from(s).slice(0, n).join('');
}

/** String length in code points (Python's `len`). */
function cpLen(s: string): number {
  return Array.from(s).length;
}

/**
 * Equivalent of BeautifulSoup's `Tag.get_text(separator=sep, strip=True)`:
 * collect the text of ALL descendant string nodes, trim the edges of EACH
 * (Python's `str.strip`, not JS trim), drop empty ones, join with `sep`.
 * Internal whitespace within a node is NOT touched — collapsing (where Python
 * does it) is left to the caller via collapseWs. Comments and CDATA are not
 * text nodes → they don't end up in the output (same as BS).
 */
function bsGetText(node: AnyNode, sep: string): string {
  const parts: string[] = [];
  const walk = (n: AnyNode): void => {
    // domhandler: a text node has type==='text' with a data field; elements have children.
    if (n.type === 'text') {
      const s = pyStrip(String((n as { data?: unknown }).data ?? ''));
      if (s) parts.push(s);
    } else {
      const kids = (n as { children?: AnyNode[] }).children;
      if (kids) for (const c of kids) walk(c);
    }
  };
  walk(node);
  return parts.join(sep);
}

/** Level headings: full count + list of the first 8 non-empty, collapsed, ≤120. */
export interface HeadingBlock {
  h1: string[];
  h1_count: number;
  h2: string[];
  h2_count: number;
  h3: string[];
  h3_count: number;
}

/** Crawl context — superset of the fields read by generate.ts. */
export interface CrawlContext extends GenerateContext {
  title: string | null;
  description: string | null;
  h1: string | null;
  hero_text: string | null;
  headings: HeadingBlock;
}

/**
 * hero_text: visible text at the top (h1/h2/p) AFTER stripping boilerplate
 * sections. Port of _hero_text (crawl_audit.py:184-195): the first 12 h1/h2/p
 * elements in document order, each through get_text(" ",strip=True)+collapse,
 * order-preserving dedup, break once the sum of LENGTHS (in code points)
 * exceeds 700, then `" • ".join(parts)[:700]`. The threshold check runs on
 * EVERY iteration, matching Python (even when the element is empty/a
 * duplicate and wasn't added).
 */
function heroText($: cheerio.CheerioAPI): string {
  const parts: string[] = [];
  const els = $('h1, h2, p').toArray().slice(0, HERO_TAG_LIMIT);
  for (const el of els) {
    const t = collapseWs(bsGetText(el, ' '));
    if (t && !parts.includes(t)) parts.push(t);
    let sum = 0;
    for (const p of parts) sum += cpLen(p);
    if (sum > HERO_MAX) break;
  }
  return cpSlice(parts.join(' • '), HERO_MAX);
}

/** headings: port of _headings (crawl_audit.py:124-133) on the ALREADY stripped tree. */
function headings($: cheerio.CheerioAPI): HeadingBlock {
  const level = (lvl: 'h1' | 'h2' | 'h3'): { list: string[]; count: number } => {
    const tags = $(lvl).toArray();
    const list = tags
      .slice(0, HEADINGS_LIMIT)
      // filter by get_text(strip=True) (separator ""): non-empty after strip
      .filter((t) => bsGetText(t, '') !== '')
      .map((t) => cpSlice(collapseWs(bsGetText(t, ' ')), HEADING_MAX));
    return { list, count: tags.length };
  };
  const h1 = level('h1');
  const h2 = level('h2');
  const h3 = level('h3');
  return {
    h1: h1.list,
    h1_count: h1.count,
    h2: h2.list,
    h2_count: h2.count,
    h3: h3.list,
    h3_count: h3.count,
  };
}

/**
 * PURE CORE: homepage HTML → context for the generator. No network,
 * deterministic, parity against core/crawl_audit.audit() (extraction part).
 * The operation order mirrors the dict computation order in Python:
 * title/description/h1 — over the FULL tree, then strip
 * script/style/noscript/svg/nav/footer (this is what _hero_text does via
 * decompose), then hero_text and headings — over the stripped tree.
 */
export function parseHomepageContext(html: string, _domain: string): CrawlContext {
  const $ = cheerio.load(html);

  // --- over the FULL tree (before stripping) --------------------------------
  const titleEl = $('title').first();
  // title tag exists → string (possibly ""), no tag → null (same as Python).
  const title = titleEl.length ? bsGetText(titleEl.get(0)!, '') : null;

  let descTag = $('meta[name="description"]').first();
  if (!descTag.length) descTag = $('meta[property="og:description"]').first();
  const description = descTag.length
    ? pyStrip(String(descTag.attr('content') ?? '')) || null
    : null;

  const h1El = $('h1').first();
  const h1 = h1El.length ? cpSlice(collapseWs(bsGetText(h1El.get(0)!, ' ')), H1_MAX) : null;

  // --- strip boilerplate sections (equivalent of decompose in _hero_text) ---
  $('script, style, noscript, svg, nav, footer').remove();

  // --- over the STRIPPED tree ------------------------------------------------
  const hero = heroText($);

  return {
    title,
    description,
    h1,
    hero_text: hero || null,
    headings: headings($),
  };
}

/** Max hops when MANUALLY following redirects (see fetchFollowingSafeRedirects). */
const MAX_REDIRECTS = 5;

/**
 * GET with MANUAL redirect following and an SSRF gate on EVERY hop.
 *
 * The starting host is already checked by checkPublicHttpsUrl in
 * crawlHomepage, but the domain is user-controlled (tracker.domain), and its
 * server is free to respond with a 3xx whose Location points into the
 * internal network — 169.254.169.254 for cloud tokens, an internal Postgres
 * address (SSRF target). With redirect:'follow' (net-checks.get's default),
 * undici would follow it ITSELF, and the body would leak into grounding and
 * into the returned suggest hints (an exfiltration channel). So we use
 * redirect:'manual' and run EVERY Location through the same public-https gate
 * (like checkRedirects.trace in the audit): the first private/non-https
 * redirect → abort to null. The loop is bounded by MAX_REDIRECTS, which also
 * breaks redirect loops.
 */
async function fetchFollowingSafeRedirects(
  start: string,
  deps: CrawlDeps,
): Promise<Response | null> {
  const doGet = deps.get ?? netGet;
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await doGet(url, { redirect: 'manual' });
    if (!res) return null;
    // not a 3xx redirect → final response (2xx/4xx/5xx is the caller's decision)
    if (!(res.status >= 300 && res.status < 400)) return res;
    const loc = res.headers.get('location');
    // don't need the redirect body — free the connection
    await res.body?.cancel().catch(() => {});
    if (!loc) return null;
    let next: string;
    try {
      next = new URL(loc, url).toString();
    } catch {
      return null;
    }
    // same gate as on the starting host: public https, not a private IP/hostname
    if (!checkPublicHttpsUrl(next).ok) return null;
    url = next;
  }
  // ran out of hops and the site is still redirecting — stop here
  return null;
}

/** GET wrapper response: final HTML or null (unreachable/broken/not HTML). */
async function fetchHomepage(
  url: string,
  deps: CrawlDeps,
): Promise<string | null> {
  const res = await fetchFollowingSafeRedirects(url, deps);
  if (!res || res.status >= 400) return null;
  // Read the body with a size cap: the homepage is only needed for order of
  // magnitude, not a full download. undici has already decoded content-encoding,
  // so the cap is applied to the DECOMPRESSED bytes.
  try {
    const reader = res.body?.getReader();
    if (!reader) {
      const t = await res.text();
      return cpSlice(t, MAX_HTML_BYTES);
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
        if (total >= MAX_HTML_BYTES) {
          await reader.cancel().catch(() => {});
          break;
        }
      }
    }
    const html = Buffer.concat(chunks).toString('utf8');
    return html || null;
  } catch {
    return null;
  }
}

/** Transport injection for tests (mock GET), so we don't hit the network for real. */
export interface CrawlDeps {
  // opts carries redirect:'manual' — manual redirect following with an SSRF
  // gate on every hop (see fetchFollowingSafeRedirects).
  get?: (url: string, opts?: { redirect?: RequestRedirect }) => Promise<Response | null>;
}

/**
 * NETWORK SHELL: domain → homepage context, best-effort. Port of
 * services.py:729-731 (`crawl_ctx = crawl_audit.audit(domain)` in try/except →
 * None). The SSRF gate keeps the request out of the internal network
 * (Postgres 192.168.x, 169.254 for cloud tokens). Any failure/unreachability/
 * private host → null: suggest doesn't fail, it just loses grounding (the
 * off-topic-industry filter becomes inert, same as in Python).
 */
export async function crawlHomepage(
  domain: string,
  deps: CrawlDeps = {},
): Promise<CrawlContext | null> {
  const clean = cleanDomain(domain);
  if (!clean) return null;
  // checkPublicHttpsUrl requires a public https host with a dot in the name and
  // rejects private/link-local addresses — the first line of defense against
  // SSRF; the same gate repeats on EVERY redirect inside fetchHomepage
  // (redirect:'manual').
  const guard = checkPublicHttpsUrl(clean);
  if (!guard.ok || !guard.url) return null;
  try {
    const html = await fetchHomepage(guard.url + '/', deps);
    if (!html) return null;
    return parseHomepageContext(html, clean);
  } catch {
    return null;
  }
}
