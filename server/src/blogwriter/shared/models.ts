/**
 * Curated catalog of OpenRouter models for selection in settings.
 * `id` — the OpenRouter slug; `role` hints at what the model is best suited for.
 * The list is used both on the client (select) and on the server (validation).
 */
export interface ModelOption {
  id: string
  label: string
  note: string
  role: 'strong' | 'fast' | 'both'
  /** Minimum plan required to select this model (Opus is gated to Scale). Empty —
   *  available to everyone. The frontend draws a lock based on this field; the backend gates it on run start. */
  planGate?: 'scale'
}

export const MODEL_CATALOG: ModelOption[] = [
  { id: 'anthropic/claude-opus-4.8', label: 'Claude Opus 4.8', note: 'самая мощная — лучшая проза, для генерации текста', role: 'strong', planGate: 'scale' },
  { id: 'anthropic/claude-opus-4.8-fast', label: 'Claude Opus 4.8 Fast', note: 'тот же Opus, быстрее (×2 цена)', role: 'strong', planGate: 'scale' },
  { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', note: 'сильная и дешевле Opus', role: 'both' },
  { id: 'anthropic/claude-sonnet-4.5', label: 'Claude Sonnet 4.5', note: 'прошлый сильный дефолт', role: 'both' },
  { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5', note: 'быстрая и дешёвая — тезисы, ключи', role: 'fast' },
  { id: 'anthropic/claude-haiku-latest', label: 'Claude Haiku (latest)', note: 'роутер на свежий Haiku', role: 'fast' },
  { id: 'x-ai/grok-4.3', label: 'Grok 4.3', note: 'альтернатива не от Anthropic', role: 'both' },
  { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro', note: 'альтернатива не от Anthropic', role: 'both' },
]

/** Models suited for text generation (strong role). */
export const strongModels = () => MODEL_CATALOG.filter(m => m.role === 'strong' || m.role === 'both')
/** Models for routine stages (fast role). */
export const fastModels = () => MODEL_CATALOG.filter(m => m.role === 'fast' || m.role === 'both')
