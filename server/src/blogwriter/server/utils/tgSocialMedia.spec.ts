/**
 * Shape of the Bot API request for a social post with media. We check the CALL
 * BODY specifically: Telegram responds to a malformed album with a vague 400, and
 * telling "caption on the wrong element" apart from "file failed to download" is
 * impossible in production.
 *
 * fetch is mocked entirely: there's nothing to test about the network here, but
 * distributing files across posts, the caption on the FIRST album element, and
 * the limit of 10 — that's exactly the logic that breaks silently.
 */
import { tgPublishSocial } from './tgPublish'

interface TgCall { method: string; body: any }

/** Mocked Bot API: accumulates calls and returns a plausible ok:true. */
function mockBotApi(): TgCall[] {
  const calls: TgCall[] = []
  ;(globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
    const method = String(url).split('/').pop()!
    const body = JSON.parse(String(init?.body || '{}'))
    calls.push({ method, body })
    // sendMediaGroup responds with an ARRAY of messages — one per file
    const result = method === 'sendMediaGroup'
      ? (body.media as any[]).map((_, i) => ({ message_id: 100 + calls.length * 10 + i, chat: { id: -1001 } }))
      : { message_id: calls.length, chat: { id: -1001 } }
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 })
  })
  return calls
}

const img = (n: number, postIndex?: number) => ({
  url: `https://ideata.io/blogwriter/crosspost-media/p${n}.jpg`,
  type: 'image' as const,
  ...(postIndex === undefined ? {} : { postIndex }),
})

const publish = (posts: string[], media: any[]) =>
  tgPublishSocial({ token: 'tok', channel: '@chan', posts, media })

describe('Telegram: album with caption', () => {
  let calls: TgCall[]
  const realFetch = globalThis.fetch
  beforeEach(() => { calls = mockBotApi() })
  afterAll(() => { globalThis.fetch = realFetch })

  it('2..10 files go out as ONE sendMediaGroup, not a batch of sendPhoto', async () => {
    await publish(['Короткий пост'], [img(1), img(2), img(3)])
    const albums = calls.filter((c) => c.method === 'sendMediaGroup')
    expect(albums).toHaveLength(1)
    expect(albums[0]!.body.media).toHaveLength(3)
    expect(calls.some((c) => c.method === 'sendPhoto')).toBe(false)
  })

  it('the caption is on the FIRST album element — the Bot API only reads it from there', async () => {
    await publish(['Короткий пост'], [img(1), img(2)])
    const items = calls.find((c) => c.method === 'sendMediaGroup')!.body.media
    expect(items[0].caption).toBe('Короткий пост')
    expect(items[0].parse_mode).toBe('HTML')
    expect(items[1].caption).toBeUndefined()
  })

  it('text fits in the caption — we don\'t duplicate it as a separate message', async () => {
    await publish(['Короткий пост'], [img(1), img(2)])
    expect(calls.some((c) => c.method === 'sendMessage')).toBe(false)
  })

  it('text longer than 1024 doesn\'t fit the caption: album without caption + a message follows', async () => {
    const long = 'я'.repeat(1500)
    await publish([long], [img(1), img(2)])
    const items = calls.find((c) => c.method === 'sendMediaGroup')!.body.media
    expect(items[0].caption).toBeUndefined()
    const texts = calls.filter((c) => c.method === 'sendMessage')
    expect(texts.length).toBeGreaterThan(0)
    expect(texts[0]!.body.text).toContain('яяя')
  })

  it('a single file — as before: sendPhoto with a caption, no album', async () => {
    await publish(['Короткий пост'], [img(1)])
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto'])
    expect(calls[0]!.body.caption).toBe('Короткий пост')
  })

  it('more than 10 files: send the first 10 and explain it in mediaError, without failing', async () => {
    const res = await publish(['Пост'], Array.from({ length: 12 }, (_, i) => img(i)))
    const albums = calls.filter((c) => c.method === 'sendMediaGroup')
    expect(albums).toHaveLength(1)
    expect(albums[0]!.body.media).toHaveLength(10)
    expect(res.ok).toBe(true) // an attachment that didn't make it isn't a publish failure
    expect(res.mediaError).toContain('10')
  })

  it('element type is taken from the extension: mp4 in an album — video, otherwise Telegram returns 400', async () => {
    await publish(['Пост'], [
      { url: 'https://ideata.io/blogwriter/crosspost-media/a.mp4', type: 'image' as const },
      img(2),
    ])
    const items = calls.find((c) => c.method === 'sendMediaGroup')!.body.media
    expect(items.map((x: any) => x.type)).toEqual(['video', 'photo'])
  })

  it('ids of ALL messages (both album and text) are kept — otherwise the post can\'t be removed', async () => {
    const res = await publish(['я'.repeat(1500)], [img(1), img(2), img(3)])
    // 3 album messages + at least one text message
    expect(res.messageIds!.length).toBeGreaterThanOrEqual(4)
    expect(new Set(res.messageIds).size).toBe(res.messageIds!.length)
  })
})

describe('Telegram: media tied to its own post', () => {
  let calls: TgCall[]
  const realFetch = globalThis.fetch
  beforeEach(() => { calls = mockBotApi() })
  afterAll(() => { globalThis.fetch = realFetch })

  it('each post gets its OWN files, not everything on the first', async () => {
    await publish(['Первый', 'Второй'], [img(1, 0), img(2, 1), img(3, 1)])
    const photo = calls.find((c) => c.method === 'sendPhoto')!
    const album = calls.find((c) => c.method === 'sendMediaGroup')!
    expect(photo.body.caption).toBe('Первый')
    expect(photo.body.photo).toContain('p1.jpg')
    expect(album.body.media[0].caption).toBe('Второй')
    expect(album.body.media.map((x: any) => x.media)).toEqual([
      expect.stringContaining('p2.jpg'), expect.stringContaining('p3.jpg'),
    ])
  })

  it('a post without attachments goes out as plain text', async () => {
    await publish(['С картинкой', 'Без картинки'], [img(1, 0)])
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendMessage'])
    expect(calls[1]!.body.text).toBe('Без картинки')
  })

  it('an attachment with an index beyond the thread isn\'t lost — it goes out with the last post', async () => {
    await publish(['Первый', 'Второй'], [img(9, 7)])
    const photo = calls.find((c) => c.method === 'sendPhoto')!
    expect(photo.body.caption).toBe('Второй')
  })
})
