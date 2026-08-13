/**
 * Stage 5: anti-slop gate (port of blog_agent/stages/antislop_gate.py).
 * 1) a deterministic linter (shared/antislop) computes a cliche score;
 * 2) if score > threshold — the LLM rewrites the problem spots based on specific
 *    findings, then we lint again. Loop up to N times, keep the best result.
 */
import { lint, type SlopReport } from '../../../shared/antislop/patterns'
import { normalizeDashes } from '../../../shared/antislop/normalize'
import type { AppSettings } from '../appSettings'
import type { LLM } from '../llm'
import type { Draft } from './types'

export async function applyGate(draft: Draft, llm: LLM, s: AppSettings): Promise<Draft> {
  // Deterministically trim excess dashes BEFORE the linter — we don't rely on the LLM,
  // which produced them in the first place (asking it to remove them is pointless).
  let text = normalizeDashes(draft.bodyMd)
  let report = lint(text)
  let bestText = text
  let bestReport = report
  let rewrites = 0

  while (bestReport.score > s.slopThreshold && rewrites < s.slopMaxRewrites) {
    // run the LLM's rewrite through the normalizer again: rewrites love dashes
    text = normalizeDashes(await rewrite(bestText, bestReport, llm, s))
    report = lint(text)
    rewrites++
    if (report.score < bestReport.score) {
      bestText = text
      bestReport = report
    } else {
      break // rewriting didn't help — don't spin idly
    }
  }

  draft.bodyMd = bestText
  draft.slop = bestReport
  draft.rewrites = rewrites
  return draft
}

async function rewrite(text: string, report: SlopReport, llm: LLM, s: AppSettings): Promise<string> {
  const problems = report.findings
    .slice(0, 20)
    .map(f => `- [${f.rule}] «…${f.snippet}…» → ${f.hint}`)
    .join('\n')
  const prompt
    = 'Ниже текст статьи и список конкретных проблем-штампов, найденных линтером.\n'
    + 'Перепиши текст, УБРАВ эти штампы, сохранив смысл, факты и структуру '
    + '(заголовки \'## \' не трогай). Не добавляй новых клише. Верни только markdown.\n\n'
    + `ПРОБЛЕМЫ:\n${problems}\n\n`
    + `ТЕКСТ:\n${text}`
  const system
    = `${s.persona}\n`
    + `Ты строгий литредактор блога ${s.brand}. Убиваешь ИИ-штампы, `
    + `оставляешь живой конкретный текст. Рекомендации и плюсы ${s.brand} сохраняй — `
    + `переформулируй доказательно, а не вычёркивай. `
    + `НЕ удаляй обязательные блоки: дисклеймеры, предупреждения, FAQ. `
    + `Язык: ${s.language}.`
  const out = await llm.complete(prompt, {
    system, strong: true,
    maxTokens: Math.floor(text.length / 2) + 1500,
    temperature: 0.4,
  })
  return out.trim() || text
}
