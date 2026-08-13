/**
 * Media in an X thread: media_ids attach to THEIR OWN tweet, the limit is
 * counted per tweet, and a scope failure is explained in words and doesn't
 * cancel publishing the text.
 *
 * HTTP is mocked: the value of the test is in the request body, not the
 * network. Prisma is mocked too — the connection itself isn't checked here,
 * only the shape of the requests.
 */
import { XService } from './x.service';
import type { MediaFile } from '../blogwriter/server/utils/crosspostMedia';

interface Call { url: string; body: any }

const file = (name: string, postIndex: number, type: 'image' | 'video' = 'image', mime?: string): MediaFile => ({
  name,
  mime: mime || (type === 'video' ? 'video/mp4' : 'image/jpeg'),
  type,
  postIndex,
  bytes: Buffer.from('0123456789'),
});

describe('X: media_ids on its own thread tweet', () => {
  const realFetch = globalThis.fetch;
  let calls: Call[];
  let svc: XService;
  /** status the upload responds with: 200 by default, 403 — token without media.write */
  let uploadStatus: number;

  beforeEach(() => {
    process.env.X_CLIENT_ID = 'cid';
    process.env.X_CLIENT_SECRET = 'secret';
    calls = [];
    uploadStatus = 200;
    svc = new XService();
    // a live token without a DB round-trip: expiry is far off, nothing to refresh
    (svc as any).prisma = {
      xConnection: {
        findUnique: async () => ({
          accessToken: 'tok',
          refreshToken: 'ref',
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        }),
      },
    };
    (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
      let body: any = null;
      try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : null } catch { /* multipart */ }
      calls.push({ url: String(url), body });
      if (String(url).includes('/2/media/upload')) {
        return uploadStatus === 200
          ? new Response(JSON.stringify({ data: { id: `m${calls.length}` } }), { status: 200 })
          : new Response(JSON.stringify({ detail: 'not permitted' }), { status: uploadStatus });
      }
      return new Response(JSON.stringify({ data: { id: `t${calls.length}` } }), { status: 200 });
    });
  });
  afterAll(() => { globalThis.fetch = realFetch });

  const tweets = () => calls.filter((c) => c.url.endsWith('/2/tweets'));
  const uploads = () => calls.filter((c) => c.url.includes('/2/media/upload'));

  it('the second post\'s image goes out with the SECOND tweet, not the first', async () => {
    const res = await svc.publishThread(1, ['First', 'Second'], [file('b.jpg', 1)]);
    expect(res.ok).toBe(true);
    expect(tweets()[0]!.body.media).toBeUndefined();
    expect(tweets()[1]!.body.media.media_ids).toHaveLength(1);
  });

  it('thread stitching does not break from an interleaved upload', async () => {
    const res = await svc.publishThread(1, ['First', 'Second'], [file('b.jpg', 1)]);
    expect(tweets()[1]!.body.reply.in_reply_to_tweet_id).toBe(res.ids[0]);
  });

  it('the 4-image limit is PER TWEET: 4 in each post is not an overflow', async () => {
    const media = [0, 1].flatMap((p) => [0, 1, 2, 3].map((i) => file(`p${p}-${i}.jpg`, p)));
    const res = await svc.publishThread(1, ['First', 'Second'], media);
    expect(tweets().every((t) => t.body.media.media_ids.length === 4)).toBe(true);
    expect(res.mediaError).toBeUndefined();
  });

  it('the fifth image of one tweet is dropped with a note, but the tweet still goes out', async () => {
    const res = await svc.publishThread(1, ['One'], [0, 1, 2, 3, 4].map((i) => file(`x${i}.jpg`, 0)));
    expect(res.ok).toBe(true);
    expect(tweets()[0]!.body.media.media_ids).toHaveLength(4);
    expect(res.mediaError).toContain('4');
  });

  it('a single GIF goes out alone with no siblings — the rest are noted', async () => {
    const res = await svc.publishThread(1, ['One'], [
      file('a.jpg', 0),
      file('g.gif', 0, 'image', 'image/gif'),
    ]);
    expect(tweets()[0]!.body.media.media_ids).toHaveLength(1);
    expect(res.mediaError).toContain('GIF');
  });

  it('video is not uploaded yet — we say so in words, no upload happens', async () => {
    const res = await svc.publishThread(1, ['One'], [file('v.mp4', 0, 'video')]);
    expect(res.ok).toBe(true);
    expect(uploads()).toHaveLength(0);
    expect(res.mediaError).toContain('video');
  });

  it('403 on upload = token without media.write: text is still published, reason points to reconnecting', async () => {
    uploadStatus = 403;
    const res = await svc.publishThread(1, ['One'], [file('a.jpg', 0)]);
    expect(res.ok).toBe(true);
    expect(tweets()[0]!.body.media).toBeUndefined();
    expect(res.mediaError).toContain('reconnect your X account');
  });
});
