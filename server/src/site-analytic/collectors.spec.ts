/**
 * Unit tests for the network shell of the collectors (meta_ads / youtube /
 * entity_kg) over an INJECTED transport - we never hit the live APIs. The shape
 * of the happy-path output is verified in parity.spec.ts; here we cover the
 * key/token gates and failure isolation (the Python except->None / try/except:
 * pass branches), which are not part of the parity corpus.
 */
import { ads } from './meta-ads';
import { youtubeInterest } from './youtube';
import { brandEntity } from './entity-kg';
import type { HttpGet, JsonResp } from './http';

const ok = (body: unknown): JsonResp => ({ status: 200, body });

describe('meta_ads.ads - token gate and failure isolation', () => {
  const items = [{
    ad_creative_link_titles: ['H'], ad_creative_bodies: ['B'],
    ad_delivery_start_time: '2026-01-01', publisher_platforms: ['facebook'],
  }];

  it('no token -> null (UI shows "n/a"), no request is sent', async () => {
    const trap = jest.fn();
    expect(await ads('brand', { token: null, get: trap as unknown as HttpGet })).toBeNull();
    expect(trap).not.toHaveBeenCalled();
  });

  it('empty brand -> null', async () => {
    expect(await ads('', { token: 't', get: async () => ok({ data: items }) })).toBeNull();
  });

  it('request failed (get->null) -> null', async () => {
    expect(await ads('b', { token: 't', get: async () => null })).toBeNull();
  });

  it('HTTP≠200 → null', async () => {
    expect(await ads('b', { token: 't', get: async () => ({ status: 500, body: {} }) })).toBeNull();
  });

  it('non-JSON/non-object body -> null (r.json().get on a non-dict)', async () => {
    expect(await ads('b', { token: 't', get: async () => ok(null) })).toBeNull();
    expect(await ads('b', { token: 't', get: async () => ok([1, 2]) })).toBeNull();
  });

  it('token from env, happy path', async () => {
    process.env.META_ADS_TOKEN = 'env-tok';
    let seen: Record<string, unknown> | null | undefined;
    const out = await ads('b', {
      get: async (_u, p) => { seen = p; return ok({ data: items }); },
    });
    delete process.env.META_ADS_TOKEN;
    expect(seen?.access_token).toBe('env-tok');
    expect(out).toEqual([{ pl: 'Meta (Facebook)', h: 'H', t: 'B', since: 'янв 2026' }]);
  });
});

describe('youtube_interest - key gate and best-effort enrichment', () => {
  it('no API key -> null', async () => {
    const trap = jest.fn();
    expect(await youtubeInterest('q', { apiKey: null, get: trap as unknown as HttpGet })).toBeNull();
    expect(trap).not.toHaveBeenCalled();
  });

  it('search HTTP≠200 → null', async () => {
    expect(await youtubeInterest('q', { apiKey: 'k', get: async () => ({ status: 403, body: {} }) })).toBeNull();
  });

  it('non-object search body -> null', async () => {
    expect(await youtubeInterest('q', { apiKey: 'k', get: async () => ok('nope') })).toBeNull();
  });

  it('videos.list fails -> block still returned with empty fields (try/except: pass)', async () => {
    const get: HttpGet = async (url) => {
      if (url.includes('/search')) {
        return ok({ items: [{ id: { videoId: 'v1' } }], pageInfo: { totalResults: 3 } });
      }
      throw new Error('videos down');
    };
    const out = await youtubeInterest('q', { apiKey: 'k', get });
    expect(out).not.toBeNull();
    expect(out!.top_views).toBe(0);
    expect(out!.video_results).toBe(3);
    expect(out!.mentions).toHaveLength(1);
    expect(out!.mentions[0]).toMatchObject({
      url: 'https://youtube.com/watch?v=v1', views: null, subs: null, title: null,
    });
  });
});

describe('brand_entity - domain gate and the found/ambiguous branches', () => {
  const emptyGet: HttpGet = async () => ok({ search: [] });

  it('malformed domain -> null (dom is empty)', async () => {
    expect(await brandEntity('', { get: emptyGet })).toBeNull();
  });

  it('no candidates -> found:false, qid:null', async () => {
    const out = await brandEntity('nobody.io', { get: emptyGet });
    expect(out).toMatchObject({ found: false, domain: 'nobody.io', ambiguous: false, qid: null });
  });

  it('same-name entity with someone else\'s P856 -> found:true, ambiguous:true, no pageviews', async () => {
    const get: HttpGet = async (url, params) => {
      const p = params || {};
      if (url.includes('wikidata') && p.action === 'wbsearchentities') {
        return ok({ search: p.language === 'en' ? [{ id: 'Q9', label: 'Name' }] : [] });
      }
      if (url.includes('wikidata') && p.action === 'wbgetentities') {
        return ok({
          entities: {
            Q9: {
              claims: { P856: [{ mainsnak: { datavalue: { value: 'https://someoneelse.org/' } } }] },
              sitelinks: { enwiki: { title: 'Name (disambig)' } },
            },
          },
        });
      }
      return ok({}); // pageviews must not be called
    };
    const out = await brandEntity('mybrand.com', { get, langs: ['en', 'ru'] });
    expect(out).toMatchObject({
      found: true, domain: 'mybrand.com', domain_matches: false, ambiguous: true, qid: 'Q9',
    });
    expect('pageviews_30d' in (out as object)).toBe(false);
  });
});
