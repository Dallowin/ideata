/**
 * Вендоры моделей: определение по слагу, человеческое имя и иконка. Один
 * источник правды для всех списков моделей (профиль агента, «Спросить агента»,
 * генерация картинок в обложках) — чтобы селектор везде выглядел одинаково.
 *
 * Слаги приходят в двух видах: OpenRouter-стиль `vendor/model` и голые слаги
 * официальных API (`claude-haiku-4-5`, `gemini-3-pro-image`, `imagen-4.0-generate-001`),
 * вторые разбираем по началу.
 */
const VENDOR_LABEL: Record<string, string> = {
  anthropic: 'Claude', openai: 'OpenAI', google: 'Google', deepseek: 'DeepSeek',
  'x-ai': 'Grok', qwen: 'Qwen', 'meta-llama': 'Llama', mistralai: 'Mistral',
  'z-ai': 'Z.ai', minimax: 'MiniMax', moonshotai: 'Kimi', xiaomi: 'MiMo',
  bytedance: 'Seedream', 'black-forest-labs': 'FLUX', other: 'Другие',
}

// Colorful vendor favicons at public/icons/ai/<vendorKey>.png (self-contained
// tiles that read on both themes). Unknown vendors fall back to a neutral icon.
const HAS_ICON = new Set([
  'anthropic', 'openai', 'google', 'deepseek', 'x-ai', 'qwen', 'meta-llama',
  'mistralai', 'z-ai', 'minimax', 'moonshotai', 'bytedance', 'black-forest-labs', 'perplexity',
])

export function vendorKey(id: string): string {
  const s = (id || '').toLowerCase()
  if (s.includes('/')) return s.split('/')[0]
  if (s.startsWith('claude')) return 'anthropic'
  // картиночные слаги Google: `gemini-2.5-flash-image`, `imagen-4.0-generate-001`
  if (s.startsWith('gemini') || s.startsWith('imagen')) return 'google'
  if (s.startsWith('gpt') || s.startsWith('4o-')) return 'openai'
  if (s.startsWith('grok')) return 'x-ai'
  if (s.startsWith('qwen')) return 'qwen'
  return 'other'
}

export function vendorLabel(id: string): string {
  const k = vendorKey(id)
  return VENDOR_LABEL[k] || k.charAt(0).toUpperCase() + k.slice(1)
}

export function modelIcon(id: string): string {
  const k = vendorKey(id)
  return `/icons/ai/${HAS_ICON.has(k) ? k : 'other'}.png`
}

/** Сгруппировать модели по вендору, сохраняя исходный порядок внутри группы. */
export function groupByVendor<T extends { id: string }>(models: T[]): [string, T[]][] {
  const g = new Map<string, T[]>()
  for (const m of models) {
    const label = vendorLabel(m.id)
    if (!g.has(label)) g.set(label, [])
    g.get(label)!.push(m)
  }
  return [...g.entries()]
}
