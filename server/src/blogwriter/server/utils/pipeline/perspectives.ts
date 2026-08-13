/** Stage 2: perspectives, STORM-style (port of blog_agent/stages/perspectives.py). */
import type { AppSettings } from '../appSettings'
import { coerceArray, type LLM } from '../llm'
import type { Perspective, Source } from './types'

export async function perspectives(
  topic: string,
  sources: Source[],
  llm: LLM,
  s: AppSettings,
): Promise<Perspective[]> {
  const ctx = sources
    .filter(src => src.keyPoints.length)
    .map(src => `- ${src.title}: ${src.keyPoints.slice(0, 3).join('; ')}`)
    .join('\n') || '(источников нет — опирайся на здравый смысл по теме)'

  const prompt
    = `Тема: «${topic}».\n`
    + `Что уже пишут по теме:\n${ctx}\n\n`
    + `Предложи ${s.maxPerspectives} РАЗНЫХ перспектив (углов зрения), `
    + 'с которых стоит раскрыть тему, чтобы статья была глубже конкурентов. '
    + 'Для каждой: name, rationale (зачем этот угол), questions (2-3 вопроса, '
    + 'на которые надо ответить с этого угла).\n'
    + 'Формат: массив объектов {name, rationale, questions}.'
  try {
    const data = await llm.json(prompt, { system: 'Ты стратег контента. Мыслишь разными аудиториями.' })
    const out: Perspective[] = []
    for (const item of coerceArray(data).slice(0, s.maxPerspectives)) {
      out.push({
        name: String(item?.name ?? ''),
        rationale: String(item?.rationale ?? ''),
        questions: Array.isArray(item?.questions) ? item.questions.map(String) : [],
      })
    }
    if (out.length) return out
  } catch {
    // fallback below
  }
  return [{ name: 'Практик', rationale: 'как применить', questions: ['Что делать?'] }]
}
