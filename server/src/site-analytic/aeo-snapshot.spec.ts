/**
 * AEO recon inside the analysis: the runAeoSnapshotCore core (port of
 * _run_aeo_snapshot) on INJECTABLE providers + the LiveLlmLayer gate wrapper.
 * No live LLM/SERP burned — the entire non-deterministic layer is mocked.
 * Checks language/market, lite, fail-soft panelOnlyBlock, competitor validation
 * with a RE-parse of mentions, the aggregateFacts composition, seeding
 * monitoring through the store, and the note the panel-only block carries when
 * the engines stay silent.
 */
import { runAeoSnapshotCore, type AeoSnapshotDeps, type AeoSnapshotStore } from './aeo-snapshot';
import type { Facts, Raw } from './types';
import type { SnapshotAnswer } from '../aeo/run';

function mkFacts(over: Partial<Facts> = {}): Facts {
  return {
    competitors: [{ domain: 'seo1.com' }, { domain: 'seo2.com' }],
    crawl: { title: 'Acme', description: '', h1: '', hero_text: '' },
    meta: { domain: 'acme.com', compare: null, geo: 'us', seoSource: 'dataforseo', collectedAt: '' },
    ...over,
  } as unknown as Facts;
}
const RAW: Raw = { domain: 'acme.com', keywords: [{ keyword: 'acme tool' }], crawl: { title: 'Acme' } };

function mkAnswers(): SnapshotAnswer[] {
  return [{
    platform: 'claude', prompt: 'best acme tool', text: 'acme is great, rival is ok',
    citations: [{ url: 'https://acme.com/p', title: 'P' }],
    brands_found: [{ brand: 'acme.com', pos: 1 }], // before validation — only its own
  }];
}

function mkDeps(over: Partial<AeoSnapshotDeps> = {}): AeoSnapshotDeps {
  return {
    generatePrompts: jest.fn(async () => [
      { prompt: 'best acme tool', volume: 100, intent: 'best', topic: 't', source: 'real' },
    ]) as any,
    runSnapshot: jest.fn(async () => mkAnswers()) as any,
    sentimentBatch: jest.fn(async () => ({ 'acme.com': { score: 70, themes: [] } })) as any,
    judgeAnswers: jest.fn(async () => undefined) as any,
    buildCompetitors: jest.fn(async () => [
      { domain: 'rival.com', name: null, verdict: 'direct', mentions: 2 } as any,
    ]),
    onboardingCompetitors: jest.fn(async () => []),
    platformsFor: jest.fn(async (profile: string) => (profile === 'micro' ? ['claude'] : ['gemini'])),
    availablePlatforms: jest.fn(async (platforms: readonly string[]) => [...platforms]),
    promptCount: jest.fn(() => 50),
    ...over,
  };
}

describe('runAeoSnapshotCore — fail-soft', () => {
  it('engines returned empty → panelOnlyBlock, run=null', async () => {
    const deps = mkDeps({ runSnapshot: jest.fn(async () => []) as any });
    const res = await runAeoSnapshotCore('acme.com', mkFacts(), RAW, {}, deps);
    expect(res.run).toBeNull();
    expect((res.block as any).aeoStatus).toBe('engines_unavailable');
    // the note points at the keys the engines actually run on
    expect((res.block as any).aeoStatusNote).toContain('ANTHROPIC_API_KEY / OPENROUTER_API_KEY');
    expect((res.block as any).aiPromptsRows).toHaveLength(1); // panel is still returned
    expect(res.competitors).toBeUndefined();
  });
});

describe('runAeoSnapshotCore — happy path', () => {
  it('competitor validation + RE-parse of mentions + aggregateFacts', async () => {
    const deps = mkDeps();
    const res = await runAeoSnapshotCore('acme.com', mkFacts(), RAW, {}, deps);

    expect(res.competitors).toEqual([{ domain: 'rival.com', name: null, verdict: 'direct', mentions: 2 }]);
    expect((res.run as any).competitors).toEqual(['rival.com']);

    // RE-parse: the answer now contains rival.com too (by text), not just its own
    const bf = (res.run as any).answers[0].brands_found as Array<{ brand: string }>;
    expect(bf.map((b) => b.brand).sort()).toEqual(['acme.com', 'rival.com']);

    const block = res.block as any;
    expect(block.aiBrands.map((b: any) => b.brand)).toEqual(['acme.com', 'rival.com']);
    expect(block.aiPromptsRows).toHaveLength(1);
    expect(block.sentiment).toEqual([{ brand: 'acme.com', self: true, score: 70 }]);

    expect(deps.sentimentBatch).toHaveBeenCalled();
    expect(deps.judgeAnswers).toHaveBeenCalledWith(expect.any(Array), 'acme.com', ['rival.com']);
    expect(deps.buildCompetitors).toHaveBeenCalledWith(
      expect.objectContaining({ domain: 'acme.com', seoRows: [{ domain: 'seo1.com' }, { domain: 'seo2.com' }] }),
    );
  });

  it('English domain, little text → fallback en, market US (2840); grounded=true', async () => {
    const deps = mkDeps();
    await runAeoSnapshotCore('acme.com', mkFacts(), RAW, {}, deps);
    const call = (deps.runSnapshot as jest.Mock).mock.calls[0];
    expect(call[0]).toBe('acme.com');
    expect(call[2]).toEqual(['best acme tool']); // active prompts
    expect(call[3]).toMatchObject({ grounded: true, locationCode: 2840, languageCode: 'en' });
  });

  it('Russian content → Yandex market (2643, ru)', async () => {
    const deps = mkDeps();
    const ru = { title: 'Крауд-игры и ставки на скины, много русского текста здесь', description: '', h1: '', hero_text: '' };
    await runAeoSnapshotCore('shop.ru', mkFacts({ crawl: ru as any }), { ...RAW, crawl: ru } as Raw, {}, deps);
    expect((deps.runSnapshot as jest.Mock).mock.calls[0][3]).toMatchObject({ locationCode: 2643, languageCode: 'ru' });
  });
});

describe('runAeoSnapshotCore — lite', () => {
  it('panel of 10, micro+mid engines, grounded=false', async () => {
    const deps = mkDeps();
    await runAeoSnapshotCore('acme.com', mkFacts(), RAW, { lite: true }, deps);
    expect((deps.generatePrompts as jest.Mock).mock.calls[0][2]).toMatchObject({ n: 10 });
    expect(deps.platformsFor).toHaveBeenCalledWith('micro');
    expect(deps.platformsFor).toHaveBeenCalledWith('mid');
    const call = (deps.runSnapshot as jest.Mock).mock.calls[0];
    expect(call[3]).toMatchObject({ grounded: false });
    expect(call[3].platforms).toEqual(['claude', 'gemini']);
  });
});

describe('runAeoSnapshotCore — store (unified panel / monitoring seed)', () => {
  it('tracker found → panel sync, monitoring point, aliases into the run', async () => {
    const updateTrackerPrompts = jest.fn(async () => undefined);
    const seedMonitoring = jest.fn(async () => undefined);
    const store: AeoSnapshotStore = {
      effectivePlan: jest.fn(async () => 'pro'),
      findTracker: jest.fn(async () => ({ id: 7, prompts: [] })),
      brandAliases: jest.fn(async () => ['Акме']),
      promptPoolLeft: jest.fn(async () => null),
      updateTrackerPrompts,
      seedMonitoring,
    };
    const deps = mkDeps({ store });
    const res = await runAeoSnapshotCore('acme.com', mkFacts(), RAW, { userId: 42 }, deps);
    expect(res.block).toBeTruthy();
    expect(updateTrackerPrompts).toHaveBeenCalledWith(7, expect.any(Array));
    expect(seedMonitoring).toHaveBeenCalledWith(7, expect.any(Date), expect.any(Array), expect.any(Object));
    expect((deps.runSnapshot as jest.Mock).mock.calls[0][3].aliases).toEqual({ 'acme.com': ['Акме'] });
  });
});
