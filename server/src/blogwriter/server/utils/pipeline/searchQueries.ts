/**
 * Stage 0 (research fan-out): given a topic, generate several REALISTIC
 * search queries — the way people actually type them into Google/Yandex to find
 * existing posts on the topic from different angles (how it's done, why it's
 * better, tools, case studies, mistakes). We then search 5-10 posts per query.
 */
import type { AppSettings } from '../appSettings'
import { coerceArray, todayLine, type LLM } from '../llm'
import type { SearchQuery } from './types'

export async function generateSearchQueries(
  topic: string,
  llm: LLM,
  s: AppSettings,
  n = 5,
): Promise<SearchQuery[]> {
  const prompt
    = `Тема статьи: «${topic}».\n`
    + `Составь поисковые запросы (${n} штук), которыми реальный человек искал бы в поисковике `
    + 'материалы по этой тематике. Разные углы: '
    + 'что это и как работает, как это делают на практике, инструменты/сервисы, '
    + 'сравнения и альтернативы, типичные ошибки, кейсы.\n'
    + 'МИНИМУМ 2 запроса нацель на ПЕРВОИСТОЧНИКИ С ДАННЫМИ: статистику, исследования, '
    + 'отчёты, официальную документацию (добавляй слова «статистика», «исследование», '
    + '«данные», «отчёт», год). Факты и цифры из них — фундамент статьи.\n'
    + `${todayLine()}\n`
    + 'Запросы — живые и короткие (2-6 слов), как реально гуглят, а не вопросы к ИИ.\n'
    + 'Верни JSON-массив объектов {query, angle}, где angle — под каким углом ищем (1-3 слова).'
  const system
    = `Ты контент-ресёрчер (${s.brand}). Знаешь, как люди ищут статьи в поисковиках. Язык: ${s.language}.`

  const out: SearchQuery[] = []
  try {
    const data = await llm.json(prompt, { system, research: true, maxTokens: 1200 })
    for (const item of coerceArray(data)) {
      const query = String(item?.query ?? '').trim()
      if (!query) continue
      out.push({ query, angle: String(item?.angle ?? '').trim() })
    }
  } catch {
    // best-effort — falls back to the topic itself below
  }

  // dedup + cap; fallback — search by the topic itself
  const seen = new Set<string>()
  const uniq = out.filter((q) => {
    const k = q.query.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }).slice(0, n)
  return uniq.length ? uniq : [{ query: topic, angle: 'тема' }]
}
