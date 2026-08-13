/**
 * Tests for the deterministic pieces of the new crosspost channels.
 *
 * We check exactly what breaks silently and surfaces only on someone else's
 * platform: dev.to tag cleanup (422 with no meaningful message), character-limit
 * clipping, SSRF protection on the user-supplied address. Network calls aren't
 * mocked — they're thin wrappers over fetch, and a test's value would just be
 * checking the mocks.
 */
import { devtoTags } from './devtoPublish'
import { bskyText } from './blueskyPublish'
import { threadsAnnounce } from './threadsAnnounce'
import { checkPublicHttpsUrl } from './safeUrl'
import type { AppSettings } from './appSettings'
import { retryFetch } from './retryFetch'
import { TOOT_LIMIT, mastodonConfig, tootText } from './mastodonPublish'
import { ghostToken, parseAdminKey } from './ghostPublish'
import { htmlToNodes } from './telegraphPublish'
import { ChannelPick, listChannels } from './publishChannels'
import { PLATFORM_KEYS, platformProfile } from './pipeline/platformProfiles'
import { MEDIA_CAP, groupMediaByPost, mediaFileName, mediaPostIndex, readLocalMedia } from './crosspostMedia'

describe('devtoTags', () => {
  it('keeps only letters and digits: a hyphen is why dev.to returns 422', () => {
    expect(devtoTags('AI-видимость', 'brand monitoring')).toEqual(['ai', 'brand', 'monitoring'])
  })

  it('no more than four tags — the platform\'s hard limit', () => {
    expect(devtoTags('seo aeo geo llm ai marketing')).toHaveLength(4)
  })

  it('drops single-character tags and duplicates', () => {
    expect(devtoTags('ai a ai seo')).toEqual(['ai', 'seo'])
  })

  it('Cyrillic is dropped entirely, and that is expected', () => {
    expect(devtoTags('видимость бренда')).toEqual([])
  })
})

describe('bskyText', () => {
  const url = 'https://ideata.io/blog/test'

  it('a short title and link fit in whole', () => {
    const t = bskyText('Как измерить видимость', url)
    expect(t).toBe(`Как измерить видимость\n\n${url}`)
  })

  it('never exceeds the 300-grapheme limit', () => {
    const t = bskyText('я'.repeat(400), url)
    expect([...t].length).toBeLessThanOrEqual(300)
  })

  it('the link is never clipped — it always rides whole at the end', () => {
    const t = bskyText('я'.repeat(400), url)
    expect(t.endsWith(url)).toBe(true)
  })

  it('appends the lead if it fits together with the title', () => {
    const t = bskyText('Заголовок', url, 'Короткий лид')
    expect(t).toContain('Короткий лид')
  })
})

describe('threadsAnnounce', () => {
  const url = 'https://ideata.io/blog/test'

  it('a single post if everything fits — no need for a thread just for a thread\'s sake', () => {
    expect(threadsAnnounce('Заголовок', url)).toHaveLength(1)
  })

  it('a long title is clipped, the link moves to a second post', () => {
    const posts = threadsAnnounce('я'.repeat(600), url)
    expect(posts).toHaveLength(2)
    expect(posts[1]).toBe(url)
    expect([...posts[0]!].length).toBeLessThanOrEqual(480)
  })

  it('empty input produces no empty posts', () => {
    expect(threadsAnnounce('', '')).toEqual([])
  })
})

describe('checkPublicHttpsUrl', () => {
  it('a public domain passes and gets normalized', () => {
    expect(checkPublicHttpsUrl('example.com').url).toBe('https://example.com')
    expect(checkPublicHttpsUrl('https://blog.example.com/wp/').url).toBe('https://blog.example.com/wp')
  })

  it.each([
    ['https://192.168.0.5', 'internal network: our own Postgres'],
    ['https://127.0.0.1', 'loopback'],
    ['https://169.254.169.254', 'cloud metadata'],
    ['https://10.0.0.1', 'private subnet'],
    ['https://172.16.0.1', 'private subnet'],
    ['https://localhost', 'localhost'],
    ['https://[::1]', 'IPv6 loopback'],
  ])('blocks %s (%s)', (raw) => {
    expect(checkPublicHttpsUrl(raw).ok).toBe(false)
  })

  it('http is not allowed: secrets would go out in plain text', () => {
    expect(checkPublicHttpsUrl('http://example.com').ok).toBe(false)
  })

  it('a login with a password inside the address is rejected', () => {
    expect(checkPublicHttpsUrl('https://user:pass@example.com').ok).toBe(false)
  })

  it('a name without a dot is treated as intranet, rejected', () => {
    expect(checkPublicHttpsUrl('https://intranet').ok).toBe(false)
  })
})

describe('retryFetch: retry policy', () => {
  const wait = async () => {} // don't actually wait
  const reply = (status: number, headers: Record<string, string> = {}) =>
    new Response('{}', { status, headers })

  it('does not retry POST on a connection drop: the post may have been created, a duplicate is worse than an error', async () => {
    let calls = 0
    const out = await retryFetch(async () => { calls++; throw new Error('socket hang up') }, { method: 'POST', wait })
    expect(calls).toBe(1)
    expect(out).toEqual({ netError: 'socket hang up' })
  })

  it('retries GET on a connection drop: re-reading is safe', async () => {
    let calls = 0
    await retryFetch(async () => { calls++; throw new Error('reset') }, { method: 'GET', attempts: 2, wait })
    expect(calls).toBe(3)
  })

  it('retries 429 even for POST: the platform clearly created nothing', async () => {
    let calls = 0
    await retryFetch(async () => { calls++; return reply(429) }, { method: 'POST', attempts: 1, wait })
    expect(calls).toBe(2)
  })

  it('does not retry 500 on POST — the request may have gone through', async () => {
    let calls = 0
    await retryFetch(async () => { calls++; return reply(500) }, { method: 'POST', attempts: 2, wait })
    expect(calls).toBe(1)
  })

  it('succeeds on the first attempt — no retries', async () => {
    let calls = 0
    const out = await retryFetch(async () => { calls++; return reply(200) }, { method: 'POST', wait })
    expect(calls).toBe(1)
    expect('res' in out && out.res.status).toBe(200)
  })

  it('Retry-After is read and does not turn into forever', async () => {
    const waited: number[] = []
    await retryFetch(async () => reply(429, { 'retry-after': '99999' }), {
      method: 'GET', attempts: 1, wait: async (ms) => { waited.push(ms) },
    })
    expect(waited[0]).toBe(30_000)
  })
})

describe('Mastodon: announcement text', () => {
  const url = 'https://ideata.io/blog/test'

  it('the link is never clipped — a truncated URL is useless', () => {
    const t = tootText('я'.repeat(900), url)
    expect(t.endsWith(url)).toBe(true)
    expect([...t].length).toBeLessThanOrEqual(TOOT_LIMIT)
  })

  it('a short title stays whole', () => {
    expect(tootText('Заголовок', url)).toBe(`Заголовок\n\n${url}`)
  })

  it('an instance address on the internal network is not accepted', () => {
    const s = { mastodonEnabled: true, mastodonInstance: 'https://192.168.0.5', mastodonToken: 'tok' } as AppSettings
    expect(mastodonConfig(s).instance).toBe('')
    expect(mastodonConfig(s).ready).toBe(false)
  })
})

describe('Ghost: key and JWT', () => {
  const KEY = '640b1b1b1b1b1b1b1b1b1b1b:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

  it('parses an Admin API key of the form id:secret', () => {
    expect(parseAdminKey(KEY).id).toBe('640b1b1b1b1b1b1b1b1b1b1b')
  })

  it.each([
    ['640b:не-hex', 'secret is not hex'],
    ['простоключ', 'no colon'],
    [':0123abcd', 'empty id'],
  ])('rejects a malformed key %s (%s)', (raw) => {
    expect(parseAdminKey(raw).id).toBe('')
  })

  it('the JWT consists of three parts and carries kid + aud', () => {
    const t = ghostToken('kid123', '00ff', 1_700_000_000)
    const [h, p] = t.split('.')
    expect(t.split('.')).toHaveLength(3)
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString()).kid).toBe('kid123')
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString())
    expect(payload.aud).toBe('/admin/')
    expect(payload.exp - payload.iat).toBe(300) // lives 5 minutes, no longer
  })

  it('base64url without padding and without + /', () => {
    expect(ghostToken('k', 'ff', 1)).not.toMatch(/[+/=]/)
  })
})

describe('Telegraph: HTML → nodes', () => {
  it('headings collapse to the allowed h3/h4: their API doesn\'t know h1 and h2', () => {
    const n = htmlToNodes('<h1>А</h1><h2>Б</h2><h5>В</h5>') as any[]
    expect(n.map((x) => x.tag)).toEqual(['h3', 'h3', 'h4'])
  })

  it('an unknown tag unwraps into its content — text matters more than the wrapper', () => {
    const n = htmlToNodes('<span>текст</span>')
    expect(n).toEqual(['текст'])
  })

  it('scripts are dropped along with their content', () => {
    expect(htmlToNodes('<script>alert(1)</script><p>ок</p>')).toEqual([{ tag: 'p', children: ['ок'] }])
  })

  it('a link keeps its href, extra attributes are stripped', () => {
    expect(htmlToNodes('<a href="https://x.dev" onclick="hack()" class="c">т</a>'))
      .toEqual([{ tag: 'a', attrs: { href: 'https://x.dev' }, children: ['т'] }])
  })

  it('img without children survives: it\'s self-sufficient via src', () => {
    expect(htmlToNodes('<img src="/a.png" alt="a">')).toEqual([{ tag: 'img', attrs: { src: '/a.png' } }])
  })

  it('empty input yields a non-empty array: Telegraph rejects empty content', () => {
    expect(htmlToNodes('')).toEqual([''])
  })
})

describe('ChannelPick: one-off channel selection', () => {
  it('with no selection, all participate — old client and auto-publish keep working', () => {
    const p = new ChannelPick(undefined)
    expect(p.explicit).toBe(false)
    expect(p.wants('devto')).toBe(true)
    expect(p.wants('ghost')).toBe(true)
  })

  it('selected channels participate, the rest do not', () => {
    const p = new ChannelPick(['devto', 'telegram'])
    expect(p.wants('devto')).toBe(true)
    expect(p.wants('ghost')).toBe(false)
  })

  it('an empty array is a deliberate "nowhere", not "as usual"', () => {
    const p = new ChannelPick([])
    expect(p.explicit).toBe(true)
    expect(p.wants('devto')).toBe(false)
  })

  it('unknown keys are dropped and don\'t make the selection empty', () => {
    const p = new ChannelPick(['devto', 'myspace', ''])
    expect(p.wants('devto')).toBe(true)
    expect(p.wants('ghost')).toBe(false)
  })

  it('case and whitespace don\'t matter', () => {
    expect(new ChannelPick([' DevTo ']).wants('devto')).toBe(true)
  })
})

describe('listChannels: the backend computes readiness', () => {
  const base = { wpMode: 'app' } as AppSettings

  it('a channel without a key is not ready and explains why', () => {
    const dev = listChannels({ ...base, devtoEnabled: true } as AppSettings).find((c) => c.key === 'devto')!
    expect(dev.ready).toBe(false)
    expect(dev.enabled).toBe(true) // toggle is on, but there's nothing to publish with
    expect(dev.reason).toContain('key')
  })

  it('readiness doesn\'t depend on the toggle: a disabled but configured channel can still be picked once', () => {
    const dev = listChannels({ ...base, devtoEnabled: false, devtoApiKey: 'k' } as AppSettings).find((c) => c.key === 'devto')!
    expect(dev.ready).toBe(true)
    expect(dev.enabled).toBe(false)
    expect(dev.reason).toBeUndefined()
  })

  it('WordPress is ready both via app password and via OAuth', () => {
    const byApp = listChannels({ ...base, wpSiteUrl: 'https://a.com', wpUser: 'u', wpAppPassword: 'p' } as AppSettings)
    const byOauth = listChannels({ ...base, wpMode: 'oauth', wpSiteUrl: 'https://a.com', wpOauthToken: 't' } as AppSettings)
    expect(byApp.find((c) => c.key === 'wordpress')!.ready).toBe(true)
    expect(byOauth.find((c) => c.key === 'wordpress')!.ready).toBe(true)
  })

  it('an address on the internal network doesn\'t make the channel ready', () => {
    const gh = listChannels({ ...base, ghostSiteUrl: 'https://127.0.0.1', ghostAdminKey: 'a:ff' } as AppSettings)
      .find((c) => c.key === 'ghost')!
    expect(gh.ready).toBe(false)
  })
})

describe('Profiles for the new crosspost platforms', () => {
  it('Bluesky and Mastodon support threads and know their own limits', () => {
    const b = platformProfile('bluesky')!
    const m = platformProfile('mastodon')!
    expect(b.thread).toBe(true)
    expect(m.thread).toBe(true)
    // limits leave headroom below the technical 300 and 500: numbering still fits in
    expect(b.charLimit).toBeLessThan(300)
    expect(m.charLimit).toBeLessThan(500)
  })

  it('platform keys are unique — otherwise tabs would overwrite each other', () => {
    expect(new Set(PLATFORM_KEYS).size).toBe(PLATFORM_KEYS.length)
  })

  it('every platform has a name and a hint for the model', () => {
    for (const key of PLATFORM_KEYS) {
      const p = platformProfile(key)!
      expect(p.label.length).toBeGreaterThan(1)
      expect(p.guide.length).toBeGreaterThan(40)
    }
  })
})

describe('Crosspost media: the file name comes from the UI', () => {
  it('a regular name passes', () => {
    expect(mediaFileName('/blogwriter/crosspost-media/run1-17123.jpg')).toBe('run1-17123.jpg')
  })

  it('query and hash are stripped — they are not part of the name', () => {
    expect(mediaFileName('/blogwriter/crosspost-media/a.png?v=2#x')).toBe('a.png')
  })

  it.each([
    ['/blogwriter/crosspost-media/..%2Fsecret', 'percent-encoded traversal'],
    ['/blogwriter/crosspost-media/a b.png', 'space'],
    ['/blogwriter/crosspost-media/пост.jpg', 'Cyrillic'],
    ['/blogwriter/crosspost-media/..', 'bare "one level up"'],
    ['', 'empty'],
  ])('rejects %s (%s)', (url) => {
    expect(mediaFileName(url)).toBe('')
  })

  it('".." in the path collapses to a basename and doesn\'t escape the directory', () => {
    // we take the LAST segment, so ../../.env turns into .env inside the directory
    expect(mediaFileName('/blogwriter/crosspost-media/../../.env')).toBe('.env')
  })

  it('reading never throws and explains each skipped entry', () => {
    const out = readLocalMedia([
      { url: '/blogwriter/crosspost-media/../../.env', type: 'image' },
      { url: '/blogwriter/crosspost-media/нет-такого.jpg', type: 'image' },
      { url: '/blogwriter/crosspost-media/file.exe', type: 'image' },
    ])
    expect(out.files).toEqual([])
    expect(out.errors).toHaveLength(3)
  })

  it('more than MEDIA_CAP entries are not read: the cap must not depend solely on the controller', () => {
    // the cap is shared across the WHOLE THREAD (each post has its own attachments), the
    // platforms' per-post limits are already checked in the connectors
    const many = Array.from({ length: MEDIA_CAP + 5 }, () => ({ url: 'bad name', type: 'image' as const }))
    expect(readLocalMedia(many).errors).toHaveLength(MEDIA_CAP)
  })
})

describe('Per-post media: distribution across thread posts', () => {
  const m = (postIndex?: number) => ({ url: `/blogwriter/crosspost-media/a${postIndex ?? 'x'}.jpg`, postIndex })

  it('without postIndex the attachment goes to the first post — how the old client behaved', () => {
    const groups = groupMediaByPost([m(undefined)], 3)
    expect(groups[0]).toHaveLength(1)
    expect(groups[1]).toEqual([])
  })

  it('each attachment lands on its own post, order within the post is preserved', () => {
    const a = m(0), b = m(2), c = { ...m(2), url: 'second-of-post-3' }
    const groups = groupMediaByPost([a, b, c], 3)
    expect(groups.map((g) => g.length)).toEqual([1, 0, 2])
    expect(groups[2]!.map((x) => x.url)).toEqual([b.url, c.url])
  })

  it('an index beyond the thread is clamped to the last post, not lost', () => {
    // text gets edited more often than attachments: the post count shrinks — the image should survive
    const groups = groupMediaByPost([m(9)], 2)
    expect(groups[1]).toHaveLength(1)
  })

  it('garbage instead of a number is treated as the first post, not a crash', () => {
    const groups = groupMediaByPost([{ postIndex: -3 }, { postIndex: NaN }, { postIndex: 'два' as any }], 2)
    expect(groups[0]).toHaveLength(3)
  })

  it('there is always at least one bucket: a post may consist of images alone', () => {
    expect(groupMediaByPost([m(0)], 0)).toHaveLength(1)
  })

  it('readLocalMedia carries postIndex further, into the connectors', () => {
    // no files on disk, but the number normalization is still visible on bad entries
    expect(mediaPostIndex(undefined)).toBe(0)
    expect(mediaPostIndex('3')).toBe(3)
    expect(mediaPostIndex(2.7)).toBe(2)
  })
})

describe('listChannels: the full article is no longer sent to Telegram', () => {
  it('the telegram channel is not in the list — the 4096 limit turned the article into walls of text', () => {
    const keys = listChannels({ wpMode: 'app' } as AppSettings).map((c) => c.key)
    expect(keys).not.toContain('telegram')
    // the short channel post remains: it lives on the composer platform, not the article channel
    expect(PLATFORM_KEYS).toContain('tg')
  })
})
