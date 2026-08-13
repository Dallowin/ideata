/** Stage 3: outline generation with a unique angle (port of blog_agent/stages/outline.py). */
import type { AppSettings } from '../appSettings'
import { pl } from '../lang'
import { todayLine, type LLM } from '../llm'
import type { Outline, OutlineSection, Perspective, Source } from './types'

export async function buildOutline(
  topic: string,
  sources: Source[],
  persps: Perspective[],
  llm: LLM,
  s: AppSettings,
  targetQueries?: string[],
): Promise<Outline> {
  const srcCtx = sources
    .filter(src => src.keyPoints.length)
    .map(src => `- ${src.title}: ${src.keyPoints.slice(0, 4).join('; ')}`)
    .join('\n') || pl(s.language, '(нет источников)', '(no sources)')
  const perspCtx = persps.map(p => `- ${p.name}: ${p.rationale}`).join('\n')
  let aeoCtx = ''
  if (targetQueries?.length) {
    const qlist = targetQueries.map(q => `- ${q}`).join('\n')
    aeoCtx = pl(
      s.language,
      '\nAEO-запросы, на которые статья ОБЯЗАНА дать прямой цитируемый ответ '
      + `(чтобы попадать в AI-движки):\n${qlist}\n`
      + 'Заложи под ключевые запросы отдельные секции/подзаголовки с чётким ответом.\n',
      '\nAEO queries the article MUST answer directly and quotably '
      + `(to be picked up by AI engines):\n${qlist}\n`
      + 'Dedicate separate sections/subheadings to the key queries, each with a clear answer.\n',
    )
  }

  const prompt = pl(
    s.language,
    `Тема: «${topic}».\n`
    + `Тезисы из похожих постов:\n${srcCtx}\n\n`
    + `Перспективы для охвата:\n${perspCtx}\n`
    + `${aeoCtx}\n`
    + `Построй структуру статьи на ~${s.targetWords} слов для блога ${s.brand}. `
    + 'Ключевое требование: явный УНИКАЛЬНЫЙ угол (angle) — чем мы лучше/иначе, '
    + 'чем то, что уже написано. Не generic-план.\n'
    + 'Не закладывай секции, требующие данных, которых нет в тезисах источников '
    + '(«наши замеры», «наш тест N транзакций») — выдумывать данные запрещено.\n'
    + 'Для КАЖДОЙ секции добавь:\n'
    + '- keywords: 3-6 ключевых слов/фраз (SEO/AEO — как это ищут). Каждое — объект '
    + '{word, required}: required=true, если слово ОБЯЗАНО войти в текст, false — желательно;\n'
    + '- topics: 2-4 смежные подтемы, которые секция обязана затронуть.\n'
    + 'Отдельную секцию FAQ НЕ закладывай: блок FAQ пайплайн добавляет '
    + 'автоматически в конце статьи.\n'
    + 'Верни JSON: {title, angle, audience, sections:[{heading, intent, points[], '
    + 'keywords:[{word, required}], topics[], est_words}]}. Секций 4-7.',
    `Topic: "${topic}".\n`
    + `Key points from similar posts:\n${srcCtx}\n\n`
    + `Perspectives to cover:\n${perspCtx}\n`
    + `${aeoCtx}\n`
    + `Build an article structure for ~${s.targetWords} words for the ${s.brand} blog. `
    + 'Key requirement: an explicit UNIQUE angle — how we are better/different '
    + 'from what has already been written. No generic plan.\n'
    + 'Do not plan sections that need data absent from the source key points '
    + '("our measurements", "our test of N transactions") — fabricating data is forbidden.\n'
    + 'For EACH section add:\n'
    + '- keywords: 3-6 key words/phrases (SEO/AEO — how people search for it). Each is an object '
    + '{word, required}: required=true if the word MUST appear in the text, false — nice to have;\n'
    + '- topics: 2-4 adjacent subtopics the section must touch on.\n'
    + 'Do NOT plan a separate FAQ section: the pipeline adds the FAQ block '
    + 'automatically at the end of the article.\n'
    + 'Return JSON: {title, angle, audience, sections:[{heading, intent, points[], '
    + 'keywords:[{word, required}], topics[], est_words}]}. 4-7 sections.',
  )
  const system = pl(
    s.language,
    `${s.persona}\n`
    + `Ты главред блога ${s.brand}. Тон: ${s.tone}. `
    + `Язык: ${s.language}. ${todayLine()} Ненавидишь воду и SEO-штампы. `
    + `Структуру строишь так, чтобы секции отвечали на реальные вопросы из AI-выдачи, `
    + `и закладываешь секции, где уместно показать сильные стороны ${s.brand}.`
    + (s.requirements?.trim() ? `\nОбязательные требования к статье (учти в структуре, напр. заложи FAQ и дисклеймер):\n${s.requirements.trim()}` : ''),
    `${s.persona}\n`
    + `You are the editor-in-chief of the ${s.brand} blog. Tone: ${s.tone}. `
    + `Language: ${s.language}. ${todayLine()} You hate filler and SEO clichés. `
    + `You build the structure so sections answer real questions from AI search results, `
    + `and you include sections that showcase ${s.brand}'s strengths where relevant.`
    + (s.requirements?.trim() ? `\nMandatory requirements for the article (reflect in the structure, e.g. include FAQ and disclaimer):\n${s.requirements.trim()}` : ''),
  )
  const data = await llm.json(prompt, { system, strong: true, maxTokens: 3500 })

  const strArr = (v: any) => Array.isArray(v) ? v.map(String).map(x => x.trim()).filter(Boolean) : []
  // a keyword may arrive as a string (→ required) or as an object {word, required}
  const kwArr = (v: any) => (Array.isArray(v) ? v : [])
    .map((k: any) => typeof k === 'string'
      ? { word: k.trim(), required: true }
      : { word: String(k?.word ?? '').trim(), required: k?.required !== false })
    .filter((k: any) => k.word)
  const sections: OutlineSection[] = ((data?.sections ?? []) as any[]).map(sec => ({
    heading: String(sec?.heading ?? ''),
    intent: String(sec?.intent ?? ''),
    points: strArr(sec?.points),
    keywords: kwArr(sec?.keywords),
    topics: strArr(sec?.topics),
    estWords: Number(sec?.est_words) || 200,
  }))
  return {
    title: String(data?.title ?? topic),
    angle: String(data?.angle ?? ''),
    audience: String(data?.audience ?? ''),
    sections,
  }
}
