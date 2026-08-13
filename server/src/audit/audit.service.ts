/**
 * Tech-audit orchestrator — port of site_audit.audit().
 *
 * Gathers all check groups into a single report: score, categories, action
 * plan, what's already good, tech passport. Call order mirrors Python,
 * because it determines the order of checks in the report, which is visible
 * to the user.
 *
 * `deep: false` skips the slow stuff (PageSpeed taking up to a minute, page
 * crawling, link pinging) — this is the mode the public tool on the landing
 * page answers with.
 */
import { Injectable } from '@nestjs/common';
import * as cheerio from 'cheerio';
import { Check, OK, WARN, FAIL, NA } from './types';
import { checkMeta, checkSocial, checkContent, checkHreflang, checkA11y } from './html-checks';
import {
  get, checkRedirects, checkHeaders, checkTransport,
  checkTrailingSlash, check404, checkLinks, checkDuplicates,
} from './net-checks';
import { checkIndexing, checkSslChecks, checkSpeed, fetchCwv, looksLikeHtml } from './index-checks';
import { checkSsl, SslInfo } from './ssl';
import { score, categoryScores, actionPlan, passed, summarize } from './scoring';
import { detectTechstack } from './techstack';
import { DiscoverSettings } from '../discover/settings';

const MAX_PAGES = 10;   // crawl ceiling: the tool is free, the sites are someone else's

/**
 * The home page didn't respond. The reason matters: "domain doesn't exist"
 * and "domain exists, but an anti-bot returns 403" are different problems
 * with different user actions, and both hide behind a generic "site didn't open".
 */
export class SiteUnreachableError extends Error {}

/** Domain without scheme, path, or www. */
export function normDomain(v: string): string {
  let s = String(v || '').trim().toLowerCase();
  s = (s.split('//').pop() || '').split('/')[0].split('?')[0];
  return s.startsWith('www.') ? s.slice(4) : s;
}

// Utility/tracking params: they don't change the document, but they spawn
// "different" URLs. Meaningful ones (?page=2, ?p=10 — pagination and WP
// permalinks) must be kept: they're separate pages, and stripping the whole
// query would drop them from the crawl.
const DROP_PARAMS = new Set(['ref', 'fbclid', 'gclid', 'yclid', '_openstat',
  'next', 'return_to', 'from']);

/** URL without an anchor or tracking params; meaningful query is kept. */
function cleanInnerUrl(url: string): string {
  let u: URL;
  try { u = new URL(url); } catch { return url; }
  const kept: Array<[string, string]> = [];
  u.searchParams.forEach((v, k) => {
    if (!k.startsWith('utm_') && !DROP_PARAMS.has(k)) kept.push([k, v]);
  });
  const qs = new URLSearchParams(kept).toString();
  return `${u.protocol}//${u.host}${u.pathname}${qs ? `?${qs}` : ''}`;
}

/**
 * Key for "same document": host + path without a trailing slash + sorted
 * meaningful query. Scheme is deliberately ignored — the http and https
 * variants of the same page converge, via redirect, into one document.
 */
function docKey(url: string): string {
  let u: URL;
  try { u = new URL(cleanInnerUrl(url)); } catch { return url; }
  const params: string[] = [];
  u.searchParams.forEach((v, k) => params.push(`${k}=${v}`));
  params.sort();
  return `${u.host.toLowerCase()}|${u.pathname.replace(/\/+$/, '') || '/'}|${params.join('&')}`;
}

/**
 * Internal links on the page. Dedup is by normalized document key, not by
 * URL string: otherwise https://x.test, http://x.test/, and https://x.test/
 * were counted as three different pages (a logo link with no slash is the
 * most common case), and the home page got crawled again and counted itself
 * as a duplicate.
 */
export function innerUrls($: cheerio.CheerioAPI, baseUrl: string, domain: string,
                         limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>([docKey(baseUrl)]);
  for (const el of $('a[href]').toArray()) {
    let raw: string;
    try {
      raw = new URL(($(el).attr('href') || '').trim(), baseUrl).toString().split('#')[0];
    } catch { continue; }
    if (!/^https?:\/\//.test(raw)) continue;
    const full = cleanInnerUrl(raw);
    let host = '';
    try { host = new URL(full).host; } catch { continue; }
    if (normDomain(host) !== domain) continue;
    const key = docKey(full);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(full);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Word count of page text — as counted by BeautifulSoup's `get_text(' ', strip=True)`.
 *
 * Two corrections, without which the text volume is skewed by roughly double:
 *   • <script>/<style> content isn't page text. bs4 keeps them as a separate
 *     node type and excludes them from get_text(), while cheerio returns them
 *     as regular nodes — on an SSR page with embedded JSON that's a thousand
 *     extra "words";
 *   • a space is needed between nodes: without it `<b>one</b><i>two</i>` glues
 *     into a single word, and the count comes in short instead.
 */
function countWords($: cheerio.CheerioAPI): number {
  const clone = cheerio.load($.html());
  clone('script, style').remove();
  const parts: string[] = [];
  const walk = (node: any): void => {
    if (node.type === 'text') {
      const t = String(node.data || '').trim();
      if (t) parts.push(t);
    } else if (node.children) {
      node.children.forEach(walk);
    }
  };
  clone.root().toArray().forEach(walk);
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return text ? text.split(' ').filter(Boolean).length : 0;
}

export interface AuditReport {
  domain: string;
  url: string;
  score: number;
  categories: ReturnType<typeof categoryScores>;
  action_plan: ReturnType<typeof actionPlan>;
  passed: ReturnType<typeof passed>;
  passport: Record<string, unknown>;
  checks: Check[];
  pages_crawled: number;
  summary: Record<string, number>;
}

@Injectable()
export class AuditService {
  constructor(private readonly settings: DiscoverSettings) {}

  /**
   * Tech passport: facts about the page with no verdict.
   *
   * Deliberately separate from checks: "HTTP/2" or "Nuxt" is neither good nor
   * bad — it's reference info. Mixing reference info with problems just
   * dilutes the action list with noise.
   */
  private passport(
    $: cheerio.CheerioAPI, html: string, headers: Record<string, string>,
    bytes: number, finalUrl: string, domain: string, ssl: SslInfo | null,
  ): Record<string, unknown> {
    // Resource sizes: exact bytes would require downloading every file — on
    // the free tool that's someone else's traffic; we count quantity, and only
    // take the weight of the page itself.
    const css = $('link[rel="stylesheet"]').length;
    const js = $('script[src]').length;
    const images = $('img').length;

    const words = countWords($);

    const tech = detectTechstack(html, headers);
    const byCat = tech.by_category || {};
    const enc = (headers['content-encoding'] || '').toLowerCase();
    const alpn = ssl?.alpn ?? null;

    return {
      // Protocol — from ALPN, same as in the check: otherwise the passport
      // would contradict the check in the same report.
      http_version: alpn === 'h2' ? 'HTTP/2' : (alpn ? 'HTTP/1.1' : null),
      tls: ssl?.protocol ?? null,
      cert_issuer: ssl?.issuer ?? null,
      cert_days_left: ssl?.days_left ?? null,
      server: headers['server'] ?? null,
      compression: enc || null,
      page_bytes: bytes,
      css_files: css,
      js_files: js,
      images,
      words,
      // ~200 words/min — the conventional reading-speed estimate.
      read_minutes: words ? Math.max(1, Math.round(words / 200)) : 0,
      internal_links: innerUrls($, finalUrl, domain, 500).length,
      frameworks: byCat.framework || [],
      analytics: byCat.analytics || [],
      cdn: byCat.cdn || [],
      hosting: byCat.hosting || [],
      payment: tech.payment,
      tech: (tech.tech || []).slice(0, 14),
    };
  }

  /** Full domain tech audit. Throws SiteUnreachableError if the home page didn't open. */
  async audit(rawDomain: string, opts: { deep?: boolean } = {}): Promise<AuditReport | null> {
    const deep = opts.deep !== false;
    const domain = normDomain(rawDomain);
    if (!domain || !domain.includes('.')) return null;

    let base = `https://${domain}`;
    let home = await get(`${base}/`);
    let html = home && home.status < 400 ? await home.text().catch(() => '') : '';

    if (!home || home.status >= 400 || !html) {
      // https didn't come up — try http, otherwise the site isn't reachable for us.
      const httpsStatus = home ? home.status : null;
      base = `http://${domain}`;
      home = await get(`${base}/`);
      html = home && home.status < 400 ? await home.text().catch(() => '') : '';
      if (!home || home.status >= 400 || !html) {
        const status = home ? home.status : httpsStatus;
        if (status !== null && [401, 403, 405, 429].includes(status)) {
          throw new SiteUnreachableError(
            `The site responded with ${status} — it's blocked from automated checks `
            + '(anti-bot or bot protection). It can\'t be checked from outside.');
        }
        if (status !== null) {
          throw new SiteUnreachableError(
            `The home page returns ${status} instead of a working page.`);
        }
        throw new SiteUnreachableError(
          'The domain isn\'t responding — check the site name and its availability.');
      }
    }

    const headers: Record<string, string> = {};
    home.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const $ = cheerio.load(html);
    const finalUrl = home.url;
    const bytes = Buffer.byteLength(html);

    const robotsRes = await get(new URL('/robots.txt', base).toString());
    let robotsTxt = robotsRes && robotsRes.status === 200
      ? await robotsRes.text().catch(() => '') : '';
    if (looksLikeHtml(robotsTxt)) {
      // SPA fallback served the home page instead of robots.txt: the file
      // doesn't exist, and HTML read as robots gave a false "doesn't block the site".
      robotsTxt = '';
    }

    const ssl = await checkSsl(domain);

    const checks: Check[] = [];
    checks.push(...await checkRedirects(domain));
    checks.push(...checkSslChecks(ssl));
    checks.push(...checkHeaders(headers));
    checks.push(...checkTransport(headers, ssl?.alpn ?? null));
    checks.push(...checkMeta($, html, headers['content-type'] || ''));
    checks.push(...checkSocial($));
    checks.push(...await checkIndexing(base, $, robotsTxt));
    checks.push(...checkHreflang($));
    checks.push(...checkContent($, html, finalUrl));
    checks.push(...checkA11y($));
    checks.push(...await check404(base));

    const passportData = this.passport($, html, headers, bytes, finalUrl, domain, ssl);

    let pages = 1;
    if (deep) {
      checks.push(...await checkLinks($, finalUrl));
      const inner = innerUrls($, finalUrl, domain, MAX_PAGES - 1);
      checks.push(...await checkDuplicates([finalUrl, ...inner]));
      pages = 1 + inner.length;
      // Check the trailing slash on an inner page: the home page never has one.
      if (inner.length) checks.push(...await checkTrailingSlash(inner[0]));
      const psiKey = await this.settings.get('PAGESPEED_API_KEY');
      checks.push(...checkSpeed(await fetchCwv(domain, psiKey)));
    }

    return {
      domain,
      url: finalUrl,
      score: score(checks),
      categories: categoryScores(checks),
      action_plan: actionPlan(checks),
      passed: passed(checks),
      passport: passportData,
      checks,
      pages_crawled: pages,
      summary: summarize(checks),
    };
  }
}
