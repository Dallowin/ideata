/**
 * Port of core/demand.py::yandex_serp (demand.py:464-504) plus the helpers
 * _yandex_post (92-110), _parse_serp_xml (446-461), _occupancy_bucket (432-437),
 * _clean_xml_text (440-443). The "press SERP" media block: ONE call to the Yandex
 * Cloud Search API that yields BOTH market saturation (results_count) AND live
 * SERP snippets (title/url/passage) — free grounding in real websites.
 *
 * Layers:
 *   • PURE CORE — `parseSerpXml(xml)`: base64-decoded SERP-XML → counter +
 *     results. Regex parsing exactly as in Python (re.S / _DOC_RE / _FOUND_RE),
 *     parity on synthetic data (yandex-serp.spec.ts) — we do not burn paid SERP
 *     calls.
 *   • NETWORK SHELL — `yandexSerp(query)`: key+folder gate (env
 *     YANDEX_SEARCH_API_KEY / YANDEX_CLOUD_FOLDER_ID), POST through an injectable
 *     transport, base64-decode of rawData, SSRF guard/timeout by default. Missing
 *     key/folder, empty rawData or broken XML → null (in Python there was a
 *     selenium fallback here, but only when configured — the native path has none,
 *     so we simply return null).
 *
 * The research_cache (per niche) is NOT ported: the snapshot calls SERP once per
 * brand, there are no repeats within one analysis; the cache existed for the live
 * Wordstat QUOTA.
 */
import { pyFalsy } from './pyutil';
import { makeFetchPostJson, type HttpPostJson } from './http';
import { htmlUnescape, stripTags, collapseWs } from './xmltext';

const SEARCH_API = 'https://searchapi.api.cloud.yandex.net/v2';
const TIMEOUT_MS = 30_000;
const SERP_EMPTY_BELOW = 1_000;
const SERP_SATURATED_ABOVE = 100_000;

// SERP-XML regexes (demand.py:421-429). The `s` flag = Python's re.S (DOTALL).
const FOUND_RE = /<found[^>]*>(\d+)<\/found>/g;
const DOC_RE = /<doc\b[^>]*>(.*?)<\/doc>/gs;
const URL_RE = /<url>(.*?)<\/url>/s;
const TITLE_RE = /<title>(.*?)<\/title>/s;
const PASSAGE_RE = /<passage>(.*?)<\/passage>/gs;

export interface SerpResult {
  title: string | null;
  url: string | null;
  passage: string | null;
}
export interface SerpBlock {
  results_count: number | null;
  occupancy: string | null;
  source: string;
  results: SerpResult[];
}

/** `_occupancy_bucket` (demand.py:432-437). */
export function occupancyBucket(count: number): string {
  if (count < SERP_EMPTY_BELOW) return 'empty';
  if (count >= SERP_SATURATED_ABOVE) return 'saturated';
  return 'some';
}

/** `_clean_xml_text` (demand.py:440-443): strip tags → unescape → collapse whitespace. */
export function cleanXmlText(s: string | null | undefined): string {
  return collapseWs(htmlUnescape(stripTags(s || '')));
}

/**
 * `_parse_serp_xml` (demand.py:446-461): SERP-XML → {results_count, results}.
 * results_count = max over all <found>; for each <doc> we take the first
 * url/title and the joined passages. A row with neither url NOR title is skipped.
 */
export function parseSerpXml(xml: string): { results_count: number | null; results: SerpResult[] } {
  const counts: number[] = [];
  for (const m of xml.matchAll(FOUND_RE)) counts.push(parseInt(m[1], 10));
  const results: SerpResult[] = [];
  for (const block of xml.matchAll(DOC_RE)) {
    const b = block[1];
    const um = b.match(URL_RE);
    const tm = b.match(TITLE_RE);
    // Python: " ".join(_clean_xml_text(p) for p in …).strip() — join+strip WITHOUT
    // a second collapse (an empty passage leaves a double space, same as CPython).
    const passage = [...b.matchAll(PASSAGE_RE)].map((p) => cleanXmlText(p[1])).join(' ').trim();
    const url = um ? cleanXmlText(um[1]) : null;
    const title = tm ? cleanXmlText(tm[1]) : null;
    if (!url && !title) continue;
    results.push({ title: title || null, url: url || null, passage: passage || null });
  }
  return { results_count: counts.length ? Math.max(...counts) : null, results };
}

/** base64 → utf-8 (errors='replace'). Python `.decode("utf-8","replace")`. */
function b64Utf8(raw: string): string {
  return Buffer.from(raw, 'base64').toString('utf-8');
}

export interface YandexSerpOptions {
  apiKey?: string | null;
  folderId?: string | null;
  maxResults?: number;
  /** Transport injection for tests; a real POST by default. */
  post?: HttpPostJson;
}

/**
 * ONE web/search call to the Yandex Cloud Search API, mined for saturation +
 * snippets (port of yandex_serp). Missing query/key/folder → null. Empty or
 * broken rawData → null.
 */
export async function yandexSerp(
  query: string,
  opts: YandexSerpOptions = {},
): Promise<SerpBlock | null> {
  if (!query || !query.trim()) return null;
  const key = opts.apiKey ?? process.env.YANDEX_SEARCH_API_KEY ?? '';
  const folder = opts.folderId ?? process.env.YANDEX_CLOUD_FOLDER_ID ?? '';
  if (!key || !folder) return null;
  const maxResults = opts.maxResults ?? 8;
  const post = opts.post ?? makeFetchPostJson({ timeoutMs: TIMEOUT_MS });

  // _yandex_post("web/search", body, api_key): non-200/failure/non-JSON → null.
  const resp = await post(
    `${SEARCH_API}/web/search`,
    { query: { searchType: 'SEARCH_TYPE_RU', queryText: query }, folderId: folder },
    { Authorization: `Api-Key ${key}` },
  );
  if (resp === null || resp.status !== 200) return null;
  const data = resp.body;
  const raw = (data && typeof data === 'object' && !Array.isArray(data)
    ? (data as Record<string, unknown>).rawData
    : null) as string | null;
  if (pyFalsy(raw)) return null;

  let parsed: { results_count: number | null; results: SerpResult[] };
  try {
    parsed = parseSerpXml(b64Utf8(String(raw)));
  } catch {
    return null; // broken XML/base64 → None (in Python a selenium fallback, only when configured)
  }
  const count = parsed.results_count;
  return {
    results_count: count,
    occupancy: count !== null ? occupancyBucket(count) : null,
    source: 'yandex_api',
    results: parsed.results.slice(0, maxResults),
  };
}
