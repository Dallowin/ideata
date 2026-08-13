/**
 * Catalog of kie.ai text→image models with per-image pricing.
 *
 * Same source as the chat catalog (kieCatalog): model sitemap → page →
 * __NEXT_DATA__.pageProps.pageData.groupData. For image groups the channel is
 * fal_request / replicate_request, and `model` is exactly the slug that goes
 * into jobs/createTask. The price sits as text in pricingDesc ("4 credits per
 * image (~$0.02)"); we take the first dollar price per image.
 *
 * We keep only generation FROM TEXT: image-to-image, edit, upscale,
 * background-remove variants and all video/audio are filtered out — they need
 * an image input, and they're useless in the cover constructor.
 *
 * Cached in the settings table (key=kieImageModelsCache), TTL 24h, falls back to a snapshot.
 */
import pLimit from 'p-limit'
import { allSettings, saveSettings } from './store'

export interface ImageModel {
  /** slug for jobs/createTask (`google/nano-banana`, `seedream/4.5-text-to-image`) */
  id: string
  label: string
  /** $ per single image (per kie's pricing) */
  usdPerImage: number | null
  /** "kie credits" from the price list — informational only, NOT our own credits */
  kieCredits: number | null
}

const CACHE_KEY = 'kieImageModelsCache'
const TTL_MS = 24 * 60 * 60 * 1000
const UA = 'Mozilla/5.0 (compatible; IdeataBlogWriter/1.0)'

/** Snapshot (scraped 2026-07-26) — for when kie.ai is unavailable. */
export const IMAGE_SNAPSHOT: ImageModel[] = [
  { id: 'google/nano-banana', label: 'Nano Banana', usdPerImage: 0.02, kieCredits: 4 },
  { id: 'nano-banana-pro', label: 'Nano Banana Pro', usdPerImage: 0.09, kieCredits: 18 },
  { id: 'google/imagen4-fast', label: 'Imagen 4 Fast', usdPerImage: 0.02, kieCredits: 4 },
  { id: 'google/imagen4', label: 'Imagen 4', usdPerImage: 0.04, kieCredits: 8 },
  { id: 'google/imagen4-ultra', label: 'Imagen 4 Ultra', usdPerImage: 0.06, kieCredits: 12 },
  { id: 'seedream/4.5-text-to-image', label: 'Seedream 4.5', usdPerImage: 0.032, kieCredits: 6.5 },
  { id: 'flux-2/pro-text-to-image', label: 'FLUX.2 Pro', usdPerImage: 0.025, kieCredits: 5 },
  { id: 'flux-2/flex-text-to-image', label: 'FLUX.2 Flex', usdPerImage: 0.07, kieCredits: 14 },
  { id: 'qwen/text-to-image', label: 'Qwen Image', usdPerImage: 0.02, kieCredits: 4 },
  { id: 'gpt-image/1.5-text-to-image', label: 'GPT Image 1.5', usdPerImage: 0.02, kieCredits: 4 },
  { id: 'z-image', label: 'Z-Image', usdPerImage: 0.004, kieCredits: 0.8 },
]

/** Default model: cheap, fast, and proven on our pipeline. */
export const DEFAULT_IMAGE_MODEL = 'google/nano-banana'

/** Image-model families in the sitemap (everything else is video/audio/utilities). */
const IMAGE_PAGES = /^(google\/imagen|nano-banana|seedream|flux|qwen-image|z-image|ideogram\/v|gpt-image|grok-imagine|4o-image)/

/** Does the model generate from text? (edit/i2i/upscale/video are excluded) */
export function isTextToImage(id: string): boolean {
  const s = id.toLowerCase()
  if (/(edit|image-to-image|i2i|upscal|remove-background|inpaint|outpaint|character|reference|video|motion|avatar|speech|tts|audio)/.test(s)) return false
  return /(text-to-image|imagen|nano-banana|z-image|grok-imagine|4o-image|ideogram)/.test(s) || s.endsWith('/t2i')
}

/** First dollar price per image from pricingDesc + "kie credits" if present. */
export function parseImagePrice(desc: string): { usdPerImage: number | null; kieCredits: number | null } {
  const usd = desc.match(/[≈~=]?\s*\$([\d.]+)/)
  const cr = desc.match(/([\d.]+)\s*(?:Kie\s+)?credits?/i)
  return {
    usdPerImage: usd ? Number(usd[1]) : null,
    kieCredits: cr ? Number(cr[1]) : null,
  }
}

function labelOf(id: string): string {
  return id
    .replace(/^[\w.-]+\//, '')
    .replace(/-?text-to-image$/, '')
    .replace(/[-/.]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.text()
}

async function scrapeImageModels(): Promise<ImageModel[]> {
  const sitemap = await fetchText('https://kie.ai/sitemaps/models-0.xml')
  const slugs = [...sitemap.matchAll(/<loc>https:\/\/kie\.ai\/([^<]+)<\/loc>/g)]
    .map((m) => m[1])
    .filter((s) => IMAGE_PAGES.test(s))

  const limit = pLimit(4)
  const lists = await Promise.all(slugs.map((slug) => limit(async (): Promise<ImageModel[]> => {
    try {
      const html = await fetchText(`https://kie.ai/${slug}`)
      const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s)
      if (!m) return []
      const pageData = JSON.parse(m[1])?.props?.pageProps?.pageData
      const out: ImageModel[] = []
      for (const g of pageData?.groupData ?? []) {
        const id = String(g?.model || '')
        if (!id || !isTextToImage(id)) continue
        out.push({ id, label: labelOf(id), ...parseImagePrice(String(g?.pricingDesc || '')) })
      }
      return out
    } catch {
      return []
    }
  })))

  const seen = new Set<string>()
  const models = lists.flat().filter((m) => !seen.has(m.id) && seen.add(m.id))
  // cheapest first: in the cover constructor price decides more often than max quality
  models.sort((a, b) => (a.usdPerImage ?? 99) - (b.usdPerImage ?? 99))
  return models
}

/** Catalog with a daily cache; falls back to cache, then snapshot, when kie.ai is unavailable. */
export async function getImageCatalog(force = false): Promise<{ models: ImageModel[]; scrapedAt: string; stale: boolean }> {
  const db = await allSettings()
  let cached: { ts: number; models: ImageModel[] } | null = null
  try { cached = db[CACHE_KEY] ? JSON.parse(db[CACHE_KEY]) : null } catch { cached = null }

  if (!force && cached?.models?.length && Date.now() - cached.ts < TTL_MS) {
    return { models: cached.models, scrapedAt: new Date(cached.ts).toISOString(), stale: false }
  }
  try {
    const models = await scrapeImageModels()
    if (models.length) {
      await saveSettings({ [CACHE_KEY]: JSON.stringify({ ts: Date.now(), models }) })
      return { models, scrapedAt: new Date().toISOString(), stale: false }
    }
  } catch { /* network/parse failed — fall back below */ }
  if (cached?.models?.length) {
    return { models: cached.models, scrapedAt: new Date(cached.ts).toISOString(), stale: true }
  }
  return { models: IMAGE_SNAPSHOT, scrapedAt: 'snapshot', stale: true }
}

/** Model by slug (from the live catalog, otherwise from the snapshot). */
export async function findImageModel(id: string): Promise<ImageModel | null> {
  const { models } = await getImageCatalog()
  return models.find((m) => m.id === id) || IMAGE_SNAPSHOT.find((m) => m.id === id) || null
}
