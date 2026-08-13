/**
 * Auto-posting schedule: parsing/validating entries, selecting due ones, and claiming them.
 *
 * Claiming is the sole defense against double publishing (the scheduler re-reads
 * the run before starting), so it's tested here separately and against an honest
 * "store": a bug in it costs a duplicate post on someone else's platform, not just
 * a red test.
 */
import {
  SCHEDULE_CAP,
  claimEntry,
  dueEntries,
  finishEntry,
  isBlogChannel,
  isSocialChannel,
  mergeScheduleStatuses,
  parseSchedule,
  saveSchedule,
  toIsoUtc,
  validateEntries,
  type ScheduleEntry,
} from './publishSchedule'

// In-memory run: getRunRow/updateRun operate on the same object, just like in the DB.
const runs = new Map<string, any>()
jest.mock('./store', () => ({
  getRunRow: jest.fn(async (id: string) => runs.get(id)),
  updateRun: jest.fn(async (id: string, fields: Record<string, unknown>) => {
    const row = runs.get(id)
    if (row) Object.assign(row, fields)
  }),
}))

function mkRun(id: string, entries: Partial<ScheduleEntry>[]) {
  const row = { id, publish_schedule_json: entries.length ? JSON.stringify(entries) : '' }
  runs.set(id, row)
  return row
}

beforeEach(() => runs.clear())

describe('toIsoUtc - canonical ISO-UTC', () => {
  it('converts an offset moment to UTC: strings are compared directly afterwards', () => {
    expect(toIsoUtc('2026-08-10T12:00:00+03:00')).toBe('2026-08-10T09:00:00.000Z')
  })

  it('accepts an already-UTC value as-is', () => {
    expect(toIsoUtc('2026-08-10T09:00:00.000Z')).toBe('2026-08-10T09:00:00.000Z')
  })

  it('garbage and an empty string -> null', () => {
    expect(toIsoUtc('завтра')).toBeNull()
    expect(toIsoUtc('')).toBeNull()
    expect(toIsoUtc(undefined)).toBeNull()
  })
})

describe('parseSchedule - lenient column parsing', () => {
  it('empty column and malformed JSON -> empty schedule, not a crash', () => {
    expect(parseSchedule('')).toEqual([])
    expect(parseSchedule('{не json')).toEqual([])
    expect(parseSchedule('{"a":1}')).toEqual([])
  })

  it('drops entries with an unknown channel and an unparsable date', () => {
    const out = parseSchedule(JSON.stringify([
      { id: 'a', channel: 'devto', at: '2026-08-11T10:00:00.000Z', status: 'planned' },
      { id: 'b', channel: 'myspace', at: '2026-08-11T10:00:00.000Z', status: 'planned' },
      { id: 'c', channel: 'tg', at: 'когда-нибудь', status: 'planned' },
    ]))
    expect(out.map((e) => e.id)).toEqual(['a'])
  })

  it('sorts by send time', () => {
    const out = parseSchedule(JSON.stringify([
      { id: 'b', channel: 'tg', at: '2026-08-12T10:00:00.000Z' },
      { id: 'a', channel: 'external', at: '2026-08-10T10:00:00.000Z' },
    ]))
    expect(out.map((e) => e.id)).toEqual(['a', 'b'])
  })

  it('unknown status is coerced to planned', () => {
    expect(parseSchedule(JSON.stringify([{ id: 'a', channel: 'tg', at: '2026-08-10T10:00:00.000Z', status: 'ушло' }]))[0].status)
      .toBe('planned')
  })
})

describe('validateEntries - what comes from the UI', () => {
  const ok = { channel: 'devto', at: '2026-08-11T10:00:00.000Z' }

  it('assigns id and planned to new entries', () => {
    const res = validateEntries([ok]) as { entries: ScheduleEntry[] }
    expect(res.entries).toHaveLength(1)
    expect(res.entries[0].id).toMatch(/^[0-9a-f]{12}$/)
    expect(res.entries[0].status).toBe('planned')
  })

  it('not an array -> error', () => {
    expect(validateEntries({ channel: 'devto' })).toEqual({ error: expect.stringContaining('array') })
  })

  it('unknown channel -> error listing the available ones', () => {
    const res = validateEntries([{ channel: 'myspace', at: ok.at }]) as { error: string }
    expect(res.error).toContain('myspace')
    expect(res.error).toContain('devto')
  })

  it('platforms without a connector (vk/dzen/threads) are not accepted into the schedule', () => {
    for (const channel of ['vk', 'dzen', 'threads']) {
      expect(validateEntries([{ channel, at: ok.at }])).toHaveProperty('error')
    }
  })

  it('unparsable date -> error', () => {
    expect(validateEntries([{ channel: 'tg', at: 'послезавтра' }])).toHaveProperty('error')
  })

  it(`more than ${SCHEDULE_CAP} entries are not accepted`, () => {
    const many = Array.from({ length: SCHEDULE_CAP + 1 }, () => ok)
    expect(validateEntries(many)).toHaveProperty('error')
    expect(validateEntries(many.slice(1))).toHaveProperty('entries')
  })

  it('preserves the status of an already-finished entry: otherwise a UI autosave would republish it', () => {
    const res = validateEntries([
      { id: 'e1', channel: 'devto', at: ok.at, status: 'done', doneAt: '2026-08-11T10:00:05.000Z' },
    ]) as { entries: ScheduleEntry[] }
    expect(res.entries[0].status).toBe('done')
    expect(res.entries[0].doneAt).toBe('2026-08-11T10:00:05.000Z')
  })

  it('renames duplicate ids - otherwise a targeted reschedule would be ambiguous', () => {
    const res = validateEntries([
      { id: 'same', channel: 'tg', at: ok.at },
      { id: 'same', channel: 'devto', at: ok.at },
    ]) as { entries: ScheduleEntry[] }
    expect(new Set(res.entries.map((e) => e.id)).size).toBe(2)
  })
})

describe('mergeScheduleStatuses - set from the client, status from the server', () => {
  const stored: ScheduleEntry[] = [
    { id: 'e1', channel: 'devto', at: '2026-08-11T10:00:00.000Z', status: 'done', doneAt: '2026-08-11T10:00:03.000Z' },
    { id: 'e2', channel: 'tg', at: '2026-08-12T10:00:00.000Z', status: 'planned' },
  ]

  it('a stale autosave does not resurrect a sent entry', () => {
    const out = mergeScheduleStatuses(stored, [
      { id: 'e1', channel: 'devto', at: '2026-08-11T10:00:00.000Z', status: 'planned' },
    ])
    expect(out[0].status).toBe('done')
    expect(out[0].doneAt).toBe('2026-08-11T10:00:03.000Z')
  })

  it('a changed time is a reschedule: the entry becomes planned again', () => {
    const out = mergeScheduleStatuses(stored, [
      { id: 'e1', channel: 'devto', at: '2026-08-15T10:00:00.000Z', status: 'done' },
    ])
    expect(out[0]).toEqual({ id: 'e1', channel: 'devto', at: '2026-08-15T10:00:00.000Z', status: 'planned' })
  })

  it('an entry removed by the client disappears, a new one appears as planned', () => {
    const out = mergeScheduleStatuses(stored, [
      { id: 'e2', channel: 'tg', at: '2026-08-12T10:00:00.000Z', status: 'planned' },
      { id: 'e3', channel: 'x', at: '2026-08-13T10:00:00.000Z', status: 'done' },
    ])
    expect(out.map((e) => e.id)).toEqual(['e2', 'e3'])
    expect(out[1].status).toBe('planned')
  })
})

describe('dueEntries - which entries are due to go out', () => {
  const now = new Date('2026-08-11T12:00:00.000Z')
  const list: ScheduleEntry[] = [
    { id: 'past', channel: 'devto', at: '2026-08-10T10:00:00.000Z', status: 'planned' },
    { id: 'now', channel: 'tg', at: '2026-08-11T12:00:00.000Z', status: 'planned' },
    { id: 'future', channel: 'x', at: '2026-08-12T10:00:00.000Z', status: 'planned' },
    { id: 'running', channel: 'ghost', at: '2026-08-10T10:00:00.000Z', status: 'running' },
    { id: 'done', channel: 'external', at: '2026-08-10T10:00:00.000Z', status: 'done' },
    { id: 'failed', channel: 'bluesky', at: '2026-08-10T10:00:00.000Z', status: 'error' },
  ]

  it('only takes planned entries whose moment has already arrived', () => {
    expect(dueEntries(list, now).map((e) => e.id)).toEqual(['past', 'now'])
  })

  it('does not retry a failed entry on its own: restarting is the user\'s decision', () => {
    expect(dueEntries(list, now).map((e) => e.id)).not.toContain('failed')
  })
})

describe('claimEntry - claiming an entry for sending', () => {
  it('the first claim returns the entry and switches it to running', async () => {
    mkRun('r1', [{ id: 'e1', channel: 'devto', at: '2026-08-10T10:00:00.000Z', status: 'planned' }])
    const claimed = await claimEntry('r1', 'e1')
    expect(claimed?.status).toBe('running')
    expect(parseSchedule(runs.get('r1').publish_schedule_json)[0].status).toBe('running')
  })

  it('claiming the same entry again -> null: a second tick does not publish a duplicate', async () => {
    mkRun('r1', [{ id: 'e1', channel: 'devto', at: '2026-08-10T10:00:00.000Z', status: 'planned' }])
    expect(await claimEntry('r1', 'e1')).not.toBeNull()
    expect(await claimEntry('r1', 'e1')).toBeNull()
  })

  it('does not claim an entry that already finished (done)', async () => {
    mkRun('r1', [{ id: 'e1', channel: 'devto', at: '2026-08-10T10:00:00.000Z', status: 'done' }])
    expect(await claimEntry('r1', 'e1')).toBeNull()
  })

  it('an entry removed from the schedule and a deleted run -> null, not a crash', async () => {
    mkRun('r1', [{ id: 'e1', channel: 'devto', at: '2026-08-10T10:00:00.000Z', status: 'planned' }])
    expect(await claimEntry('r1', 'нет-такой')).toBeNull()
    expect(await claimEntry('нет-рана', 'e1')).toBeNull()
  })

  it('claiming does not touch neighboring entries', async () => {
    mkRun('r1', [
      { id: 'e1', channel: 'devto', at: '2026-08-10T10:00:00.000Z', status: 'planned' },
      { id: 'e2', channel: 'tg', at: '2026-08-11T10:00:00.000Z', status: 'planned' },
    ])
    await claimEntry('r1', 'e1')
    const after = parseSchedule(runs.get('r1').publish_schedule_json)
    expect(after.find((e) => e.id === 'e2')?.status).toBe('planned')
  })
})

describe('finishEntry - closing out an entry', () => {
  it('success -> done with a timestamp and without the old error', async () => {
    mkRun('r1', [{ id: 'e1', channel: 'devto', at: '2026-08-10T10:00:00.000Z', status: 'running', error: 'старое' }])
    await finishEntry('r1', 'e1', { ok: true })
    const e = parseSchedule(runs.get('r1').publish_schedule_json)[0]
    expect(e.status).toBe('done')
    expect(e.error).toBeUndefined()
    expect(e.doneAt).toBeTruthy()
  })

  it('error -> error with the reason text', async () => {
    mkRun('r1', [{ id: 'e1', channel: 'devto', at: '2026-08-10T10:00:00.000Z', status: 'running' }])
    await finishEntry('r1', 'e1', { ok: false, error: 'dev.to API key not set' })
    const e = parseSchedule(runs.get('r1').publish_schedule_json)[0]
    expect(e.status).toBe('error')
    expect(e.error).toBe('dev.to API key not set')
  })

  it('the entry was removed while it was going out - we don\'t resurrect it', async () => {
    mkRun('r1', [])
    await finishEntry('r1', 'e1', { ok: true })
    expect(runs.get('r1').publish_schedule_json).toBe('')
  })
})

describe('saveSchedule', () => {
  it('an empty schedule is written as an empty string - the scheduler skips such runs', async () => {
    mkRun('r1', [{ id: 'e1', channel: 'devto', at: '2026-08-10T10:00:00.000Z', status: 'planned' }])
    await saveSchedule('r1', [])
    expect(runs.get('r1').publish_schedule_json).toBe('')
  })
})

describe('channel breakdown', () => {
  it('blog channels send the article, social channels send an adapted post', () => {
    expect(isBlogChannel('external')).toBe(true)
    expect(isBlogChannel('devto')).toBe(true)
    expect(isSocialChannel('tg')).toBe(true)
    expect(isSocialChannel('linkedin')).toBe(true)
  })

  it('bluesky and mastodon in the schedule are SOCIAL: a native thread there, not an auto-link', () => {
    expect(isSocialChannel('bluesky')).toBe(true)
    expect(isBlogChannel('bluesky')).toBe(false)
    expect(isSocialChannel('mastodon')).toBe(true)
    expect(isBlogChannel('mastodon')).toBe(false)
  })
})
