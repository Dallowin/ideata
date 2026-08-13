import { normalize } from './normalize';
import type { Raw } from './types';

describe('normalize — spot checks on top of parity', () => {
  it('collectedAt — injecting a clock → ISO string; meta forwards the fields', () => {
    const raw: Raw = { domain: 'x.com', compare: 'y.com', geo: 'gb', seo_source: 'dataforseo' };
    const f = normalize(raw, () => new Date('2026-02-03T04:05:06Z'));
    expect(f.meta).toEqual({
      domain: 'x.com', compare: 'y.com', geo: 'gb', seoSource: 'dataforseo',
      collectedAt: '2026-02-03T04:05:06.000Z',
    });
  });

  it('empty raw data → deterministic nulls (visits/channels/geo)', () => {
    const f = normalize({ domain: 'empty.com', geo: 'us', seo_source: 'dataforseo' });
    expect(f.visits).toBeNull();
    expect(f.visitsSource).toBe('search');
    expect(f.trafficByChannel).toBeNull();
    expect(f.intents).toBeNull();
    expect(f.competitors).toBeNull();
    expect(f.plan).toBeNull();
  });

  it('intents — banker\'s rounding: 1/8 = 12.5% → 12 (not 13)', () => {
    // total volume = 8; INFO=1 → 12.5%, COMM=7 → 87.5%. pyRound(12.5)=12.
    const f = normalize({
      domain: 'r.com', geo: 'us', seo_source: 'dataforseo',
      keywords: [
        { keyword: 'a', intent: 'INFO', volume: 1, rank: 3, clicks: 1 },
        { keyword: 'b', intent: 'COMM', volume: 7, rank: 2, clicks: 2 },
      ],
    });
    expect(f.intents).toEqual([
      { label: 'Коммерческие', pct: 88 }, // pyRound(87.5)=88 (88 is even)
      { label: 'Информационные', pct: 12 }, // pyRound(12.5)=12 (12 is even) — Math.round would give 13
    ]);
  });

  it('the Similarweb panel overrides the search-based visits estimate', () => {
    const f = normalize({
      domain: 's.com', geo: 'us', seo_source: 'dataforseo',
      overview: { total_traffic: 5000, organic_etv: 5000, paid_etv: 0 },
      similarweb: { visits_monthly: 120000, engagement: { bounce_rate: 40 } },
    });
    expect(f.visits).toBe(120000);
    expect(f.visitsSource).toBe('similarweb');
    expect(f.searchVisits).toBe(5000); // the search-based estimate stays a separate field
    expect(f.bouncePct).toBe(40);
  });
});
