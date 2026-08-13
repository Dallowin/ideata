/**
 * Port of core/competitors.py — sourcing and validating competitors for the
 * AI-analytic.
 *
 * "Competitors" is no longer just the raw SEO intersection of organic keywords
 * (empty for small domains, wikis/media/marketplaces for the rest). It's one of
 * THREE candidate sources:
 *   1) SEO keyword intersection (as before);
 *   2) brands the AI ACTUALLY names in the snapshot's answers (LLM extraction,
 *      frequency counted deterministically over the texts);
 *   3) brand competitors from onboarding (the brands table).
 * Then — filtering out non-brands and a batch LLM verdict direct/adjacent/not_competitor.
 * Everything is fail-soft: a source failing narrows the list but doesn't fail the analysis.
 *
 * Port layers:
 *   • DETERMINISTIC CORE — `hostLike`, `isNonCompetitorHost`, merge/filter/
 *     ranking in `buildCompetitors`. Parity against the oracle with az=None
 *     (LLM stub → null == Python's `az is None`): extract gives [], validate
 *     gives {}, onboarding is trusted without a verdict (competitors.parity.spec.ts).
 *   • LLM — `extractAiBrands`/`validateCandidates` via askFlashJson (an analog of
 *     `_ask_json(FLASH_MODELS)`); separate units with a stub LLM.
 *   • Prisma — `onboardingCompetitors` reads brands.
 *
 * The non-citation host lists reuse exactly aeo._UGC/_REVIEW/_MEDIA (parse.ts).
 */
import { pyStrip, UGC_HOSTS, REVIEW_HOSTS, MEDIA_HOSTS } from '../aeo/parse';
import { askFlashJson } from '../aeo/run';
import { blogPrisma } from '../blogwriter/server/utils/prisma';
import { cpLen, cpSlice, isDict, pyFalsy, pyOr } from './pyutil';

/** Flash-JSON caller — defaults to provider's askFlashJson, a stub in tests. */
export type AskJson = (prompt: string) => Promise<Record<string, unknown> | null>;

// Hosts that are almost never business competitors: reference sites, social
// networks, marketplaces, app stores. UGC/review sites/media — from aeo.
const NON_COMPETITOR_HOSTS: readonly string[] = [
  'wikipedia.org', 'wikimedia.org', 'youtube.com', 'google.com',
  'facebook.com', 'instagram.com', 'x.com', 'twitter.com', 'vk.com',
  't.me', 'telegram.org', 'linkedin.com', 'tiktok.com', 'twitch.tv',
  'amazon.com', 'ozon.ru', 'wildberries.ru', 'aliexpress.com', 'ebay.com',
  'apps.apple.com', 'play.google.com', 'github.com', 'wikihow.com',
  'yandex.ru', 'dzen.ru', 'rutube.ru', 'avito.ru',
];

const MAX_CANDIDATES = 14; // how many candidates go into LLM validation
const MAX_FINAL = 8; // how many competitors we keep in facts

/** Normalize a domain/URL to a "bare" host; not a domain → '' (port of `_host_like`). */
export function hostLike(value: unknown): string {
  const v0 = pyStrip(String(pyFalsy(value) ? '' : value)).toLowerCase();
  const v = v0.replace(/^https?:\/\//, '').replace('www.', '').split('/')[0];
  return v.includes('.') ? v : '';
}

/** Reference site/social network/marketplace/UGC/media — a citation source, not a competitor. */
export function isNonCompetitorHost(value: unknown): boolean {
  const h = hostLike(value);
  if (!h) return false;
  const hosts = [...NON_COMPETITOR_HOSTS, ...UGC_HOSTS, ...REVIEW_HOSTS, ...MEDIA_HOSTS];
  return hosts.some((x) => h === x || h.endsWith('.' + x));
}

export interface AiBrand {
  name: string;
  domain: string;
  mentions: number;
}

export interface AnswerLike {
  text?: unknown;
}

/** Source 2: which brands the AI names in its answers (LLM extraction + frequency count). */
export async function extractAiBrands(
  answers: AnswerLike[],
  domain: string,
  opts: { limit?: number; ask?: AskJson } = {},
): Promise<AiBrand[]> {
  const limit = opts.limit ?? 10;
  const ask = opts.ask ?? askFlashJson;
  if (!answers || !answers.length) return [];
  // list(dict.fromkeys(...)) — order-preserving dedup on the stripped text.
  const texts: string[] = [];
  const seenT = new Set<string>();
  for (const a of answers) {
    if (pyFalsy((a || {}).text)) continue; // `if a.get("text")`
    const t = pyStrip(String((a as AnswerLike).text));
    if (!seenT.has(t)) {
      seenT.add(t);
      texts.push(t);
    }
  }
  if (!texts.length) return [];
  const blob = texts.slice(0, 24).map((t) => cpSlice(t, 800)).join('\n---\n');
  const p =
    'Ниже ответы ИИ-ассистентов на нишевые вопросы (домен пользователя: ' +
    `${domain}).\nВыпиши БРЕНДЫ/ПРОДУКТЫ/СЕРВИСЫ, которые названы в ` +
    'ответах как варианты, рекомендации или сравнения. НЕ включай: сам ' +
    `${domain}, сайты-источники (вики, СМИ, форумы, обзорники), ` +
    'общие категории.\nОтветь СТРОГО JSON: {"brands":[{"name":"…",' +
    '"domain":"site.com или пусто"}]}\n\nОТВЕТЫ:\n' + blob;
  const data = await ask(p);
  const rows = data ? (data as Record<string, unknown>).brands : null;
  if (!Array.isArray(rows)) return [];
  const lowTexts = texts.map((t) => t.toLowerCase());
  const out: AiBrand[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!isDict(r)) continue;
    const name = pyStrip(String(pyOr(r.name, '')));
    const dom = hostLike(String(pyOr(r.domain, '')));
    if (!name || cpLen(name) < 3) continue;
    const key = (dom || name).toLowerCase();
    if (seen.has(key) || key === domain.toLowerCase()) continue;
    seen.add(key);
    const needles = [name.toLowerCase(), ...(dom ? [dom] : [])];
    let mentions = 0;
    for (const t of lowTexts) if (needles.some((n) => t.includes(n))) mentions += 1;
    if (mentions === 0) continue; // LLM made it up — discard
    out.push({ name, domain: dom, mentions });
  }
  out.sort((a, b) => b.mentions - a.mentions);
  return out.slice(0, limit);
}

export interface CandidateRow {
  key: string;
  domain: string | null;
  name: string | null;
  traffic: number | null;
  growth: number | null;
  shared: number | null;
  dr: number | null;
  source: string | null;
  mentions: number;
  verdict: string | null;
  why: string | null;
}

const VERDICTS = new Set(['direct', 'adjacent', 'not_competitor']);

/** Batch check of "is this really a competitor": {key: {verdict, why}} (port of validate). */
export async function validateCandidates(
  domain: string,
  about: string,
  candidates: CandidateRow[],
  opts: { ask?: AskJson } = {},
): Promise<Record<string, { verdict: string; why: string }>> {
  const ask = opts.ask ?? askFlashJson;
  if (!candidates || !candidates.length) return {};
  const lines: string[] = [];
  for (const c of candidates.slice(0, MAX_CANDIDATES)) {
    const sig: string[] = [];
    if (c.mentions) sig.push(`ИИ упоминает в ${c.mentions} ответах`);
    if (c.shared) sig.push(`общих SEO-ключей: ${c.shared}`);
    if (c.source === 'onboarding') sig.push('указан владельцем');
    const label = c.domain || c.name || '';
    lines.push(`- ${label}` + (sig.length ? ` (${sig.join('; ')})` : ''));
  }
  const p =
    `Наш продукт: ${domain}. ${about || ''}\n` +
    'Кандидаты в конкуренты:\n' + lines.join('\n') + '\n\n' +
    'Для КАЖДОГО реши, конкурент ли это нашему продукту:\n' +
    '- direct — тот же тип продукта, та же аудитория/деньги;\n' +
    '- adjacent — смежная ниша, частично пересекаемся;\n' +
    '- not_competitor — источник/справочник/СМИ/маркетплейс или вообще ' +
    'другая ниша.\n' +
    'Ответь СТРОГО JSON: {"verdicts":{"<домен или имя>":' +
    '{"verdict":"direct|adjacent|not_competitor",' +
    '"why":"одна короткая причина по-русски"}}}';
  const data = await ask(p);
  const rows = data ? (data as Record<string, unknown>).verdicts : null;
  if (!isDict(rows)) return {};
  const out: Record<string, { verdict: string; why: string }> = {};
  for (const [k, v] of Object.entries(rows)) {
    if (!isDict(v)) continue;
    const verdict = v.verdict;
    if (typeof verdict !== 'string' || !VERDICTS.has(verdict)) continue;
    out[pyStrip(String(k)).toLowerCase()] = {
      verdict,
      why: cpSlice(pyStrip(String(pyOr(v.why, ''))), 160),
    };
  }
  return out;
}

export interface SeoRow {
  domain?: unknown;
  traffic?: unknown;
  growth?: unknown;
  shared?: unknown;
  dr?: unknown;
}

export interface BuildCompetitorsInput {
  domain: string;
  about?: string;
  seoRows?: SeoRow[] | null;
  answers?: AnswerLike[] | null;
  onboarding?: string[] | null;
  ask?: AskJson;
}

function newRow(key: string): CandidateRow {
  return {
    key, domain: null, name: null, traffic: null, growth: null, shared: null,
    dr: null, source: null, mentions: 0, verdict: null, why: null,
  };
}

/** Candidates → filter → validation → ranking (port of build_competitors). */
export async function buildCompetitors(input: BuildCompetitorsInput): Promise<CandidateRow[]> {
  const { domain, about = '' } = input;
  const ask = input.ask ?? askFlashJson;
  const domainL = domain.toLowerCase();
  const byKey = new Map<string, CandidateRow>();

  const put = (rawKey: string, fields: Array<[keyof CandidateRow, unknown]>): void => {
    const key = String(rawKey).toLowerCase();
    if (!key || key === domainL || isNonCompetitorHost(key)) return;
    let row = byKey.get(key);
    if (!row) {
      row = newRow(key);
      byKey.set(key, row);
    }
    for (const [k, v] of fields) {
      // v is not None (undefined is also treated as None: != null catches both)
      if (v == null) continue;
      const cur = row[k];
      const noneOrZero = cur === null || cur === 0;
      if (!(noneOrZero || k === 'source')) continue;
      if (k === 'source' && (row.source === 'ai' || row.source === 'onboarding')) continue;
      (row as unknown as Record<string, unknown>)[k as string] = v;
    }
  };

  for (const c of input.seoRows || []) {
    const d = hostLike(String(pyOr(c.domain, '')));
    if (d) {
      put(d, [
        ['domain', d], ['traffic', c.traffic], ['growth', c.growth],
        ['shared', c.shared], ['dr', c.dr], ['source', 'seo'],
      ]);
    }
  }

  const aiBrands = await extractAiBrands(input.answers || [], domain, { ask });
  for (const b of aiBrands) {
    const key = b.domain || b.name;
    put(key, [['domain', b.domain || null], ['name', b.name], ['mentions', b.mentions], ['source', 'ai']]);
  }

  for (const c of input.onboarding || []) {
    const d = hostLike(String(c));
    put(d || c, [['domain', d || null], ['name', d ? null : c], ['source', 'onboarding']]);
  }

  const candidates = [...byKey.values()];
  if (!candidates.length) return [];
  // order into validation: AI mentions → onboarding → SEO by shared keywords
  candidates.sort((a, b) => {
    const am = -(a.mentions || 0);
    const bm = -(b.mentions || 0);
    if (am !== bm) return am - bm;
    const ao = a.source !== 'onboarding' ? 1 : 0;
    const bo = b.source !== 'onboarding' ? 1 : 0;
    if (ao !== bo) return ao - bo;
    return -(a.shared || 0) - -(b.shared || 0);
  });

  let verdicts: Record<string, { verdict: string; why: string }> = {};
  try {
    verdicts = await validateCandidates(domain, about, candidates, { ask });
  } catch {
    /* a broken list is worse than the old one — proceed without verdicts */
  }

  const out: CandidateRow[] = [];
  for (const c of candidates) {
    const v =
      verdicts[c.key] ||
      (c.domain ? verdicts[String(c.domain).toLowerCase()] : undefined) ||
      (c.name ? verdicts[String(c.name).toLowerCase()] : undefined);
    if (v) {
      if (v.verdict === 'not_competitor') continue;
      c.verdict = v.verdict;
      c.why = v.why;
    } else if (c.source === 'onboarding') {
      // the owner knows their own competitors — trust without an LLM verdict
      c.verdict = 'direct';
      c.why = 'указан владельцем бренда';
    }
    delete (c as Partial<CandidateRow>).key;
    if (!c.domain && !c.name) continue;
    out.push(c);
  }

  const rankOf = (verdict: string | null): number =>
    verdict === 'direct' ? 0 : verdict === 'adjacent' ? 1 : 2;
  out.sort((a, b) => {
    const ar = rankOf(a.verdict);
    const br = rankOf(b.verdict);
    if (ar !== br) return ar - br;
    const am = -(a.mentions || 0);
    const bm = -(b.mentions || 0);
    if (am !== bm) return am - bm;
    return -(a.shared || 0) - -(b.shared || 0);
  });
  return out.slice(0, MAX_FINAL);
}

/**
 * Pure parsing of the brands.competitors field (a JSON array of strings or
 * objects) → a list of domains/names. An object takes domain→url→name; ≤8.
 * Split out of onboardingCompetitors so it can be parity-tested without a DB.
 */
export function parseOnboardingCompetitors(comps: unknown): string[] {
  const out: string[] = [];
  for (const raw of Array.isArray(comps) ? comps : []) {
    let c: unknown = raw;
    if (isDict(c)) c = c.domain || c.url || c.name || '';
    const s = String(c).trim();
    if (s) out.push(s);
  }
  return out.slice(0, 8);
}

/**
 * Source 3: competitors from the brands table (filled in by the owner during
 * onboarding). Takes the brand with this domain (active ones first); no
 * DB/brand → [] (fail-soft).
 */
export async function onboardingCompetitors(domain: string): Promise<string[]> {
  try {
    const row = await blogPrisma().brand.findFirst({
      where: { domain },
      orderBy: [{ isActive: 'desc' }, { id: 'asc' }],
      select: { competitors: true },
    });
    return parseOnboardingCompetitors(row ? (row.competitors as unknown) : null);
  } catch {
    return []; // no DATABASE_URL / table / brand
  }
}
