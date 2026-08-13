/**
 * Repairing headings left untranslated in the source language. A typical model
 * miss is the FAQ block: answers get translated but the questions (<h3>) stay
 * in Russian, because the model extends the "don't translate the search query" rule to them.
 */
import { repairHeadings, untranslatedHeadings } from './translate'

const HTML = [
  '<h2>Metrics That Matter</h2><p>Plain English text.</p>',
  '<h2>FAQ</h2>',
  '<h3>Что такое AI-видимость бренда?</h3><p>An English answer.</p>',
  '<h3>Чем AI-видимость отличается от SEO?</h3><p>Another English answer.</p>',
  '<blockquote>как отслеживать упоминания бренда</blockquote>',
].join('')

const llmReturning = (text: string) => ({ complete: jest.fn(async () => text) }) as any

describe('untranslatedHeadings', () => {
  it('finds only Cyrillic headings, leaves the quote untouched', () => {
    expect(untranslatedHeadings(HTML, 'ru', 'en')).toEqual([
      'Что такое AI-видимость бренда?',
      'Чем AI-видимость отличается от SEO?',
    ])
  })

  it('stays silent on already-translated HTML', () => {
    expect(untranslatedHeadings('<h2>All English</h2><p>Body.</p>', 'ru', 'en')).toEqual([])
  })

  // Cyrillic→Cyrillic and Latin→Latin: the script-change check won't trigger,
  // there should be no false positives.
  it('does not trigger when both locales share the same script', () => {
    expect(untranslatedHeadings(HTML, 'ru', 'uk')).toEqual([])
    expect(untranslatedHeadings(HTML, 'en', 'de')).toEqual([])
  })
})

describe('repairHeadings', () => {
  const heads = ['Что такое AI-видимость бренда?', 'Чем AI-видимость отличается от SEO?']

  it('replaces headings with a line-by-line translation', async () => {
    const llm = llmReturning('1. What is brand AI visibility?\n2. How does AI visibility differ from SEO?')
    const out = await repairHeadings(llm, HTML, heads, 'английский', 'sys')
    expect(out).toContain('<h3>What is brand AI visibility?</h3>')
    expect(out).toContain('<h3>How does AI visibility differ from SEO?</h3>')
    expect(untranslatedHeadings(out, 'ru', 'en')).toEqual([])
    // the quote with the target query stays as it was
    expect(out).toContain('<blockquote>как отслеживать упоминания бренда</blockquote>')
  })

  it('does not let markup from the model response into the HTML', async () => {
    const llm = llmReturning('1. <script>alert(1)</script>Title\n2. Second')
    const out = await repairHeadings(llm, HTML, heads, 'английский', 'sys')
    expect(out).not.toContain('<script>')
    expect(out).toContain('<h3>scriptalert(1)/scriptTitle</h3>')
  })

  it('leaves the HTML untouched on a broken model response', async () => {
    const llm = llmReturning('извини, не могу')
    await expect(repairHeadings(llm, HTML, heads, 'английский', 'sys')).resolves.toBe(HTML)
  })
})
