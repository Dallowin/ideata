/**
 * Units for the LLM branches of competitors (extract/validate/build) on a STUB
 * LLM (askFlashJson isn't invoked — no network burned). The deterministic
 * branches (merge/filter/rank, host normalization) are checked in
 * parity.spec.ts against live Python with az=None. Here — that the port is
 * correct: counts frequencies over texts, cuts LLM junk, upgrades source
 * seo→ai, drops not_competitor, ranks direct before adjacent.
 */
import {
  extractAiBrands, validateCandidates, buildCompetitors,
  type AskJson, type CandidateRow,
} from './competitors';

/** Stub LLM: routes by a substring of the prompt (extract vs validate). */
function stub(brands: unknown, verdicts: unknown): AskJson {
  return async (p: string) => {
    if (p.includes('Выпиши БРЕНДЫ')) return { brands } as Record<string, unknown>;
    if (p.includes('Кандидаты в конкуренты')) return { verdicts } as Record<string, unknown>;
    return null;
  };
}

describe('extractAiBrands — frequencies over texts + filtering out LLM junk', () => {
  const answers = [
    { text: 'Try Notion and Obsidian for notes' },
    { text: 'Notion is great' },
    { text: 'Coda too' },
  ];
  const ask = stub(
    [
      { name: 'Notion', domain: 'notion.so' },
      { name: 'Obsidian', domain: '' },
      { name: 'Coda', domain: 'coda.io' },
      { name: 'Faketool', domain: '' }, // doesn't appear in the texts → discard
      { name: 'ab', domain: '' }, // shorter than 3 chars → discard
    ],
    {},
  );

  it('counts mentions by name/domain occurrence, sorts descending', async () => {
    const out = await extractAiBrands(answers, 'mytool.com', { ask });
    expect(out).toEqual([
      { name: 'Notion', domain: 'notion.so', mentions: 2 },
      { name: 'Obsidian', domain: '', mentions: 1 },
      { name: 'Coda', domain: 'coda.io', mentions: 1 },
    ]);
  });

  it('no answers → [] without calling the LLM', async () => {
    const spy = jest.fn(async () => ({ brands: [{ name: 'X' }] }));
    expect(await extractAiBrands([], 'd.com', { ask: spy })).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('LLM returned null (no key) → []', async () => {
    expect(await extractAiBrands(answers, 'd.com', { ask: async () => null })).toEqual([]);
  });

  it('excludes the user\'s own domain', async () => {
    const a = [{ text: 'self.com rocks and rival.com too' }];
    const out = await extractAiBrands(a, 'self.com', {
      ask: stub([{ name: 'Self', domain: 'self.com' }, { name: 'Rival', domain: 'rival.com' }], {}),
    });
    expect(out.map((b) => b.domain)).toEqual(['rival.com']);
  });
});

describe('validateCandidates — sanitizing verdicts', () => {
  const cands: CandidateRow[] = [
    { key: 'notion.so', domain: 'notion.so', name: 'Notion', traffic: null, growth: null, shared: null, dr: null, source: 'ai', mentions: 2, verdict: null, why: null },
    { key: 'coda.io', domain: 'coda.io', name: null, traffic: null, growth: null, shared: 3, dr: null, source: 'seo', mentions: 0, verdict: null, why: null },
  ];

  it('filters out an invalid verdict, trims why to 160 codepoints, lowercases the key', async () => {
    const longWhy = 'я'.repeat(200);
    const ask = stub({}, {
      'Notion.So': { verdict: 'direct', why: longWhy },
      'coda.io': { verdict: 'bogus', why: 'skip' },
      junk: { verdict: 'adjacent', why: '  trimmed  ' },
    });
    const out = await validateCandidates('mytool.com', 'about', cands, { ask });
    expect(Object.keys(out).sort()).toEqual(['junk', 'notion.so']);
    expect([...out['notion.so'].why].length).toBe(160);
    expect(out['notion.so'].verdict).toBe('direct');
    expect(out.junk).toEqual({ verdict: 'adjacent', why: 'trimmed' });
  });

  it('empty candidates → {} without the LLM', async () => {
    const spy = jest.fn(async () => ({ verdicts: {} }));
    expect(await validateCandidates('d.com', '', [], { ask: spy })).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('buildCompetitors — merging sources + verdicts (LLM branch)', () => {
  it('source seo→ai upgrades, not_competitor is dropped, direct ranks before adjacent', async () => {
    const ask = stub(
      [{ name: 'Notion', domain: 'notion.so' }, { name: 'Coda', domain: 'coda.io' }],
      {
        'notion.so': { verdict: 'direct', why: 'd' },
        'coda.io': { verdict: 'adjacent', why: 'a' },
        'owned.com': { verdict: 'not_competitor', why: 'no' },
      },
    );
    const out = await buildCompetitors({
      domain: 'mytool.com',
      about: 'notes',
      seoRows: [{ domain: 'coda.io', traffic: 100, shared: 3 }],
      answers: [{ text: 'Notion and Coda are alternatives' }],
      onboarding: ['owned.com'],
      ask,
    });
    expect(out).toEqual([
      {
        domain: 'notion.so', name: 'Notion', traffic: null, growth: null,
        shared: null, dr: null, source: 'ai', mentions: 1, verdict: 'direct', why: 'd',
      },
      {
        domain: 'coda.io', name: 'Coda', traffic: 100, growth: null,
        shared: 3, dr: null, source: 'ai', mentions: 1, verdict: 'adjacent', why: 'a',
      },
    ]);
  });

  it('validation failed → proceed without verdicts (fail-soft), onboarding is still direct', async () => {
    const ask: AskJson = async (p) => {
      if (p.includes('Кандидаты в конкуренты')) throw new Error('LLM down');
      return null;
    };
    const out = await buildCompetitors({
      domain: 'mytool.com', seoRows: [{ domain: 'rival.com', shared: 2 }],
      answers: [], onboarding: ['owned.com'], ask,
    });
    const byDomain = Object.fromEntries(out.map((r) => [r.domain, r]));
    expect(byDomain['owned.com'].verdict).toBe('direct');
    expect(byDomain['owned.com'].why).toBe('указан владельцем бренда');
    expect(byDomain['rival.com'].verdict).toBeNull(); // no verdict, but not dropped
  });
});
