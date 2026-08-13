/**
 * Import posts from an external receiver (a brand's ingest API) into the Ideata blog writer.
 * We pull GET {base}/blog/ingest (list with bodies, including drafts) and create
 * each post as a draft BlogRun. This is the reverse direction of auto-publish.
 *
 * Idempotency:
 *   run id = post.sourceId  (post originated from Ideata — round-trip to its own run)
 *          | ins_<post.id>  (created directly on the receiver — stable pseudo-id)
 * A repeat import updates the same run, no duplicates pile up. Back-ref
 * blog_post_id = id of the post on the receiver → a subsequent publish from the blog writer
 * will update THAT SAME post rather than creating a new one.
 *
 * We don't touch runs in an active pipeline phase — to avoid clobbering unfinished work.
 */
import { resolveSettings } from './server/utils/appSettings'
import { extConfig, ingestListRemote, isSelfHost, type ExtRemotePost } from './server/utils/extPublish'
import { sanitizeArticleHtml } from './server/utils/htmlSanitize'
import { blogPrisma } from './server/utils/prisma'
import { getRunRow } from './server/utils/store'

const INFLIGHT = new Set(['running', 'awaiting_sources', 'awaiting_outline'])
const PAGE_LIMIT = 50 // receiver's max

// allowSelf: importing from Ideata ITSELF (self-host base → native BlogPost) reads
// THE WHOLE platform blog, including drafts — admin-only (controller).
export interface ImportOpts { status?: string; locale?: string; category?: string; max?: number; allowSelf?: boolean }

export interface ImportSummary {
  ok: boolean
  total: number // total posts on the receiver (by filter)
  fetched: number // how many were actually read
  imported: number // new runs created
  updated: number // existing runs updated (including localEdited — only metadata was updated there)
  skipped: number // skipped (in-flight pipeline)
  localEdited: number // body kept: edited locally after the last sync
  groups: number // how many distinct articles (translation groups) were touched
  error?: string
}

/**
 * Fields considered a run's CONTENT. When there's a local edit newer than the last
 * sync, import leaves them alone: otherwise a repeat import (incl. a background one)
 * would silently roll back the author's work to whatever's on the receiver.
 */
const CONTENT_KEYS = ['topic', 'title', 'body_md', 'body_html', 'category', 'author', 'cover_url', 'word_count'] as const

/**
 * Whether there's a local edit newer than the last sync. Both timestamps are ISO strings
 * from the same source (new Date().toISOString()), so they're comparable lexicographically.
 * An empty blog_synced_at (a run that was never synced) is NOT considered an edit:
 * this is the first import, and there's no content yet to override.
 */
function locallyEdited(existing: { updated_at: string, blog_synced_at: string }): boolean {
  const synced = (existing.blog_synced_at || '').trim()
  return !!synced && (existing.updated_at || '') > synced
}

/**
 * Stable run id for a receiver post. The pseudo-id is namespaced by brand:
 * p.id is a local auto-increment of a SPECIFIC receiver, so without a namespace posts
 * from different receivers of different brands would collide on the same run (`ins_1`
 * of brand X would get overwritten by an import from brand Y). The legacy format `ins_<id>` (without
 * a brand) remains for old imports — they're detached by the migration and don't match.
 */
function runIdFor(p: ExtRemotePost, brandId: number): string {
  const src = (p.sourceId || '').trim()
  return src || (brandId ? `ins_${brandId}_${p.id}` : `ins_${p.id}`)
}

/**
 * Translation group key. Locales of a single article in the blog writer are created with a new
 * id, but a shared group_id and IDENTICAL topic (topic isn't translated, whereas category
 * IS translated, so it can't be used for grouping). The receiver doesn't store group_id,
 * so we merge by topic. An empty topic → its own group (don't merge blindly).
 */
function topicKey(p: ExtRemotePost, brandId: number): string {
  const t = (p.topic || '').trim().toLowerCase()
  return t ? `t:${t}` : `u:${runIdFor(p, brandId)}`
}

/**
 * Group anchor = the post of the source locale (its runId becomes group_id — matching
 * Ideata's convention where group_id = id of the source run). If there isn't one — the
 * earliest by createdAt (tiebreak: smaller receiver id). Deterministic, so
 * a repeat import gives the same group_id.
 */
function pickAnchor(members: ExtRemotePost[], srcLang: string): ExtRemotePost {
  const src = members.find(m => (m.locale || '').toLowerCase() === srcLang)
  if (src) return src
  return [...members].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || (a.id - b.id))[0]
}

/** Run fields from a receiver post (no id/group_id/created_at — those are fixed at create time). */
function contentFor(p: ExtRemotePost, now: string) {
  return {
    topic: p.topic || p.title || '',
    title: p.title || '',
    body_md: p.bodyMd || '',
    // the body came from a THIRD-PARTY receiver (editable by anyone with access to the
    // brand's site) and is later rendered as v-html in the editor and on the storefront —
    // sanitize on write, like anything else that goes into body_html
    body_html: sanitizeArticleHtml(p.bodyHtml || ''),
    locale: p.locale || '',
    category: p.category || '',
    author: p.author || '',
    views: p.views || 0,
    word_count: p.wordCount || 0,
    cover_url: p.coverUrl || '', // absolute R2 URL — coverUrlForPost will pass it through as-is
    status: 'done',
    phase: 'factcheck',
    // back-ref to the receiver's post → idempotent re-publish to the same post
    blog_post_id: p.id,
    blog_slug: p.slug || '',
    blog_status: p.status || '',
    blog_locale: p.locale || '',
    blog_cover_url: p.coverUrl || '',
    blog_synced_at: now,
    updated_at: now,
  }
}

/** Preview: how many posts on the receiver + sample titles (no DB writes). */
export async function extImportPreview(opts: ImportOpts = {}, brandId = 0) {
  const s = await resolveSettings(brandId)
  const cfg = extConfig(s)
  if (!cfg.base || !cfg.token) {
    return { ok: false, total: 0, sample: [] as any[], error: 'external API is not configured (base URL or token)' }
  }
  if (isSelfHost(cfg.base) && !opts.allowSelf) {
    return { ok: false, total: 0, sample: [] as any[], error: 'importing from Ideata itself is unavailable — it is the native blog' }
  }
  const r = await ingestListRemote({ status: opts.status, locale: opts.locale, category: opts.category, page: 1, limit: PAGE_LIMIT }, s)
  if (!r.ok) return { ok: false, total: 0, groups: 0, sample: [] as any[], error: r.error }
  // estimate the number of articles (translation groups) from the page we read
  const groups = new Set(r.items.map(p => topicKey(p, brandId))).size
  return {
    ok: true,
    total: r.total,
    groups, // ≈ distinct articles (exact when total ≤ page size, otherwise a lower bound)
    sample: r.items.slice(0, 8).map(p => ({
      id: p.id, title: p.title, slug: p.slug, status: p.status, locale: p.locale, category: p.category, updatedAt: p.updatedAt,
    })),
  }
}

/** Fetch all receiver posts (paginated, respecting max). */
async function fetchAll(opts: ImportOpts, s: any): Promise<{ ok: boolean; items: ExtRemotePost[]; total: number; error?: string }> {
  const max = opts.max && opts.max > 0 ? opts.max : Infinity
  const items: ExtRemotePost[] = []
  let page = 1, total = 0
  for (;;) {
    const r = await ingestListRemote({ status: opts.status, locale: opts.locale, category: opts.category, page, limit: PAGE_LIMIT }, s)
    if (!r.ok) return { ok: false, items, total, error: r.error }
    total = r.total
    if (!r.items.length) break
    for (const p of r.items) { if (items.length >= max) break; items.push(p) }
    if (items.length >= max || items.length >= total || r.items.length < PAGE_LIMIT) break
    page++
  }
  return { ok: true, items, total }
}

/**
 * Import: pull the whole list, group locales of a single article by topic (shared
 * group_id), upsert the runs. Runs in an active phase are skipped; native
 * grouping of existing runs is not overwritten (only regroup runs that are
 * currently "their own group").
 */
export async function importFromExternal(opts: ImportOpts = {}, brandId = 0): Promise<ImportSummary> {
  const s = await resolveSettings(brandId)
  const cfg = extConfig(s)
  const zero = { total: 0, fetched: 0, imported: 0, updated: 0, skipped: 0, localEdited: 0, groups: 0 }
  if (!cfg.base || !cfg.token) return { ok: false, ...zero, error: 'external API is not configured (base URL or token)' }
  if (isSelfHost(cfg.base) && !opts.allowSelf) {
    return { ok: false, ...zero, error: 'importing from Ideata itself is unavailable — it is the native blog' }
  }

  const fetched = await fetchAll(opts, s)
  if (!fetched.ok) return { ok: false, ...zero, total: fetched.total, error: fetched.error }
  const all = fetched.items

  // group by topic → shared group_id (= anchor's runId = post of the source locale)
  const srcLang = (s.language || 'ru').toLowerCase()
  const byGroup = new Map<string, ExtRemotePost[]>()
  for (const p of all) {
    const k = topicKey(p, brandId)
    const arr = byGroup.get(k); if (arr) arr.push(p); else byGroup.set(k, [p])
  }
  const groupIdByPost = new Map<number, string>()
  for (const members of byGroup.values()) {
    const gid = runIdFor(pickAnchor(members, srcLang), brandId)
    for (const m of members) groupIdByPost.set(m.id, gid)
  }

  const touchedGroups = new Set<string>()
  const acc = { ...zero, total: fetched.total, fetched: all.length }

  for (const p of all) {
    const id = runIdFor(p, brandId)
    const gid = groupIdByPost.get(p.id) || id
    const existing = await getRunRow(id)
    if (existing && INFLIGHT.has(existing.status)) { acc.skipped++; continue }
    // run of another brand (round-trip sourceId pointed at someone else's run) — leave it alone:
    // import must not overwrite content and can't reassign the brand
    if (existing && existing.brandId && brandId && existing.brandId !== brandId) { acc.skipped++; continue }

    const now = new Date().toISOString()
    const content = contentFor(p, now)
    if (existing) {
      const data: Record<string, any> = { ...content }
      // The author's local edits take priority over what's on the receiver: body,
      // title, and category are left alone, only publish metadata is updated.
      // updated_at and blog_synced_at are also left as-is — otherwise on the next
      // import the "edit newer than sync" condition would collapse and the edit would get overwritten anyway.
      const keepLocal = locallyEdited(existing)
      if (keepLocal) {
        for (const k of CONTENT_KEYS) delete data[k]
        delete data.updated_at
        delete data.blog_synced_at
        delete data.status
        delete data.phase
        acc.localEdited++
      }
      // only regroup "standalone" runs (group_id empty or equal to their own id),
      // so we don't break grouping done natively in the blog writer
      if (!existing.group_id || existing.group_id === existing.id) data.group_id = gid
      // adopt an "orphan" run (brand_id=NULL) into the active import brand — this way
      // old imports without a brand move to the right brand on a repeat import
      if (brandId && !existing.brandId) data.brandId = brandId
      await blogPrisma().blogRun.update({ where: { id }, data })
      acc.updated++
    } else {
      await blogPrisma().blogRun.create({
        data: { id, brandId: brandId || null, mode: 'interactive', group_id: gid, created_at: p.createdAt || now, ...content },
      })
      acc.imported++
    }
    touchedGroups.add(gid)
  }

  acc.groups = touchedGroups.size
  return { ok: true, ...acc }
}
