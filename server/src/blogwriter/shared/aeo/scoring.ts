/**
 * Deterministic "AEO fitness" score for a query (0..10).
 * A direct port of blog-agent/blog_agent/aeo/scoring.py.
 *
 * AI engines (ChatGPT, Perplexity, AI Overviews) more often answer in depth and
 * cite sources for SPECIFIC, question-form, long-tail queries, rather than
 * bare 1-2 word "head" terms. A network/LLM-free heuristic — reproducible.
 */

const QUESTION_STARTS = [
  'как', 'что', 'почему', 'зачем', 'какой', 'какая', 'какие', 'когда', 'где', 'чем',
  'сколько', 'стоит ли', 'нужно ли', 'можно ли',
  'how', 'what', 'why', 'when', 'which', 'who', 'is', 'are', 'does', 'should', 'can',
]

const COMPARISON = [' vs ', ' или ', ' против ', ' сравнени', ' разница', ' alternative', ' альтернатив']

const MODIFIERS = [
  'лучш', 'топ', 'best', 'top', 'пошагов', 'гайд', 'guide', 'пример', 'чеклист',
  'ошибк', 'как выбрать', 'how to', 'для чего', 'стоимость', 'цена', 'сравнение',
]

const WORD_RE = /[\p{L}\p{N}_]+/gu

export function aeoScore(query: string): number {
  const q = query.trim().toLowerCase()
  if (!q) return 0
  const n = (q.match(WORD_RE) || []).length
  let score = 0

  // 1) Question form — the main signal (AI engines like questions).
  if (q.endsWith('?') || QUESTION_STARTS.some(s => q.startsWith(s))) score += 4.0

  // 2) Long-tail: 4-12 words — the sweet spot. Penalize head terms (1-2 words).
  if (n <= 2) score += 0.5
  else if (n >= 3 && n <= 12) score += 3.0
  else score += 1.5

  // 3) Comparison/choice — a very "answerable" intent.
  const padded = ` ${q} `
  if (COMPARISON.some(c => padded.includes(c))) score += 1.5

  // 4) Specificity modifier.
  if (MODIFIERS.some(m => q.includes(m))) score += 1.5

  return Math.round(Math.min(10, score) * 10) / 10
}

/** True for "bare" short terms that AEO barely works for. */
export function isHeadTerm(query: string): boolean {
  return (query.match(WORD_RE) || []).length <= 2 && !query.trim().endsWith('?')
}
