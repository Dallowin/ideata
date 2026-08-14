/**
 * Static catalog of Anthropic Claude models: the id used across the product, the
 * slug the Messages API expects, and the OFFICIAL list price ($ per 1M tokens).
 *
 * Anthropic publishes no models-with-pricing endpoint, and the list barely moves —
 * so this is a plain constant: no network, no cache. The live OpenRouter catalog
 * carries the same (official) prices and wins when it's reachable; this list is
 * what keeps the selector and the accounting working offline.
 */

export interface AnthropicModel {
  id: string // canonical id, OpenRouter style: anthropic/claude-opus-4.8
  apiSlug: string // slug for api.anthropic.com: claude-opus-4-8
  label: string
  inUsd: number // $ per 1M input tokens, official list price
  outUsd: number // $ per 1M output tokens, official list price
}

/** Price families: fable 10/50, opus 5/25, sonnet 3/15, haiku 1/5. */
export const ANTHROPIC_MODELS: AnthropicModel[] = [
  { id: 'anthropic/claude-fable-5', apiSlug: 'claude-fable-5', label: 'Claude Fable 5', inUsd: 10, outUsd: 50 },
  { id: 'anthropic/claude-opus-4.8', apiSlug: 'claude-opus-4-8', label: 'Claude Opus 4.8', inUsd: 5, outUsd: 25 },
  { id: 'anthropic/claude-opus-4.7', apiSlug: 'claude-opus-4-7', label: 'Claude Opus 4.7', inUsd: 5, outUsd: 25 },
  { id: 'anthropic/claude-sonnet-5', apiSlug: 'claude-sonnet-5', label: 'Claude Sonnet 5', inUsd: 3, outUsd: 15 },
  { id: 'anthropic/claude-sonnet-4.6', apiSlug: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', inUsd: 3, outUsd: 15 },
  { id: 'anthropic/claude-sonnet-4.5', apiSlug: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', inUsd: 3, outUsd: 15 },
  { id: 'anthropic/claude-haiku-4.5', apiSlug: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', inUsd: 1, outUsd: 5 },
]

/** API slug for a catalog id; null — the model isn't in the list. */
export function anthropicSlugFor(id: string): string | null {
  return ANTHROPIC_MODELS.find(m => m.id === id)?.apiSlug ?? null
}

/** Whether the model is served by the Anthropic Messages API. */
export function isAnthropicModel(id: string): boolean {
  const s = String(id || '')
  return s.startsWith('anthropic/') || ANTHROPIC_MODELS.some(m => m.id === s)
}
