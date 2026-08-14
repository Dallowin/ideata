/**
 * Official model price — the base for credits. Checks both sources and that
 * the price does not depend on the shape of the model slug or on the provider
 * entry the model came in through.
 */
import { getUnifiedCatalog } from '../blogwriter/server/utils/modelCatalog';
import { normModel, officialRub, officialUsd } from './official-price';

jest.mock('../blogwriter/server/utils/modelCatalog', () => ({
  getUnifiedCatalog: jest.fn(async () => ({
    models: [
      // both provider entries carry the vendor's list price
      { id: 'anthropic/claude-sonnet-5', provider: 'anthropic', inUsd: 3, outUsd: 15, label: '', format: 'claude', desc: '', context: null },
      { id: 'openai/gpt-5-mini', provider: 'openrouter', inUsd: 0.25, outUsd: 2, label: '', format: 'openai', desc: '', context: null },
      // in the catalog, but without a price — must not shadow the table
      { id: 'x-ai/grok-4.5', provider: 'openrouter', inUsd: null, outUsd: null, label: '', format: 'openai', desc: '', context: null },
    ],
    source: 'snapshot' as const,
    at: '2026-07-26T00:00:00.000Z',
  })),
}));

describe('normModel', () => {
  it('reduces different spellings of the same model to a common key', () => {
    expect(normModel('anthropic/claude-opus-4.8')).toBe('claudeopus48');
    expect(normModel('claude-opus-4-8')).toBe('claudeopus48');
    expect(normModel('gemini-3-5-flash')).toBe('gemini35flash');
    expect(normModel('google/gemini-3.5-flash')).toBe('gemini35flash');
  });
});

describe('officialUsd — price sources in order of trust', () => {
  it('takes the vendor list price from the catalog', async () => {
    await expect(officialUsd('anthropic/claude-sonnet-5')).resolves.toEqual({ inUsd: 3, outUsd: 15, source: 'openrouter' });
    await expect(officialUsd('openai/gpt-5-mini')).resolves.toEqual({ inUsd: 0.25, outUsd: 2, source: 'openrouter' });
  });

  it('a bare slug of the same model gets the same price', async () => {
    // that's exactly the rule: which route the call went through is not the client's concern
    await expect(officialUsd('claude-sonnet-5')).resolves.toMatchObject({ inUsd: 3, outUsd: 15 });
  });

  it('not in the catalog → local table of vendor prices', async () => {
    await expect(officialUsd('anthropic/claude-haiku-4.5')).resolves.toEqual({ inUsd: 1, outUsd: 5, source: 'table' });
    await expect(officialUsd('deepseek/deepseek-v3.2')).resolves.toMatchObject({ source: 'table' });
  });

  it('in the catalog but without a price → local table', async () => {
    await expect(officialUsd('x-ai/grok-4.5')).resolves.toEqual({ inUsd: 0.2, outUsd: 0.5, source: 'table' });
  });

  it('catalog unavailable → local table', async () => {
    (getUnifiedCatalog as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    await expect(officialUsd('anthropic/claude-sonnet-5')).resolves.toEqual({ inUsd: 3, outUsd: 15, source: 'table' });
  });

  it('completely unknown model → null', async () => {
    await expect(officialUsd('нечто/непонятное')).resolves.toBeNull();
    await expect(officialUsd('')).resolves.toBeNull();
  });
});

describe('officialRub — ₽ at the official price', () => {
  it('computes from the vendor list price', async () => {
    // 1000 in × $3/1M + 2000 out × $15/1M = $0.033 × 90 ₽ = 2.97 ₽
    await expect(officialRub('anthropic/claude-sonnet-5', 1000, 2000)).resolves.toBeCloseTo(2.97, 6);
    // the bare slug is the same model — same price
    await expect(officialRub('claude-sonnet-5', 1000, 2000)).resolves.toBeCloseTo(2.97, 6);
  });

  it('no tokens → null', async () => {
    await expect(officialRub('anthropic/claude-sonnet-5', null, null)).resolves.toBeNull();
  });
});
