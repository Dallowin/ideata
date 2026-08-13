/**
 * Stage 6: fact-check / polish (port of blog_agent/stages/factcheck.py).
 * Returns a list of flagged notes — doesn't block publication, just flags risks.
 * Checks against facts (claim + verbatim quote) and source text fragments,
 * not just the paraphrased key points.
 */
import type { AppSettings } from '../appSettings'
import { pl } from '../lang'
import { coerceArray, type LLM } from '../llm'
import type { Source } from './types'

/** Source context for verification: facts with quotes + the start of the text. */
function sourceCtx(s: Source, i: number, lang: string): string {
  const lines = [`[${i + 1}] ${s.title} — ${s.url}`]
  for (const f of (s.facts ?? []).slice(0, 6)) {
    lines.push(`    ${pl(lang, 'факт', 'fact')}: ${f.claim}${f.quote ? ` (${pl(lang, 'цитата', 'quote')}: «${f.quote}»)` : ''}`)
  }
  if (s.keyPoints.length) lines.push(`    ${pl(lang, 'тезисы', 'key points')}: ${s.keyPoints.slice(0, 4).join('; ')}`)
  if (s.text) lines.push(`    ${pl(lang, 'текст (фрагмент)', 'text (excerpt)')}: ${s.text.slice(0, 1200)}`)
  return lines.join('\n')
}

export async function factcheck(
  bodyMd: string,
  sources: Source[],
  llm: LLM,
  s: AppSettings,
): Promise<string[]> {
  if (llm.isMock) return []
  const srcCtx = sources.filter(src => src.fetched).map((src, i) => sourceCtx(src, i, s.language)).join('\n') || pl(s.language, '(нет)', '(none)')
  const prompt
    = pl(s.language,
      'Проверь черновик статьи против источников. Найди:\n'
      + '(1) цифры и утверждения, которых НЕТ в фактах/тексте источников ниже;\n'
      + '(2) искажения: цифра есть в источнике, но в статье она изменена или вырвана из контекста;\n'
      + '(3) ссылки на источник рядом с утверждением, которого в этом источнике нет;\n'
      + '(4) внутренние противоречия; (5) обещания цифр без цифр.\n'
      + 'Каждая заметка: где в статье (короткая цитата) + в чём проблема + какой источник смотреть.\n'
      + 'Верни JSON-массив коротких заметок-претензий (пустой массив, если всё ок).\n\n',
      'Check the article draft against the sources. Find:\n'
      + '(1) numbers and claims that are NOT in the facts/text of the sources below;\n'
      + '(2) distortions: the number exists in the source, but in the article it is changed or taken out of context;\n'
      + '(3) references to a source next to a claim that is not actually in that source;\n'
      + '(4) internal contradictions; (5) promises of numbers without numbers.\n'
      + 'Each note: where in the article (a short quote) + what the problem is + which source to check.\n'
      + 'Return a JSON array of short complaint notes (an empty array if everything is fine).\n\n',
    )
    + `${pl(s.language, 'ИСТОЧНИКИ', 'SOURCES')}:\n${srcCtx}\n\n${pl(s.language, 'СТАТЬЯ', 'ARTICLE')}:\n${bodyMd.slice(0, 12000)}`
  try {
    const data = await llm.json(prompt, {
      system: pl(s.language,
        'Ты дотошный фактчекер. Претензию всегда привязываешь к месту в статье и к источнику. Не придираешься к стилю — только факты.',
        'You are a meticulous fact-checker. You always tie a complaint to a specific place in the article and a source. You do not nitpick style — facts only.',
      ),
      maxTokens: 2000,
    })
    return coerceArray(data).map(toNote).filter(Boolean).slice(0, 15)
  } catch {
    // fact-check is best-effort
  }
  return []
}

/** The model may return strings or objects {claim, issue, …} — normalize to a readable string. */
function toNote(x: unknown): string {
  if (typeof x === 'string') return x
  if (x && typeof x === 'object') {
    const vals = Object.values(x).filter(v => typeof v === 'string' && v.trim())
    return vals.length ? vals.join(' — ') : JSON.stringify(x)
  }
  return String(x ?? '')
}
