// Экспорт данных мониторинга: CSV (везде с тарифа Старт) и Excel (.xls
// HTML-таблицей — без зависимостей, держит кириллицу и переносы строк, с Pro).
// Источник — те же строки трекера, что видит пользователь на экране.
import { i18n } from '@/i18n'
import type { Platform, PromptRow, SourceRow } from '@/data/prompts'

// Шапки выгрузки идут за языком интерфейса; названия движков приходят с бэка
// (platform.label) и не переводятся.
const T = (k: string) => i18n.global.t(`preview.export.${k}`)

function download(content: string, filename: string, mime: string) {
  const blob = new Blob(['﻿' + content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const safeName = (d: string) => (d || 'ideata').replace(/[^a-z0-9.-]/gi, '')
const today = () => new Date().toISOString().slice(0, 10)

// ── CSV ───────────────────────────────────────────────────────────────────
// Разделитель — «;»: Excel в русской локали иначе не бьёт строку на колонки.
const csvCell = (v: unknown) => {
  const s = String(v ?? '').replace(/\r?\n/g, ' ').trim()
  return /[";]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const csvDoc = (head: string[], rows: unknown[][]) =>
  [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n')

/** промпты: строка = промпт, колонки = видимость, цитаты и позиция в каждом движке */
export function exportPromptsCsv(rows: PromptRow[], platforms: Platform[], domain: string) {
  const head = [T('prompt'), T('intent'), T('region'), T('visibility'), T('citations'), ...platforms.map((p) => p.label)]
  const body = rows.map((r) => [
    r.text, r.intent, r.region, r.vis, r.citations,
    ...platforms.map((p) => {
      const pos = r.engines[p.key] ?? 0
      return pos > 0 ? `#${pos}` : '—'
    }),
  ])
  download(csvDoc(head, body), `${safeName(domain)}-prompts-${today()}.csv`, 'text/csv;charset=utf-8')
}

/** источники: строка = домен, который цитируют движки */
export function exportSourcesCsv(sources: SourceRow[], domain: string) {
  const head = [T('domain'), T('category'), T('ownSite'), T('citations'), T('share'), T('engines'), T('url')]
  const body = sources.map((s) => [
    s.host, s.category, s.own ? T('yes') : T('no'), s.citations, s.share,
    s.engines.join(', '), s.urls.map((u) => u.url).join(' | '),
  ])
  download(csvDoc(head, body), `${safeName(domain)}-sources-${today()}.csv`, 'text/csv;charset=utf-8')
}

// ── Excel (.xls) ──────────────────────────────────────────────────────────
const esc = (s: unknown) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escNl = (s: unknown) => esc(s).replace(/\n/g, '<br style="mso-data-placement:same-cell">')

/**
 * Полная выгрузка «промпт × ответ движка»: то, что не влезает в таблицу на
 * экране — сам текст ответа ИИ и все ссылки, на которые он сослался.
 */
export function exportAnswersXls(rows: PromptRow[], platforms: Platform[], domain: string) {
  const label = (key: string) => platforms.find((p) => p.key === key)?.label || key
  const head = [T('prompt'), T('intent'), T('visibility'), T('engine'), T('mentioned'), T('position'), T('aiAnswer'), T('sources')]
  let body = ''
  for (const r of rows) {
    const base = [esc(r.text), esc(r.intent), r.vis]
    const answers = r.answers || []
    if (!answers.length) {
      body += '<tr>' + [...base, '—', T('no'), '', '', ''].map((c) => `<td>${c}</td>`).join('') + '</tr>'
      continue
    }
    for (const a of answers) {
      const pos = a.brandsFound?.find((b) => b.pos != null)?.pos ?? ''
      const cites = (a.citations || [])
        .map((c) => (typeof c === 'string' ? c : c.url || c.host || ''))
        .filter(Boolean).join('\n')
      body += '<tr>' + [
        ...base, esc(label(a.platform)), a.self ? T('yes') : T('no'), pos,
        escNl(a.text || ''), escNl(cites),
      ].map((c) => `<td>${c}</td>`).join('') + '</tr>'
    }
  }
  const table = `<table border="1"><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table>`
  const doc = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head><meta charset="utf-8"><style>td{mso-number-format:"\\@";vertical-align:top}</style></head><body>${table}</body></html>`
  download(doc, `${safeName(domain)}-answers-${today()}.xls`, 'application/vnd.ms-excel')
}
