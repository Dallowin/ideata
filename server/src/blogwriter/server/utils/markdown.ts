/**
 * Article body HTML → markdown. One shared helper: markdown is needed for
 * export (.md), dev.to (body_markdown) and the ingest receiver, whereas the
 * conversion used to live only in the run's PATCH — for translations and
 * imports body_md stayed empty, and an empty article shipped out.
 */

/**
 * Turndown is loaded lazily (heavy and not needed on every request). By default
 * it silently swallows figure/iframe/video/audio — keep leaves them as raw HTML,
 * and the public renderer runs markdown through marked, which passes raw HTML through.
 * A conversion failure must not break publishing — so we return an empty string then.
 */
export async function htmlToMarkdown(html: string): Promise<string> {
  const src = (html || '').trim()
  if (!src) return ''
  try {
    const { default: Turndown } = await import('turndown')
    return new Turndown({ headingStyle: 'atx', bulletListMarker: '-' })
      .keep(['figure', 'iframe', 'video', 'audio'])
      .turndown(src)
  } catch {
    return ''
  }
}
