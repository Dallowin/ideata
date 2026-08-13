/**
 * Article topic idea generator: given an (optional) direction, the agent proposes
 * titles with an angle, intent, keyword, and AEO queries. Uses the persona/brand
 * from settings — so ideas come out "on topic" (e.g. for Insane.gg — CS2 skins).
 * Each idea is scored by the average AEO score of its queries and sorted.
 */
import { aeoScore } from '../../../shared/aeo/scoring'
import type { AppSettings } from '../appSettings'
import { coerceArray, todayLine, type LLM } from '../llm'

export interface TopicIdea {
  title: string
  angle: string
  intent: string
  keyword: string
  queries: string[]
  score: number // average AEO score of the queries (0..10)
}

export async function generateTopics(
  seed: string,
  llm: LLM,
  s: AppSettings,
  n = 8,
): Promise<TopicIdea[]> {
  const seedLine = seed.trim()
    ? `Отталкивайся от направления: «${seed.trim()}».`
    : `Покрой разные интенты и этапы воронки в нише бренда ${s.brand}.`
  const prompt
    = `Придумай ${n} идей статей для блога ${s.brand}. ${seedLine}\n`
    + 'Каждая идея закрывает реальные запросы из AI-выдачи и полезна читателю (не реклама).\n'
    + `${todayLine()}\n`
    + 'Для каждой верни: title (заголовок статьи), angle (чем цепляет / уникальный угол — 1 строка), '
    + 'intent (informational|howto|comparison|best|definition|news), keyword (главный ключ), '
    + 'queries (2-4 AEO-запроса, на которые статья отвечает).\n'
    + 'Верни JSON-массив объектов {title, angle, intent, keyword, queries}.'
  const system
    = `${s.persona}\nТы контент-стратег блога ${s.brand}. Придумываешь темы, которые ловят `
    + `трафик из AI-выдачи и закрывают реальные вопросы аудитории. Язык: ${s.language}.`

  // We do NOT swallow model errors. There used to be an empty catch here, and any
  // failure (provider out of credits, 500, timeout) looked like "no ideas":
  // the endpoint returned {topics: [], mock: false}, and the page showed an empty
  // screen with no hint of the cause. Let it throw with the provider's message —
  // it's visible both in the UI and in the logs.
  const ideas: TopicIdea[] = []
  {
    const data = await llm.json(prompt, { system, strong: true, maxTokens: 2500 })
    for (const item of coerceArray(data)) {
      const title = String(item?.title ?? '').trim()
      if (!title) continue
      const queries = (Array.isArray(item?.queries) ? item.queries : [])
        .map(String).map((q: string) => q.trim()).filter(Boolean).slice(0, 4)
      ideas.push({
        title,
        angle: String(item?.angle ?? '').trim(),
        intent: String(item?.intent ?? 'informational'),
        keyword: String(item?.keyword ?? '').trim(),
        queries,
        score: queries.length ? Math.round((queries.reduce((a, q) => a + aeoScore(q), 0) / queries.length) * 10) / 10 : 0,
      })
    }
  }

  // dedup by title + sort by AEO fitness
  const seen = new Set<string>()
  const out = ideas.filter((i) => {
    const k = i.title.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
  out.sort((a, b) => b.score - a.score)
  return out
}
