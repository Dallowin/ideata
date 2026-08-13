/**
 * Port of core/rss_mentions.py — brand mentions from Google News RSS (free, no
 * keys). The news block of the media section: it is exactly the fresh
 * publications that web-search-enabled engines pull into their answers and cite,
 * so the news stream is a direct signal of AI visibility.
 *
 * Layers:
 *   • PURE CORE — `parseNewsXml` (RSS XML → rows) and `parseDate` (RFC-822 →
 *     ISO-8601 UTC). Deterministic, parity on synthetic input (rss-mentions.spec.ts).
 *   • NETWORK SHELL — `googleNews`/`brandMentions`: GET the RSS through an
 *     injectable text transport (SSRF/timeout by default, follow_redirects),
 *     failure-isolated (non-200/empty/broken XML → []).
 *
 * Pitfalls verified against CPython:
 *   • Google News puts the publisher at the end of the title, "Title - Publisher"
 *     — with an empty <source> we cut it off via rpartition(" - ");
 *   • `re.sub(r"\s+"," ",title)[:200]` and `source[:80]` — sliced by code points;
 *   • `_parse_date`: %Z=GMT/UTC yields tz-aware UTC, a `%z` offset is converted to
 *     UTC, naive → UTC; isoformat = "…+00:00";
 *   • `google_news(..., limit=0)` returns 1 row because the check happens AFTER append.
 */
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { cpSlice } from './pyhelpers';
import { collapseWs } from './xmltext';
import { makeFetchGetText, type HttpGetText } from './http';

const GOOGLE_NEWS = 'https://news.google.com/rss/search';
const UA = 'ideata-research/1.0 (+https://ideata.io)';
const TIMEOUT_MS = 10_000;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

export interface NewsRow {
  title: string;
  url: string | null;
  source: string | null;
  published_at: string | null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * `_parse_date` (rss_mentions.py:29-40): RFC-822 → ISO-8601 UTC. Parses both
 * Python forms (`%Z`=GMT/UTC and the numeric `%z`); the offset is converted to
 * UTC; a naive date is treated as UTC. Malformed input → null (Python swallows
 * the ValueError).
 */
export function parseDate(raw: string): string | null {
  const s = (raw || '').trim();
  // Ddd, DD Mon YYYY HH:MM:SS <TZ|+HHMM|GMT>
  const m = s.match(
    /^[A-Za-z]{3},\s+(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2}):(\d{2})\s+(GMT|UTC|[+-]\d{4})$/,
  );
  if (!m) return null;
  const day = Number(m[1]);
  const mon = MONTHS[m[2].toLowerCase()];
  if (!mon) return null;
  const year = Number(m[3]);
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const ss = Number(m[6]);
  const tz = m[7];
  // Base time as a UTC epoch, then subtract the zone offset → true UTC.
  let epoch = Date.UTC(year, mon - 1, day, hh, mm, ss);
  if (tz !== 'GMT' && tz !== 'UTC') {
    const sign = tz[0] === '-' ? -1 : 1;
    const offMin = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)));
    epoch -= offMin * 60_000;
  }
  const d = new Date(epoch);
  if (Number.isNaN(d.getTime())) return null;
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` +
    `T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}+00:00`
  );
}

/** First scalar out of a fast-xml-parser value (string/number/#text object). */
function textOf(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object') {
    const t = (v as Record<string, unknown>)['#text'];
    return t === undefined ? '' : String(t);
  }
  return '';
}

/**
 * RSS XML → news rows (port of the google_news body after ET.fromstring). Returns
 * are capped by `limit`; the length check AFTER append reproduces Python verbatim
 * (with limit=0 one row comes back). Broken XML → [].
 */
export function parseNewsXml(xml: string, limit: number): NewsRow[] {
  const body = String(xml || '').trim();
  if (!body || XMLValidator.validate(body) !== true) return [];
  let tree: unknown;
  try {
    tree = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true }).parse(body);
  } catch {
    return [];
  }
  // Collect every <item> anywhere in the tree (equivalent of iterfind(".//item")).
  const items: Record<string, unknown>[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === 'item') {
          for (const it of Array.isArray(v) ? v : [v]) {
            if (it && typeof it === 'object') items.push(it as Record<string, unknown>);
          }
        } else {
          walk(v);
        }
      }
    }
  };
  walk(tree);

  const out: NewsRow[] = [];
  for (const it of items) {
    let title = textOf(it.title).trim();
    if (!title) continue;
    let source = textOf(it.source).trim();
    if (!source && title.includes(' - ')) {
      const idx = title.lastIndexOf(' - '); // rpartition(" - ")
      source = title.slice(idx + 3);
      title = title.slice(0, idx);
    }
    out.push({
      title: cpSlice(collapseWs(title), 200),
      url: textOf(it.link).trim() || null,
      source: cpSlice(source, 80) || null,
      published_at: parseDate(textOf(it.pubDate)),
    });
    if (out.length >= limit) break; // check AFTER append (Python semantics)
  }
  return out;
}

export interface GoogleNewsOptions {
  lang?: string;
  geo?: string;
  limit?: number;
  days?: number | null;
  /** Transport injection for tests; defaults to the real text GET. */
  get?: HttpGetText;
}

/**
 * Mentions for a query: [{title,url,source,published_at}] (port of google_news).
 * `days` adds a freshness window (the Google News `when:Nd` operator). Non-200/
 * empty/failure → [].
 */
export async function googleNews(query: string, opts: GoogleNewsOptions = {}): Promise<NewsRow[]> {
  let q = (query || '').trim();
  if (!q) return [];
  const lang = opts.lang ?? 'ru';
  const geo = opts.geo ?? 'RU';
  const limit = opts.limit ?? 20;
  if (opts.days) q = `${q} when:${Math.trunc(opts.days)}d`;
  const get = opts.get ?? makeFetchGetText({ timeoutMs: TIMEOUT_MS, headers: { 'User-Agent': UA } });

  const resp = await get(GOOGLE_NEWS, { q, hl: lang, gl: geo, ceid: `${geo}:${lang}` });
  if (resp === null || resp.status !== 200 || !resp.text.trim()) return [];
  return parseNewsXml(resp.text, limit);
}

export interface BrandMentionsOptions {
  lang?: string;
  geo?: string;
  limit?: number;
  get?: HttpGetText;
}

/**
 * Brand mentions over a quarter by name AND by domain (port of brand_mentions).
 * The domain is searched with a separate query (some publications mention the
 * site rather than the name), then we dedupe by title and cut down to limit.
 */
export async function brandMentions(
  brand: string,
  domain = '',
  opts: BrandMentionsOptions = {},
): Promise<NewsRow[]> {
  const lang = opts.lang ?? 'ru';
  const geo = opts.geo ?? 'RU';
  const limit = opts.limit ?? 20;
  const base = { lang, geo, get: opts.get };

  const rows = await googleNews(brand, { ...base, limit, days: 90 });
  if (domain) {
    const seen = new Set(rows.map((r) => r.title.toLowerCase()));
    const more = await googleNews(domain, { ...base, limit: Math.max(0, limit - rows.length), days: 90 });
    for (const r of more) {
      if (!seen.has(r.title.toLowerCase())) rows.push(r);
    }
  }
  return rows.slice(0, limit);
}
