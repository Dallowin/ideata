/**
 * Catalog of kie.ai Claude models with pricing — scraped from their website.
 *
 * Source: sitemap kie.ai/sitemaps/models-0.xml → model pages →
 * __NEXT_DATA__.pageProps.pageData.groupData[channel=chat].pricingDesc
 * ("Input 400 credits / 1M tokens (≈ $2.00) …"). kie has no API listing.
 *
 * Cached in the settings table (key=kieModelsCache), TTL 24h; falls back to a snapshot.
 */
import pLimit from 'p-limit'
import { allSettings, saveSettings } from './store'

export interface KieModel {
  id: string // canonical id: for Claude, OpenRouter-style (anthropic/claude-opus-4.8); for others, the kie slug
  kieSlug: string // kie slug: claude-opus-4-8, gemini-3-pro, gpt-5-2
  label: string
  format: 'claude' | 'openai' // which API kie serves it through (Messages vs chat/completions)
  inUsd: number | null // $ per 1M input tokens
  outUsd: number | null // $ per 1M output tokens
  inCredits: number | null
  outCredits: number | null
  pctOfficial: number | null // % of the official API price (lower = cheaper)
}

const CACHE_KEY = 'kieModelsCache'
const TTL_MS = 24 * 60 * 60 * 1000
const UA = 'Mozilla/5.0 (compatible; IdeataBlogWriter/1.0)'

/** Snapshot for when kie.ai is unavailable (scraped 2026-07-06). */
export const KIE_SNAPSHOT: KieModel[] = [
  { id: 'anthropic/claude-fable-5', kieSlug: 'claude-fable-5', label: 'Claude Fable 5', format: 'claude', inUsd: 4.0, outUsd: 20.0, inCredits: 800, outCredits: 4000, pctOfficial: 40 },
  { id: 'anthropic/claude-opus-4.8', kieSlug: 'claude-opus-4-8', label: 'Claude Opus 4.8', format: 'claude', inUsd: 2.0, outUsd: 10.0, inCredits: 400, outCredits: 2000, pctOfficial: 40 },
  { id: 'anthropic/claude-opus-4.7', kieSlug: 'claude-opus-4-7', label: 'Claude Opus 4.7', format: 'claude', inUsd: 1.425, outUsd: 7.15, inCredits: 285, outCredits: 1430, pctOfficial: null },
  { id: 'anthropic/claude-sonnet-5', kieSlug: 'claude-sonnet-5', label: 'Claude Sonnet 5', format: 'claude', inUsd: 0.85, outUsd: 4.275, inCredits: 170, outCredits: 855, pctOfficial: null },
  { id: 'anthropic/claude-sonnet-4.5', kieSlug: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', format: 'claude', inUsd: 0.85, outUsd: 4.275, inCredits: 170, outCredits: 855, pctOfficial: null },
  { id: 'anthropic/claude-haiku-4.5', kieSlug: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', format: 'claude', inUsd: 0.275, outUsd: 1.425, inCredits: 55, outCredits: 285, pctOfficial: null },
  { id: 'gemini-3-pro', kieSlug: 'gemini-3-pro', label: 'Gemini 3 Pro', format: 'openai', inUsd: 0.5, outUsd: 3.5, inCredits: 100, outCredits: 700, pctOfficial: null },
  { id: 'gemini-3.1-pro', kieSlug: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', format: 'openai', inUsd: 0.5, outUsd: 3.5, inCredits: 100, outCredits: 700, pctOfficial: null },
  { id: 'gemini-3-5-flash-openai', kieSlug: 'gemini-3-5-flash-openai', label: 'Gemini 3.5 Flash', format: 'openai', inUsd: 0.45, outUsd: 2.7, inCredits: 90, outCredits: 540, pctOfficial: 30 },
  { id: 'gpt-5-2', kieSlug: 'gpt-5-2', label: 'GPT 5.2', format: 'openai', inUsd: null, outUsd: null, inCredits: null, outCredits: null, pctOfficial: null },
]

/** claude-opus-4-8 → anthropic/claude-opus-4.8 (last digit pair joined with a dot). */
export function kieSlugToCanonical(slug: string): string {
  return 'anthropic/' + slug.replace(/-(\d+)-(\d+)$/, '-$1.$2')
}

function labelOf(slug: string): string {
  return slug
    .replace(/-openai$/, '')
    .replace(/^claude-/, 'Claude ')
    .replace(/^gemini-/, 'Gemini ')
    .replace(/^gpt-/, 'GPT ')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/^(Gemini|GPT) (\d+)-(\d+)/, '$1 $2.$3')
    .replace(/-(\d+)$/, ' $1')
    .replace(/-(pro|flash|mini)/g, ' $1')
    .replace(/\b(opus|sonnet|haiku|fable|pro|flash|mini)\b/g, s => s[0].toUpperCase() + s.slice(1))
    .replace(/\s+/g, ' ').trim()
}

/**
 * Parse pricingDesc — all three kie formats:
 *  "Input 400 credits / 1M tokens (≈ $2.00) …" (credits+dollars)
 *  "Input $0.38 (≈76 credits) & Output $3.00 (≈600 credits) per million tokens" (dollars+credits)
 *  "… ~40% of official pricing" / "flat 70 % cheaper than the official rates"
 */
export function parsePricingDesc(desc: string): Pick<KieModel, 'inUsd' | 'outUsd' | 'inCredits' | 'outCredits' | 'pctOfficial'> {
  const num = (s: string) => Number(s.replace(/,/g, ''))
  let mIn = desc.match(/Input\s+([\d,]+)\s*credits\s*\/\s*1M tokens\s*\(≈\s*\$([\d.]+)/i)
  let mOut = desc.match(/Output\s+([\d,]+)\s*credits\s*\/\s*1M tokens\s*\(≈\s*\$([\d.]+)/i)
  let inCredits = mIn ? num(mIn[1]) : null
  let inUsd = mIn ? Number(mIn[2]) : null
  let outCredits = mOut ? num(mOut[1]) : null
  let outUsd = mOut ? Number(mOut[2]) : null
  if (inUsd == null) {
    const alt = desc.match(/Input\s+\$([\d.]+)\s*\(≈\s*([\d,]+)\s*credits\)/i)
    const altOut = desc.match(/Output\s+\$([\d.]+)\s*\(≈\s*([\d,]+)\s*credits\)/i)
    if (alt) { inUsd = Number(alt[1]); inCredits = num(alt[2]) }
    if (altOut) { outUsd = Number(altOut[1]); outCredits = num(altOut[2]) }
  }
  const mPct = desc.match(/~?([\d.]+)\s*%\s*of official/i)
  const mCheaper = desc.match(/([\d.]+)\s*%\s*cheaper/i)
  const pctOfficial = mPct
    ? Math.round(Number(mPct[1]))
    : (mCheaper ? Math.round(100 - Number(mCheaper[1])) : null)
  return { inCredits, inUsd, outCredits, outUsd, pctOfficial }
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.text()
}

async function scrapeKieModels(): Promise<KieModel[]> {
  const sitemap = await fetchText('https://kie.ai/sitemaps/models-0.xml')
  const slugs = [...sitemap.matchAll(/<loc>https:\/\/kie\.ai\/([^<]+)<\/loc>/g)]
    .map(m => m[1])
    // LLM families only (the rest of the sitemap is image/video/audio models)
    .filter(s => /^(claude|gpt|gemini)-/.test(s))

  const limit = pLimit(4)
  const lists = await Promise.all(slugs.map(slug => limit(async (): Promise<KieModel[]> => {
    try {
      const html = await fetchText(`https://kie.ai/${slug}`)
      const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)
      if (!m) return []
      const pageData = JSON.parse(m[1])?.props?.pageProps?.pageData
      const out: KieModel[] = []
      for (const g of pageData?.groupData ?? []) {
        const format = g?.chatModelConfig?.format
        // we support Messages (claude) and chat/completions (openai);
        // our client doesn't handle 'response' (GPT 5.4+) or native 'gemini' — skip them
        if (g?.channel !== 'chat' || (format !== 'claude' && format !== 'openai')) continue
        const kieSlug = String(g.model || slug)
        out.push({
          id: format === 'claude' ? kieSlugToCanonical(kieSlug) : kieSlug,
          kieSlug,
          label: labelOf(kieSlug),
          format,
          ...parsePricingDesc(String(g.pricingDesc || '')),
        })
      }
      return out
    } catch {
      return []
    }
  })))
  // dedup by kieSlug (pages can duplicate groups)
  const seen = new Set<string>()
  const models = lists.flat().filter(m => !seen.has(m.kieSlug) && seen.add(m.kieSlug))

  // sort: more expensive (more powerful) on top, priceless ones at the end
  models.sort((a, b) => (b.outUsd ?? -1) - (a.outUsd ?? -1))
  return models
}

/** Catalog with caching: scrape once a day, fall back to cache/snapshot when unavailable. */
export async function getKieCatalog(force = false): Promise<{ models: KieModel[], scrapedAt: string, stale: boolean }> {
  const db = await allSettings()
  let cached: { ts: number, models: KieModel[] } | null = null
  try { cached = db[CACHE_KEY] ? JSON.parse(db[CACHE_KEY]) : null } catch { cached = null }

  if (!force && cached?.models?.length && Date.now() - cached.ts < TTL_MS) {
    return { models: cached.models, scrapedAt: new Date(cached.ts).toISOString(), stale: false }
  }
  try {
    const models = await scrapeKieModels()
    if (models.length) {
      await saveSettings({ [CACHE_KEY]: JSON.stringify({ ts: Date.now(), models }) })
      return { models, scrapedAt: new Date().toISOString(), stale: false }
    }
  } catch { /* network/parse failed — fall back below */ }
  if (cached?.models?.length) {
    return { models: cached.models, scrapedAt: new Date(cached.ts).toISOString(), stale: true }
  }
  return { models: KIE_SNAPSHOT, scrapedAt: 'snapshot', stale: true }
}
