/**
 * Search for similar POSTS on a topic (fan-out over queries) — the core of `findArticles`.
 *
 * Flow: topic → N realistic search queries (searchQueries) → for each one search
 * 5-10 posts → dedup by URL + per-domain cap + round-robin → fetch full text
 * of the top candidates (the rest stay as candidates from search results) →
 * extract key points AND attributed facts (numbers/dates + a verbatim quote).
 * Each source remembers which query found it, its own byline/date/publication, and
 * a domain-authority heuristic — authoritative sources are fetched first.
 *
 * Used both in the pipeline (research stage) and as a standalone
 * "reference article search" tool (server/api/references/*).
 */
import pLimit from 'p-limit'
import type { AppSettings } from '../appSettings'
import { pl } from '../lang'
import { coerceArray, type LLM } from '../llm'
import { ddgSearch, fetchArticleFull, type SearchHit } from '../search'
import { authorityScore } from './authority'
import { generateSearchQueries } from './searchQueries'
import type { SearchQuery, Source, SourceFact } from './types'

export interface ResearchResult {
  queries: SearchQuery[]
  sources: Source[]
}

export interface FindOpts {
  queries?: string[] // custom queries instead of generated ones
  extraQueries?: string[] // add to the generated ones (e.g. target AEO queries)
  fetchN?: number // how many top candidates to fetch in full (key points)
  perQuery?: number // posts from search results per query
  candidateCap?: number // how many unfetched candidates to return
}

/** Fan-out core: topic → queries → posts. Doesn't persist anything. */
export async function findArticles(
  topic: string,
  llm: LLM,
  s: AppSettings,
  opts: FindOpts = {},
): Promise<ResearchResult> {
  const queries: SearchQuery[] = opts.queries?.length
    ? opts.queries.map(q => ({ query: q, angle: '' }))
    : await generateSearchQueries(topic, llm, s, s.maxQueries)
  // target AEO queries also go into the search: the article must answer them,
  // so they need sources too (dedup by normalized text)
  for (const q of (opts.extraQueries ?? []).slice(0, 3)) {
    const norm = q.trim().toLowerCase()
    if (norm && !queries.some(x => x.query.toLowerCase() === norm)) {
      queries.push({ query: q.trim(), angle: 'целевой AEO-запрос' })
    }
  }

  const fetchN = opts.fetchN ?? s.maxSources

  // mock mode: synthesize candidates deterministically, no network calls
  if (llm.isMock) return { queries, sources: mockSources(topic, queries, fetchN) }

  // fan-out: fetch 5-10 posts per query
  const perQuery = opts.perQuery ?? s.postsPerQuery
  const hitLists = await Promise.all(
    queries.map(async q => ({ q: q.query, hits: await ddgSearch(q.query, perQuery) })),
  )

  // merge with query attribution, dedup by URL, cap per domain (so one blog doesn't crowd everything out)
  const candidates = mergeCandidates(hitLists, s.maxPerDomain)

  // fetch full text only for the top candidates, the rest stay as candidates from search results
  const fetchLimit = pLimit(4)
  const toFetch = candidates.slice(0, fetchN)
  const rest = candidates.slice(fetchN)

  const fetched: Source[] = (await Promise.all(toFetch.map(c => fetchLimit(async () => {
    const art = await fetchArticleFull(c.url, s.fetchTimeoutMs)
    if (!art.text || art.text.length < 200) return null
    return {
      url: c.url, title: c.title, text: art.text, keyPoints: [], facts: [],
      author: art.author, publishedAt: art.publishedAt, siteName: art.siteName,
      authority: authorityScore(c.url),
      query: c.query, snippet: c.snippet, fetched: true,
    } as Source
  })))).filter((x): x is Source => x !== null)

  const kpLimit = pLimit(3)
  await Promise.all(fetched.map(src => kpLimit(async () => {
    const ins = await extractInsights(topic, src, llm, s.language)
    src.keyPoints = ins.keyPoints
    src.facts = ins.facts
  })))

  // candidates from search results (not fetched) — can be picked up manually
  const candidateSources: Source[] = rest.slice(0, opts.candidateCap ?? 24).map(c => ({
    url: c.url, title: c.title, text: '', keyPoints: [], query: c.query, snippet: c.snippet,
    authority: authorityScore(c.url), fetched: false,
  }))

  return { queries, sources: [...fetched, ...candidateSources] }
}

/** Pipeline's research stage — a thin wrapper over findArticles with defaults. */
export async function research(
  topic: string,
  llm: LLM,
  s: AppSettings,
  targetQueries: string[] = [],
): Promise<ResearchResult> {
  return findArticles(topic, llm, s, { extraQueries: targetQueries })
}

interface Candidate { url: string, title: string, snippet: string, query: string }

/**
 * Merge search results across queries: dedup by URL + at most maxPerDomain per domain.
 * Order: round-robin over queries (diversity), then a stable sort by domain
 * authority — primary sources get fetched before SEO blogs.
 */
export function mergeCandidates(lists: Array<{ q: string, hits: SearchHit[] }>, maxPerDomain: number): Candidate[] {
  const seen = new Set<string>()
  const perDomain = new Map<string, number>()
  const out: Candidate[] = []
  // round-robin over queries — so the top candidates are diverse
  const maxLen = Math.max(0, ...lists.map(l => l.hits.length))
  for (let i = 0; i < maxLen; i++) {
    for (const { q, hits } of lists) {
      const hit = hits[i]
      if (!hit?.url || seen.has(hit.url)) continue
      const dom = domainOf(hit.url)
      const n = perDomain.get(dom) ?? 0
      if (n >= maxPerDomain) continue
      seen.add(hit.url)
      perDomain.set(dom, n + 1)
      out.push({ url: hit.url, title: hit.title, snippet: hit.snippet, query: q })
    }
  }
  // stable: round-robin order is preserved for equal authority
  return out
    .map((c, i) => ({ c, i, a: authorityScore(c.url) }))
    .sort((x, y) => y.a - x.a || x.i - y.i)
    .map(x => x.c)
}

function domainOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url }
}

function mockSources(topic: string, queries: SearchQuery[], limit: number): Source[] {
  const out: Source[] = []
  for (const q of queries) {
    for (let i = 1; i <= 2 && out.length < limit; i++) {
      const slug = q.query.replace(/\s+/g, '-')
      out.push({
        url: `https://example-${out.length + 1}.com/${slug}`,
        title: `Пост про «${q.query}»${q.angle ? ` (${q.angle})` : ''}`,
        text: `Демо-текст источника про «${topic}»${q.angle ? ` под углом «${q.angle}»` : ''}. Тезис 1. Тезис 2.`,
        keyPoints: [`Тезис A по запросу «${q.query}»`, 'Тезис B из источника'],
        facts: [{ claim: `Демо-факт: 42% по запросу «${q.query}»`, quote: 'демо-цитата про 42%' }],
        authority: 5,
        query: q.query,
        snippet: `Выдержка выдачи по запросу «${q.query}»…`,
        fetched: true,
      })
    }
  }
  return out
}

export interface SourceInsights {
  keyPoints: string[]
  facts: SourceFact[]
}

/**
 * Key points + attributed facts from a source. Facts are concrete details
 * (numbers, dates, names) with a verbatim supporting quote: they go into the
 * text with a link to the source and give fact-check something to verify.
 */
export async function extractInsights(topic: string, src: Source, llm: LLM, lang: string = 'ru'): Promise<SourceInsights> {
  const prompt
    = `${pl(lang, `Тема статьи: «${topic}».`, `Article topic: "${topic}".`)}\n`
    + pl(lang,
      'Ниже фрагмент источника. Верни JSON-объект с двумя полями:\n'
      + '- "key_points": 3-6 ключевых тезисов (без воды, каждый — одна строка);\n'
      + '- "facts": 0-6 ФАКТОВ С КОНКРЕТИКОЙ — цифры, проценты, даты, названия, '
      + 'имена. Каждый факт: {"claim": "факт с сохранёнными цифрами/именами", '
      + '"quote": "короткая дословная цитата из текста (до 25 слов), откуда факт"}. '
      + 'ТОЛЬКО то, что реально есть в тексте. Нет конкретики — верни facts: [].\n\n',
      'Below is a source excerpt. Return a JSON object with two fields:\n'
      + '- "key_points": 3-6 key takeaways (no fluff, each one a single line);\n'
      + '- "facts": 0-6 CONCRETE FACTS — numbers, percentages, dates, names, '
      + 'titles. Each fact: {"claim": "fact with numbers/names preserved", '
      + '"quote": "a short verbatim quote from the text (up to 25 words) the fact comes from"}. '
      + 'ONLY what is actually in the text. No concrete details — return facts: [].\n\n',
    )
    + `${pl(lang, 'ИСТОЧНИК', 'SOURCE')}: ${src.title}\n${src.text.slice(0, 6000)}`
  try {
    const data = await llm.json(prompt, { system: pl(lang, 'Ты аналитик контента. Извлекаешь суть и проверяемые факты из источников.', 'You are a content analyst. You extract the gist and verifiable facts from sources.'), research: true, maxTokens: 2000 })
    const keyPoints = coerceArray(data?.key_points ?? data)
      .map(x => typeof x === 'string' ? x : String(x?.point ?? x?.text ?? JSON.stringify(x)))
      .filter(Boolean)
      .slice(0, 6)
    const facts: SourceFact[] = (Array.isArray(data?.facts) ? data.facts : [])
      .map((f: any) => ({
        claim: String(f?.claim ?? '').trim(),
        quote: String(f?.quote ?? '').trim() || undefined,
      }))
      .filter((f: SourceFact) => f.claim)
      .slice(0, 6)
    return { keyPoints, facts }
  } catch (e) {
    // best-effort: a source without key points doesn't block the pipeline, but we log a trace
    console.warn('[research] insights failed for', src.url, e instanceof Error ? e.message : e)
  }
  return { keyPoints: [], facts: [] }
}

/** Backward compatibility: key points only (references/extract and manual pickup). */
export async function extractKeyPoints(topic: string, src: Source, llm: LLM, lang: string = 'ru'): Promise<string[]> {
  return (await extractInsights(topic, src, llm, lang)).keyPoints
}
