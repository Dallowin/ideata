/**
 * Auto-posting schedule for an article by channel: "the site on the 10th, dev.to on
 * the 11th, bluesky on the 12th". One entry = "this channel gets the article at
 * this moment", stored on the run as a single JSON blob (publish_schedule_json) -
 * like crosspost_json: a new channel shouldn't require a new column.
 *
 * The channels here are ONLY the ones we actually send to ourselves. Platforms
 * without a connector (VK, Dzen, Threads) don't get into the schedule: setting a
 * date for something that won't go out is a promise we won't keep.
 *
 * Bluesky and Mastodon exist both in the blog channels (announcement on article
 * publish) and in the social composer. In the schedule they're SOCIAL: a native
 * thread with text from the draft and media, not an auto-link - that's what the
 * user is actually planning.
 */
import { randomUUID } from 'node:crypto'
import { getRunRow, updateRun, type RunRow } from './store'

/** Blog channels: the whole article goes out (via publishRunToBlog). */
export const SCHEDULE_BLOG_CHANNELS = ['external', 'devto', 'wordpress', 'ghost', 'telegraph'] as const
/** Social channels: an adapted post from the composer draft goes out. */
export const SCHEDULE_SOCIAL_CHANNELS = ['tg', 'x', 'bluesky', 'mastodon', 'linkedin'] as const

export const SCHEDULE_CHANNELS = [...SCHEDULE_BLOG_CHANNELS, ...SCHEDULE_SOCIAL_CHANNELS] as const
export type ScheduleBlogChannel = (typeof SCHEDULE_BLOG_CHANNELS)[number]
export type ScheduleSocialChannel = (typeof SCHEDULE_SOCIAL_CHANNELS)[number]
export type ScheduleChannel = (typeof SCHEDULE_CHANNELS)[number]

export type ScheduleStatus = 'planned' | 'running' | 'done' | 'error'
const STATUSES: readonly ScheduleStatus[] = ['planned', 'running', 'done', 'error']

/**
 * Cap on entries per article. 10 channels x a few waves of republishing is dozens,
 * not hundreds: a schedule with 500 dates means a UI typo or an attempt to stuff
 * the JSON, not a working plan.
 */
export const SCHEDULE_CAP = 40

/** We truncate the error field: it goes into the UI and the DB, and a network error's text can be a whole page. */
const ERROR_MAX = 400

export interface ScheduleEntry {
  id: string
  channel: ScheduleChannel
  at: string // ISO-UTC send moment
  status: ScheduleStatus
  error?: string
  doneAt?: string // ISO moment the entry finished (success or error)
}

export function isBlogChannel(key: string): key is ScheduleBlogChannel {
  return (SCHEDULE_BLOG_CHANNELS as readonly string[]).includes(key)
}

export function isSocialChannel(key: string): key is ScheduleSocialChannel {
  return (SCHEDULE_SOCIAL_CHANNELS as readonly string[]).includes(key)
}

export function isScheduleChannel(key: string): key is ScheduleChannel {
  return (SCHEDULE_CHANNELS as readonly string[]).includes(key)
}

/** Short entry id: it goes into the URL for a targeted reschedule, a UUID would be overkill there. */
export function newEntryId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12)
}

/**
 * Send moment -> canonical ISO-UTC. We accept any parseable Date (with or without
 * a timezone), and always emit strictly toISOString(): date comparisons in the
 * scheduler and the calendar are done as strings, and "2026-08-10 12:00+03:00"
 * next to "2026-08-10T09:00:00.000Z" would compare as garbage.
 */
export function toIsoUtc(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  const t = Date.parse(s)
  if (!Number.isFinite(t)) return null
  return new Date(t).toISOString()
}

/** Parse publish_schedule_json. A malformed/empty string -> an empty schedule. */
export function parseSchedule(raw: string | undefined | null): ScheduleEntry[] {
  let v: unknown
  try { v = JSON.parse(String(raw || '') || '[]') } catch { return [] }
  if (!Array.isArray(v)) return []
  const out: ScheduleEntry[] = []
  for (const item of v) {
    const e = item as Partial<ScheduleEntry> | null
    if (!e || typeof e !== 'object') continue
    const channel = String(e.channel || '').trim().toLowerCase()
    const at = toIsoUtc(e.at)
    if (!isScheduleChannel(channel) || !at) continue
    const status = STATUSES.includes(e.status as ScheduleStatus) ? (e.status as ScheduleStatus) : 'planned'
    out.push({
      id: String(e.id || '').trim() || newEntryId(),
      channel,
      at,
      status,
      ...(e.error ? { error: String(e.error).slice(0, ERROR_MAX) } : {}),
      ...(toIsoUtc(e.doneAt) ? { doneAt: toIsoUtc(e.doneAt) as string } : {}),
    })
  }
  return sortSchedule(out)
}

/** A run's schedule (convenience wrapper over parseSchedule for the DB string). */
export function runSchedule(run: Pick<RunRow, 'publish_schedule_json'>): ScheduleEntry[] {
  return parseSchedule(run.publish_schedule_json)
}

/** By time: the calendar and scheduler walk entries in send order. */
export function sortSchedule(entries: ScheduleEntry[]): ScheduleEntry[] {
  return [...entries].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.channel.localeCompare(b.channel)))
}

/**
 * Parse the schedule FROM A REQUEST. We return an error as a string rather than
 * throwing an HTTP exception: this module is plain, without Nest, and the same
 * tests run against it.
 *
 * A valid status from the body is passed through as-is - but WHO gets to decide
 * how it's used is up to the caller: the schedule-save controller merges the
 * status with what's stored by id, because a stale tab copy would otherwise put an
 * already-sent entry back to planned and publish it a second time.
 */
export function validateEntries(raw: unknown): { entries: ScheduleEntry[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'entries must be an array of schedule entries' }
  if (raw.length > SCHEDULE_CAP) return { error: `no more than ${SCHEDULE_CAP} entries in the schedule` }

  const entries: ScheduleEntry[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const e = (item && typeof item === 'object' ? item : {}) as Partial<ScheduleEntry>
    const channel = String(e.channel || '').trim().toLowerCase()
    if (!isScheduleChannel(channel)) {
      return { error: `unknown channel "${channel || '-'}": available channels are ${SCHEDULE_CHANNELS.join(', ')}` }
    }
    const at = toIsoUtc(e.at)
    if (!at) return { error: `send date "${String(e.at ?? '')}" cannot be parsed as an ISO date` }

    // we respect the client's id (targeted reschedule relies on it), duplicates get renamed:
    // two identical ids would make the reschedule ambiguous
    let id = String(e.id || '').trim().slice(0, 40)
    if (!id || seen.has(id)) id = newEntryId()
    seen.add(id)

    const status = STATUSES.includes(e.status as ScheduleStatus) ? (e.status as ScheduleStatus) : 'planned'
    entries.push({
      id,
      channel,
      at,
      status,
      ...(e.error ? { error: String(e.error).slice(0, ERROR_MAX) } : {}),
      ...(toIsoUtc(e.doneAt) ? { doneAt: toIsoUtc(e.doneAt) as string } : {}),
    })
  }
  return { entries: sortSchedule(entries) }
}

/**
 * Merge the schedule coming from the UI with what's stored: the client dictates
 * the SET of entries, the server dictates the STATUS.
 *
 * The scheduler also modifies the schedule, so an autosave from an open tab can
 * easily arrive with a stale copy. Taking the status from the body would mean
 * putting an already-sent entry back to planned and publishing it a second time.
 * A changed time is a reschedule: such an entry honestly becomes planned again and
 * will go out anew.
 */
export function mergeScheduleStatuses(stored: ScheduleEntry[], incoming: ScheduleEntry[]): ScheduleEntry[] {
  const byId = new Map(stored.map((e) => [e.id, e]))
  return incoming.map((e): ScheduleEntry => {
    const prev = byId.get(e.id)
    if (!prev || prev.at !== e.at) return { id: e.id, channel: e.channel, at: e.at, status: 'planned' }
    return { ...prev, at: e.at, channel: e.channel }
  })
}

/** Entries due to go out: still planned and the send moment has already arrived. */
export function dueEntries(entries: ScheduleEntry[], now: Date = new Date()): ScheduleEntry[] {
  const iso = now.toISOString()
  return entries.filter((e) => e.status === 'planned' && e.at <= iso)
}

/** Write the schedule onto the run (empty -> an empty string, so the scheduler skips it). */
export async function saveSchedule(runId: string, entries: ScheduleEntry[]): Promise<ScheduleEntry[]> {
  const sorted = sortSchedule(entries)
  await updateRun(runId, { publish_schedule_json: sorted.length ? JSON.stringify(sorted) : '' })
  return sorted
}

/**
 * Claim an entry for sending: RE-READ the run and switch planned -> running.
 * The entry is no longer planned (a previous tick already took it, the user
 * removed it from the schedule, the run was deleted) -> null, and the caller just
 * skips it.
 *
 * Re-reading before starting is exactly the defense against double publishing: a
 * tick taking longer than a minute isn't a problem, the next one will see 'running'
 * in the DB and pass it by.
 */
export async function claimEntry(runId: string, entryId: string): Promise<ScheduleEntry | null> {
  const run = await getRunRow(runId)
  if (!run) return null
  const entries = runSchedule(run)
  const idx = entries.findIndex((e) => e.id === entryId)
  if (idx < 0 || entries[idx].status !== 'planned') return null
  const claimed: ScheduleEntry = { ...entries[idx], status: 'running', error: undefined }
  entries[idx] = claimed
  await saveSchedule(runId, entries)
  return claimed
}

/** Close out an entry: success -> done, otherwise error with text. doneAt is set in both cases. */
export async function finishEntry(
  runId: string,
  entryId: string,
  result: { ok: true } | { ok: false; error: string },
): Promise<void> {
  const run = await getRunRow(runId)
  if (!run) return
  const entries = runSchedule(run)
  const idx = entries.findIndex((e) => e.id === entryId)
  if (idx < 0) return // entry was removed from the schedule while it was going out - don't resurrect it
  entries[idx] = {
    ...entries[idx],
    status: result.ok ? 'done' : 'error',
    doneAt: new Date().toISOString(),
    ...(result.ok ? { error: undefined } : { error: String(result.error || 'send failed').slice(0, ERROR_MAX) }),
  }
  await saveSchedule(runId, entries)
}
