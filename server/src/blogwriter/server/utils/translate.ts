/**
 * Generating all article locales from a single source: LLM translation of title+bodyHtml
 * into target locales, each becoming a separate run draft in the same translation group (group_id).
 * Brand names/terms and HTML structure are preserved; the 18+ disclaimer is localized.
 */
import { randomUUID } from 'node:crypto'
import pLimit from 'p-limit'
import { countWords } from '../../shared/antislop/patterns'
import { findLanguage, LANGUAGES } from '../../shared/languages'
import { resolveSettings } from './appSettings'
import { chargeRunCredits } from './credits'
import { sanitizeArticleHtml } from './htmlSanitize'
import { LLM } from './llm'
import { htmlToMarkdown } from './markdown'
import { htmlToText } from './search'
import { createLocaleRun, getRunRow, listGroup, updateRun } from './store'

const CODES = new Set(LANGUAGES.map(l => l.code))
const msgOf = (e: any) => e?.message || String(e)

/** Parse a model response in the TITLE/CATEGORY/---HTML--- format. */
function parseTranslation(out: string, fallback: { title: string, category: string, topic: string, html: string }) {
  const clean = (s: string) => s.trim().replace(/^```[a-z]*\s*/i, '').replace(/```$/i, '').trim()
  const idx = out.indexOf('---HTML---')
  if (idx < 0) return { title: fallback.title, category: fallback.category, topic: fallback.topic, bodyHtml: clean(out) || fallback.html }
  const head = out.slice(0, idx)
  const bodyHtml = clean(out.slice(idx + '---HTML---'.length)) || fallback.html
  const title = (head.match(/TITLE:\s*(.+)/i)?.[1] || fallback.title).trim()
  const category = (head.match(/CATEGORY:\s*(.+)/i)?.[1] || fallback.category).trim()
  const topic = (head.match(/TOPIC:\s*(.+)/i)?.[1] || fallback.topic).trim()
  return { title, category, topic, bodyHtml }
}

/**
 * Split off the final disclaimer (after the last <hr>) — we'll translate it separately and guarantee its return.
 * We split it off ONLY if the tail is a simple single paragraph (no lists/links/tables/headings):
 * otherwise we risk flattening the structure or mistaking a regular <hr> separator for a disclaimer — leave it in the body.
 */
function splitDisclaimer(html: string): { body: string, disclaimer: string } {
  const i = html.toLowerCase().lastIndexOf('<hr')
  if (i < 0) return { body: html, disclaimer: '' }
  const tail = html.slice(i)
  const blocks = (tail.match(/<(p|ul|ol|table|h[1-6]|blockquote|div)\b/gi) || []).length
  const rich = /<(a|ul|ol|table|h[1-6])\b/i.test(tail) // links/lists/tables/headings — don't flatten
  if (blocks !== 1 || rich) return { body: html, disclaimer: '' }
  return { body: html.slice(0, i).trim(), disclaimer: htmlToText(tail).trim() }
}

/** Cyrillic-script locales — a script change lets us catch untranslated leftovers. */
const CYRILLIC_LOCALES = new Set(['ru', 'uk', 'be', 'bg', 'sr', 'kk'])

/**
 * Headings left in the source language. We ONLY catch a script change
 * (Cyrillic → Latin): this is a signal free of false positives, unlike
 * "text looks Russian". The model extends the <blockquote> rule to FAQ
 * questions and leaves their whole block in Russian — the answers get
 * translated, but not the headings.
 */
export function untranslatedHeadings(html: string, srcLocale: string, targetLocale: string): string[] {
  if (!CYRILLIC_LOCALES.has(srcLocale) || CYRILLIC_LOCALES.has(targetLocale)) return []
  const found = [...html.matchAll(/<(h[2-6])\b[^>]*>([\s\S]*?)<\/\1>/gi)]
    .map(m => m[2])
    .filter(inner => /[а-яё]/i.test(inner))
  return [...new Set(found)]
}

/**
 * Repair headings in one short call: a "number. heading" list → line-by-line
 * translation, then swap into the HTML. If it fails, leave as-is: an untranslated
 * heading is worse than a translation, but better than losing the whole locale.
 */
export async function repairHeadings(
  llm: LLM, html: string, heads: string[], langName: string, system: string,
): Promise<string> {
  const list = heads.map((h, i) => `${i + 1}. ${htmlToText(h).trim()}`).join('\n')
  const out = await llm.complete(
    `Переведи на ${langName} каждый заголовок статьи. Верни РОВНО столько же строк в формате «номер. перевод», без пояснений и markdown:\n\n${list}`,
    { system, maxTokens: 600, temperature: 0.3 },
  )
  let fixed = html
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)[.)]\s*(.+?)\s*$/)
    if (!m) continue
    const from = heads[Number(m[1]) - 1]
    // text, not markup: strip angle brackets from the model's response before it hits the HTML
    const to = m[2].replace(/[<>]/g, '').trim()
    if (from && to) fixed = fixed.split(from).join(to)
  }
  return fixed
}

async function translateOne(llm: LLM, src: any, srcLocale: string, targetLocale: string, brand: string) {
  const langName = findLanguage(targetLocale)?.prompt || targetLocale
  const system = `Ты — профессиональный переводчик-локализатор блога бренда ${brand}. `
    + `Переводишь точно и естественно, сохраняя смысл, факты, тон и SEO/AEO-структуру.`
  // the 18+ disclaimer is translated and appended separately — the model sometimes drops it (compliance-critical)
  const { body: srcBody, disclaimer: srcDisc } = splitDisclaimer(src.body_html)

  const prompt = `Переведи статью на ${langName}.

Верни РОВНО в таком формате, без пояснений и markdown-ограждений:
TITLE: <переведённый заголовок>
CATEGORY: <переведённая рубрика>
TOPIC: <переведённая тема — короткое описание статьи>
---HTML---
<переведённое тело статьи в HTML>

Правила:
- Переведи ЦЕЛИКОМ, ничего не пропускай и не сокращай. Число секций (<h2>) и абзацев должно совпасть с оригиналом.
- Сохрани ВСЕ HTML-теги и структуру (<p>, <h2>, <ul>, <ol>, <li>, <blockquote>, <table>, <tr>, <th>, <td>, <strong>, <em>). Переводи только текст внутри тегов.
- Таблицу (<table>…</table>) сохрани ИМЕННО как HTML-таблицу с теми же <tr>/<th>/<td> — НЕ превращай в список или абзацы. Переводи только текст в ячейках.
- НЕ переводи и не меняй названия брендов (в т.ч. «${brand}»), продуктов и устоявшиеся англоязычные термины индустрии.
- ВСЕ заголовки (<h2>, <h3>), включая вопросы в блоке FAQ, переводи обязательно. Заголовок на языке оригинала внутри переведённой статьи — брак.
- Единственное исключение: поисковый запрос внутри <blockquote> — его оставь как есть, переведи только пояснение к нему. На заголовки это исключение НЕ распространяется.

Заголовок оригинала: ${src.title}
Рубрика оригинала: ${src.category || ''}
Тема оригинала: ${src.topic || ''}

HTML оригинала:
${srcBody}`

  const out = await llm.complete(prompt, { system, strong: true, maxTokens: 8000, temperature: 0.3 })
  const t = parseTranslation(out, { title: src.title, category: src.category || '', topic: src.topic || '', html: srcBody })

  // guard against a "silent fallback to source": an empty response or unchanged HTML is NOT a translation
  if (!t.bodyHtml.trim() || t.bodyHtml.trim() === srcBody.trim()) {
    throw new Error('the model did not return a translation (empty response or source HTML)')
  }

  // sanity check: not truncated and didn't lose the table
  const srcLen = htmlToText(srcBody).length
  const outLen = htmlToText(t.bodyHtml).length
  if (outLen < srcLen * 0.5) throw new Error(`translation is suspiciously short (${outLen} vs ${srcLen} chars) — likely truncated`)
  if (/<table/i.test(srcBody) && !/<table/i.test(t.bodyHtml)) throw new Error('translation lost the comparison table')

  let bodyHtml = t.bodyHtml

  // headings left in the source language (a typical miss — the FAQ block) are repaired separately
  const heads = untranslatedHeadings(bodyHtml, srcLocale, targetLocale)
  if (heads.length) {
    try {
      bodyHtml = await repairHeadings(llm, bodyHtml, heads, langName, system)
    } catch { /* didn't work out — keep the translation as-is, the locale matters more */ }
  }

  // disclaimer: a separate short translation + guaranteed append
  if (srcDisc) {
    let disc = srcDisc
    try {
      const dOut = await llm.complete(
        `Переведи на ${langName}. Верни ТОЛЬКО перевод, без кавычек и пояснений:\n\n${srcDisc}`,
        { system, maxTokens: 400, temperature: 0.3 },
      )
      disc = dOut.trim().replace(/^```[a-z]*\s*/i, '').replace(/```$/, '').replace(/^["'«]+|["'»]+$/g, '').trim() || srcDisc
    } catch { /* fallback: the original disclaimer — compliance matters more than localization */ }
    bodyHtml = `${bodyHtml}<hr><p><em>${disc}</em></p>`
  }
  return { title: t.title, category: t.category, bodyHtml }
}

export interface TranslateResult {
  groupId: string
  sourceLocale: string
  created: Array<{ locale: string, id: string }>
  skipped: string[]
  failed: Array<{ locale: string, error: string }>
}

/** Translate the source run into target locales (skipping ones that already exist in the group). */
export async function translateRun(sourceId: string, targetLocales: string[]): Promise<TranslateResult> {
  const src = await getRunRow(sourceId)
  if (!src) throw new Error('run not found')
  if (!src.title?.trim() || !src.body_html?.trim()) {
    throw new Error('Cannot translate: title and article text are required')
  }

  const s = await resolveSettings(src.brandId ?? 0)
  if (s.mock) {
    throw new Error('Translation is unavailable in mock mode: set an LLM key (OpenRouter/KIE) in settings')
  }
  const srcLocale = src.locale || findLanguage(s.language)?.code || 'ru'
  const groupId = src.group_id || src.id
  // normalize the source: pin down its locale and group
  if (!src.locale || !src.group_id) await updateRun(sourceId, { locale: srcLocale, group_id: groupId })

  const existing = new Set((await listGroup(groupId)).map(r => r.locale || srcLocale))
  existing.add(srcLocale)

  const wanted = [...new Set(targetLocales)].filter(l => CODES.has(l))
  const skipped = wanted.filter(l => existing.has(l))
  const targets = wanted.filter(l => !existing.has(l))

  const created: Array<{ locale: string, id: string }> = []
  const failed: Array<{ locale: string, error: string }> = []
  const limit = pLimit(4)
  await Promise.all(targets.map(loc => limit(async () => {
    // the locale id is known UPFRONT: it also goes into usage.runId, so the
    // translation is recorded in llm_usage as a regular generation and charged
    // to the owner (previously runId wasn't passed through, so translating an
    // article was free).
    const id = randomUUID()
    try {
      // Pass the settings as a WHOLE: enumerating fields by hand dropped kieKey/
      // openrouterKey, and without them model routing degenerates into a single
      // provider — non-kie models ended up going to kie (422), with nothing to
      // fall back on when kie flapped.
      const llm = new LLM({ ...s, usage: { ...s.usage, runId: id } })
      const t = await translateOne(llm, src, srcLocale, loc, s.brand)
      // The model returned HTML — same write path into body_html as the editor,
      // so the same sanitization applies (otherwise a translation is a hole past the sanitizer)
      const bodyHtml = sanitizeArticleHtml(t.bodyHtml)
      const wc = countWords(htmlToText(bodyHtml))
      await createLocaleRun({
        id, groupId, locale: loc, topic: src.topic, title: t.title, category: t.category,
        // build the markdown right away: .md export, dev.to and ingest all depend on it —
        // with an empty body_md the locale would ship to platforms as an empty article
        bodyHtml, bodyMd: await htmlToMarkdown(bodyHtml),
        queriesJson: src.queries_json || '[]', wordCount: wc,
        brandId: src.brandId ?? null,
      })
      created.push({ locale: loc, id })
    } catch (e) {
      failed.push({ locale: loc, error: msgOf(e) })
    } finally {
      // model calls are already paid for by us — charge for a failed locale too
      await chargeRunCredits(id)
    }
  })))

  return { groupId, sourceLocale: srcLocale, created, skipped, failed }
}
