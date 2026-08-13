/**
 * Article announcement for Threads: a short thread without calling the LLM.
 *
 * Why not repackage with the model: platform adaptation in the content factory
 * costs LLM calls and the user's credits. Charging for that on EVERY article
 * publish would be wrong — the person clicked "publish", not "make it pretty
 * for me". Full adaptation remains a separate action on the crossposting
 * screen; here it's just the title and link, cut to the platform's limit.
 */

/** Threads' technical limit is 500; we leave headroom for the link and line breaks. */
const LIMIT = 480

export function threadsAnnounce(title: string, url: string): string[] {
  const head = String(title || '').trim()
  const link = String(url || '').trim()
  if (!head && !link) return []

  // The title fits whole together with the link — one post, no artificial thread.
  const single = link ? `${head}\n\n${link}` : head
  if ([...single].length <= LIMIT) return [single]

  // Didn't fit — trim the title, move the link to a second post: the URL must not be cut.
  const room = LIMIT - 1
  const cut = [...head].slice(0, room).join('').trimEnd() + '…'
  return link ? [cut, link] : [cut]
}
