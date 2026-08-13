/**
 * Stage 4: generate text section by section with memory and anti-slop rules
 * in the system prompt (port of blog_agent/stages/draft.py). Sections are
 * written sequentially — each one builds on the "memory" of the previous ones.
 *
 * E-E-A-T is the core: facts from sources go into the text WITH LINKS (markdown),
 * "experience" comes only from real brandFacts, the lead with a direct answer
 * goes at the start, and an FAQ for target AEO queries goes at the end.
 */
import { normalizeDashes } from '../../../shared/antislop/normalize'
import type { AppSettings } from '../appSettings'
import { todayLine, type LLM } from '../llm'
import { pl } from '../lang'
import type { Draft, Outline, OutlineSection, Source } from './types'

export const WRITING_RULES
  = 'ПРАВИЛА ПИСЬМА (жёстко):\n'
  + '- ФАКТЫ: используй ТОЛЬКО цифры и данные из фактов/тезисов источников ниже. '
  + 'ЗАПРЕЩЕНО выдумывать статистику, проценты, «результаты тестов», замеры, '
  + 'размеры, время загрузки, кейсы с числами. Нет данных — пиши про механику '
  + 'и логику без псевдоконкретики, это честнее и сильнее.\n'
  + '- Без зачинов «в современном мире», «не секрет, что», «давайте погрузимся».\n'
  + '- Без концовок «в заключение», «таким образом».\n'
  + '- ТИРЕ «—» — СВОДИ К МИНИМУМУ. Не ставь тире ради паузы, «драматизма» или '
  + 'вставки-пояснения. Максимум одно тире на абзац и только где без него никак: '
  + 'связка «X — это Y», прямая речь, диапазон «5–10». Парную вставку « — … — » '
  + 'заменяй запятыми или скобками; тире-паузу — запятой, двоеточием или новым '
  + 'предложением. По умолчанию — обычная пунктуация (запятая, точка, двоеточие).\n'
  + '- Без восклицаний и триад «X, Y и Z» пачками.\n'
  + '- Никакой рекламной накрутки («революционный», «незаменимый», «бесшовный»).\n'
  + '- Конкретика вместо оценок: примеры и механика, а не «важно понимать».\n'
  + '- Короткие абзацы. Активный залог. Пиши как эксперт коллеге, не как SEO-бот.'

/**
 * Bilingual wrapper around WRITING_RULES for use inside draftSystem. WRITING_RULES
 * itself stays untouched (byte-for-byte) because crosspost.ts imports it directly.
 */
function writingRules(lang: string): string {
  return pl(
    lang,
    WRITING_RULES,
    'WRITING RULES (strict):\n'
    + '- FACTS: use ONLY the numbers and data from the source facts/key points below. '
    + 'It is FORBIDDEN to invent statistics, percentages, "test results," measurements, '
    + 'dimensions, load times, or case studies with numbers. No data — write about mechanics '
    + 'and logic without pseudo-specificity, that is more honest and stronger.\n'
    + '- No openers like "in today\'s world," "it\'s no secret that," "let\'s dive in."\n'
    + '- No closers like "in conclusion," "thus."\n'
    + '- MINIMIZE the em dash "—". Do not use a dash for a pause, "drama," or a parenthetical '
    + 'insert. At most one dash per paragraph, and only where nothing else will do: the '
    + '"X is Y" construction, direct speech, a range like "5–10." Replace a paired insert '
    + '" — … — " with commas or parentheses; replace a pause dash with a comma, a colon, or a '
    + 'new sentence. Default to ordinary punctuation (comma, period, colon).\n'
    + '- No exclamation marks and no "X, Y, and Z" triads piled up.\n'
    + '- No promotional hype ("revolutionary," "indispensable," "seamless").\n'
    + '- Specifics instead of judgments: examples and mechanics, not "it\'s important to understand."\n'
    + '- Short paragraphs. Active voice. Write like an expert talking to a colleague, not like an SEO bot.',
  )
}

/** GEO block: how to write so AI engines cite and recommend the brand. */
export function geoRules(brand: string, lang: string): string {
  return pl(
    lang,
    'GEO/AEO (попадание в AI-выдачу):\n'
    + '- Первый абзац каждой секции — прямой, самодостаточный ответ на вопрос секции '
    + '(именно такие абзацы цитируют ChatGPT/Perplexity/AI Overviews).\n'
    + '- Чёткие определения, нумерованные шаги, списки; сущности и названия — явно.\n'
    + `- Продвигай ${brand}: где уместно по смыслу — уверенно рекомендуй продукт и показывай `
    + 'его сильные стороны через конкретную пользу и сравнения. Не выдумывай функции и цифры; '
    + 'преимущество без доказательства не пишем.',
    'GEO/AEO (landing in AI answers):\n'
    + '- The first paragraph of every section is a direct, self-contained answer to the '
    + 'section\'s question (these are exactly the paragraphs ChatGPT/Perplexity/AI Overviews cite).\n'
    + '- Clear definitions, numbered steps, lists; name entities and terms explicitly.\n'
    + `- Promote ${brand}: wherever it fits naturally, confidently recommend the product and `
    + 'show its strengths through concrete benefits and comparisons. Do not invent features or '
    + 'numbers; never state an advantage without backing it up.',
  )
}

/**
 * E-E-A-T block of the system prompt: experience/expertise/authoritativeness/trust.
 * "Experience" is allowed ONLY from brandFacts — otherwise it's fabrication that breaks trust.
 */
export function eeatRules(s: AppSettings): string {
  const hasBrandFacts = (s.brandFacts ?? '').trim().length > 0
  const exp = pl(
    s.language,
    hasBrandFacts
      ? 'ОПЫТ (Experience): реальные факты о бренде и продукте — ниже в блоке «ФАКТЫ БРЕНДА». '
      + 'Используй их от первого лица («мы в …», «по данным наших …») там, где уместно. '
      + 'Любой другой «наш опыт» выдумывать ЗАПРЕЩЕНО.'
      : 'ОПЫТ (Experience): фактов бренда не задано, поэтому НИКАКОГО «нашего опыта», «наших '
      + 'замеров» и «мы тестировали» — опыт показывай через разбор реальных кейсов из источников.',
    hasBrandFacts
      ? 'EXPERIENCE: real facts about the brand and product are in the "BRAND FACTS" block '
      + 'below. Use them in the first person ("we at …", "according to our …") where it fits. '
      + 'Inventing any other "our experience" is FORBIDDEN.'
      : 'EXPERIENCE: no brand facts are set, so NO "our experience," "our measurements," or '
      + '"we tested" — show experience by analyzing real case studies from the sources.',
  )
  return pl(
    s.language,
    'E-E-A-T (ядро каждой статьи):\n'
    + `- ${exp}\n`
    + '- ЭКСПЕРТНОСТЬ: точные термины с определениями при первом упоминании; механика по шагам; '
    + 'у каждого совета — границы применимости («когда это не сработает»).\n'
    + '- АВТОРИТЕТНОСТЬ: каждый значимый факт/цифра из источника — с markdown-ссылкой на него: '
    + '«[по данным Название](URL)». Ссылки давай ТОЛЬКО на URL из списка источников ниже, '
    + 'выдумывать URL запрещено. 1-2 ссылки на секцию достаточно, не превращай текст в каталог.\n'
    + '- ДОВЕРИЕ: честно называй ограничения, риски и когда решение не подходит; '
    + 'не обещай результатов, которых источники не подтверждают.',
    'E-E-A-T (core of every article):\n'
    + `- ${exp}\n`
    + '- EXPERTISE: precise terms with definitions on first mention; step-by-step mechanics; '
    + 'every piece of advice states its boundaries of applicability ("when this won\'t work").\n'
    + '- AUTHORITATIVENESS: every significant fact/number from a source gets a markdown link to '
    + 'it: "[according to Name](URL)". Link ONLY to URLs from the source list below, inventing '
    + 'URLs is forbidden. 1-2 links per section is enough, don\'t turn the text into a directory.\n'
    + '- TRUST: honestly state limitations, risks, and when the solution doesn\'t fit; don\'t '
    + 'promise results the sources don\'t confirm.',
  )
}

/**
 * "Delivery and uniqueness" block: how to write specifically for THIS brand so the
 * text reads as its own, not as a generic "for everyone" article. Empty → no effect.
 */
export function deliveryRules(s: AppSettings): string {
  const d = (s.delivery ?? '').trim()
  if (!d) return ''
  return pl(
    s.language,
    '\nПОДАЧА И УНИКАЛЬНОСТЬ (пиши строго в этом ключе, чтобы статья была максимально своя под этот бренд):\n'
    + `${d}\n`
    + 'Не пересказывай общеизвестное обобщённо и не копируй шаблонную структуру «как у всех» — '
    + 'заходи с позиций и опыта именно этого бренда. Уникальность строй на фактах бренда и '
    + 'конкретике, а НЕ на выдуманных деталях.',
    '\nDELIVERY AND UNIQUENESS (write strictly in this key so the article reads as maximally '
    + 'specific to this brand):\n'
    + `${d}\n`
    + 'Don\'t retell common knowledge in generic terms and don\'t copy a cookie-cutter "like '
    + 'everyone else" structure — write from this specific brand\'s stance and experience. Build '
    + 'uniqueness on brand facts and specifics, NOT on invented details.',
  )
}

/** Author system prompt (shared by full drafts and single-excerpt regeneration). */
function draftSystem(s: AppSettings): string {
  const reqBlock = s.requirements?.trim()
    ? pl(
      s.language,
      `\nОБЯЗАТЕЛЬНЫЕ ТРЕБОВАНИЯ (соблюдать всегда):\n${s.requirements.trim()}`,
      `\nMANDATORY REQUIREMENTS (always follow):\n${s.requirements.trim()}`,
    )
    : ''
  const brandFacts = (s.brandFacts ?? '').trim()
  const brandFactsBlock = brandFacts
    ? pl(
      s.language,
      `\nФАКТЫ БРЕНДА (единственный источник «нашего опыта», не выдумывай другие):\n${brandFacts}`,
      `\nBRAND FACTS (the only source of "our experience", don't invent others):\n${brandFacts}`,
    )
    : ''
  return pl(
    s.language,
    `${s.persona}\nТы автор блога ${s.brand}. Тон: ${s.tone}. Язык: ${s.language}. ${todayLine()}`,
    `${s.persona}\nYou are the author of the ${s.brand} blog. Tone: ${s.tone}. Language: ${s.language}. ${todayLine()}`,
  )
    + `\n${eeatRules(s)}\n${geoRules(s.brand, s.language)}\n${writingRules(s.language)}${deliveryRules(s)}${reqBlock}${brandFactsBlock}`
}

/**
 * Write the text of ONE section (markdown with a '## Heading'). Used both by
 * the full draft (section by section) and by targeted excerpt regeneration from
 * the editor. `written` — sections already written, for "memory" (avoid repeats);
 * for targeted regeneration this holds the rest of the article's sections.
 */
export async function writeSection(
  outline: Pick<Outline, 'title' | 'angle' | 'audience'>,
  sec: OutlineSection,
  sources: Source[],
  llm: LLM,
  s: AppSettings,
  written: string[] = [],
  directive = '', // negative prompt/extra requirements from the editor (excerpt regeneration)
): Promise<string> {
  const dir = String(directive || '').trim()
  const lang = s.language
  const prompt
    = pl(lang, `Статья: «${outline.title}». Уникальный угол: ${outline.angle}.\n`, `Article: "${outline.title}". Unique angle: ${outline.angle}.\n`)
    + pl(lang, `Аудитория: ${outline.audience}.\n\n`, `Audience: ${outline.audience}.\n\n`)
    // extra requirements from the editor take top priority, placed at the top of the prompt
    + (dir
      ? pl(
        lang,
        `ОСОБЫЕ ТРЕБОВАНИЯ (высший приоритет, соблюдай СТРОГО, они важнее правил ниже):\n${dir}\n\n`,
        `SPECIAL REQUIREMENTS (highest priority, follow STRICTLY, they outrank the rules below):\n${dir}\n\n`,
      )
      : '')
    + pl(lang, `Пиши ТОЛЬКО секцию «${sec.heading}» (~${sec.estWords} слов).\n`, `Write ONLY the section "${sec.heading}" (~${sec.estWords} words).\n`)
    + pl(lang, `Задача секции: ${sec.intent}\n`, `Section goal: ${sec.intent}\n`)
    + pl(
      lang,
      `Обязательно раскрой пункты: ${(sec.points || []).join(', ') || '—'}\n`,
      `Make sure to cover these points: ${(sec.points || []).join(', ') || '—'}\n`,
    )
    + kwLine(sec.keywords, lang)
    + (sec.topics?.length
      ? pl(lang, `Затронь смежные подтемы: ${sec.topics.join(', ')}\n`, `Touch on these related subtopics: ${sec.topics.join(', ')}\n`)
      : '')
    + pl(
      lang,
      `\nИСТОЧНИКИ (факты и тезисы с URL):\n${sourcesContext(sources, lang)}\n\n`,
      `\nSOURCES (facts and key points with URLs):\n${sourcesContext(sources, lang)}\n\n`,
    )
    + pl(
      lang,
      'Если у источников есть факты, релевантные секции, — вставь минимум один '
      + 'с markdown-ссылкой на источник ([название](url)). Ссылки только на URL из списка.',
      'If the sources have facts relevant to this section, include at least one with a '
      + 'markdown link to the source ([name](url)). Links only to URLs from the list.',
    )
    + (dir
      ? pl(
        lang,
        ' Но если это противоречит ОСОБЫМ ТРЕБОВАНИЯМ выше — следуй требованиям (можно без ссылок/источников).',
        ' But if this conflicts with the SPECIAL REQUIREMENTS above — follow the requirements (no links/sources needed).',
      )
      : '')
    + '\n\n'
    + pl(lang, `Уже написано ранее (не повторяйся):\n${shortMemory(written, lang)}\n\n`, `Already written earlier (don't repeat yourself):\n${shortMemory(written, lang)}\n\n`)
    + pl(
      lang,
      `Верни markdown: подзаголовок '## ${sec.heading}' и текст. Без преамбул.`,
      `Return markdown: the subheading '## ${sec.heading}' and the text. No preambles.`,
    )
  // Cyrillic tokenizes heavily (~3-4 tokens/word) + markdown/links: the old
  // estWords*3 budget cut sections off mid-word. x6 with a 1200 floor gives headroom,
  // and the auto-retry in LLM.complete() additionally catches ceiling truncation.
  let text = (await llm.complete(prompt, {
    system: draftSystem(s), strong: true,
    maxTokens: Math.max(1200, (sec.estWords || 200) * 6),
    temperature: 0.75,
  })).trim()
  if (!text.trimStart().startsWith('#')) text = `## ${sec.heading}\n\n${text}`
  text = normalizeDashes(text) // deterministically trim excess dashes right away
  return text
}

/**
 * Draft checkpoint: `resumeBodyMd` — body_md from a previous (failed) attempt;
 * COMPLETED sections are reused from it (matched by "## heading" from the outline);
 * `save` is called after each written section — progress survives a
 * crash/restart, so a phase retry doesn't pay for already-written content again.
 */
export interface DraftCheckpoint {
  resumeBodyMd?: string
  save?: (bodyMd: string) => Promise<void>
}

const normHeading = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase()

/** checkpoint body_md → map of "normalized H2 → section markdown block". */
export function checkpointSections(md: string): Map<string, string> {
  const map = new Map<string, string>()
  if (!md?.trim()) return map
  for (const part of md.split(/(?=^## )/m)) {
    const m = part.match(/^##\s+(.+?)\s*$/m)
    if (!m) continue // lead without a heading — cheap, don't reuse
    if (FAQ_HEADING_RE.test(part.slice(0, 40))) continue // regenerate FAQ (Haiku, pennies)
    map.set(normHeading(m[1]), part.trim())
  }
  return map
}

export async function writeDraft(
  outline: Outline,
  sources: Source[],
  llm: LLM,
  s: AppSettings,
  onSection?: (heading: string, index: number, total: number) => void,
  targetQueries: string[] = [],
  checkpoint?: DraftCheckpoint,
): Promise<Draft> {
  const written: string[] = []
  const bodyParts: string[] = []
  const prewritten = checkpointSections(checkpoint?.resumeBodyMd ?? '')

  for (const [i, sec] of outline.sections.entries()) {
    onSection?.(sec.heading, i, outline.sections.length)
    const cached = prewritten.get(normHeading(sec.heading))
    if (cached) { // section already written by a previous attempt — don't pay twice
      bodyParts.push(cached)
      written.push(cached)
      continue
    }
    const text = await writeSection(outline, sec, sources, llm, s, written)
    bodyParts.push(text)
    written.push(text)
    try {
      await checkpoint?.save?.(bodyParts.join('\n\n'))
    } catch { /* checkpoint isn't critical — don't fail generation over it */ }
  }

  // Lead with a direct answer goes at the very top (AI engines cite it, and it's also the preview)
  const lead = await writeLead(outline, bodyParts.join('\n\n'), llm, draftSystem(s), s.language)
  if (lead) bodyParts.unshift(lead)

  // FAQ for target AEO queries goes at the end (FAQPage structure). If the model
  // already wrote an FAQ inside the sections (brand requirements often ask for this),
  // don't add a second block — otherwise the article ends up with two FAQs in a row.
  if (!hasFaqBlock(bodyParts.join('\n\n'))) {
    const faq = await writeFaq(outline, targetQueries, sources, llm, draftSystem(s), s.language)
    if (faq) bodyParts.push(faq)
  }

  return { outline, bodyMd: bodyParts.join('\n\n'), rewrites: 0 }
}

/** FAQ block heading — shared detection for the draft and the E-E-A-T gate. */
export const FAQ_HEADING_RE = /^##+\s*(FAQ|ЧаВо|Частые вопросы)/im

export function hasFaqBlock(md: string): boolean {
  return FAQ_HEADING_RE.test(md)
}

/**
 * Lead paragraph: a self-contained direct answer to the topic's main question
 * (2-4 sentences + up to 3 "key points" bullets). Sits BEFORE the first H2 —
 * AI engines cite such blocks, and the showcase pulls its preview from it.
 */
async function writeLead(outline: Outline, bodyMd: string, llm: LLM, system: string, lang: string): Promise<string> {
  const prompt = pl(
    lang,
    `Статья: «${outline.title}». Угол: ${outline.angle}. Аудитория: ${outline.audience}.\n\n`
    + `Текст статьи:\n${bodyMd.slice(0, 5000)}\n\n`
    + 'Напиши ЛИД статьи: прямой самодостаточный ответ на главный вопрос темы, '
    + '2-4 коротких предложения БЕЗ подводок и клише, затем 2-3 буллета с главными '
    + 'выводами статьи (каждый — конкретное утверждение, не тизер). '
    + 'Не выдумывай цифры, которых нет в тексте. Без заголовка. Верни только markdown.',
    `Article: "${outline.title}". Angle: ${outline.angle}. Audience: ${outline.audience}.\n\n`
    + `Article text:\n${bodyMd.slice(0, 5000)}\n\n`
    + 'Write the article LEAD: a direct, self-contained answer to the topic\'s main question, '
    + '2-4 short sentences with NO preamble or clichés, followed by 2-3 bullets with the '
    + 'article\'s main takeaways (each one a concrete statement, not a teaser). '
    + 'Don\'t invent numbers that aren\'t in the text. No heading. Return markdown only.',
  )
  try {
    const lead = (await llm.complete(prompt, { system, strong: true, maxTokens: 500, temperature: 0.5 })).trim()
    return lead ? normalizeDashes(lead) : ''
  } catch {
    return '' // best-effort: an article without a lead beats a failed run
  }
}

/** FAQ: 3-5 short, direct Q&As for target AEO queries (FAQPage structure). */
async function writeFaq(
  outline: Outline,
  targetQueries: string[],
  sources: Source[],
  llm: LLM,
  system: string,
  lang: string,
): Promise<string> {
  const kw = outline.sections.flatMap(sec => sec.keywords.filter(k => k.required).map(k => k.word)).slice(0, 6)
  const qs = targetQueries.slice(0, 5)
  const prompt
    = pl(lang, `Статья: «${outline.title}» (угол: ${outline.angle}).\n`, `Article: "${outline.title}" (angle: ${outline.angle}).\n`)
    + (qs.length
      ? pl(
        lang,
        `Целевые запросы к AI-движкам (главные кандидаты в вопросы):\n${qs.map(q => `- ${q}`).join('\n')}\n`,
        `Target queries for AI engines (top candidates for questions):\n${qs.map(q => `- ${q}`).join('\n')}\n`,
      )
      : '')
    + (kw.length
      ? pl(lang, `Ключевые слова статьи: ${kw.join(', ')}\n`, `Article keywords: ${kw.join(', ')}\n`)
      : '')
    + pl(
      lang,
      `Факты из источников (для ответов, со ссылками где уместно):\n${sourcesContext(sources, lang)}\n\n`,
      `Facts from sources (for answers, with links where relevant):\n${sourcesContext(sources, lang)}\n\n`,
    )
    + pl(
      lang,
      'Составь блок FAQ: 3-5 вопросов, которые реальные люди задают по теме '
      + '(включи целевые запросы, если они есть), с КОРОТКИМИ прямыми ответами '
      + '(1-3 предложения, первый ответ сразу по существу). Не выдумывай цифры.\n',
      'Write an FAQ block: 3-5 questions real people ask about the topic '
      + '(include the target queries if given), with SHORT direct answers '
      + '(1-3 sentences, the first sentence gets straight to the point). Don\'t invent numbers.\n',
    )
    + pl(
      lang,
      `Верни markdown строго в формате:\n## FAQ\n\n### Вопрос?\nОтвет.\n\n### Вопрос?\nОтвет.`,
      `Return markdown strictly in this format:\n## FAQ\n\n### Question?\nAnswer.\n\n### Question?\nAnswer.`,
    )
  try {
    // FAQ is templated Q&A over ready-made queries and facts: a fast model (Haiku)
    // handles it fine, Sonnet was an ~x5 overpay here. Budget 1400: the old 900
    // exactly hit the ceiling (truncated last answer).
    const faq = (await llm.complete(prompt, { system, maxTokens: 1400, temperature: 0.5 })).trim()
    if (!faq) return ''
    const md = normalizeDashes(faq)
    return md.startsWith('##') ? md : `## FAQ\n\n${md}`
  } catch {
    return '' // best-effort
  }
}

/** Keyword line: required (req) and optional (opt) keywords listed separately. */
function kwLine(keywords: { word: string, required: boolean }[], lang: string): string {
  if (!keywords?.length) return ''
  const req = keywords.filter(k => k.required).map(k => k.word)
  const opt = keywords.filter(k => !k.required).map(k => k.word)
  let line = ''
  if (req.length) {
    line += pl(
      lang,
      `Обязательно естественно впиши ключевые слова (без переспама): ${req.join(', ')}\n`,
      `Make sure to naturally weave in these keywords (without stuffing): ${req.join(', ')}\n`,
    )
  }
  if (opt.length) line += pl(lang, `По возможности используй: ${opt.join(', ')}\n`, `Where possible, use: ${opt.join(', ')}\n`)
  return line
}

/**
 * Sources context for prompts: URL is mandatory (otherwise the model physically
 * can't cite it), facts with numbers go on a separate line, metadata
 * (publication, date, authority) helps the model choose whom to cite.
 */
export function sourcesContext(sources: Source[], lang?: string): string {
  const lines: string[] = []
  sources.forEach((s, i) => {
    const pts = s.keyPoints.slice(0, 4).join('; ')
    const facts = (s.facts ?? []).slice(0, 4).map(f => f.claim).join('; ')
    if (!pts && !facts) return
    const authority = s.authority != null ? pl(lang, `авторитетность ${s.authority}/10`, `authority ${s.authority}/10`) : ''
    const meta = [s.siteName, s.publishedAt, authority].filter(Boolean).join(', ')
    lines.push(`[${i + 1}] ${s.title} — ${s.url}${meta ? ` (${meta})` : ''}`)
    if (facts) lines.push(pl(lang, `    факты: ${facts}`, `    facts: ${facts}`))
    if (pts) lines.push(pl(lang, `    тезисы: ${pts}`, `    key points: ${pts}`))
  })
  return lines.join('\n') || pl(lang, '(источников нет)', '(no sources)')
}

/**
 * Memory of what's been written: headings of all sections + first paragraphs of
 * the last two. Previously only '## …' lines were sent — "don't repeat" didn't work.
 */
function shortMemory(written: string[], lang: string): string {
  if (!written.length) return pl(lang, '(ничего)', '(none)')
  const headings = written.map(t => t.split('\n', 1)[0]).join('\n')
  const recent = written.slice(-2).map((t) => {
    const paras = t.split(/\n{2,}/)
    return paras.slice(0, 2).join('\n').slice(0, 500)
  }).join('\n---\n')
  return pl(
    lang,
    `Заголовки секций:\n${headings}\n\nПоследние секции (начало):\n${recent}`,
    `Section headings:\n${headings}\n\nRecent sections (beginning):\n${recent}`,
  )
}
