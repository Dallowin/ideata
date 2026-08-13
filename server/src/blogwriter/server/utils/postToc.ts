/**
 * Article table of contents (post navigation) — generated AT PUBLISH TIME from the clean bodyHtml.
 * Assigns ids to headings (H2/H3), builds a <nav class="post-toc"> with anchor links,
 * and inserts it before the first section. Idempotent: the run's source body is not modified.
 */
import * as cheerio from 'cheerio'
import { slugify } from './publicPosts'

/** Table-of-contents block heading, per locale. */
const TOC_LABEL: Record<string, string> = {
  ru: 'Содержание', en: 'Contents', de: 'Inhalt', es: 'Contenido',
  pt: 'Conteúdo', tr: 'İçindekiler', pl: 'Spis treści',
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * Insert a table of contents into the HTML. Returns the original html unchanged if there are < 2 sections.
 * @param locale — for localizing the "Contents" label.
 */
export function injectToc(html: string, locale = 'ru'): string {
  if (!html?.trim()) return html
  const $ = cheerio.load(html, null, false)
  const heads = $('h2, h3')
  if (heads.length < 2) return html // one section — no table of contents needed

  const used = new Set<string>()
  const items: Array<{ id: string, text: string, sub: boolean }> = []
  heads.each((_, el) => {
    const $el = $(el)
    const text = $el.text().trim()
    if (!text) return
    // stable unique id from the heading text (Cyrillic gets transliterated)
    let id = slugify(text) || 'section'
    const base = id
    let n = 2
    while (used.has(id)) id = `${base}-${n++}`
    used.add(id)
    $el.attr('id', id)
    items.push({ id, text, sub: (el as any).tagName?.toLowerCase() === 'h3' })
  })
  if (items.length < 2) return html

  const label = TOC_LABEL[locale] || TOC_LABEL.en
  const lis = items
    .map(it => `<li${it.sub ? ' class="post-toc-sub"' : ''}><a href="#${it.id}">${esc(it.text)}</a></li>`)
    .join('')
  const toc = `<nav class="post-toc"><p><strong>${label}</strong></p><ul>${lis}</ul></nav>`

  const firstH2 = $('h2').first()
  if (firstH2.length) firstH2.before(toc)
  else $.root().prepend(toc)

  return $.html()
}
