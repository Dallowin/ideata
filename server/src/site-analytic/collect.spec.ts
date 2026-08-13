/**
 * Structural test of the COLLECT orchestrator on mock ports: SEO-source choice
 * (RU by TLD / DataForSEO / data-driven RU fallback), propagation of the strongest
 * location's geo params into the tables, the compare gate on gap analysis, and
 * failure isolation (a failed source = null block, the analysis does not crash).
 */
import { collect, collectOverviews, safe, type CollectDeps } from './collect';

const overview = (etv: number) => ({
  organic_etv: etv, paid_etv: 0, total_traffic: etv,
  organic_keywords: 10, paid_keywords: 0, top3_rankings: 1,
  cpc_spend_usd: null, pos_dist: { '1-3': 1 },
});

function mkDeps(): CollectDeps {
  return {
    dfs: {
      domainOverview: jest.fn(async () => null),
      historicalOverview: jest.fn(async () => null),
      domainKeywords: jest.fn(async () => null),
      domainPages: jest.fn(async () => null),
      domainCompetitors: jest.fn(async () => null),
      domainBacklinks: jest.fn(async () => ({ backlinks: 1 })),
      backlinksAnchors: jest.fn(async () => null),
      backlinksHistory: jest.fn(async () => null),
      domainTechnologies: jest.fn(async () => null),
      domainGapKeywords: jest.fn(async () => null),
    },
    keysso: {
      domainOverview: jest.fn(async () => ({ total_traffic: 0 })),
      domainKeywords: jest.fn(async () => []),
      domainCompetitors: jest.fn(async () => []),
    },
    site: {
      similarweb: jest.fn(async () => null),
      pagespeed: jest.fn(async () => null),
      entity: jest.fn(async () => null),
      crawl: jest.fn(async () => null),
      ads: jest.fn(async () => null),
      youtube: jest.fn(async () => null),
      yandexSerp: jest.fn(async () => null),
      news: jest.fn(async () => null),
    },
  };
}

describe('safe — failure-isolation', () => {
  it('exception -> null, value -> passed through', async () => {
    expect(await safe('x', async () => { throw new Error('boom'); })).toBeNull();
    expect(await safe('x', async () => 42)).toBe(42);
  });
});

describe('collect - RU-by-TLD branch -> keys.so', () => {
  it('.ru goes through keys.so, dfs.domainOverview is not called', async () => {
    const deps = mkDeps();
    const raw = await collect('shop.ru', deps);
    expect(raw.seo_source).toBe('keysso');
    expect(deps.keysso.domainOverview).toHaveBeenCalledWith('shop.ru');
    expect(deps.keysso.domainKeywords).toHaveBeenCalledWith('shop.ru', 200);
    expect(deps.keysso.domainCompetitors).toHaveBeenCalledWith('shop.ru', 10);
    // backlinks/technologies do not depend on the SEO source, they go through DataForSEO
    expect(deps.dfs.domainBacklinks).toHaveBeenCalledWith('shop.ru');
    expect(deps.dfs.backlinksAnchors).toHaveBeenCalledWith('shop.ru');
    expect(deps.dfs.domainTechnologies).toHaveBeenCalledWith('shop.ru');
    expect(deps.dfs.domainOverview).not.toHaveBeenCalled();
    expect(raw.historical).toBeUndefined();
    expect(raw.overviews).toBeUndefined();
    // site-side is always collected (brand = 'shop')
    expect(deps.site.pagespeed).toHaveBeenCalledWith('shop.ru');
    expect(deps.site.youtube).toHaveBeenCalledWith('shop');
  });
});

describe('collect - DataForSEO branch (worldwide estimate)', () => {
  const OLD = process.env.AA_GEO_MARKETS;
  beforeEach(() => { process.env.AA_GEO_MARKETS = '3'; }); // US, IN, BR
  afterEach(() => { if (OLD === undefined) delete process.env.AA_GEO_MARKETS; else process.env.AA_GEO_MARKETS = OLD; });

  it('per-market overviews -> merge + geo_split + tables in the strongest location', async () => {
    const deps = mkDeps();
    (deps.dfs.domainOverview as jest.Mock).mockImplementation(async (_d: string, geo: any) =>
      geo?.locationCode === 2840 ? overview(5000) : null);
    const raw = await collect('acme.com', deps, {});

    expect(raw.seo_source).toBe('dataforseo');
    expect(deps.dfs.domainOverview).toHaveBeenCalledTimes(3);
    expect(raw.overviews).toEqual({ US: overview(5000) });
    expect((raw.overview as any).total_traffic).toBe(5000);
    expect(raw.geo_split).toEqual([{ code: 'US', etv: 5000 }]);
    // strongest location US -> [2840,'en'] propagated into the tables
    const g = { locationCode: 2840, languageCode: 'en' };
    expect(deps.dfs.historicalOverview).toHaveBeenCalledWith('acme.com', 12, g);
    expect(deps.dfs.domainKeywords).toHaveBeenCalledWith('acme.com', 200, g);
    expect(deps.dfs.domainPages).toHaveBeenCalledWith('acme.com', 20, g);
    expect(deps.dfs.domainCompetitors).toHaveBeenCalledWith('acme.com', 10, g);
    // Labs gives enough -> keys.so fallback is untouched; gap does not run without compare
    expect(deps.keysso.domainOverview).not.toHaveBeenCalled();
    expect(deps.dfs.domainGapKeywords).not.toHaveBeenCalled();
  });

  it('compare -> gap analysis is computed', async () => {
    const deps = mkDeps();
    (deps.dfs.domainOverview as jest.Mock).mockImplementation(async (_d: string, geo: any) =>
      geo?.locationCode === 2840 ? overview(5000) : null);
    await collect('acme.com', deps, { compare: 'rival.com' });
    expect(deps.dfs.domainGapKeywords).toHaveBeenCalledWith(
      'acme.com', 'rival.com', 30, { locationCode: 2840, languageCode: 'en' });
  });

  it('one market fails -> it simply drops out of overviews', async () => {
    const deps = mkDeps();
    (deps.dfs.domainOverview as jest.Mock).mockImplementation(async (_d: string, geo: any) => {
      if (geo?.locationCode === 2356) throw new Error('IN market down');
      return geo?.locationCode === 2840 ? overview(5000) : null;
    });
    const ov = await collectOverviews('acme.com', deps.dfs);
    expect(Object.keys(ov)).toEqual(['US']);
  });

  it('data-driven RU fallback: Labs is empty, keys.so sees 2x+ -> keysso', async () => {
    const deps = mkDeps();
    (deps.dfs.domainOverview as jest.Mock).mockImplementation(async (_d: string, geo: any) =>
      geo?.locationCode === 2840 ? overview(100) : null); // only 100 < 1000
    (deps.keysso.domainOverview as jest.Mock).mockResolvedValue({ total_traffic: 500 }); // 500 > max(200,100)
    const raw = await collect('acme.com', deps, {});

    expect(raw.seo_source).toBe('keysso');
    expect(raw.geo_split).toBeNull();
    expect(deps.keysso.domainKeywords).toHaveBeenCalledWith('acme.com', 200);
    expect(deps.dfs.historicalOverview).not.toHaveBeenCalled(); // took the keys.so branch
  });
});

describe('collect - per-block failure isolation', () => {
  it('failed sources -> null blocks, the analysis does not crash', async () => {
    const deps = mkDeps();
    (deps.keysso.domainOverview as jest.Mock).mockRejectedValue(new Error('keysso down'));
    (deps.dfs.domainBacklinks as jest.Mock).mockRejectedValue(new Error('bl down'));
    (deps.site.crawl as jest.Mock).mockRejectedValue(new Error('crawl down'));
    const raw = await collect('shop.ru', deps);
    expect(raw.overview).toBeNull();
    expect(raw.backlinks).toBeNull();
    expect(raw.crawl).toBeNull();
  });
});
