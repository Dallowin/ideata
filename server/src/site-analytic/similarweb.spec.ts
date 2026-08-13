/**
 * The Similarweb panel: deterministic parsing of the RapidAPI wrapper response
 * (parseSimilarweb) on synthetic input + the network shell (similarwebOverview)
 * over an INJECTED transport — we don't burn the paid RapidAPI. We cover the rich
 * and the minimal branches, the host/domain gate and failure isolation
 * (rapid→null).
 */
import { parseSimilarweb, similarwebOverview, normDomain, swf, type RapidGet } from './similarweb';

describe('normDomain / swf — Python odds and ends', () => {
  it('normDomain: URL/name → bare host', () => {
    expect(normDomain('https://calendly.com/x')).toBe('calendly.com');
    expect(normDomain('Calendly')).toBe('calendly');
    expect(normDomain('')).toBeNull();
    expect(normDomain(null)).toBeNull();
  });
  it('swf: float(x) or null', () => {
    expect(swf('0.508')).toBeCloseTo(0.508, 6);
    expect(swf(2)).toBe(2);
    expect(swf('')).toBeNull();
    expect(swf('abc')).toBeNull();
    expect(swf(null)).toBeNull();
    expect(swf([])).toBeNull();
  });
});

describe('parseSimilarweb — rich response', () => {
  const data = {
    domain_analytics: {
      Engagements: { Visits: 1000, BounceRate: '0.5', PagePerVisit: '3.4', TimeOnSite: '65' },
      TrafficSources: { Direct: '0.4', Search: '0.35' },
      EstimatedMonthlyVisits: { '2026-01-01': 900, '2026-03-01': 1100, '2026-02-01': 1000 },
      GlobalRank: { Rank: '1234' },
      CountryRank: { Rank: 50, CountryCode: 'US' },
      CategoryRank: { Rank: '10', Category: 'Business' },
      TopCountryShares: [{ country: 'United States', countryCode: 'US', Value: '0.6' }],
      TopKeywords: [{ Name: 'kw', Volume: '500', Cpc: '1.2', EstimatedValue: '600' }],
      AiTrafficDetails: { Traffic: { Split: [{ Name: 'ChatGPT', Rank: 1 }] } },
      Category: 'Business',
      LargeScreenshot: 'http://x',
    },
  };

  it('lays the panel out per the normalize contract', () => {
    const out = parseSimilarweb(data, 'acme.com')!;
    expect(out.domain).toBe('acme.com');
    expect(out.visits_monthly).toBe(1000);
    // history is sorted by the month key
    expect(out.visits_history).toEqual([
      { month: '2026-01-01', visits: 900 },
      { month: '2026-02-01', visits: 1000 },
      { month: '2026-03-01', visits: 1100 },
    ]);
    expect(out.engagement).toEqual({ bounce_rate: 50, pages_per_visit: 3.4, time_on_site_sec: 65 });
    expect(out.ranks).toEqual({ global: 1234, country: 50, country_code: 'US', category: 10, category_name: 'Business' });
    expect(out.channels).toEqual({ Direct: 40, Search: 35 });
    expect(out.geo).toEqual([{ country: 'United States', code: 'US', pct: 60 }]);
    expect(out.top_keywords).toEqual([{ keyword: 'kw', volume: 500, cpc: 1.2, est_value: 600 }]);
    expect(out.ai_traffic).toEqual([{ name: 'ChatGPT', rank: 1 }]);
    expect(out.category).toBe('Business');
    expect(out.screenshot).toBe('http://x');
  });

  it('"Engagments" (the wrapper typo) wins when present', () => {
    const d = { domain_analytics: { Engagments: { Visits: 7 }, TrafficSources: { Direct: '1' } } };
    const out = parseSimilarweb(d, 'a.com')!;
    expect(out.visits_monthly).toBe(7);
  });
});

describe('parseSimilarweb — minimal/empty response', () => {
  it('Visits only → visits-only block', () => {
    const out = parseSimilarweb({ domain_analytics: { Visits: '2000' } }, 'a.com')!;
    expect(out).toEqual({ domain: 'a.com', visits_monthly: 2000, raw: { domain_analytics: { Visits: '2000' } } });
  });
  it('da = data itself when there is no domain_analytics', () => {
    const out = parseSimilarweb({ Visits: '5' }, 'a.com')!;
    expect(out.visits_monthly).toBe(5);
  });
  it('minimal without visits → null', () => {
    expect(parseSimilarweb({ domain_analytics: { Visits: 0 } }, 'a.com')).toBeNull();
    expect(parseSimilarweb({}, 'a.com')).toBeNull();
    expect(parseSimilarweb(null, 'a.com')).toBeNull();
  });
});

describe('similarwebOverview — network shell (mock transport)', () => {
  it('no host → null, the transport is not called', async () => {
    const rapid = jest.fn();
    expect(await similarwebOverview('acme.com', { host: null, rapid: rapid as unknown as RapidGet })).toBeNull();
    expect(rapid).not.toHaveBeenCalled();
  });

  it('param=url → the value is a full URL; param=domain → a bare domain', async () => {
    const seenUrl: Record<string, unknown>[] = [];
    const rapid: RapidGet = async (_h, _p, query) => { seenUrl.push(query); return { domain_analytics: { Visits: 10 } }; };
    await similarwebOverview('acme.com', { host: 'h', param: 'url', rapid });
    await similarwebOverview('acme.com', { host: 'h', param: 'domain', rapid });
    expect(seenUrl[0]).toEqual({ url: 'https://acme.com' });
    expect(seenUrl[1]).toEqual({ domain: 'acme.com' });
  });

  it('rapid → null / empty → null', async () => {
    expect(await similarwebOverview('acme.com', { host: 'h', rapid: async () => null })).toBeNull();
    expect(await similarwebOverview('acme.com', { host: 'h', rapid: async () => ({}) })).toBeNull();
  });

  it('happy path: host+rapid → a parsed panel', async () => {
    const rapid: RapidGet = async () => ({ domain_analytics: { Visits: '300' } });
    const out = await similarwebOverview('acme.com', { host: 'h', rapid });
    expect(out).toMatchObject({ domain: 'acme.com', visits_monthly: 300 });
  });
});
