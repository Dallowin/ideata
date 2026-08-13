/**
 * Cost of an LLM call in USD (cost.ts). Expected values were TAKEN from live
 * Python (usage.token_cost_rub ÷ rate): at rate 90, cost_usd × 90 == Python's
 * cost_rub for every family — verified by cross-checking 16/16. These values
 * are pinned here as the regression baseline.
 */
import { tokenCostUsd, matchModel, fixedCostUsd, usdRub } from './cost';

describe('cost.ts — USD, parity with Python ÷ rate', () => {
  const prev = process.env.USD_RUB;
  beforeAll(() => {
    process.env.USD_RUB = '90';
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.USD_RUB;
    else process.env.USD_RUB = prev;
  });

  // [model, ti, to, grounded, expectedUsd, expectedFam] — taken from Python at rate 90
  const cases: Array<
    [string, number, number, boolean, number | null, string]
  > = [
    ['claude-opus-4', 1000, 500, false, 0.0175, 'claude-opus'],
    ['claude-sonnet', 2000, 1000, false, 0.021, 'claude-sonnet'],
    ['claude-haiku', 500, 0, false, 0.0005, 'claude-haiku'],
    ['gemini-2.5-pro', 0, 800, false, 0.0072, 'gemini-pro'],
    ['gemini-flash', 1200, 300, false, 0.00111, 'gemini-flash'],
    ['gpt-4o-mini', 900, 450, false, 0.000405, 'gpt-mini'],
    ['gpt-4o-mini-search-preview', 900, 450, true, 0.005405, 'gpt-mini'],
    ['deepseek-chat', 3000, 1500, true, 0.013126, 'deepseek'],
    ['grok-2', 1000, 1000, true, 0.0127, 'grok'],
    ['perplexity/sonar', 800, 400, false, 0.0062, 'sonar'],
    ['gigachat', 5000, 2500, false, 0.016667, 'gigachat'],
    ['yandexgpt-lite', 1000, 1000, false, 0.004444, 'yandexgpt'],
    ['gpt://folder/yandexgpt-lite', 1000, 1000, false, 0.004444, 'yandexgpt'],
    ['alice', 600, 600, false, 0.002667, 'yandexgpt'],
    ['deepseek-chat', 3000, 1500, false, 0.001126, 'deepseek'],
    ['unknown-xyz', 1000, 1000, false, null, ''],
  ];

  it.each(cases)(
    '%s (ti=%i,to=%i,grounded=%s) → $%s / fam=%s',
    (model, ti, to, grounded, expUsd, expFam) => {
      expect(matchModel(model)).toBe(expFam);
      expect(tokenCostUsd(model, ti, to, { grounded })).toBe(expUsd);
    },
  );

  it('no tokens and no fixed fee → null', () => {
    expect(tokenCostUsd('claude-opus', 0, 0)).toBeNull();
    expect(tokenCostUsd('claude-opus', null, null)).toBeNull();
  });

  it('null/empty model → null (fam empty)', () => {
    expect(matchModel(null)).toBe('');
    expect(matchModel('')).toBe('');
    expect(tokenCostUsd(null, 1000, 500)).toBeNull();
  });

  it('fixed fee without tokens: sonar 0/0 → only the search fee 0.45 RUB/90 = $0.005', () => {
    expect(tokenCostUsd('perplexity/sonar', 0, 0)).toBe(0.005);
  });

  it('grounded adds a fixed fee: gpt-mini search +0.45 RUB, deepseek/grok Exa +1.08 RUB', () => {
    // without grounded — tokens only; with grounded — plus the fixed fee (in USD)
    expect(tokenCostUsd('gpt-4o-mini', 900, 450, { grounded: false })).toBe(
      0.000405,
    );
    expect(tokenCostUsd('deepseek-chat', 3000, 1500, { grounded: false })).toBe(
      0.001126,
    );
  });

  it('standalone fixed fees in USD: Neuro 5.08 RUB, DataForSEO 0.18 RUB at rate 90', () => {
    expect(fixedCostUsd('yandex_neuro')).toBe(0.056444);
    expect(fixedCostUsd('dataforseo')).toBe(0.002);
  });

  it('the USD_RUB rate affects ruble providers and fixed fees', () => {
    process.env.USD_RUB = '100';
    expect(usdRub()).toBe(100);
    // gigachat 5000/2500 = (5000+2500)/1e6 * 200 RUB = 1.5 RUB → /100 = $0.015
    expect(tokenCostUsd('gigachat', 5000, 2500)).toBe(0.015);
    // a dollar-priced provider does NOT depend on the rate
    expect(tokenCostUsd('claude-opus-4', 1000, 500)).toBe(0.0175);
    process.env.USD_RUB = '90';
  });

  it('invalid/empty USD_RUB → defaults to 90', () => {
    process.env.USD_RUB = 'abc';
    expect(usdRub()).toBe(90);
    process.env.USD_RUB = '0';
    expect(usdRub()).toBe(90);
    process.env.USD_RUB = '90';
  });
});
