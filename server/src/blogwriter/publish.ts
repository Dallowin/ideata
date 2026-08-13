/**
 * Publishes a run to the NATIVE Ideata blog (Prisma BlogPost) — replaces the HTTP
 * publish to the external Insane blog (blogPublish.ts + blogApi.ts). Maps run → BlogPost,
 * keeps idempotency via the back-ref run.blog_post_id, and saves the id/slug/status/locale
 * assigned by the blog back onto the run.
 *
 * BlogPost has fewer columns than a run (no category/locale/topic/author), so these
 * fields are folded into tags so nothing gets lost.
 */
import { resolveSettings } from './server/utils/appSettings'
import { bskyConfig, bskyDelete, bskyPublish, type BskyResult } from './server/utils/blueskyPublish'
import { wpConfig, wpPublish, wpUnpublish, type WpResult } from './server/utils/wordpressPublish'
import { devtoConfig, devtoPublishArticle, devtoTags, devtoUnpublish, type DevtoResult } from './server/utils/devtoPublish'
import { mastodonConfig, mastodonPublish, mastodonUnpublish, type MastodonResult } from './server/utils/mastodonPublish'
import { ghostConfig, ghostPublish, ghostUnpublish, type GhostResult } from './server/utils/ghostPublish'
import { telegraphConfig, telegraphPublish, telegraphUnpublish, type TelegraphResult } from './server/utils/telegraphPublish'
import { crosspostState } from './server/utils/crosspost'
import { ChannelPick, type ChannelKey } from './server/utils/publishChannels'
import { buildIngest, ingestDelete, ingestPost, type ExtResult } from './server/utils/extPublish'
import { sanitizeArticleHtml } from './server/utils/htmlSanitize'
import { htmlToMarkdown } from './server/utils/markdown'
import { injectToc } from './server/utils/postToc'
import { excerpt, publicSlug } from './server/utils/publicPosts'
import { blogPrisma } from './server/utils/prisma'
import { getRunRow, updateRun } from './server/utils/store'
import { tgConfig, tgDelete, tgPublishArticle, type TgResult } from './server/utils/tgPublish'

/** Read the saved channel message ids off the run (tg_msgids_json). */
function parseMsgIds(raw: string | undefined): number[] {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.filter((n) => typeof n === 'number' && n > 0) : []
  } catch { return [] }
}

export interface PublishResult {
  postId: number
  slug: string
  status: string
  locale: string
  url: string
  coverUrl: string // post cover (so the UI doesn't overwrite it with undefined after publishing)
  syncedAt: string // ISO timestamp of the sync moment (for the "Synced: …" line)
  external?: ExtResult // result of autopublishing to the external ingest API (if enabled)
  devto?: DevtoResult // result of cross-posting to dev.to
  bluesky?: BskyResult // result of the Bluesky announcement
  wordpress?: WpResult // result of publishing to the WordPress blog
  mastodon?: MastodonResult // result of the Mastodon announcement
  ghost?: GhostResult // result of publishing to the Ghost blog
  telegraph?: TelegraphResult // result of publishing to Telegra.ph
  telegram?: TgResult // result of cross-posting to the Telegram channel (if enabled)
  dzen?: { enabled: boolean; url: string } // Dzen — still a stub: a reminder to publish manually
}

/**
 * The native blog (blog_posts) is Ideata's OWN blog (ideata.io/blog), not a shared
 * platform for all workspaces. Only content from the brand whose site IS that blog
 * may be written there: every other brand has its own outlet (siteUrl + extPublish),
 * and their articles in our public blog would be someone else's content. That's exactly
 * how 26 CS2 articles from insane.gg ended up on ideata.io/blog (cleaned up manually on 2026-07-16).
 */
const NATIVE_BLOG_HOST = 'ideata.io'

function hostOf(url: string): string {
  const raw = (url || '').trim()
  if (!raw) return ''
  try {
    const u = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`)
    return u.hostname.replace(/^www\./, '').toLowerCase()
  } catch { return '' }
}

/**
 * The brand whose site matches our public blog (PUBLIC_BASE_URL, or
 * ideata.io otherwise). settings.siteUrl is either a per-brand override or the
 * brand's domain from brands (see resolveSettings); the key is strictly per-brand,
 * not inherited from the account level.
 * Empty siteUrl (no brand selected) → false: we don't write to the public blog.
 */
export function isNativeBlogBrand(settings: { siteUrl: string }): boolean {
  const self = hostOf(process.env.PUBLIC_BASE_URL || '') || NATIVE_BLOG_HOST
  const brandHost = hostOf(settings.siteUrl)
  return !!brandHost && brandHost === self
}

/**
 * run's cover_url → URL for BlogPost.coverUrl. An absolute http(s) URL is returned
 * as-is (R2/remote); a local path is converted to the served path /blogwriter/covers/<file>
 * and made absolute via PUBLIC_BASE_URL (if set), otherwise left relative.
 */
function coverUrlForPost(coverUrl: string): string | null {
  const raw = (coverUrl || '').trim()
  if (!raw) return null
  if (/^https?:\/\//.test(raw)) return raw
  // file name: last path segment without query/hash (cover_url can have ?t=<ts>)
  const file = raw.split(/[?#]/)[0].split('/').filter(Boolean).pop()
  if (!file) return null
  const served = `/blogwriter/covers/${file}`
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '')
  return base ? base + served : served
}

/**
 * Publish/update a run in the native blog.
 * status: 'published' publishes it, 'draft' (default) keeps it a draft.
 */
export async function publishRunToBlog(
  id: string,
  opts: { status?: 'draft' | 'published', locale?: string, channels?: string[] } = {},
): Promise<PublishResult> {
  const run = await getRunRow(id)
  if (!run) throw new Error('run not found')

  const title = (run.title || '').trim()
  const bodyRaw = (run.body_html || '').trim()
  if (!title || !bodyRaw) {
    throw new Error('Cannot publish: a title and article text are required')
  }

  const settings = await resolveSettings(run.brandId ?? 0)

  /**
   * A one-off channel selection. The toggle in settings remains the default value,
   * and the choice made at publish time overrides it: a technical deep-dive fits
   * dev.to but not Dzen, and vice versa.
   *
   * The key subtlety — an unchecked box does NOT mean "unpublish". It means
   * "skip this time": otherwise publishing an article only to Telegram would kick
   * it out of dev.to and Ghost, which nobody asked to touch. Unpublishing is still
   * done by the disabled toggle plus moving the article to draft.
   *
   * That's also why the selection applies ONLY at publish time. "To draft" means
   * "remove from everywhere": honoring the checkboxes there would leave copies
   * hanging on other domains after the author has retracted the article.
   */
  const pick = new ChannelPick(opts.status === 'published' ? opts.channels : undefined)
  const chan = (key: ChannelKey, enabled: boolean) => ({
    active: pick.explicit ? pick.wants(key) : enabled,
    untouched: pick.explicit && !pick.wants(key),
  })
  // Where this run can even be published: our own blog — Ideata only,
  // everyone else — only their own ingest.
  const ownBlog = isNativeBlogBrand(settings)
  if (!ownBlog && !settings.extPublishEnabled) {
    throw new Error(
      `Nowhere to publish: "${settings.brand || 'the brand'}" is not Ideata, and publishing ` +
      `to its blog isn't configured (Settings → Publish to external blog). ` +
      `Only Ideata's own content goes into the Ideata blog.`,
    )
  }
  const locale = opts.locale || run.locale || settings.language
  const status: 'draft' | 'published' = opts.status === 'published' ? 'published' : 'draft'

  // Sanitize a second time (the first pass is in the run's PATCH): the body could have
  // reached the DB bypassing the editor — via an import from an external blog, a migration,
  // a direct update — and from here it flows into the public render, which outputs it via v-html.
  const bodySafe = sanitizeArticleHtml(bodyRaw)

  // On publish: inject a table of contents; don't touch the run's body otherwise. Disclaimers
  // and other compliance text are per-brand (part of the brand voice requirements, the LLM
  // writes them into the body) — there's no longer a hardcoded "single-brand" disclaimer here.
  const bodyHtml = injectToc(bodySafe, locale)
  // Slug is fixed on the FIRST publish and never recomputed afterward. publicSlug
  // is derived from the title, and the title gets edited in the editor — republishing
  // on every edit used to produce a new address: on WordPress/Ghost/dev.to (where
  // idempotency is keyed on slug/canonical) that spawned duplicates and killed old article links.
  const slug = run.blog_slug || publicSlug(run)
  const coverUrl = coverUrlForPost(run.cover_url)
  // BlogPost doesn't store category/locale/topic/author/group — fold them into tags
  // so nothing is lost. `group:` is the run's translation group: the blog storefront
  // uses it to link language versions of the same article into an hreflang pair. Without it,
  // a translation looks to search engines like a separate, competing page.
  const tags = [
    run.category || '',
    `locale:${locale}`,
    run.group_id ? `group:${run.group_id}` : '',
    run.topic ? `topic:${run.topic}` : '',
    run.author ? `author:${run.author}` : '',
  ].filter(Boolean)
  const publishedAt = status === 'published' ? new Date() : null

  const data = {
    title,
    slug,
    body: bodyHtml,
    excerpt: excerpt(bodySafe),
    coverUrl,
    tags,
    status,
    publishedAt,
  }

  // Idempotency: if we know the post id — a targeted update, otherwise create (source:'manual').
  // IMPORTANT: run.blog_post_id is AMBIGUOUS — for imported runs it's the post id
  // on a FOREIGN receiver (extImport back-ref), not our BlogPost. A blind update on
  // it would overwrite someone else's native post with a matching id (that's how insane
  // content leaked into the public ideata blog). Only update if the post exists AND its
  // slug matches the run's blog_slug (slug is stable since our first publish);
  // otherwise it's a foreign post — create our own new one.
  // We only write to the native blog for OUR OWN brand (ownBlog); other brands' runs only
  // go to their own ingest below, and their blog_post_id stays 0 — they have no post of ours.
  let postId = 0
  if (ownBlog) {
    const owned = run.blog_post_id > 0
      ? await blogPrisma().blogPost.findUnique({ where: { id: run.blog_post_id }, select: { id: true, slug: true } })
      : null
    if (owned && run.blog_slug && owned.slug === run.blog_slug) {
      const post = await blogPrisma().blogPost.update({ where: { id: owned.id }, data })
      postId = post.id
    } else {
      const post = await blogPrisma().blogPost.create({ data: { ...data, source: 'manual' } })
      postId = post.id
    }
  }

  const syncedAt = new Date().toISOString()
  await updateRun(id, {
    blog_post_id: postId,
    blog_slug: slug,
    blog_status: status,
    blog_locale: locale,
    blog_synced_at: syncedAt,
  })

  const siteBase = (settings.siteUrl || '').replace(/\/+$/, '')
  const url = siteBase && slug ? `${siteBase}/blog/${slug}` : ''

  // Autopublish to the external ingest API (if enabled). Idempotent upsert
  // keyed on sourceId = run id. Doesn't fail native publishing: errors are returned
  // via external instead of thrown. Drafts are synced too (status is sent as-is).
  let external: ExtResult | undefined
  const cExt = chan('external', !!settings.extPublishEnabled)
  if (cExt.active) {
    external = await ingestPost(buildIngest({
      sourceId: id,
      title,
      bodyHtml,
      // for imports/translations body_md can be empty — the receiver would get an
      // article without a markdown body; convert from HTML on the fly
      bodyMd: run.body_md?.trim() || await htmlToMarkdown(bodySafe),
      slug,
      locale,
      status,
      topic: run.topic || '',
      category: run.category || '',
      author: run.author || '',
      wordCount: run.word_count || 0,
      coverImageUrl: coverUrl && /^https?:\/\//.test(coverUrl) ? coverUrl : undefined,
    }), settings)
  }

  // Telegram: we NO LONGER SEND the full article to the channel. The message limit is 4096
  // characters, while the target article length is 1200 words — that's 8-9 thousand
  // characters, i.e. two or three walls of text in a row in the channel feed. The channel
  // doesn't read that; for it there's a short post with a link (social composer, tg platform).
  //
  // The unpublish branch stays: brands that posted articles before still have messages
  // sitting in the channel, and "remove from blog" should keep clearing them as it used to.
  let telegram: TgResult | undefined
  const tg = tgConfig(settings)
  const prevTgIds = parseMsgIds(run.tg_msgids_json)
  if (prevTgIds.length && tg.token) {
    // Ones that couldn't be deleted (Telegram won't let you delete messages older than
    // 48h) stay on the run, so we don't lose their "live" ids.
    const leftover = await tgDelete(prevTgIds, run.tg_chat_id || tg.channel, tg.token)
    await updateRun(id, {
      tg_msgids_json: JSON.stringify(leftover),
      tg_chat_id: leftover.length ? (run.tg_chat_id || '') : '',
    })
    telegram = leftover.length
      ? { attempted: true, ok: false, sent: 0, error: `failed to remove ${leftover.length} message(s) from the channel (Telegram won't let you delete messages older than 48h)` }
      : { attempted: true, ok: true, sent: 0 }
  }

  // dev.to: a full article with a canonical link back to our original. Only published
  // when there's a known url — without canonical, the copy would start competing with
  // the source in search results, which is exactly what cross-posting is supposed to prevent.
  //
  // Same as with ingest/Telegram, the block isn't gated purely on "enabled": if the
  // article got unpublished or the channel got disabled, a previously published copy
  // needs to be moved to draft, otherwise it stays hanging on someone else's domain.
  let devto: DevtoResult | undefined
  const dev = devtoConfig(settings)
  const cDev = chan('devto', !!settings.devtoEnabled)
  if (cDev.active && dev.apiKey && status === 'published' && url) {
    devto = await devtoPublishArticle({
      title,
      bodyMd: run.body_md || '',
      bodyHtml: bodySafe, // fallback if the run has no markdown body (translation/import)
      canonicalUrl: url,
      tags: devtoTags(run.category, run.topic),
      coverUrl: coverUrl && /^https?:\/\//.test(coverUrl) ? coverUrl : undefined,
      published: true,
    }, settings)
  } else if (dev.apiKey && url && !cDev.untouched && (status !== 'published' || !cDev.active)) {
    devto = await devtoUnpublish(url, settings)
  } else if (cDev.active && status === 'published' && !dev.apiKey) {
    devto = { attempted: false, ok: false, error: 'dev.to API key not set' }
  } else if (cDev.active && status === 'published' && !url) {
    devto = { attempted: false, ok: false, error: 'no original URL — cannot publish without a canonical link' }
  }

  // Bluesky: an announcement with a link to the article. Idempotency — by looking up
  // our own record by link (see blueskyPublish), so republishing doesn't spawn
  // duplicates in the feed. Unpublishing the article deletes the record: the API allows it.
  let bluesky: BskyResult | undefined
  const bsky = bskyConfig(settings)
  const cBsky = chan('bluesky', !!settings.blueskyEnabled)
  if (cBsky.active && bsky.handle && bsky.appPassword && status === 'published' && url) {
    bluesky = await bskyPublish({ title, url }, settings)
  } else if (bsky.handle && bsky.appPassword && url && !cBsky.untouched && (status !== 'published' || !cBsky.active)) {
    bluesky = await bskyDelete(url, settings)
  } else if (cBsky.active && status === 'published' && !(bsky.handle && bsky.appPassword)) {
    bluesky = { attempted: false, ok: false, error: 'Bluesky handle or app password not set' }
  }

  // WordPress: a full article in the client's blog. Idempotency by slug —
  // the same trick as dev.to and Bluesky, without its own state column.
  let wordpress: WpResult | undefined
  const wp = wpConfig(settings)
  const cWp = chan('wordpress', !!settings.wpEnabled)
  if (cWp.active && wp.siteUrl && status === 'published' && slug) {
    wordpress = await wpPublish({
      title, bodyHtml: bodySafe, slug, status: 'publish',
    }, settings)
  } else if (wp.siteUrl && slug && !cWp.untouched && (status !== 'published' || !cWp.active)) {
    wordpress = await wpUnpublish(slug, settings)
  } else if (cWp.active && status === 'published' && !wp.ready) {
    wordpress = { attempted: false, ok: false, error: 'WordPress settings incomplete' }
  }

  // Mastodon: an announcement with a link. Idempotency — by looking up our own record
  // with this link in our own feed; deletion there is real, unlike Threads.
  let mastodon: MastodonResult | undefined
  const masto = mastodonConfig(settings)
  const cMasto = chan('mastodon', !!settings.mastodonEnabled)
  if (cMasto.active && masto.instance && masto.token && status === 'published' && url) {
    mastodon = await mastodonPublish({ title, url }, settings)
  } else if (masto.instance && masto.token && url && !cMasto.untouched && (status !== 'published' || !cMasto.active)) {
    mastodon = await mastodonUnpublish(url, settings)
  } else if (cMasto.active && status === 'published' && !masto.ready) {
    mastodon = { attempted: false, ok: false, error: 'Mastodon settings incomplete' }
  }

  // Ghost: a full article with a canonical link to the original. Idempotency by slug.
  let ghost: GhostResult | undefined
  const gh = ghostConfig(settings)
  const cGhost = chan('ghost', !!settings.ghostEnabled)
  if (cGhost.active && gh.siteUrl && gh.keyId && status === 'published' && slug) {
    ghost = await ghostPublish({
      title, bodyHtml: bodySafe, slug, canonicalUrl: url, status: 'published',
    }, settings)
  } else if (gh.siteUrl && gh.keyId && slug && !cGhost.untouched && (status !== 'published' || !cGhost.active)) {
    ghost = await ghostUnpublish(slug, settings)
  } else if (cGhost.active && status === 'published' && !gh.ready) {
    ghost = { attempted: false, ok: false, error: 'Ghost settings incomplete' }
  }

  // Telegraph: there's no way to look up our own page — their API doesn't return a list,
  // so path is the one thing across all channels we have to store (crosspost_json).
  let telegraph: TelegraphResult | undefined
  const tph = telegraphConfig(settings)
  const tphPath = crosspostState(run).telegraph?.path || ''
  const cTph = chan('telegraph', !!settings.telegraphEnabled)
  if (cTph.active && tph.token && status === 'published') {
    telegraph = await telegraphPublish({ title, bodyHtml: bodySafe, path: tphPath || undefined }, settings)
  } else if (tph.token && tphPath && !cTph.untouched && (status !== 'published' || !cTph.active)) {
    // Telegraph has no deletion at all: the page stays, but redirects to the original
    telegraph = await telegraphUnpublish(tphPath, url, settings)
  } else if (cTph.active && status === 'published' && !tph.token) {
    telegraph = { attempted: false, ok: false, error: 'Telegraph token not set' }
  }
  if (telegraph?.ok && telegraph.path && telegraph.path !== tphPath) {
    const all = crosspostState(run)
    all.telegraph = { path: telegraph.path, url: telegraph.url }
    await updateRun(id, { crosspost_json: JSON.stringify(all) })
  }

  // Dzen: no autopublish (by owner's decision) — just a reminder with a link
  // to the channel, so the UI can prompt to publish manually.
  const dzen = settings.dzenEnabled ? { enabled: true, url: settings.dzenChannelUrl } : undefined

  return {
    postId, slug, status, locale, url, coverUrl: coverUrl || '', syncedAt,
    external, telegram, devto, bluesky, wordpress, mastodon, ghost, telegraph, dzen,
  }
}

/** What actually got removed when unpublishing. */
export interface RemoveResult {
  /** the native Ideata post (deleted=false — there wasn't one) */
  blog: { deleted: boolean }
  /** the brand's external ingest receiver; attempted=false — autopublish is disabled */
  external: { attempted: boolean, ok: boolean, error?: string }
  /** Telegram channel messages: how many are left (can't delete ones older than 48h) */
  tg: { attempted: boolean, leftover: number, error?: string }
  /** false — back-refs (blog_slug/blog_post_id) were kept: the copy is still live */
  cleared: boolean
}

/**
 * Remove a run's post from the native blog and clear its publish state on the run.
 *
 * External deletion errors are NO LONGER SWALLOWED: previously ingestDelete would fail
 * silently while the back-refs got cleared anyway — the copy stayed hanging on the brand's
 * live site with no way left to remove it (we'd forgotten the post's address). Now on
 * failure blog_slug/blog_post_id/blog_status stay on the run, and the report goes to the UI.
 */
export async function removeRunFromBlog(id: string): Promise<RemoveResult> {
  const run = await getRunRow(id)
  if (!run) throw new Error('run not found')

  // deleteMany tolerates an already-deleted post (doesn't throw if the row is missing).
  // Guarded by slug — same as publishRunToBlog: for imported runs blog_post_id points
  // to a post on a FOREIGN receiver, so a blind delete would wipe out our native post
  // with a matching id.
  let blogDeleted = false
  if (run.blog_post_id > 0 && run.blog_slug) {
    const res = await blogPrisma().blogPost.deleteMany({ where: { id: run.blog_post_id, slug: run.blog_slug } })
    blogDeleted = res.count > 0
  }

  // Also remove from the external blog (keyed on sourceId = run id), if autopublish is enabled.
  const settings = await resolveSettings(run.brandId ?? 0)

  const external: RemoveResult['external'] = { attempted: false, ok: true }
  if (settings.extPublishEnabled) {
    external.attempted = true
    try {
      const r = await ingestDelete(id, settings)
      // attempted=false — the receiver isn't configured: there was nothing to publish
      // there, so there's nothing to remove either (don't block clearing the back-refs).
      external.attempted = !!r?.attempted
      external.ok = !r?.attempted || !!r.ok
      if (!external.ok) external.error = r?.error || 'the receiver did not confirm deletion'
    } catch (e: any) {
      external.ok = false
      external.error = e?.message || 'network error while deleting on the receiver'
    }
  }

  // Remove messages from the Telegram channel (if any were posted). We fetch the token
  // even if the toggle is already off — previously sent messages still need deleting.
  // Ones that can't be deleted (Telegram won't allow >48h) are kept on the run so we
  // don't orphan the "live" ids.
  const prevIds = parseMsgIds(run.tg_msgids_json)
  const tgToken = (settings.tgBotToken || '').trim()
  const tg: RemoveResult['tg'] = { attempted: false, leftover: 0 }
  let tgLeftover: number[] = []
  if (prevIds.length && tgToken) {
    tg.attempted = true
    try { tgLeftover = await tgDelete(prevIds, run.tg_chat_id || tgConfig(settings).channel, tgToken) }
    catch (e: any) {
      tgLeftover = prevIds /* network call failed — treat all as undeleted, don't lose the ids */
      tg.error = e?.message || 'failed to remove channel messages'
    }
    tg.leftover = tgLeftover.length
  }

  // Failed to remove the external copy → keep the back-refs: they're the only way
  // to retry removing the article later.
  const cleared = external.ok
  await updateRun(id, {
    ...(cleared
      ? { blog_post_id: 0, blog_slug: '', blog_status: '', blog_locale: '' }
      : {}),
    blog_synced_at: new Date().toISOString(),
    tg_msgids_json: JSON.stringify(tgLeftover),
    tg_chat_id: tgLeftover.length ? (run.tg_chat_id || '') : '',
  })

  return { blog: { deleted: blogDeleted }, external, tg, cleared }
}
