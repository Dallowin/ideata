/**
 * AEO keyword generator (port of blog_agent/aeo/keywords.py): the LLM generates
 * queries by intent bucket, each deterministically scored and sorted.
 */
import { aeoScore } from '../../../../shared/aeo/scoring'
import type { AppSettings } from '../../appSettings'
import { pl } from '../../lang'
import { coerceArray, todayLine, type LLM } from '../../llm'
import type { Keyword } from '../types'

export const INTENTS = ['informational', 'comparison', 'howto', 'best', 'alternatives', 'definition']

export async function generateKeywords(
  topic: string,
  llm: LLM,
  s: AppSettings,
  perIntent = 4,
): Promise<Keyword[]> {
  const prompt
    = `${pl(s.language, `Тема: «${topic}».`, `Topic: "${topic}".`)}\n`
    + pl(s.language,
      'Сгенерируй запросы, которые реальные люди задают AI-ассистентам '
      + '(ChatGPT, Perplexity, Google AI Overviews) по этой теме — так, чтобы '
      + 'движок дал развёрнутый ответ и процитировал источники.\n',
      'Generate queries that real people ask AI assistants '
      + '(ChatGPT, Perplexity, Google AI Overviews) about this topic — the kind that '
      + 'make the engine give a detailed answer and cite sources.\n',
    )
    + `${pl(s.language, `По ${perIntent} запроса на каждый интент: ${INTENTS.join(', ')}.`, `${perIntent} queries per intent: ${INTENTS.join(', ')}.`)}\n`
    + pl(s.language,
      'Запросы — естественные, разговорные, длиннохвостые (не head-термины).\n',
      'Queries should be natural, conversational, long-tail (not head terms).\n',
    )
    + `${todayLine()}\n`
    + pl(s.language,
      'Верни JSON-массив объектов {query, intent, cluster}, '
      + 'где cluster — короткая тема-группа.',
      'Return a JSON array of objects {query, intent, cluster}, '
      + 'where cluster is a short topic group.',
    )
  const system
    = pl(s.language,
      `Ты AEO-стратег (${s.brand}). Понимаешь, на какие запросы AI-движки `
      + `дают цитируемые ответы. Язык: ${s.language}.`,
      `You are an AEO strategist (${s.brand}). You understand which queries get `
      + `AI engines to give cited answers. Language: ${s.language}.`,
    )

  const keywords: Keyword[] = []
  try {
    const data = await llm.json(prompt, { system, maxTokens: 3000 })
    for (const item of coerceArray(data)) {
      const q = String(item?.query ?? '').trim()
      if (!q) continue
      keywords.push({
        query: q,
        intent: String(item?.intent ?? 'informational'),
        cluster: String(item?.cluster ?? ''),
        aeoScore: 0,
        rationale: '',
      })
    }
  } catch {
    // best-effort: return an empty list
  }

  // Deterministic scoring + dedup + sort by AEO fitness.
  const seen = new Set<string>()
  const scored: Keyword[] = []
  for (const kw of keywords) {
    const key = kw.query.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kw.aeoScore = aeoScore(kw.query)
    kw.rationale = explain(kw)
    scored.push(kw)
  }
  scored.sort((a, b) => b.aeoScore - a.aeoScore)
  return scored
}

function explain(kw: Keyword): string {
  if (kw.aeoScore >= 8) return 'сильный AEO-запрос: вопросная форма + конкретика'
  if (kw.aeoScore >= 5) return 'рабочий длиннохвостый запрос'
  return 'слабый для AEO (близок к head-термину) — использовать осторожно'
}

/** Pick the top n queries above the AEO-score threshold. */
export function topKeywords(keywords: Keyword[], n: number, minScore = 5.0): Keyword[] {
  return keywords.filter(k => k.aeoScore >= minScore).slice(0, n)
}
