/**
 * Deterministic antislop linter (no LLM, no network).
 * A direct port of blog-agent/blog_agent/antislop/patterns.py.
 *
 * Catches persistent LLM clichés with regexes, computes a score. Cheap, fast, and
 * reproducible — works both as a pipeline GATE on the server and as a live linter
 * in the editor (the same code via shared/).
 *
 * Score = sum of severity over hits, with repeat hits of the same rule decayed.
 *
 * JS nuance: \b in JS doesn't work for Cyrillic (the word class is ASCII-only),
 * so word boundaries are done via lookarounds on \p{L}\p{N}_.
 */

export interface Rule {
  id: string
  re: RegExp
  severity: number
  hint: string
}

export interface Hit {
  rule: string
  severity: number
  snippet: string
  hint: string
  index: number
  length: number
}

export interface SlopReport {
  score: number
  findings: Hit[]
  clean: boolean
}

// unicode word boundaries instead of \b
const B = '(?<![\\p{L}\\p{N}_])'
const E = '(?![\\p{L}\\p{N}_])'
const W = '[\\p{L}\\p{N}_]' // equivalent of \w with re.UNICODE

const rx = (p: string) => new RegExp(B + p + E, 'giu')

// --- Russian "AI-writing" clichés -------------------------------------------- //
const RU_PHRASES: Array<[string, string]> = [
  ['в (современном|сегодняшнем) (мире|цифровом мире)', 'клише-зачин «в современном мире»'],
  [`в (быстро )?меняющ(ем|ей)ся (мире|среде|ландшафте)`, 'клише «в меняющемся мире»'],
  ['в заключени[еи]', 'штамп-концовка «в заключение»'],
  ['погруз(имся|итесь|ится) в', '«погрузимся в» (delve)'],
  ['давайте (разберёмся|погрузимся|окунёмся)', 'приторный зачин «давайте …»'],
  ['не секрет,? что', 'пустой зачин «не секрет, что»'],
  ['как известно', 'пустое «как известно»'],
  [`играет (важн|ключев|значим)${W}* роль`, 'штамп «играет важную роль»'],
  ['является неотъемлемой частью', 'штамп «неотъемлемая часть»'],
  ['открывает (новые )?(горизонты|возможности|двери)', 'штамп «открывает горизонты»'],
  ['мир (возможностей|инноваций)', 'штамп «мир возможностей»'],
  [`революци(я|онн${W}+)`, 'затасканное «революция/революционный»'],
  ['меняет правила игры', 'калька «game-changer»'],
  ['на (сегодняшний день|современном этапе)', 'вода «на сегодняшний день»'],
  ['стоит отметить,? что', 'филлер «стоит отметить»'],
  ['важно (понимать|отметить|помнить),? что', 'филлер «важно понимать»'],
  ['таким образом,', 'механическое «таким образом»'],
  [`богат(ый|ая|ое) (палитр|гобелен|мозаик)${W}*`, '«богатая палитра/гобелен» (tapestry)'],
  [`это (не просто ${W}+, это|больше чем)`, 'негативный параллелизм «это не просто…»'],
  ['незаменим(ый|ая|ое) (инструмент|помощник)', 'рекламное «незаменимый инструмент»'],
  [`бесшовн${W}+`, 'маркетинговое «бесшовный» (seamless)'],
  [`экосистем${W}+ (решений|продуктов)`, 'жаргон «экосистема решений»'],
  ['раскры(ть|вает) (весь )?потенциал', 'штамп «раскрыть потенциал»'],
]

// --- English clichés ------------------------------------------------------ //
const EN_PHRASES: Array<[string, string]> = [
  [`in today's (world|digital age|fast-paced world)`, 'cliché opener «in today\'s world»'],
  ['in conclusion', 'штамп «in conclusion»'],
  [`it'?s (not just|more than) ${W}+, it'?s`, 'negative parallelism «not just X, it\'s Y»'],
  ['a testament to', '«a testament to»'],
  ['(rich )?tapestry', '«tapestry»'],
  ['delve into', '«delve into»'],
  ['navigat(e|ing) the (landscape|complexities|world)', '«navigate the landscape»'],
  ['game[- ]changer', '«game-changer»'],
  ['unlock (the|your) (full )?potential', '«unlock potential»'],
  ['at the end of the day', 'филлер «at the end of the day»'],
  ['when it comes to', 'филлер «when it comes to»'],
  ['seamless(ly)?', '«seamless»'],
  ['ever[- ]evolving', '«ever-evolving»'],
  ['moreover', 'механическое «moreover»'],
  ['furthermore', 'механическое «furthermore»'],
]

// --- Sycophancy / evaluative padding ---------------------------------------- //
const SYCOPHANCY: Array<[string, string]> = [
  [`(отличн${W}+|прекрасн${W}+|замечательн${W}+) вопрос`, 'сикофантия «отличный вопрос»'],
  ['без сомнени[йя]', 'накрутка уверенности «без сомнения»'],
  ['на самом деле', 'филлер «на самом деле»'],
  ['по-настоящему', 'усилитель-вода «по-настоящему»'],
]

export const PHRASE_RULES: Rule[] = [
  ...[...RU_PHRASES, ...EN_PHRASES].map(([p, hint]) => ({
    id: `phrase:${hint}`, re: rx(p), severity: 2.0, hint,
  })),
  ...SYCOPHANCY.map(([p, hint]) => ({
    id: `sycophancy:${hint}`, re: rx(p), severity: 1.5, hint,
  })),
]

const WORD_RE = new RegExp(`${W}+`, 'gu')

function context(text: string, start: number, end: number, width = 30): string {
  return text
    .slice(Math.max(0, start - width), Math.min(text.length, end + width))
    .replace(/\n/g, ' ')
    .trim()
}

/** Return all hits. Score is computed separately (see score()). */
export function scan(text: string): Hit[] {
  const hits: Hit[] = []

  // 1) Phrase clichés
  for (const rule of PHRASE_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags)
    let m: RegExpExecArray | null
    while ((m = re.exec(text))) {
      hits.push({
        rule: rule.id,
        severity: rule.severity,
        snippet: context(text, m.index, m.index + m[0].length),
        hint: rule.hint,
        index: m.index,
        length: m[0].length,
      })
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }

  // 2) Em-dash "—" density (LLMs overuse the em-dash). The threshold is set low and severity
  // grows with the dash count — so real overuse actually clears slopThreshold instead of getting lost
  // (the normalizer in shared/antislop/normalize already strips this deterministically
  // earlier; the linter here is an honest metric and a backstop).
  const dashes = (text.match(/—/g) || []).length
  const words = Math.max(1, (text.match(WORD_RE) || []).length)
  if (dashes >= 3 && dashes / words > 0.008) {
    hits.push({
      rule: 'em_dash_overuse', severity: Math.min(6, 2.0 + dashes * 0.3),
      snippet: `${dashes} тире на ${words} слов`,
      hint: 'перебор с тире «—», часть заменить на точку/запятую',
      index: -1, length: 0,
    })
  }

  // 3) "Rule of three" — triple enumerations (X, Y and Z) too often
  const triples = text.match(new RegExp(`${B}${W}+,\\s+${W}+\\s+и\\s+${W}+${E}`, 'gu')) || []
  if (triples.length >= 3) {
    hits.push({
      rule: 'rule_of_three', severity: 1.5,
      snippet: `${triples.length} тройных перечислений`,
      hint: 'разбавь ритм, не всё сводить к триадам',
      index: -1, length: 0,
    })
  }

  // 4) Exclamation marks — marketing tone
  const bangs = (text.match(/!/g) || []).length
  if (bangs >= 3) {
    hits.push({
      rule: 'exclamation_spam', severity: 1.0,
      snippet: `${bangs} восклицаний`,
      hint: 'убери восклицательные знаки, тон спокойнее',
      index: -1, length: 0,
    })
  }

  // 5) Intensifier adverbs in bunches (a rough heuristic for Russian)
  const adverbs = text.match(new RegExp(`${B}${W}{4,}(?:тельно|значно|мерно|нечно)${E}`, 'gu')) || []
  if (adverbs.length >= 5) {
    hits.push({
      rule: 'adverb_overuse', severity: 1.0,
      snippet: `${adverbs.length} наречий-усилителей`,
      hint: 'сократи наречия, глаголы сами тянут смысл',
      index: -1, length: 0,
    })
  }

  return hits
}

/** Score with decay on repeats: the n-th hit of the same rule weighs /n. */
export function score(hits: Hit[]): number {
  const counts: Record<string, number> = {}
  let total = 0
  for (const h of hits) {
    counts[h.rule] = (counts[h.rule] || 0) + 1
    total += h.severity / counts[h.rule]
  }
  return Math.round(total * 100) / 100
}

/** Deterministic slop assessment: score + findings in one object. */
export function lint(text: string): SlopReport {
  const hits = scan(text)
  const s = score(hits)
  return { score: s, findings: hits, clean: s === 0 }
}

export function slopSummary(report: SlopReport): string {
  if (report.clean) return 'чисто (0)'
  const top = [...new Set(report.findings.map(f => f.rule))].sort().join(', ')
  return `score=${report.score.toFixed(1)}: ${top}`
}

/** Word count (unicode, like re.findall(r"\w+") in Python). */
export function countWords(text: string): number {
  return (text.match(WORD_RE) || []).length
}
