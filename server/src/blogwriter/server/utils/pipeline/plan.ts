/**
 * Content-plan generator: the LLM comes up with a coherent set of article ideas
 * for the persona/brand (like generateTopics, but with a category and intent
 * variety across the whole plan), while date slots are assigned deterministically —
 * planSlots distributes the period across weekdays based on the perWeek frequency.
 * The LLM never picks dates: the distribution is stable and predictable.
 */
import { aeoScore } from '../../../shared/aeo/scoring'
import type { AppSettings } from '../appSettings'
import { pl } from '../lang'
import { coerceArray, todayLine, type LLM } from '../llm'

export interface PlanIdea {
  title: string
  angle: string
  intent: string
  keyword: string
  queries: string[]
  category: string
  score: number // average AEO score of the queries (0..10)
}

// Publication weekdays by frequency (Mon=0): 3/week → Mon-Wed-Fri, 2/week → Tue-Thu…
const WEEKDAY_PATTERNS: Record<number, number[]> = {
  1: [2],
  2: [1, 3],
  3: [0, 2, 4],
  4: [0, 1, 3, 4],
  5: [0, 1, 2, 3, 4],
  6: [0, 1, 2, 3, 4, 5],
  7: [0, 1, 2, 3, 4, 5, 6],
}

/** 'YYYY-MM-DD' → UTC Date (midnight). Invalid string → null. */
export function parseDay(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  // discard rollovers like 2026-02-31 → March
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? d : null
}

const fmtDay = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`

/**
 * Publication dates for the period [from..to] (inclusive) at frequency perWeek.
 * Everything is in UTC midnights — DST/timezones don't affect it. Invalid period → [].
 */
export function planSlots(from: string, to: string, perWeek = 3): string[] {
  const start = parseDay(from)
  const end = parseDay(to)
  if (!start || !end || start > end) return []
  const pattern = new Set(WEEKDAY_PATTERNS[Math.min(Math.max(Math.round(perWeek) || 3, 1), 7)])
  const out: string[] = []
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    const d = new Date(t)
    if (pattern.has((d.getUTCDay() + 6) % 7)) out.push(fmtDay(d)) // JS: Sun=0 → Mon=0
  }
  return out
}

export async function generatePlanIdeas(
  seed: string,
  count: number,
  llm: LLM,
  s: AppSettings,
  avoid: string[] = [],
): Promise<PlanIdea[]> {
  const n = Math.min(Math.max(Math.round(count) || 1, 1), 31)
  const seedLine = seed.trim()
    ? pl(s.language, `Отталкивайся от направления: «${seed.trim()}».`, `Build on this direction: "${seed.trim()}".`)
    : pl(
      s.language,
      `Покрой нишу бренда ${s.brand} целиком: от «что такое» до сравнений и продвинутых how-to.`,
      `Cover the ${s.brand} niche completely: from "what is it" to comparisons and advanced how-tos.`,
    )
  const categories = String(s.categories || '').split(',').map(c => c.trim()).filter(Boolean)
  const catLine = categories.length
    ? pl(
      s.language,
      `Рубрики блога: ${categories.join(', ')}. Каждой идее проставь category из этого списка.\n`,
      `Blog categories: ${categories.join(', ')}. Assign a category to each idea from this list.\n`,
    )
    : pl(s.language, 'Поле category оставь пустой строкой.\n', 'Leave the category field as an empty string.\n')
  const avoidLine = avoid.length
    ? pl(
      s.language,
      `Эти темы уже есть в плане — не повторяй и не перефразируй их:\n${avoid.slice(0, 60).map(t => `- ${t}`).join('\n')}\n`,
      `These topics are already in the plan — don't repeat or rephrase them:\n${avoid.slice(0, 60).map(t => `- ${t}`).join('\n')}\n`,
    )
    : ''
  const prompt = pl(
    s.language,
    `Составь контент-план блога ${s.brand}: придумай ровно ${n} идей статей. ${seedLine}\n`
    + 'Идеи идут в порядке публикации: чередуй интенты и сложность (лёгкое ↔ глубокое), '
    + 'не ставь две почти одинаковые темы подряд, вместе они должны закрывать нишу без дыр.\n'
    + 'Каждая статья закрывает реальные запросы из AI-выдачи и полезна читателю (не реклама).\n'
    + `${todayLine()}\n`
    + catLine + avoidLine
    + 'Для каждой верни: title (заголовок статьи), angle (чем цепляет / уникальный угол — 1 строка), '
    + 'intent (informational|howto|comparison|best|definition|news), keyword (главный ключ), '
    + 'queries (2-4 AEO-запроса, на которые статья отвечает), category (рубрика).\n'
    + 'Верни JSON-массив объектов {title, angle, intent, keyword, queries, category}.',
    `Put together a content plan for the ${s.brand} blog: come up with exactly ${n} article ideas. ${seedLine}\n`
    + 'Ideas go in publication order: alternate intents and depth (light ↔ deep), '
    + 'don\'t put two near-identical topics back to back, together they must cover the niche with no gaps.\n'
    + 'Each article answers real queries from AI search results and is useful to the reader (not an ad).\n'
    + `${todayLine()}\n`
    + catLine + avoidLine
    + 'For each, return: title (article headline), angle (the hook / unique angle — 1 line), '
    + 'intent (informational|howto|comparison|best|definition|news), keyword (main keyword), '
    + 'queries (2-4 AEO queries the article answers), category (category).\n'
    + 'Return a JSON array of objects {title, angle, intent, keyword, queries, category}.',
  )
  const system = pl(
    s.language,
    `${s.persona}\nТы контент-стратег блога ${s.brand}. Составляешь редакционный план, который `
    + `ловит трафик из AI-выдачи и ведёт читателя по воронке. Язык: ${s.language}.`,
    `${s.persona}\nYou are the content strategist for the ${s.brand} blog. You put together an editorial plan that `
    + `captures traffic from AI search results and guides the reader through the funnel. Language: ${s.language}.`,
  )

  const ideas: PlanIdea[] = []
  // We do NOT swallow model errors (as in topics.ts): an empty catch used to turn
  // a failed provider call into a silent "generated 0" with no explanation — the
  // controller catches the exception and surfaces the reason to the user.
  const data = await llm.json(prompt, { system, strong: true, maxTokens: Math.min(500 + n * 180, 6000) })
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
      category: categories.length ? String(item?.category ?? '').trim() : '',
      score: queries.length ? Math.round((queries.reduce((a, q) => a + aeoScore(q), 0) / queries.length) * 10) / 10 : 0,
    })
  }

  // dedup by title (including against topics already taken in the plan)
  const seen = new Set(avoid.map(t => t.toLowerCase().trim()))
  return ideas.filter((i) => {
    const k = i.title.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  }).slice(0, n)
}
