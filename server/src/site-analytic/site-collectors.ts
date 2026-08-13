/**
 * Default site-side collectors (port of _collect_site_side, site_analytic.py:179-213).
 * The blocks that do not depend on a search database: Similarweb panel, speed,
 * brand in the knowledge graph, crowd audit, ads, media (video/press SERP/news).
 *
 * We reuse what already exists: pagespeed = audit/index-checks.fetchCwv
 * (perf_score/lcp/cls/inp is exactly the shape normalize reads); crawl context =
 * aeo/crawl.crawlHomepage. The rest are native adapters of this module
 * (similarweb/entity-kg/meta-ads/youtube/yandex-serp/rss-mentions), each
 * best-effort: an unavailable source (no key/network failure) → null, exactly
 * like the failure isolation in Python.
 *
 * API keys come from DiscoverSettings (env → app_settings, the way Python reads
 * os.environ but with an admin override); the RapidAPI transport (proxy/key)
 * stays an infrastructure env var inside the adapter.
 */
import { Injectable } from '@nestjs/common';
import { fetchCwv } from '../audit/index-checks';
import { crawlHomepage } from '../aeo/crawl';
import { DiscoverSettings } from '../discover/settings';
import type { SiteSidePort } from './collect';
import { similarwebOverview } from './similarweb';
import { brandEntity } from './entity-kg';
import { ads as metaAds } from './meta-ads';
import { youtubeInterest } from './youtube';
import { yandexSerp } from './yandex-serp';
import { brandMentions } from './rss-mentions';

/** settings.get() returns '' when missing; map that to undefined so the option default applies. */
const orUndef = (v: string): string | undefined => v || undefined;

@Injectable()
export class DefaultSiteCollectors implements SiteSidePort {
  constructor(private readonly settings: DiscoverSettings) {}

  async similarweb(domain: string): Promise<any> {
    // Panel via the configurable RapidAPI wrapper: host/path/param come from
    // settings, transport (proxy/key) from env inside the adapter. No host →
    // the adapter returns null.
    const [host, path, param] = await Promise.all([
      this.settings.get('RAPIDAPI_SIMILARWEB_HOST'),
      this.settings.get('RAPIDAPI_SIMILARWEB_PATH'),
      this.settings.get('RAPIDAPI_SIMILARWEB_PARAM'),
    ]);
    return similarwebOverview(domain, {
      host: orUndef(host),
      path: orUndef(path),
      param: orUndef(param),
    });
  }

  async pagespeed(domain: string): Promise<any> {
    // The PSI key is optional (without it the public rate limit applies). Key comes from settings/env.
    const key = await this.settings.get('PAGESPEED_API_KEY');
    return fetchCwv(domain, key || '');
  }

  async entity(domain: string): Promise<any> {
    return brandEntity(domain); // Wikidata/Wikipedia — no keys needed
  }

  async crawl(domain: string): Promise<any> {
    return crawlHomepage(domain); // title/description/h1/hero_text/headings
  }

  async ads(brand: string): Promise<any> {
    const token = await this.settings.get('META_ADS_TOKEN');
    return metaAds(brand, { token: token || null });
  }

  async youtube(brand: string): Promise<any> {
    const key = await this.settings.get('YOUTUBE_API_KEY');
    return youtubeInterest(brand, { apiKey: key || null });
  }

  async yandexSerp(brand: string): Promise<any> {
    const [key, folder] = await Promise.all([
      this.settings.get('YANDEX_SEARCH_API_KEY'),
      this.settings.get('YANDEX_CLOUD_FOLDER_ID'),
    ]);
    return yandexSerp(brand, { apiKey: key || null, folderId: folder || null });
  }

  async news(brand: string, domain: string): Promise<any> {
    return brandMentions(brand, domain); // Google News RSS — no keys needed
  }
}
