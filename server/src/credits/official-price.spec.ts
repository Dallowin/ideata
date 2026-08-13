/**
 * Official model price — the base for credits. Checks all three sources and
 * that the kie discount does NOT leak into the client's price.
 */
import { normModel, officialRub, officialUsd } from './official-price';

jest.mock('../blogwriter/server/utils/modelCatalog', () => ({
  getUnifiedCatalog: jest.fn(async () => ({
    models: [
      // vendor price (OpenRouter returns the vendor's price)
      { id: 'anthropic/claude-sonnet-5', provider: 'openrouter', inUsd: 3, outUsd: 15, label: '', format: 'openai', desc: '', context: null },
      { id: 'openai/gpt-5-mini', provider: 'openrouter', inUsd: 0.25, outUsd: 2, label: '', format: 'openai', desc: '', context: null },
      // same Sonnet, but via kie — three times cheaper
      { id: 'anthropic/claude-sonnet-5', provider: 'kie', inUsd: 0.85, outUsd: 4.275, label: '', format: 'anthropic', desc: '', context: null },
    ],
    source: 'snapshot' as const,
    at: '2026-07-26T00:00:00.000Z',
  })),
}));

jest.mock('../blogwriter/server/utils/kieCatalog', () => ({
  getKieCatalog: jest.fn(async () => ({
    models: [
      // opus only exists at kie, but the percentage of the official price is known
      { id: 'anthropic/claude-opus-4.8', kieSlug: 'claude-opus-4-8', label: '', format: 'claude', inUsd: 2, outUsd: 10, inCredits: null, outCredits: null, pctOfficial: 40 },
    ],
    scrapedAt: '2026-07-26T00:00:00.000Z',
    stale: false,
  })),
}));

describe('normModel', () => {
  it('reduces different spellings of the same model to a common key', () => {
    expect(normModel('anthropic/claude-opus-4.8')).toBe('claudeopus48');
    expect(normModel('claude-opus-4-8')).toBe('claudeopus48');
    expect(normModel('gemini-3-5-flash-openai')).toBe('gemini35flash');
    expect(normModel('google/gemini-3.5-flash')).toBe('gemini35flash');
  });
});

describe('officialUsd — price sources in order of trust', () => {
  it('takes OpenRouter\'s vendor price, not the cheaper kie one', async () => {
    await expect(officialUsd('anthropic/claude-sonnet-5')).resolves.toEqual({ inUsd: 3, outUsd: 15, source: 'openrouter' });
  });

  it('a kie slug of the same model also gets the vendor price', async () => {
    // that's exactly the rule: which provider the call went through is not the client's concern
    await expect(officialUsd('claude-sonnet-5')).resolves.toMatchObject({ inUsd: 3, outUsd: 15 });
  });

  it('not in OpenRouter → recovered from the kie percentage', async () => {
    // kie 2/10 at pctOfficial=40 → official 5/25
    await expect(officialUsd('anthropic/claude-opus-4.8')).resolves.toEqual({ inUsd: 5, outUsd: 25, source: 'kie-pct' });
  });

  it('not anywhere → local table of vendor prices', async () => {
    await expect(officialUsd('anthropic/claude-haiku-4.5')).resolves.toEqual({ inUsd: 1, outUsd: 5, source: 'table' });
    await expect(officialUsd('deepseek/deepseek-v3.2')).resolves.toMatchObject({ source: 'table' });
  });

  it('completely unknown model → null', async () => {
    await expect(officialUsd('нечто/непонятное')).resolves.toBeNull();
    await expect(officialUsd('')).resolves.toBeNull();
  });
});

describe('officialRub — ₽ at the official price', () => {
  it('computes from the vendor price, not from what we actually pay', async () => {
    // 1000 in × $3/1M + 2000 out × $15/1M = $0.033 × 90 ₽ = 2.97 ₽
    await expect(officialRub('anthropic/claude-sonnet-5', 1000, 2000)).resolves.toBeCloseTo(2.97, 6);
    // via kie the same call would cost 0.85/4.275 → 0.846 ₽, but the client pays the same price
    await expect(officialRub('claude-sonnet-5', 1000, 2000)).resolves.toBeCloseTo(2.97, 6);
  });

  it('no tokens → null', async () => {
    await expect(officialRub('anthropic/claude-sonnet-5', null, null)).resolves.toBeNull();
  });
});
