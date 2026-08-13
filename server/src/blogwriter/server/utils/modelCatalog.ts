/**
 * Unified model catalog for the assistant AND the blog writer. Built from two
 * sources, marking a route for each model:
 *  - kie (kieCatalog) — cheap Claude (pctOfficial discount) + a couple of gpt/gemini models;
 *  - OpenRouter — everything else (deepseek, qwen, llama, mistral, xai…).
 * Claude is routed through kie (cheaper), everything else through OpenRouter.
 * The provider is chosen BY MODEL (providerForModel), not globally in settings.
 *
 * The {id,label,provider,format,inUsd,outUsd} shape is compatible with the old
 * blog catalog ({id,label,format,inUsd,outUsd}) — the old frontend won't break.
 */
import { getKieCatalog, KIE_SNAPSHOT, type KieModel } from './kieCatalog'

export interface UnifiedModel {
  id: string // OpenRouter style (`deepseek/deepseek-chat`); kie-claude is also `anthropic/claude-*`
  label: string
  provider: 'kie' | 'openrouter'
  format: 'claude' | 'openai'
  inUsd: number | null // $/1M input tokens
  outUsd: number | null // $/1M output tokens
  // For the model card in the selector (hover): one "what is it" sentence and the context window.
  // Only present for OpenRouter models; the kie catalog doesn't have these fields — empty there.
  desc: string
  context: number | null // context size in tokens
}

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const TTL_MS = 60 * 60 * 1000 // 1 hour

// kieSlugs: catalog id → the ACTUAL kie slug (claude-sonnet-5, gemini-3-5-flash-openai).
// The slug can't be guessed from the id: some models don't expose it (…-openai suffix).
interface Cache { at: number; models: UnifiedModel[]; kieIds: Set<string>; kieSlugs: Map<string, string> }
let cache: Cache | null = null

/** OpenRouter price arrives as a $/token string → round to $/1M */
function perMillion(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 1_000_000 * 1000) / 1000
}

/** text→text chat models only (no image/audio modalities) */
function isTextChat(m: any): boolean {
  const arch = m?.architecture || {}
  const inp: string[] = arch.input_modalities || (arch.modality ? [arch.modality] : [])
  const out: string[] = arch.output_modalities || []
  return (!inp.length || inp.includes('text')) && (!out.length || out.includes('text'))
}

/** OpenRouter description — a marketing paragraph; the card takes the first sentence. */
function firstSentence(v: unknown): string {
  const s = String(v || '').replace(/\s+/g, ' ').trim()
  if (!s) return ''
  const cut = s.split(/(?<=[.!?])\s/)[0] || s
  return cut.length > 180 ? `${cut.slice(0, 177)}…` : cut
}

async function fetchOpenRouter(): Promise<UnifiedModel[]> {
  const res = await fetch(OPENROUTER_MODELS_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`)
  const data: any = await res.json()
  const raw: any[] = Array.isArray(data?.data) ? data.data : []
  return raw
    .filter(isTextChat)
    .map((m): UnifiedModel | null => {
      const id = String(m?.id || '')
      if (!id.includes('/')) return null
      return {
        id,
        label: String(m?.name || id).replace(/^[^:]+:\s*/, '').trim(),
        provider: 'openrouter',
        format: 'openai',
        inUsd: perMillion(m?.pricing?.prompt),
        outUsd: perMillion(m?.pricing?.completion),
        desc: firstSentence(m?.description),
        context: Number.isFinite(Number(m?.context_length)) ? Number(m.context_length) : null,
      }
    })
    .filter((m): m is UnifiedModel => !!m)
}

const kieToUnified = (k: KieModel): UnifiedModel => ({
  id: k.id, label: k.label, provider: 'kie', format: k.format, inUsd: k.inUsd, outUsd: k.outUsd,
  desc: '', context: null,
})

/** vendor from the id: for OpenRouter — the prefix before `/`; for bare kie slugs — by the start */
export function vendorOf(id: string): string {
  if (id.includes('/')) return id.split('/')[0]
  if (id.startsWith('claude')) return 'anthropic'
  if (id.startsWith('gemini')) return 'google'
  if (id.startsWith('gpt')) return 'openai'
  return 'other'
}

// Cheapness key: output price ($/1M) — it dominates cost; falls back to input;
// unknown price (null) goes to the end. Within the same price — by vendor and
// label. Shared sort order for the assistant and the blog writer.
const priceKey = (m: UnifiedModel): number =>
  m.outUsd ?? m.inUsd ?? Number.POSITIVE_INFINITY

function sortModels(list: UnifiedModel[]): UnifiedModel[] {
  return list.sort((a, b) =>
    priceKey(a) - priceKey(b)
    || vendorOf(a.id).localeCompare(vendorOf(b.id))
    || a.label.localeCompare(b.label),
  )
}

// Curated model list — exactly the kie/LobeHub menu, not all of OpenRouter.
// The ids are verified against the live catalogs (kie + OpenRouter). Claude goes
// through kie (cheaper), everything else through OpenRouter; providerForModel
// picks the route. Order here doesn't matter — the result is sorted by price.
const CURATED: { id: string; label: string }[] = [
  { id: 'deepseek/deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5' },
  { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6' },
  { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8' },
  { id: 'anthropic/claude-fable-5', label: 'Claude Fable 5' },
  { id: 'openai/gpt-5.6-luna', label: 'GPT-5.6 Luna' },
  { id: 'openai/gpt-5.6-terra', label: 'GPT-5.6 Terra' },
  { id: 'openai/gpt-5.6-sol', label: 'GPT-5.6 Sol' },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5' },
  { id: 'openai/gpt-5.5-pro', label: 'GPT-5.5 Pro' },
  { id: 'google/gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  { id: 'google/gemini-3.5-flash', label: 'Gemini 3.5 Flash' },
  { id: 'google/gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
  { id: 'google/gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview' },
  { id: 'x-ai/grok-4.5', label: 'Grok 4.5' },
  { id: 'x-ai/grok-4.3', label: 'Grok 4.3' },
  { id: 'z-ai/glm-5.2', label: 'GLM-5.2' },
  { id: 'qwen/qwen3.7-plus', label: 'Qwen3.7 Plus' },
  { id: 'qwen/qwen3.7-max', label: 'Qwen3.7 Max' },
  { id: 'minimax/minimax-m3', label: 'MiniMax M3' },
  { id: 'moonshotai/kimi-k3', label: 'Kimi K3' },
  { id: 'moonshotai/kimi-k2.7-code', label: 'Kimi K2.7 Code' },
  { id: 'xiaomi/mimo-v2.5', label: 'MiMo-V2.5' },
  { id: 'xiaomi/mimo-v2.5-pro', label: 'MiMo-V2.5 Pro' },
]

/** Unified catalog: only the curated list, prices/route from the live catalogs. */
export async function getUnifiedCatalog(force = false): Promise<{ models: UnifiedModel[]; source: 'live' | 'snapshot'; at: string }> {
  const now = Date.now()
  if (!force && cache && now - cache.at < TTL_MS) {
    return { models: cache.models, source: 'live', at: new Date(cache.at).toISOString() }
  }
  // kie — the authority on "what kie can do" (and on the cheap Claude price)
  let kie: KieModel[]
  try { kie = (await getKieCatalog(force)).models } catch { kie = KIE_SNAPSHOT }
  if (!kie.length) kie = KIE_SNAPSHOT
  const kieIds = new Set(kie.map((k) => k.id))

  // OpenRouter — the price/label source for non-kie models
  let or: UnifiedModel[] = []
  try { or = await fetchOpenRouter() } catch { /* network failure → fall back below */ }

  // index of live data: kie overrides OpenRouter on PRICE (kie is cheaper for
  // Claude), but description and context are kept from OpenRouter — kie has none
  const byId = new Map<string, UnifiedModel>()
  for (const m of or) byId.set(m.id, m)
  for (const k of kie) {
    const prev = byId.get(k.id)
    const u = kieToUnified(k)
    byId.set(k.id, prev ? { ...u, desc: prev.desc, context: prev.context } : u)
  }

  // take ONLY the curated list; price/provider come from the live data,
  // and if a model hasn't arrived (network/withdrawn) — show it without a price
  const models = sortModels(CURATED.map(({ id, label }): UnifiedModel => {
    const live = byId.get(id)
    if (live) return { ...live, label }
    return {
      id, label, provider: kieIds.has(id) ? 'kie' : 'openrouter', format: 'openai',
      inUsd: null, outUsd: null, desc: '', context: null,
    }
  }))

  cache = { at: now, models, kieIds, kieSlugs: new Map(kie.map(k => [k.id, k.kieSlug])) }
  return { models, source: or.length ? 'live' : 'snapshot', at: new Date(now).toISOString() }
}

/** Whether the model is in the kie catalog (kie only knows its own slugs, others get a 422). */
export function isKieModel(id: string): boolean {
  return cache?.kieIds.has(id) ?? KIE_SNAPSHOT.some(k => k.id === id)
}

/** kie slug for a catalog model; null — kie doesn't have this model. */
export function kieSlugFor(id: string): string | null {
  const fromCache = cache?.kieSlugs.get(id)
  if (fromCache) return fromCache
  return KIE_SNAPSHOT.find(k => k.id === id)?.kieSlug ?? null
}

/**
 * Keep only the models in the catalog that will actually work with the current
 * keys: without an OpenRouter key, non-kie models can't be selected — kie
 * responds to them with "The model is not supported", which looks like a
 * broken product.
 */
export function modelsForKeys(models: UnifiedModel[], keys: { kieKey?: string; orKey?: string }): UnifiedModel[] {
  if (keys.kieKey && keys.orKey) return models
  if (keys.orKey) return models // OpenRouter can also do Claude — the route will move to it
  if (keys.kieKey) return models.filter(m => isKieModel(m.id))
  return models
}

/**
 * Route for a specific model. Claude/the gpt-gemini pair from the kie catalog →
 * kie (cheaper, if a key is present); everything else → OpenRouter. Synchronous:
 * uses the catalog cache, and before it's warmed up — the static KIE_SNAPSHOT.
 */
export function providerForModel(id: string, keys: { kieKey?: string; orKey?: string }): 'kie' | 'openrouter' {
  if (isKieModel(id) && keys.kieKey) return 'kie'
  if (keys.orKey) return 'openrouter'
  if (keys.kieKey) return 'kie'
  return 'openrouter'
}

/** default cheap assistant model when the client hasn't chosen one */
export const DEFAULT_ASSISTANT_MODEL = 'anthropic/claude-haiku-4.5'

/** loose validation of a model slug before sending it to a provider */
export function isValidModelId(id: unknown): id is string {
  return typeof id === 'string' && /^[\w./:-]{2,80}$/.test(id)
}
