/**
 * Images in a LinkedIn post: one — a regular image post, two or more — a
 * multiImage carousel, video — skipped with a note for now. LinkedIn only
 * has ONE post, so postIndex has no effect here: attachments are collected
 * from all posts of the thread.
 *
 * HTTP and Prisma are mocked: we check the shape of the requests, not the
 * network or the DB.
 */
import { LinkedinService } from './linkedin.service';
import type { MediaFile } from '../blogwriter/server/utils/crosspostMedia';

interface Call { url: string; method: string; body: any }

const file = (name: string, type: 'image' | 'video' = 'image'): MediaFile => ({
  name,
  mime: type === 'video' ? 'video/mp4' : 'image/jpeg',
  type,
  postIndex: 0,
  bytes: Buffer.from('0123456789'),
});

describe('LinkedIn: images in a post', () => {
  const realFetch = globalThis.fetch;
  let calls: Call[];
  let svc: LinkedinService;
  /** initializeUpload status: 200 by default, 403 — no upload permission */
  let initStatus: number;

  beforeEach(() => {
    process.env.LINKEDIN_CLIENT_ID = 'cid';
    process.env.LINKEDIN_CLIENT_SECRET = 'secret';
    calls = [];
    initStatus = 200;
    svc = new LinkedinService();
    (svc as any).clientId = 'cid';
    (svc as any).clientSecret = 'secret';
    // a live token without a DB round-trip: expiry is far off, nothing to refresh
    (svc as any).prisma = {
      linkedinConnection: {
        findUnique: async () => ({
          accessToken: 'tok',
          refreshToken: 'ref',
          memberUrn: 'urn:li:person:42',
          orgUrn: null,
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          refreshExpiresAt: null,
        }),
      },
    };
    (globalThis as any).fetch = jest.fn(async (url: string, init: any) => {
      let body: any = null;
      try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : null } catch { /* bytes */ }
      calls.push({ url: String(url), method: String(init?.method || 'GET'), body });
      if (String(url).includes('action=initializeUpload')) {
        return initStatus === 200
          ? new Response(JSON.stringify({
              value: { uploadUrl: `https://upload.li/${calls.length}`, image: `urn:li:image:${calls.length}` },
            }), { status: 200 })
          : new Response('{}', { status: initStatus });
      }
      if (String(url).startsWith('https://upload.li/')) return new Response(null, { status: 201 });
      return new Response('{}', { status: 201, headers: { 'x-restli-id': 'urn:li:share:1' } });
    });
  });
  afterAll(() => { globalThis.fetch = realFetch });

  const post = () => calls.find((c) => c.url.endsWith('/rest/posts'))!;
  const puts = () => calls.filter((c) => c.method === 'PUT');

  it('one image — a regular image post, not a carousel', async () => {
    const res = await svc.publish(1, 'Text', [file('a.jpg')]);
    expect(res.ok).toBe(true);
    expect(post().body.content.media.id).toMatch(/^urn:li:image:/);
    expect(post().body.content.multiImage).toBeUndefined();
    expect(puts()).toHaveLength(1);
  });

  it('two or more — multiImage with all URNs in order', async () => {
    const res = await svc.publish(1, 'Text', [file('a.jpg'), file('b.jpg'), file('c.jpg')]);
    expect(res.ok).toBe(true);
    expect(post().body.content.multiImage.images).toHaveLength(3);
    expect(post().body.content.media).toBeUndefined();
  });

  it('the image owner is set to the post author', async () => {
    await svc.publish(1, 'Text', [file('a.jpg')]);
    const init = calls.find((c) => c.url.includes('action=initializeUpload'))!;
    expect(init.body.initializeUploadRequest.owner).toBe('urn:li:person:42');
    expect(post().body.author).toBe('urn:li:person:42');
  });

  it('video is not uploaded yet — text still goes out, reason is in mediaError', async () => {
    const res = await svc.publish(1, 'Text', [file('v.mp4', 'video')]);
    expect(res.ok).toBe(true);
    expect(post().body.content).toBeUndefined();
    expect(res.mediaError).toContain('video');
  });

  it('the tenth image is dropped with a note, the post goes out with nine', async () => {
    const media = Array.from({ length: 10 }, (_, i) => file(`x${i}.jpg`));
    const res = await svc.publish(1, 'Text', media);
    expect(post().body.content.multiImage.images).toHaveLength(9);
    expect(res.mediaError).toContain('9');
  });

  it('403 on upload: text is still published, reason points to reconnecting', async () => {
    initStatus = 403;
    const res = await svc.publish(1, 'Text', [file('a.jpg')]);
    expect(res.ok).toBe(true);
    expect(post().body.content).toBeUndefined();
    expect(res.mediaError).toContain('reconnect your LinkedIn account');
  });
});
