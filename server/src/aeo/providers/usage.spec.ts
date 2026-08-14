/**
 * AEO usage accounting (usage.ts): dollar cost per entry (costUsdFor) + run context
 * (runContext/platformContext via AsyncLocalStorage) + recordUsage safety (doesn't
 * throw without an initialized prisma). Cost is checked against cost.ts (the same
 * values as cost.spec, derived from Python ÷ a 90 exchange rate).
 */
import { costUsdFor, currentUsage, recordUsage, runContext, platformContext, withUsage, shortError } from '../usage';

describe('costUsdFor — dollar price of a usage entry', () => {
  const prev = process.env.USD_RUB;
  beforeAll(() => {
    process.env.USD_RUB = '90';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.USD_RUB;
    else process.env.USD_RUB = prev;
  });

  it('success by tokens: claude-haiku 500/0 → $0.0005', () => {
    expect(costUsdFor({ provider: 'anthropic', model: 'claude-haiku', tokensIn: 500, tokensOut: 0, status: 'ok' })).toBe(0.0005);
  });
  it('tokens are priced by the model, whichever route served it: gemini-flash 1000/1000 → $0.0028', () => {
    expect(costUsdFor({ provider: 'google', model: 'gemini-3.5-flash', tokensIn: 1000, tokensOut: 1000, status: 'ok' })).toBe(0.0028);
    expect(costUsdFor({ provider: 'openrouter', model: 'google/gemini-3.5-flash', tokensIn: 1000, tokensOut: 1000, status: 'ok' })).toBe(0.0028);
  });
  it('grounded adds a fixed fee: gpt-mini search 900/450 → $0.005405', () => {
    expect(costUsdFor({ provider: 'openrouter', model: 'gpt-4o-mini-search-preview', tokensIn: 900, tokensOut: 450, grounded: true, status: 'ok' })).toBe(0.005405);
  });
  it('the search fee follows the route: grounded xai → xAI Live Search, not the Exa plugin', () => {
    expect(costUsdFor({ provider: 'xai', model: 'grok-4.3', tokensIn: 1000, tokensOut: 1000, grounded: true, status: 'ok' })).toBe(0.0757);
    expect(costUsdFor({ provider: 'openrouter', model: 'x-ai/grok-4.3', tokensIn: 1000, tokensOut: 1000, grounded: true, status: 'ok' })).toBe(0.0127);
  });
  it('grounded deepseek on the vendor API → tokens only (it has no search there)', () => {
    expect(costUsdFor({ provider: 'deepseek', model: 'deepseek-chat', tokensIn: 3000, tokensOut: 1500, grounded: true, status: 'ok' })).toBe(0.001126);
  });
  it('openai/perplexity native are billed exactly like the OpenRouter route', () => {
    expect(costUsdFor({ provider: 'openai', model: 'gpt-4o-mini', tokensIn: 900, tokensOut: 450, grounded: true, status: 'ok' })).toBe(0.005405);
    expect(costUsdFor({ provider: 'perplexity', model: 'sonar', tokensIn: 800, tokensOut: 400, status: 'ok' })).toBe(0.0062);
  });
  it('an explicit fixed cost (Neuro/AIO) is respected as-is, even with no tokens', () => {
    expect(costUsdFor({ provider: 'yandex', model: 'neuro-search', costUsd: 0.056444 })).toBe(0.056444);
    expect(costUsdFor({ provider: 'dataforseo', model: '/v3/...', costUsd: 0.002 })).toBe(0.002);
  });
  it('an error with no explicit cost → null (a failed call spends no money)', () => {
    expect(costUsdFor({ provider: 'anthropic', model: 'claude-haiku', tokensIn: 500, tokensOut: 0, status: 'error' })).toBeNull();
  });
  it('an explicit cost on an ERROR is respected (DataForSEO bills even on a task error)', () => {
    expect(costUsdFor({ provider: 'dataforseo', model: '/v3/...', status: 'error', costUsd: 0.002 })).toBe(0.002);
  });
  it('unknown model, success, tokens present → null (outside the price list)', () => {
    expect(costUsdFor({ provider: 'openrouter', model: 'unknown-xyz', tokensIn: 1000, tokensOut: 1000, status: 'ok' })).toBeNull();
  });
  it('default status is ok: we bill by tokens', () => {
    expect(costUsdFor({ provider: 'gigachat', model: 'GigaChat', tokensIn: 5000, tokensOut: 2500 })).toBe(0.016667);
  });
});

describe('run context (port of run_context/platform_context via ALS)', () => {
  it('runContext sets kind=aeo_run, id, purpose; platformContext adds the slug', () => {
    runContext('run-42', () => {
      expect(currentUsage()).toMatchObject({ runKind: 'aeo_run', runId: 'run-42', purpose: 'aeo_run' });
      platformContext('claude', () => {
        expect(currentUsage()).toMatchObject({ runKind: 'aeo_run', runId: 'run-42', platform: 'claude' });
      });
      // nested context torn down — platform is gone again
      expect(currentUsage().platform).toBeUndefined();
    });
  });
  it('context is empty outside a run', () => {
    expect(currentUsage()).toEqual({});
  });
  it('runContext forwards userId/domain and a numeric id → string', () => {
    runContext(7, () => {
      expect(currentUsage()).toMatchObject({ runId: '7', userId: 11, domain: 'x.io' });
    }, { userId: 11, domain: 'x.io' });
  });
  it('withUsage merges on top of the current context', () => {
    runContext('r', () => {
      withUsage({ platform: 'gemini' }, () => {
        expect(currentUsage()).toMatchObject({ runId: 'r', platform: 'gemini' });
      });
    });
  });
});

describe('recordUsage — safety (accounting must not bring down a run)', () => {
  it('does not throw without an initialized prisma (blogPrisma throw is swallowed)', () => {
    expect(() => recordUsage({ provider: 'anthropic', model: 'claude-haiku', tokensIn: 1, tokensOut: 1, status: 'ok' })).not.toThrow();
  });
  it('a call inside a context does not throw', () => {
    expect(() =>
      runContext('r1', () => platformContext('claude', () => recordUsage({ provider: 'anthropic', status: 'error', error: 'HTTP 500' }))),
    ).not.toThrow();
  });
});

describe('shortError — short error code (port of usage.short_error)', () => {
  it('status → code; timeout/connect → category; otherwise the class name', () => {
    expect(shortError({ status: 402 })).toBe('402');
    expect(shortError(new Error('request timeout after 90s'))).toBe('timeout');
    expect(shortError(new Error('ECONNREFUSED connect'))).toBe('connect');
    expect(shortError(new TypeError('boom'))).toBe('TypeError');
  });
});
