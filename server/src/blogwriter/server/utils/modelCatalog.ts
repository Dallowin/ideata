/**
 * Unified model catalog for the assistant AND the blog writer. Built from two
 * sources, marking a route for each model:
 *  - Anthropic (anthropicCatalog) — Claude, served by the official Messages API;
 *  - OpenRouter — everything else (deepseek, qwen, llama, mistral, xai…).
 * The provider is chosen BY MODEL (providerForModel), not globally in settings.
 *
 * The {id,label,provider,format,inUsd,outUsd} shape is compatible with the old
 * blog catalog ({id,label,format,inUsd,outUsd}) — the old frontend won't break.
 */
import { ANTHROPIC_MODELS, anthropicSlugFor, isAnthropicModel, type AnthropicModel } from './anthropicCatalog'

export { anthropicSlugFor, isAnthropicModel }

export interface UnifiedModel {
  id: string // OpenRouter style (`deepseek/deepseek-chat`); Claude is `anthropic/claude-*`
  label: string
  provider: 'anthropic' | 'openrouter'
  format: 'claude' | 'openai'
  inUsd: number | null // $/1M input tokens
  outUsd: number | null // $/1M output tokens
  // For the model card in the selector (hover): one "what is it" sentence and the context window.
  // Only present for OpenRouter models; the static Claude list doesn't have these fields — empty there.
  desc: string
  context: number | null // context size in tokens
}

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
const TTL_MS = 60 * 60 * 1000 // 1 hour

interface Cache { at: number; models: UnifiedModel[] }
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

const claudeToUnified = (k: AnthropicModel): UnifiedModel => ({
  id: k.id, label: k.label, provider: 'anthropic', format: 'claude', inUsd: k.inUsd, outUsd: k.outUsd,
  desc: '', context: null,
})

/** vendor from the id: for OpenRouter — the prefix before `/`; for bare slugs — by the start */
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

// Curated model list — a hand-picked menu, not all of OpenRouter. The ids are
// verified against the live catalog. Claude goes to the Anthropic Messages API,
// everything else to OpenRouter; providerForModel picks the route. Order here
// doesn't matter — the result is sorted by price.
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

/** Unified catalog: only the curated list, prices/route from the live catalog. */
export async function getUnifiedCatalog(force = false): Promise<{ models: UnifiedModel[]; source: 'live' | 'snapshot'; at: string }> {
  const now = Date.now()
  if (!force && cache && now - cache.at < TTL_MS) {
    return { models: cache.models, source: 'live', at: new Date(cache.at).toISOString() }
  }
  // OpenRouter — the live price/label/description source
  let or: UnifiedModel[] = []
  try { or = await fetchOpenRouter() } catch { /* network failure → fall back below */ }

  // Index of live data. The OpenRouter price is the vendor's list price, so it
  // wins where it exists; the static Claude list fills the gaps (and stands in
  // whole when OpenRouter is unreachable). The route always stays Anthropic for
  // Claude — that's what decides which API the call goes to, not the price.
  const byId = new Map<string, UnifiedModel>()
  for (const m of or) byId.set(m.id, m)
  for (const k of ANTHROPIC_MODELS) {
    const prev = byId.get(k.id)
    const u = claudeToUnified(k)
    byId.set(k.id, prev
      ? { ...u, inUsd: prev.inUsd ?? u.inUsd, outUsd: prev.outUsd ?? u.outUsd, desc: prev.desc, context: prev.context }
      : u)
  }

  // take ONLY the curated list; price comes from the live data, and if a model
  // hasn't arrived (network/withdrawn) — show it without a price. The route is
  // decided by the id, so the card always says where the call will actually go.
  const models = sortModels(CURATED.map(({ id, label }): UnifiedModel => {
    const claude = isAnthropicModel(id)
    const provider = claude ? 'anthropic' as const : 'openrouter' as const
    const format = claude ? 'claude' as const : 'openai' as const
    const live = byId.get(id)
    if (live) return { ...live, label, provider, format }
    return { id, label, provider, format, inUsd: null, outUsd: null, desc: '', context: null }
  }))

  cache = { at: now, models }
  return { models, source: or.length ? 'live' : 'snapshot', at: new Date(now).toISOString() }
}

/**
 * Keep only the models in the catalog that will actually work with the current
 * keys: with an Anthropic key alone, everything outside Claude has nowhere to go —
 * offering it would look like a broken product.
 */
export function modelsForKeys(models: UnifiedModel[], keys: { anthropicKey?: string; orKey?: string }): UnifiedModel[] {
  if (keys.anthropicKey && keys.orKey) return models
  if (keys.orKey) return models // OpenRouter can also do Claude — the route will move to it
  if (keys.anthropicKey) return models.filter(m => isAnthropicModel(m.id))
  return models
}

/**
 * Route for a specific model. Claude → the Anthropic Messages API (if a key is
 * present); everything else → OpenRouter. Synchronous: decided by the model id,
 * so it works before the catalog cache is warmed up.
 */
export function providerForModel(id: string, keys: { anthropicKey?: string; orKey?: string }): 'anthropic' | 'openrouter' {
  if (isAnthropicModel(id) && keys.anthropicKey) return 'anthropic'
  if (keys.orKey) return 'openrouter'
  if (keys.anthropicKey) return 'anthropic'
  return 'openrouter'
}

/** default cheap assistant model when the client hasn't chosen one */
export const DEFAULT_ASSISTANT_MODEL = 'anthropic/claude-haiku-4.5'

/** loose validation of a model slug before sending it to a provider */
export function isValidModelId(id: unknown): id is string {
  return typeof id === 'string' && /^[\w./:-]{2,80}$/.test(id)
}
