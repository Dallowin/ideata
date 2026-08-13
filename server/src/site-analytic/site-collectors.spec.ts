/**
 * DefaultSiteCollectors — the wiring of the site-side adapters. We only check the
 * collectors that are GATED by a key (similarweb/ads/youtube/yandexSerp): without
 * a key they return null BEFORE any network call, so we never touch live APIs.
 * entity/crawl/news/pagespeed are omitted deliberately — their happy path is
 * covered in the adapters' own unit tests with an injectable transport, whereas
 * here they would hit the real network.
 */
import { DefaultSiteCollectors } from './site-collectors';
import type { DiscoverSettings } from '../discover/settings';

function mkCollectors(values: Record<string, string> = {}) {
  const get = jest.fn(async (key: string) => values[key] ?? '');
  const settings = { get } as unknown as DiscoverSettings;
  return { site: new DefaultSiteCollectors(settings), get };
}

describe('DefaultSiteCollectors — key gate (no network)', () => {
  // Guard against an accidentally set environment (otherwise the adapter hits the network).
  const SNAP = { ...process.env };
  beforeEach(() => {
    delete process.env.RAPIDAPI_SIMILARWEB_HOST;
    delete process.env.RAPIDAPI_KEY;
    delete process.env.RAPIDAPI_PROXY_URL;
    delete process.env.META_ADS_TOKEN;
    delete process.env.YOUTUBE_API_KEY;
    delete process.env.YANDEX_SEARCH_API_KEY;
    delete process.env.YANDEX_CLOUD_FOLDER_ID;
  });
  afterEach(() => { process.env = { ...SNAP }; });

  it('similarweb: no host → null, keys read from settings', async () => {
    const { site, get } = mkCollectors();
    expect(await site.similarweb('acme.com')).toBeNull();
    expect(get).toHaveBeenCalledWith('RAPIDAPI_SIMILARWEB_HOST');
  });

  it('ads: no META_ADS_TOKEN → null', async () => {
    const { site, get } = mkCollectors();
    expect(await site.ads('acme')).toBeNull();
    expect(get).toHaveBeenCalledWith('META_ADS_TOKEN');
  });

  it('youtube: no YOUTUBE_API_KEY → null', async () => {
    const { site, get } = mkCollectors();
    expect(await site.youtube('acme')).toBeNull();
    expect(get).toHaveBeenCalledWith('YOUTUBE_API_KEY');
  });

  it('yandexSerp: no key/folder → null', async () => {
    const { site, get } = mkCollectors();
    expect(await site.yandexSerp('acme')).toBeNull();
    expect(get).toHaveBeenCalledWith('YANDEX_SEARCH_API_KEY');
    expect(get).toHaveBeenCalledWith('YANDEX_CLOUD_FOLDER_ID');
  });
});
