/**
 * Attachments in Bluesky and Mastodon threads: EACH post has its own media.
 *
 * The whole embed/media_ids used to get hung on the first post — the "image
 * for the second point" ended up at the start of the thread, and the only way
 * to notice was in someone else's feed. We check the distribution by
 * postIndex and platforms' per-post limits (4 images for Bluesky, 4 images OR
 * 1 video for Mastodon).
 *
 * HTTP is stubbed out: the test's value is in the request body, not the network.
 */
import { bskyPublishThread } from './blueskyPublish'
import { mastodonPublishThread } from './mastodonPublish'
import type { AppSettings } from './appSettings'
import type { MediaFile } from './crosspostMedia'

interface Call { url: string; body: any }

const file = (name: string, postIndex: number, type: 'image' | 'video' = 'image'): MediaFile => ({
  name,
  mime: type === 'video' ? 'video/mp4' : 'image/jpeg',
  type,
  postIndex,
  bytes: Buffer.from('0123456789'),
})

/** Request bodies where they're JSON (uploads go as multipart — we count those by url). */
function record(calls: Call[], url: string, init: any) {
  let body: any = null
  try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : null } catch { /* multipart */ }
  calls.push({ url, body })
}

describe('Bluesky: embed on its own thread post', () => {
  const realFetch = globalThis.fetch
  const s = { blueskyHandle: 'brand.bsky.social', blueskyAppPassword: 'app-pass' } as AppSettings
  let calls: Call[]

  beforeEach(() => {
    calls = []
    ;(globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
      record(calls, String(url), init)
      if (String(url).includes('createSession')) {
        return new Response(JSON.stringify({ accessJwt: 'jwt', did: 'did:plc:me' }), { status: 200 })
      }
      if (String(url).includes('uploadBlob')) {
        return new Response(JSON.stringify({ blob: { $type: 'blob', ref: calls.length } }), { status: 200 })
      }
      return new Response(JSON.stringify({ uri: `at://did:plc:me/post/${calls.length}`, cid: `cid${calls.length}` }), { status: 200 })
    })
  })
  afterAll(() => { globalThis.fetch = realFetch })

  const records = () => calls.filter((c) => c.url.includes('createRecord'))

  it('the second post\'s image attaches to the SECOND post, not the first', async () => {
    const res = await bskyPublishThread(['Первый', 'Второй'], s, [file('b.jpg', 1)])
    expect(res.ok).toBe(true)
    const [first, second] = records()
    expect(first!.body.record.embed).toBeUndefined()
    expect(second!.body.record.embed.images).toHaveLength(1)
  })

  it('without postIndex the attachment stays on the first post — the old client doesn\'t break', async () => {
    await bskyPublishThread(['Первый', 'Второй'], s, [{ ...file('b.jpg', 0), postIndex: undefined as any }])
    expect(records()[0]!.body.record.embed.images).toHaveLength(1)
    expect(records()[1]!.body.record.embed).toBeUndefined()
  })

  it('the 4-image limit is counted PER POST: 4 in each post is not an overflow', async () => {
    const media = [0, 1].flatMap((p) => [0, 1, 2, 3].map((i) => file(`p${p}-${i}.jpg`, p)))
    const res = await bskyPublishThread(['Первый', 'Второй'], s, media)
    expect(records().every((r) => r.body.record.embed.images.length === 4)).toBe(true)
    expect(res.mediaError).toBeUndefined()
  })

  it('a fifth image on one post is dropped with a note, but the post still goes out', async () => {
    const res = await bskyPublishThread(['Один'], s, [0, 1, 2, 3, 4].map((i) => file(`x${i}.jpg`, 0)))
    expect(res.ok).toBe(true)
    expect(records()[0]!.body.record.embed.images).toHaveLength(4)
    expect(res.mediaError).toContain('4')
  })

  it('Bluesky doesn\'t accept video — says so with the post number', async () => {
    const res = await bskyPublishThread(['Первый', 'Второй'], s, [file('v.mp4', 1, 'video')])
    expect(res.ok).toBe(true)
    expect(res.mediaError).toContain('post 2')
  })
})

describe('Mastodon: media_ids on its own status', () => {
  const realFetch = globalThis.fetch
  const s = {
    mastodonInstance: 'https://mastodon.example.com',
    mastodonToken: 'tok',
  } as AppSettings
  let calls: Call[]

  beforeEach(() => {
    calls = []
    ;(globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
      record(calls, String(url), init)
      if (String(url).includes('/api/v2/media')) {
        // a non-empty url in the response = attachment ready, no processing poll will happen
        return new Response(JSON.stringify({ id: `m${calls.length}`, url: 'https://cdn/x.jpg' }), { status: 200 })
      }
      return new Response(JSON.stringify({ id: `s${calls.length}`, url: `https://mastodon.example.com/@brand/${calls.length}` }), { status: 200 })
    })
  })
  afterAll(() => { globalThis.fetch = realFetch })

  const statuses = () => calls.filter((c) => c.url.includes('/api/v1/statuses'))

  it('the second post\'s attachment goes out with the SECOND status', async () => {
    const res = await mastodonPublishThread(['Первый', 'Второй'], s, [file('a.jpg', 1)])
    expect(res.ok).toBe(true)
    expect(statuses()[0]!.body.media_ids).toBeUndefined()
    expect(statuses()[1]!.body.media_ids).toHaveLength(1)
  })

  it('statuses are stitched into a thread: the second replies to the first', async () => {
    const res = await mastodonPublishThread(['Первый', 'Второй'], s, [file('a.jpg', 1)])
    // the attachment upload wedges itself between statuses — the stitching must not be thrown off by that
    expect(statuses()[1]!.body.in_reply_to_id).toBe(res.ids[0])
  })

  it('the 4-attachment limit is per status, not per thread', async () => {
    const media = [0, 1].flatMap((p) => [0, 1, 2, 3].map((i) => file(`p${p}-${i}.jpg`, p)))
    const res = await mastodonPublishThread(['Первый', 'Второй'], s, media)
    expect(statuses().every((x) => x.body.media_ids.length === 4)).toBe(true)
    expect(res.mediaError).toBeUndefined()
  })

  it('video and images in one status are not mixed — video is skipped with a note', async () => {
    const res = await mastodonPublishThread(['Один'], s, [file('a.jpg', 0), file('v.mp4', 0, 'video')])
    expect(statuses()[0]!.body.media_ids).toHaveLength(1)
    expect(res.mediaError).toContain('video')
  })

  it('one video per status — the first is taken, the rest are noted', async () => {
    const res = await mastodonPublishThread(['Один'], s, [file('v1.mp4', 0, 'video'), file('v2.mp4', 0, 'video')])
    expect(statuses()[0]!.body.media_ids).toHaveLength(1)
    expect(res.mediaError).toContain('one video')
  })
})
