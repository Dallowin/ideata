/**
 * Snapshot orchestration (run.ts) on a MOCK provider: we don't burn live
 * engines — askPlatform is swapped for a jest mock, the DB (writeAnswers) uses
 * a mock blogPrisma accessor.
 *
 * We verify the contract of the run_snapshot port (aeo.py:2340): result order =
 * task order (cartesian prompt×platform) regardless of completion time; the
 * p-limit concurrency limit is respected; a failed/empty call is dropped, the
 * run doesn't crash; brands_found/citations are collected via parse.ts. Plus
 * the shape of aeo_answers rows (writeAnswers) and judge/sentiment enrichment.
 */

// Provider dispatcher: real exports (DEFAULT_PLATFORMS/RU_MARKET_… need to stay
// live), but askPlatform is mocked (we don't touch the network).
jest.mock('./providers/dispatcher', () => {
  const actual = jest.requireActual('./providers/dispatcher');
  return { ...actual, askPlatform: jest.fn() };
});

// Prisma accessor: writeAnswers writes via blogPrisma().aeoAnswer.createMany.
const mockCreateMany = jest.fn();
jest.mock('../blogwriter/server/utils/prisma', () => ({
  blogPrisma: jest.fn(() => ({
    aeoAnswer: { createMany: mockCreateMany },
    llmUsage: { create: jest.fn() },
  })),
  setBlogPrisma: jest.fn(),
}));

import { askPlatform } from './providers/dispatcher';
import { runSnapshot, judgeAnswers, sentimentBatch, type SnapshotAnswer } from './run';
import { writeAnswers } from './run-job';

const mockAsk = askPlatform as unknown as jest.Mock;

describe('runSnapshot — port of run_snapshot (aeo.py:2340)', () => {
  beforeEach(() => mockAsk.mockReset());

  it('result order = cartesian (outer prompt, inner platform), not by completion time', async () => {
    // Later tasks resolve earlier (random delay) — Promise.all must return by
    // INDEX, not by completion order.
    mockAsk.mockImplementation(
      (pl: string, pr: string) =>
        new Promise((res) =>
          setTimeout(() => res({ text: `${pl}|${pr}`, citations: [] }), Math.floor(Math.random() * 10)),
        ),
    );
    const res = await runSnapshot('brand.com', [], ['p0', 'p1', 'p2'], {
      platforms: ['claude', 'gemini'],
      maxWorkers: 4,
    });
    expect(res.map((r) => [r.prompt, r.platform])).toEqual([
      ['p0', 'claude'],
      ['p0', 'gemini'],
      ['p1', 'claude'],
      ['p1', 'gemini'],
      ['p2', 'claude'],
      ['p2', 'gemini'],
    ]);
    // text is passed through from askPlatform as-is
    expect(res[0].text).toBe('claude|p0');
  });

  it('the p-limit concurrency limit is respected', async () => {
    let active = 0;
    let peak = 0;
    mockAsk.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return { text: 'x', citations: [] };
    });
    // 3 platforms × 4 prompts = 12 tasks, workers max(4,min(24,4))=4.
    await runSnapshot('b.com', [], ['a', 'b', 'c', 'd'], {
      platforms: ['claude', 'gemini', 'perplexity'],
      maxWorkers: 4,
    });
    expect(mockAsk).toHaveBeenCalledTimes(12);
    expect(peak).toBeLessThanOrEqual(4); // limit not exceeded
    expect(peak).toBeGreaterThan(1); // and it actually ran in parallel
  });

  it('a failed call (throw) and an empty one (null) → dropped, the rest survive', async () => {
    mockAsk.mockImplementation(async (pl: string, pr: string) => {
      if (pl === 'claude' && pr === 'boom') throw new Error('kaboom'); // engine failed
      if (pl === 'gemini' && pr === 'empty') return null; // engine unavailable/empty
      return { text: `${pl}:${pr}`, citations: [] };
    });
    const res = await runSnapshot('b.com', [], ['boom', 'empty', 'ok'], {
      platforms: ['claude', 'gemini'],
      maxWorkers: 4,
    });
    // 6 tasks − 2 dropped = 4
    expect(res).toHaveLength(4);
    expect(res.find((r) => r.platform === 'claude' && r.prompt === 'boom')).toBeUndefined();
    expect(res.find((r) => r.platform === 'gemini' && r.prompt === 'empty')).toBeUndefined();
    // neighbors on the same prompts survived
    expect(res.find((r) => r.platform === 'gemini' && r.prompt === 'boom')).toBeDefined();
    expect(res.find((r) => r.platform === 'claude' && r.prompt === 'empty')).toBeDefined();
  });

  it('brands_found and citations are collected via parse.ts', async () => {
    mockAsk.mockResolvedValue({
      text: 'Попробуйте Notion, а ещё Obsidian — оба хороши.',
      // a dict with a url stays; a dict without url, an empty string, and a number are garbage, citeItems drops them
      citations: [
        { url: 'https://notion.so/help', title: 'Help' },
        { title: 'no-url' },
        '',
        5,
      ] as unknown[],
    });
    const res = await runSnapshot('notion.so', ['obsidian.md'], ['q'], {
      platforms: ['claude'],
      maxWorkers: 4,
    });
    expect(res).toHaveLength(1);
    const a = res[0];
    // parseBrands: stem 'notion' (pos 1) before 'obsidian' (pos 2); names = original brands
    expect(a.brands_found).toEqual([
      { brand: 'notion.so', pos: 1 },
      { brand: 'obsidian.md', pos: 2 },
    ]);
    // citeItems canonicalizes: only the entry with a url survives
    expect(a.citations).toEqual([{ url: 'https://notion.so/help', title: 'Help' }]);
  });

  it('no prompts → no tasks → empty run (no engine calls)', async () => {
    mockAsk.mockResolvedValue({ text: 't', citations: [] });
    const res = await runSnapshot('b.com', [], [], { platforms: ['claude'], maxWorkers: 4 });
    expect(res).toEqual([]);
    expect(mockAsk).not.toHaveBeenCalled();
  });
});

describe('writeAnswers — shape of aeo_answers rows (storage.insert_aeo_answers)', () => {
  beforeEach(() => {
    mockCreateMany.mockReset();
    mockCreateMany.mockResolvedValue({ count: 2 });
  });

  it('rows = (tracker_id,run_at,platform,prompt,raw_text,brands_found,citations,judge); createMany skipDuplicates', async () => {
    const runAt = new Date('2026-08-10T06:00:00.000Z');
    const answers: SnapshotAnswer[] = [
      {
        platform: 'claude',
        prompt: 'q1',
        text: 't1',
        citations: [{ url: 'https://x/y', title: '' }],
        brands_found: [{ brand: 'b', pos: 1 }],
        judge: {
          score: 70,
          sentiment: 'neutral',
          factuality: 80,
          relevance: 90,
          recommendation: 40,
          hallucination: 'low',
          reason: 'r',
        },
      },
      { platform: 'gemini', prompt: 'q2', text: 't2', citations: [], brands_found: [] },
    ];
    const n = await writeAnswers(7, runAt, answers, null);
    expect(n).toBe(2);
    expect(mockCreateMany).toHaveBeenCalledTimes(1); // no sentiment — a single insert
    const arg = mockCreateMany.mock.calls[0][0];
    expect(arg.skipDuplicates).toBe(true);
    expect(arg.data[0]).toMatchObject({
      trackerId: 7,
      runAt,
      platform: 'claude',
      prompt: 'q1',
      rawText: 't1',
      brandsFound: [{ brand: 'b', pos: 1 }],
      citations: [{ url: 'https://x/y', title: '' }],
    });
    expect(arg.data[0].judge).toMatchObject({ score: 70, recommendation: 40 });
    // answer without a judge → judge field omitted (NULL in the DB)
    expect(arg.data[1].judge).toBeUndefined();
  });

  it('sentiment — service row platform="_sentiment", prompt=""', async () => {
    mockCreateMany.mockResolvedValue({ count: 1 });
    await writeAnswers(
      7,
      new Date('2026-08-10T06:00:00.000Z'),
      [{ platform: 'claude', prompt: 'q', text: 't', citations: [], brands_found: [] }],
      { brand: { score: 55, themes: [] } },
    );
    expect(mockCreateMany).toHaveBeenCalledTimes(2); // answers + a separate sentiment row
    const sentArg = mockCreateMany.mock.calls[1][0];
    expect(sentArg.data[0]).toMatchObject({ trackerId: 7, platform: '_sentiment', prompt: '' });
    expect(sentArg.data[0].sentiment).toEqual({ brand: { score: 55, themes: [] } });
  });
});

describe('judgeAnswers — port of judge_answers (aeo.py:2232) via flash-JSON', () => {
  beforeEach(() => mockAsk.mockReset());

  it('fills in judge; sentiment only when the brand is mentioned; garbage is sanitized', async () => {
    mockAsk.mockImplementation(async (pl: string) =>
      pl === 'claude'
        ? {
            text: JSON.stringify({
              answers: {
                '0': {
                  score: 62,
                  sentiment: 'positive',
                  factuality: 80,
                  relevance: 90,
                  recommendation: 70,
                  hallucination: 'low',
                  reason: 'ok',
                },
                '1': { score: 50, sentiment: 'negative', hallucination: 'bad-value' },
              },
            }),
            citations: [],
          }
        : null,
    );
    const answers: SnapshotAnswer[] = [
      { platform: 'claude', prompt: 'q0', text: 'brand.com рулит', citations: [], brands_found: [{ brand: 'brand.com', pos: 1 }] },
      { platform: 'gemini', prompt: 'q1', text: 'нет упоминаний', citations: [], brands_found: [] },
    ];
    await judgeAnswers(answers, 'brand.com', [], { batchSize: 6 });
    expect(answers[0].judge).toMatchObject({
      score: 62,
      sentiment: 'positive',
      recommendation: 70,
      hallucination: 'low',
    });
    // brand NOT mentioned → sentiment null; invalid hallucination → 'med'; missing fields → 0
    expect(answers[1].judge).toMatchObject({
      score: 50,
      sentiment: null,
      hallucination: 'med',
      factuality: 0,
      recommendation: 0,
    });
  });

  it('AEO_JUDGE=0 disables the judge (engine is never called)', async () => {
    const prev = process.env.AEO_JUDGE;
    process.env.AEO_JUDGE = '0';
    const answers: SnapshotAnswer[] = [
      { platform: 'claude', prompt: 'q', text: 't', citations: [], brands_found: [] },
    ];
    await judgeAnswers(answers, 'b', []);
    expect(mockAsk).not.toHaveBeenCalled();
    expect(answers[0].judge).toBeUndefined();
    if (prev === undefined) delete process.env.AEO_JUDGE;
    else process.env.AEO_JUDGE = prev;
  });
});

describe('sentimentBatch — port of sentiment_batch (aeo.py:2153)', () => {
  beforeEach(() => mockAsk.mockReset());

  it('empty input → null', async () => {
    expect(await sentimentBatch({})).toBeNull();
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('flash-JSON → {brand:{score,themes}}: score is clamped, themes are sanitized and cut to 3', async () => {
    mockAsk.mockImplementation(async (pl: string) =>
      pl === 'claude'
        ? {
            text: JSON.stringify({
              brands: {
                'brand.com': {
                  score: 150,
                  themes: [
                    { t: 'быстро', tone: 'good' },
                    { t: '', tone: 'good' }, // empty label — dropped
                    { t: 'дорого', tone: 'weird' }, // invalid tone → neutral
                    { t: 'a', tone: 'bad' },
                    { t: 'b', tone: 'good' }, // fourth — cut off by the top-3 slice
                  ],
                },
              },
            }),
            citations: [],
          }
        : null,
    );
    const out = await sentimentBatch({ 'brand.com': ['t1', 't2'] });
    expect(out).not.toBeNull();
    expect(out!['brand.com'].score).toBe(100); // 150 → clamped to 100
    expect(out!['brand.com'].themes).toEqual([
      { t: 'быстро', tone: 'good' },
      { t: 'дорого', tone: 'neutral' },
      { t: 'a', tone: 'bad' },
    ]);
  });
});
