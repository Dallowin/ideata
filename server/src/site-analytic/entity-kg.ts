/**
 * Port of core/entity_kg.py - brand presence in the knowledge graph (Wikidata +
 * Wikipedia, free, no API keys). Models "know" entities, not websites: the
 * absence of a record linked to the domain via P856 is a diagnosis of its own.
 *
 * The key signal is not the existence of a record but its LINK to the domain
 * (P856 "official website"). There are many same-name entities; we count the one
 * that points at the domain under test, otherwise the same-name record is
 * returned as `ambiguous`.
 *
 * Orchestration: wbsearchentities (up to 5 per language, <=8 total) ->
 * wbgetentities for the first 6 candidates -> plus article pageviews when the
 * domain matches. The transport is injected (`get`) and parity runs on synthetic
 * data (entity-kg.parity.spec.ts): we never hit Wikidata and do not depend on
 * its live index.
 *
 * Everything is best-effort: an unavailable API is a null branch, not a failure
 * of the whole analysis.
 */
import { pyStrip } from '../aeo/parse';
import { isDict, pyFalsy } from './pyutil';
import { makeFetchGet, type HttpGet } from './http';

const WD_API = 'https://www.wikidata.org/w/api.php';
const PAGEVIEWS =
  'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/' +
  '{lang}.wikipedia/all-access/user/{title}/daily/{start}/{end}';
const P_OFFICIAL_SITE = 'P856';
const UA = 'ideata-research/1.0 (+https://ideata.io)';
const TIMEOUT_MS = 12_000;

export interface BrandEntity {
  found: boolean;
  domain: string;
  query: string;
  qid: string | null;
  ambiguous: boolean;
  label?: string | null;
  description?: string | null;
  official_sites?: string[];
  domain_matches?: boolean;
  sitelinks?: number;
  wikipedia?: string | null;
  wikipedia_lang?: string | null;
  pageviews_30d?: number | null;
}

/** `https://www.tilda.cc/ru/` -> `tilda.cc` (port of `_host`). */
export function hostOf(url: unknown): string {
  const raw = pyFalsy(url) ? '' : url;
  let h = String(raw).trim().toLowerCase().replace(/^https?:\/\//, '');
  h = h.split('/')[0].split('?')[0];
  return h.startsWith('www.') ? h.slice(4) : h;
}

const dict = (v: unknown): Record<string, unknown> => (isDict(v) ? v : {});
/** `str.strip() or None` applied to a value coming from JSON. */
const stripOrNull = (v: unknown): string | null => pyStrip(String(pyFalsy(v) ? '' : v)) || null;

function officialSites(claims: unknown): string[] {
  const arr = isDict(claims) && Array.isArray(claims[P_OFFICIAL_SITE])
    ? (claims[P_OFFICIAL_SITE] as unknown[])
    : [];
  const out: string[] = [];
  for (const st of arr) {
    try {
      // st["mainsnak"]["datavalue"]["value"] - any gap in the chain -> skip
      const value = ((st as any).mainsnak.datavalue.value) as unknown;
      out.push(String(value));
    } catch {
      continue;
    }
  }
  return out;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
function yyyymmdd(d: Date): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** Total article views over N days - a proxy for public attention. */
export async function wikipediaPageviews(
  title: string,
  lang: string,
  opts: { days?: number; get: HttpGet; now?: Date },
): Promise<number | null> {
  const days = opts.days ?? 30;
  const now = opts.now ?? new Date();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const start = new Date(end.getTime());
  start.setUTCDate(start.getUTCDate() - Math.max(1, days));
  const url = PAGEVIEWS.replace('{lang}', lang)
    .replace('{title}', title.split(' ').join('_'))
    .replace('{start}', yyyymmdd(start))
    .replace('{end}', yyyymmdd(end));
  const resp = await opts.get(url);
  const data = resp && resp.status === 200 ? resp.body : null;
  const items = isDict(data) && Array.isArray(data.items) ? data.items : [];
  if (!items.length) return null;
  let sum = 0;
  for (const i of items) {
    const v = dict(i).views;
    sum += Math.trunc(Number(pyFalsy(v) ? 0 : v)) || 0;
  }
  return sum;
}

export interface BrandEntityOptions {
  name?: string | null;
  langs?: readonly string[];
  get?: HttpGet;
  now?: Date;
}

export async function brandEntity(
  domain: string,
  opts: BrandEntityOptions = {},
): Promise<BrandEntity | null> {
  const langs = opts.langs ?? ['en', 'ru'];
  const get = opts.get ?? makeFetchGet({ timeoutMs: TIMEOUT_MS, headers: { 'User-Agent': UA } });

  const dom = hostOf(domain);
  if (!dom) return null;
  const term = pyStrip(String(opts.name && !pyFalsy(opts.name) ? opts.name : dom.split('.')[0]));
  if (!term) return null;

  const wget = async (params: Record<string, unknown>): Promise<unknown> => {
    const r = await get(WD_API, params);
    if (r === null || r.status !== 200) return null;
    return r.body;
  };
  const search = async (t: string, lang: string): Promise<Record<string, unknown>[]> => {
    const data = await wget({
      action: 'wbsearchentities', search: t, language: lang, uselang: lang,
      format: 'json', limit: 5, type: 'item',
    });
    const s = isDict(data) ? data.search : undefined;
    return Array.isArray(s) ? (s as Record<string, unknown>[]) : [];
  };
  const entity = async (qid: string): Promise<Record<string, unknown> | null> => {
    const data = await wget({
      action: 'wbgetentities', ids: qid,
      props: 'claims|sitelinks|descriptions|labels', format: 'json',
    });
    const ents = isDict(data) ? data.entities : undefined;
    const e = isDict(ents) ? ents[qid] : undefined;
    return isDict(e) && !pyFalsy(e) ? e : null;
  };

  // ── candidates: up to 5 per language, stop at >=8 (checked per language) ──
  const candidates: Array<[string, Record<string, unknown>]> = [];
  const seen = new Set<string>();
  for (const lang of langs) {
    for (const hit of await search(term, lang)) {
      const qid = hit.id;
      if (!qid || seen.has(String(qid))) continue;
      seen.add(String(qid));
      candidates.push([lang, hit]);
    }
    if (candidates.length >= 8) break;
  }
  if (!candidates.length) {
    return { found: false, domain: dom, query: term, ambiguous: false, qid: null };
  }

  let fallback: BrandEntity | null = null;
  for (const [, hit] of candidates.slice(0, 6)) {
    const ent = await entity(String(hit.id));
    if (!ent || pyFalsy(ent)) continue;
    const sites = officialSites(isDict(ent.claims) ? ent.claims : {});
    const matches = sites.some((u) => hostOf(u) === dom);
    const sitelinks = isDict(ent.sitelinks) ? ent.sitelinks : {};
    const wikiKey =
      langs.map((l) => `${l}wiki`).find((k) => Object.prototype.hasOwnProperty.call(sitelinks, k)) ??
      null;
    let wikipedia: string | null = null;
    if (wikiKey) {
      const sl = sitelinks[wikiKey];
      const sld = pyFalsy(sl) ? {} : sl;
      wikipedia = isDict(sld) ? ((sld.title as string | undefined) ?? null) : null;
    }
    const payload: BrandEntity = {
      found: true,
      domain: dom,
      query: term,
      qid: String(hit.id),
      label: stripOrNull(hit.label),
      description: stripOrNull(hit.description),
      official_sites: sites.slice(0, 3),
      domain_matches: matches,
      ambiguous: !matches,
      sitelinks: Object.keys(sitelinks).length,
      wikipedia,
      wikipedia_lang: wikiKey ? wikiKey.slice(0, -4) : null,
    };
    if (matches) {
      if (payload.wikipedia) {
        payload.pageviews_30d = await wikipediaPageviews(
          payload.wikipedia,
          payload.wikipedia_lang || 'en',
          { get, now: opts.now },
        );
      }
      return payload;
    }
    fallback = fallback || payload;
  }
  return fallback || { found: false, domain: dom, query: term, ambiguous: false, qid: null };
}
