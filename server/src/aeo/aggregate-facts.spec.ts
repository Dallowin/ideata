/**
 * aggregate_facts (aeo.py:2386-2535) — the answers of ONE run → the AEO facts
 * block for the "AI Search" tab. A DIFFERENT shape than aggregateMonitoring
 * (a window): no trends, has estImpressions/promptIntents/citedPages. Values
 * are computed by hand following the Python logic (banker's rounding; stable
 * sorts; brand order [domain]+competitors[:5]). panel_only_block is fail-soft
 * when the engines return nothing.
 */
import { aggregateFacts, panelOnlyBlock, type FactAnswer, type AeoFactsBlock } from './aggregate';

const answers: FactAnswer[] = [
  {
    platform: 'claude', prompt: 'p1', text: 'acme и rival',
    brands_found: [{ brand: 'acme.com', pos: 1 }, { brand: 'rival.com', pos: 2 }],
    citations: [{ url: 'https://acme.com/a', title: 'A' }, { url: 'https://other.com/x', title: 'X' }],
    judge: { score: 80, sentiment: 'positive', recommendation: 70 },
  },
  {
    platform: 'gemini', prompt: 'p1', text: 'только rival',
    brands_found: [{ brand: 'rival.com', pos: 1 }],
    citations: [{ url: 'https://other.com/x', title: '' }],
    judge: { score: 60, sentiment: 'neutral', recommendation: 40 },
  },
  {
    platform: 'claude', prompt: 'p2', text: 'ни про кого',
    brands_found: [], citations: [], judge: { score: 50 },
  },
];

const promptMeta = {
  p1: { volume: 100, intent: 'best', topic: 't1' },
  p2: { volume: null, intent: 'reviews', topic: null },
};
const sentiment = {
  'acme.com': { score: 70, themes: [{ t: 'быстрый', tone: 'good' }] },
  'rival.com': { score: 40, themes: [] },
};

describe('aggregateFacts — run metrics', () => {
  const block = aggregateFacts(answers, 'acme.com', ['rival.com'], {
    platforms: ['claude', 'gemini'],
    sentiment,
    promptMeta,
  }) as AeoFactsBlock;

  it('empty input → {}', () => {
    expect(aggregateFacts([], 'acme.com', [])).toEqual({});
  });

  it('aiBrands: visibility by engine (round)', () => {
    expect(block.aiPlatforms).toEqual(['claude', 'gemini']);
    expect(block.aiBrands).toEqual([
      { brand: 'acme.com', self: true, vals: [50, 0] },
      { brand: 'rival.com', self: false, vals: [50, 100] },
    ]);
  });

  it('SoV/solution/judged', () => {
    expect(block.sovSelf).toBe(33); // round(100*1/3)
    expect(block.solutionRate).toBe(33); // 1 of 3 (rec>=60 for ans1)
    expect(block.solutionJudged).toBe(3);
    expect(block.solutionMinRec).toBe(60);
    expect(block.estImpressions).toBe(100); // p1 mentioned, vol 100; p2 not mentioned
    expect(block.foundNotCited).toBe(0);
  });

  it('citations: own / other pages / sources', () => {
    expect(block.citations).toEqual([{ url: 'https://acme.com/a', n: 1, title: 'A' }]);
    expect(block.citedPages).toEqual([
      { url: 'https://other.com/x', title: 'X', host: 'other.com', cat: 'Другое', n: 2 },
    ]);
    expect(block.citeSources).toEqual([
      { label: 'Другое', pct: 67 }, // 2/3
      { label: 'Свой сайт', pct: 33 }, // 1/3
    ]);
  });

  it('visibility by intent + sentiment', () => {
    expect(block.promptIntents).toEqual([
      { intent: 'best', label: expect.any(String), total: 1, mentioned: 1, vis: 100 },
      { intent: 'reviews', label: expect.any(String), total: 1, mentioned: 0, vis: 0 },
    ]);
    expect(block.sentiment).toEqual([
      { brand: 'acme.com', self: true, score: 70 },
      { brand: 'rival.com', self: false, score: 40 },
    ]);
    expect(block.sentThemes).toEqual({
      'acme.com': [{ t: 'быстрый', tone: 'good' }],
      'rival.com': [],
    });
  });

  it('prompt rows: mentioned comes first, judge is aggregated', () => {
    const rows = block.aiPromptsRows;
    expect(rows.map((r) => r.prompt)).toEqual(['p1', 'p2']); // mentioned p1 comes first
    expect(rows[0]).toMatchObject({
      prompt: 'p1', vol: 100, intent: 'best', topic: 't1', mentioned: true, pos: 1,
      platforms: ['claude'], judgeScore: 70, judgeSentiment: 'neutral', solution: true,
    });
    expect(rows[0].answers).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      prompt: 'p2', vol: null, intent: 'reviews', mentioned: false, pos: null,
      platforms: [], judgeScore: 50, judgeSentiment: null, solution: false,
    });
    expect(block.visTrend).toBeNull(); // trend is monitoring-only
  });
});

describe('aggregateFacts — foundNotCited', () => {
  it('brand is named, but its own site is not cited → +1', () => {
    const a: FactAnswer[] = [{
      platform: 'claude', prompt: 'q', text: 'acme',
      brands_found: [{ brand: 'acme.com', pos: 1 }],
      citations: [{ url: 'https://other.com/y', title: '' }],
    }];
    const block = aggregateFacts(a, 'acme.com', [], { platforms: ['claude'] }) as AeoFactsBlock;
    expect(block.foundNotCited).toBe(1);
    expect(block.citations).toBeNull(); // no own citations
  });
});

describe('panelOnlyBlock — fail-soft (engines did not respond)', () => {
  it('prompts + status/reason, zeroed metrics', () => {
    const panel = [
      { prompt: 'вопрос 1', volume: 10, intent: 'best', topic: 't' },
      { prompt: '', volume: null, intent: null, topic: null }, // empty prompt is filtered out
    ];
    const out = panelOnlyBlock(panel, ['claude', 'gemini'], { note: 'проверьте ключ' });
    expect(out.aeoStatus).toBe('engines_unavailable');
    expect(out.aeoStatusNote).toBe('проверьте ключ');
    expect(out.sovSelf).toBe(0);
    expect(out.aiBrands).toEqual([]);
    expect(out.aiPromptsRows).toEqual([
      { prompt: 'вопрос 1', vol: 10, intent: 'best', topic: 't', mentioned: false, pos: null, platforms: [], answers: [] },
    ]);
    expect(out.citations).toBeNull();
  });
});
