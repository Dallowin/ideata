/**
 * Blog-writer storage. Ported from better-sqlite3 to Prisma/Postgres (models
 * BlogRun + BlogWriterSetting). The public interface (RunRow + functions) is kept
 * 1:1 - it just became async (Prisma). BlogRun fields are deliberately snake_case,
 * so rows pass straight through as RunRow without mapping.
 */
import { join } from 'node:path'
import { blogPrisma } from './prisma'

export interface RunRow {
  id: string
  brandId: number | null // article's brand workspace (null - legacy/unassigned)
  topic: string
  // running | awaiting_sources | awaiting_outline | done | published | error
  status: string
  phase: string // research | outline | draft - which phase is running/failed (for retry)
  mode: string // interactive (pauses for user choices) | auto (single unattended run)
  model: string // model selected for THIS article ('' - the strong model from brand settings)
  locale: string // locale of the run's content (ru/en/...); '' - language from default settings
  group_id: string // translation group: all locales of one article share a single group_id
  perspectives_json: string
  pending_input_json: string // input for the current phase (source selection etc.) - for retry
  title: string
  body_md: string
  body_html: string
  outline_json: string
  sources_json: string
  slop_json: string
  eeat_json: string // E-E-A-T gate report (citations, stripped links, lead/FAQ)
  notes_json: string
  queries_json: string
  search_queries_json: string // search queries generated for the topic (research fan-out)
  cover_url: string // post cover image, path /blogtool/covers/<id>.jpg
  category: string // post category (e.g. CS2, Guides...) - for filter/chip/related
  author: string // post author (empty -> "{brand} Editorial Team")
  views: number // view counter (incremented by the public API)
  word_count: number
  error: string
  // --- blog publish state (native BlogPost) ---------------------------
  blog_post_id: number // post id in the blog (0 - not published yet)
  blog_slug: string // slug assigned by the blog (stable, doesn't change when title is edited)
  blog_status: string // '' | 'draft' | 'published'
  blog_locale: string // locale the post was sent with
  blog_cover_url: string // cover image CDN URL after upload
  blog_cover_src: string // local cover_url we last uploaded (to avoid re-uploading needlessly)
  blog_synced_at: string // ISO timestamp of last send/update to the blog
  // --- Telegram channel crossposting (per-brand bot) ---------------------------
  tg_msgids_json: string // JSON array of channel message ids (for idempotent resend/removal)
  tg_chat_id: string // resolved channel chat_id messages were sent to (removed when @channel changes)
  crosspost_json: string // crossposting state by platform: { "<platform>": { ids, url } }
  // Composer draft: { adapts: { "<platform>": AdaptResult }, media: { "<platform>": [...] } }.
  // Assembled adaptations live on the run, not just in frontend memory: otherwise F5
  // would wipe them and the user would pay for another LLM run.
  crosspost_drafts_json: string
  // Auto-posting schedule by channel: [{ id, channel, at, status, error?, doneAt? }].
  // Empty string - no schedule (the scheduler skips such runs).
  publish_schedule_json: string
  created_at: string
  updated_at: string
}

/** Application data directory (post cover images). */
export function dataDir(): string {
  return process.env.BLOG_WRITER_DATA || join(process.cwd(), 'data')
}

// --- runs ------------------------------------------------------------------ //

export async function createRun(id: string, topic: string, targetQueries: string[], mode = 'interactive', brandId?: number | null, model = ''): Promise<void> {
  const now = new Date().toISOString()
  // group_id = own id: a fresh run is its own translation group
  await blogPrisma().blogRun.create({
    data: { id, brandId: brandId ?? null, topic, status: 'running', mode, model, group_id: id, queries_json: JSON.stringify(targetQueries), created_at: now, updated_at: now },
  })
}

/** Insert a ready translation run (locale/group + content), immediately as a done draft. */
export async function createLocaleRun(r: {
  id: string, groupId: string, locale: string, topic: string, title: string,
  category: string, bodyHtml: string, bodyMd: string, queriesJson: string, wordCount: number,
  brandId?: number | null, // inherits the brand of the source article
}): Promise<void> {
  const now = new Date().toISOString()
  await blogPrisma().blogRun.create({
    data: {
      id: r.id, brandId: r.brandId ?? null, topic: r.topic, status: 'done', phase: 'factcheck', mode: 'interactive',
      locale: r.locale, group_id: r.groupId, title: r.title, body_html: r.bodyHtml, body_md: r.bodyMd,
      category: r.category, queries_json: r.queriesJson, word_count: r.wordCount, created_at: now, updated_at: now,
    },
  })
}

/** All runs in one translation group. An empty group_id (legacy run) is treated as its own id. */
export async function listGroup(groupId: string): Promise<RunRow[]> {
  const rows = await blogPrisma().blogRun.findMany({
    where: { OR: [{ group_id: groupId }, { group_id: '', id: groupId }] },
    orderBy: { created_at: 'asc' },
  })
  return rows as unknown as RunRow[]
}

export async function getRunRow(id: string): Promise<RunRow | undefined> {
  const row = await blogPrisma().blogRun.findUnique({ where: { id } })
  return (row as unknown as RunRow | null) ?? undefined
}

/**
 * List of runs. With brandId - only that brand's articles (+ legacy ones without a
 * brand, if includeUnassigned): workspace isolation. Without brandId - all of them
 * (admin overview).
 */
export async function listRuns(brandId?: number | null, includeUnassigned = true): Promise<RunRow[]> {
  const where = brandId == null
    ? undefined
    : includeUnassigned
      ? { OR: [{ brandId }, { brandId: null }] }
      : { brandId }
  const rows = await blogPrisma().blogRun.findMany({ where, orderBy: { updated_at: 'desc' } })
  return rows as unknown as RunRow[]
}

/**
 * Runs that are actually PUBLISHED to the blog (blog_status='published'), in one
 * query and with only the public API's fields.
 *
 * The criterion is specifically blog_status, not status: a run gets
 * `status='published'` on ANY publish (including to a brand's external blog or to
 * social media), and using it would have leaked other people's articles through
 * the public showcase. Bodies are needed for excerpt/html - otherwise every card
 * would trigger a second request for the full run.
 */
export type PublicRunRow = Pick<RunRow,
  'id' | 'brandId' | 'title' | 'topic' | 'category' | 'author' | 'cover_url'
  | 'word_count' | 'views' | 'body_html' | 'body_md' | 'created_at' | 'updated_at'>

export async function listPublishedRuns(): Promise<PublicRunRow[]> {
  const rows = await blogPrisma().blogRun.findMany({
    where: { blog_status: 'published' },
    orderBy: { updated_at: 'desc' },
    select: {
      id: true, brandId: true, title: true, topic: true, category: true, author: true,
      cover_url: true, word_count: true, views: true, body_html: true, body_md: true,
      created_at: true, updated_at: true,
    },
  })
  return rows as unknown as PublicRunRow[]
}

/** Increment the view counter (doesn't touch updated_at - won't bump it in sort order). */
export async function incrementViews(id: string): Promise<number> {
  const row = await blogPrisma().blogRun.update({ where: { id }, data: { views: { increment: 1 } }, select: { views: true } })
  return row.views
}

const UPDATE_ALLOWED = [
  'status', 'phase', 'mode', 'locale', 'group_id', 'title', 'body_md', 'body_html', 'outline_json', 'sources_json',
  'perspectives_json', 'pending_input_json', 'slop_json', 'eeat_json', 'notes_json', 'queries_json',
  'search_queries_json', 'cover_url', 'category', 'author', 'views', 'word_count', 'error',
  'blog_post_id', 'blog_slug', 'blog_status', 'blog_locale', 'blog_cover_url', 'blog_cover_src', 'blog_synced_at',
  'tg_msgids_json', 'tg_chat_id', 'crosspost_json', 'crosspost_drafts_json', 'publish_schedule_json',
] as const

export async function updateRun(id: string, fields: Partial<RunRow>): Promise<void> {
  const data: Record<string, unknown> = {}
  for (const key of UPDATE_ALLOWED) {
    if (fields[key] !== undefined) data[key] = fields[key]
  }
  if (!Object.keys(data).length) return
  data.updated_at = new Date().toISOString()
  await blogPrisma().blogRun.update({ where: { id }, data })
}

/**
 * Claim a run for starting a phase: switch it to 'running' ONLY if it's currently
 * in one of the expected statuses (no list -> "any status except already running").
 * The conditional update is atomic, so out of two parallel "Continue"/"Retry"
 * clicks (double-click, two tabs) exactly one gets count=1 - the others won't
 * trigger a second generation paid for twice.
 */
export async function claimRun(id: string, fromStatuses?: string[]): Promise<boolean> {
  const res = await blogPrisma().blogRun.updateMany({
    where: { id, status: fromStatuses ? { in: fromStatuses } : { not: 'running' } },
    data: { status: 'running', updated_at: new Date().toISOString() },
  })
  return res.count === 1
}

/**
 * Delete the article entirely: the run itself + all locales in its translation
 * group (the UI promises "delete the article and all its locales"). Legacy runs
 * without a group_id are treated as their own group. Given a member locale's id -
 * we delete the whole group by its group_id.
 */
export async function deleteRun(id: string): Promise<void> {
  const row = await blogPrisma().blogRun.findUnique({ where: { id }, select: { group_id: true } })
  const groupId = row?.group_id || id
  await blogPrisma().blogRun.deleteMany({
    where: { OR: [{ id }, { group_id: groupId }, { group_id: '', id: groupId }] },
  })
}

/** Lightweight run summary by id (for joining statuses into the calendar - without the heavy body_*). */
export interface RunBrief {
  id: string
  status: string
  title: string
  blog_status: string
  blog_slug: string
  cover_url: string
  word_count: number
}

export async function listRunBriefs(ids: string[]): Promise<RunBrief[]> {
  if (!ids.length) return []
  return blogPrisma().blogRun.findMany({
    where: { id: { in: ids } },
    select: { id: true, status: true, title: true, blog_status: true, blog_slug: true, cover_url: true, word_count: true },
  })
}

/**
 * Runs with a NON-EMPTY auto-posting schedule - in one query and with only the
 * fields the scheduler and calendar need. Using listRuns() just to read the
 * schedule is not an option: it pulls body_md/body_html for every article of the
 * brand, and the tick runs once a minute.
 * brandId=null (default) - all brands: this is how the scheduler calls it.
 */
export interface RunScheduleRow {
  id: string
  brandId: number | null
  title: string
  topic: string
  locale: string
  publish_schedule_json: string
}

export async function listRunSchedules(brandId?: number | null): Promise<RunScheduleRow[]> {
  const rows = await blogPrisma().blogRun.findMany({
    where: { publish_schedule_json: { not: '' }, ...(brandId == null ? {} : { brandId }) },
    select: { id: true, brandId: true, title: true, topic: true, locale: true, publish_schedule_json: true },
  })
  return rows as unknown as RunScheduleRow[]
}

// --- content plan ------------------------------------------------------------ //

export interface PlanItemRow {
  id: string
  brandId: number // 0 - admin without an active brand
  date: string // 'YYYY-MM-DD'
  time: string // 'HH:mm' - exact publish time, '' = all day
  title: string
  angle: string
  intent: string
  keyword: string
  queries_json: string
  category: string
  status: string // planned | skipped (article progress is tracked via run_id -> BlogRun)
  run_id: string
  score: number
  created_at: string
  updated_at: string
}

/** A brand's plan slots, optionally within a date range (YYYY-MM-DD strings compare lexicographically). */
export async function listPlanItems(brandId: number, from?: string, to?: string): Promise<PlanItemRow[]> {
  const date = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined
  const rows = await blogPrisma().blogPlanItem.findMany({
    where: { brandId, ...(date ? { date } : {}) },
    orderBy: [{ date: 'asc' }, { created_at: 'asc' }],
  })
  return rows as unknown as PlanItemRow[]
}

export async function getPlanItem(id: string): Promise<PlanItemRow | undefined> {
  const row = await blogPrisma().blogPlanItem.findUnique({ where: { id } })
  return (row as unknown as PlanItemRow | null) ?? undefined
}

export async function createPlanItems(rows: Omit<PlanItemRow, 'created_at' | 'updated_at'>[]): Promise<void> {
  if (!rows.length) return
  const now = new Date().toISOString()
  await blogPrisma().blogPlanItem.createMany({
    data: rows.map(r => ({ ...r, created_at: now, updated_at: now })),
  })
}

const PLAN_UPDATE_ALLOWED = [
  'date', 'time', 'title', 'angle', 'intent', 'keyword', 'queries_json', 'category', 'status', 'run_id', 'score',
] as const

export async function updatePlanItem(id: string, fields: Partial<PlanItemRow>): Promise<void> {
  const data: Record<string, unknown> = {}
  for (const key of PLAN_UPDATE_ALLOWED) {
    if (fields[key] !== undefined) data[key] = fields[key]
  }
  if (!Object.keys(data).length) return
  data.updated_at = new Date().toISOString()
  await blogPrisma().blogPlanItem.update({ where: { id }, data })
}

export async function deletePlanItem(id: string): Promise<void> {
  await blogPrisma().blogPlanItem.delete({ where: { id } })
}

/**
 * Clear untouched slots for the period before regeneration: delete only planned
 * slots without a started article - slots with a run_id and manual skipped ones survive.
 */
export async function clearPlannedItems(brandId: number, from: string, to: string): Promise<number> {
  const res = await blogPrisma().blogPlanItem.deleteMany({
    where: { brandId, date: { gte: from, lte: to }, status: 'planned', run_id: '' },
  })
  return res.count
}

// --- settings ---------------------------------------------------------------- //

/**
 * Shared keys from the scrapper's `app_settings` table (set in the Admin panel:
 * ANTHROPIC_API_KEY, OPENROUTER_API_KEY... plaintext KV in the same DB). The table is
 * declared in the Prisma schema (AppSetting) - we just read it client-side; no
 * table/rows -> {}. It's tiny, so we pull it whole.
 */
let _appCache: { at: number; data: Record<string, string> } | null = null
export async function getAppSettings(keys?: string[]): Promise<Record<string, string>> {
  // 60s cache: resolveSettings is called on every request, and app_settings rarely changes
  const now = Date.now()
  if (!_appCache || now - _appCache.at > 60_000) {
    try {
      const rows = await blogPrisma().appSetting.findMany()
      _appCache = { at: now, data: Object.fromEntries(rows.map(r => [r.key, r.value || ''])) }
    } catch {
      _appCache = { at: now, data: {} }
    }
  }
  const all = _appCache.data
  return keys ? Object.fromEntries(keys.map(k => [k, all[k] || ''])) : all
}

/** KV settings for a single brand scope (brandId=0 - account-wide defaults). */
export async function allSettings(brandId = 0): Promise<Record<string, string>> {
  const rows = await blogPrisma().blogWriterSetting.findMany({ where: { brandId } })
  return Object.fromEntries(rows.map(r => [r.key, r.value]))
}

/**
 * Per-brand JSON cache on top of KV (same blog_writer_settings, brand-scoped). Holds
 * generated topic ideas / AEO keys so a repeat visit doesn't burn tokens - we read
 * from the DB instead. The key doesn't inherit from brand-0 (allSettings(brandId)
 * only reads that brand's rows), so the cache is strictly per-brand.
 */
export async function getBrandCache<T = unknown>(brandId: number, key: string): Promise<T | null> {
  const rows = await blogPrisma().blogWriterSetting.findMany({ where: { brandId, key } })
  const raw = rows[0]?.value
  if (!raw) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

export async function setBrandCache(brandId: number, key: string, value: unknown): Promise<void> {
  await saveSettings({ [key]: JSON.stringify(value) }, brandId)
}

export async function saveSettings(patch: Record<string, string>, brandId = 0): Promise<void> {
  const p = blogPrisma()
  await p.$transaction(
    Object.entries(patch).map(([key, value]) =>
      p.blogWriterSetting.upsert({
        where: { brandId_key: { brandId, key } },
        update: { value: String(value) },
        create: { brandId, key, value: String(value) },
      }),
    ),
  )
}
