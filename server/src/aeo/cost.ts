/**
 * Cost of a single LLM call in DOLLARS (USD).
 *
 * Port of the pricing part of scrapper/core/usage.py (PRICES_USD/PRICES_RUB/
 * FIXED_* + match_model + token_cost_rub), but the final result is computed
 * in dollars, not rubles.
 *
 * Dollar-priced providers (Anthropic/OpenAI/OpenRouter/Perplexity) are
 * computed directly from their USD per-token prices. Ruble-priced providers
 * (GigaChat, YandexGPT) and ruble-denominated fixed costs (Yandex Neuro,
 * DataForSEO SERP, the Exa web plugin, sonar/search fees) have no dollar
 * price of their own — they're billed in rubles, so they're converted to USD
 * by dividing by the USD_RUB rate (env, default 90). The rate here is only an
 * internal detail of converting ruble-priced providers to a single dollar
 * total; the number that comes out is always in dollars.
 *
 * Cost doesn't need to be precise (what matters is grouping by engine for
 * analytics), see the comment in usage.py:150.
 */
import { pyRound } from './text';

/** USD per 1M tokens (in, out) — copied verbatim from usage.py:152 (PRICES_USD). */
export const PRICES_USD: Record<string, readonly [number, number]> = {
  'claude-opus': [5.0, 25.0],
  'claude-sonnet': [3.0, 15.0],
  'claude-haiku': [1.0, 5.0],
  'gemini-pro': [1.5, 9.0],
  'gemini-flash': [0.3, 2.5],
  'gpt-mini': [0.15, 0.6], // gpt-4o-mini (+ search-preview: same token rate)
  deepseek: [0.2145, 0.3218],
  grok: [0.2, 0.5],
  sonar: [1.0, 1.0], // perplexity/sonar
};

/** RUB per 1M tokens — providers with ruble pricing (usage.py:164, PRICES_RUB). */
export const PRICES_RUB: Record<string, readonly [number, number]> = {
  gigachat: [200.0, 200.0], // GigaChat Lite ~0.2 RUB/1k
  yandexgpt: [200.0, 200.0], // yandexgpt-lite ~0.2 RUB/1k
};

/** Fixed cost per request in RUB (usage.py:169-174, FIXED_*_RUB). Converted to USD at compute time. */
export const FIXED_RUB = {
  sonar: 0.45, // perplexity/sonar — service search fee
  search: 0.45, // openai web search (gpt-4o-mini-search-preview / the Responses tool) — search fee
  xai_search: 6.75, // xAI Live Search: $25/1k sources × 3 sources at USD_RUB 90
  exa: 1.08, // Exa web plugin: 0.36 RUB/result × 3 (deepseek/grok full)
  dataforseo: 0.18, // SERP advanced — fallback when the envelope has no cost
  yandex_neuro: 5.08, // Neuro's generative answer (Yandex gen search)
} as const;

/** $→RUB rate (env USD_RUB, default 90). Resolved on every call — can be changed live. */
export function usdRub(): number {
  const v = Number(process.env.USD_RUB);
  return Number.isFinite(v) && v > 0 ? v : 90;
}

const has = (o: object, k: string): boolean =>
  Object.prototype.hasOwnProperty.call(o, k);

/** Any provider's model slug → pricing family. Unknown → ''. Port of match_model (usage.py:181). */
export function matchModel(model?: string | null): string {
  const m = (model || '').toLowerCase();
  if (!m) return '';
  if (m.includes('opus')) return 'claude-opus';
  if (m.includes('sonnet')) return 'claude-sonnet';
  if (m.includes('haiku')) return 'claude-haiku';
  if (m.includes('gemini')) return m.includes('pro') ? 'gemini-pro' : 'gemini-flash';
  // yandexgpt / gpt:// checked before generic gpt — otherwise gpt://…/yandexgpt-lite would land in gpt-mini.
  if (m.includes('yandexgpt') || m.startsWith('gpt://') || m.includes('alice'))
    return 'yandexgpt';
  if (m.includes('gpt')) return 'gpt-mini';
  if (m.includes('deepseek')) return 'deepseek';
  if (m.includes('grok')) return 'grok';
  if (m.includes('sonar') || m.includes('perplexity')) return 'sonar';
  if (m.includes('gigachat')) return 'gigachat';
  return '';
}

/**
 * Cost of a call in USD from tokens + the family's fixed fees. null if
 * neither tokens nor a fixed fee can be computed (background enrichment /
 * call-site fixed fee will fill it in later). Port of token_cost_rub
 * (usage.py:211), output in dollars. `provider` picks the search fee where the
 * same model family bills differently on the vendor API and on OpenRouter.
 */
export function tokenCostUsd(
  model: string | null | undefined,
  tokensIn: number | null | undefined,
  tokensOut: number | null | undefined,
  opts: { grounded?: boolean; provider?: string | null } = {},
): number | null {
  const fam = matchModel(model);
  const ti = tokensIn ? Math.trunc(Number(tokensIn)) : 0;
  const to = tokensOut ? Math.trunc(Number(tokensOut)) : 0;
  const rate = usdRub();
  let base: number | null = null;
  if (has(PRICES_USD, fam) && (ti || to)) {
    const [pin, pout] = PRICES_USD[fam];
    base = (ti * pin + to * pout) / 1_000_000; // price already in USD
  } else if (has(PRICES_RUB, fam) && (ti || to)) {
    const [pin, pout] = PRICES_RUB[fam];
    base = (ti * pin + to * pout) / 1_000_000 / rate; // RUB → USD
  }
  let add = 0;
  const ml = (model || '').toLowerCase();
  // Which search the call paid for depends on the ROUTE: the vendor API bills its
  // own search (xAI Live Search), OpenRouter bills the Exa plugin, and the DeepSeek
  // API has no search at all.
  const via = opts.provider || '';
  if (fam === 'sonar') add += FIXED_RUB.sonar / rate;
  else if (fam === 'gpt-mini' && (opts.grounded || ml.includes('search')))
    add += FIXED_RUB.search / rate;
  else if (via === 'xai' && opts.grounded) add += FIXED_RUB.xai_search / rate;
  else if ((fam === 'deepseek' || fam === 'grok') && opts.grounded && via !== 'deepseek')
    add += FIXED_RUB.exa / rate;
  if (base === null && add === 0) return null;
  return pyRound((base ?? 0) + add, 6);
}

/** A standalone fixed fee in USD (Yandex Neuro, DataForSEO SERP) — no tokens involved there. */
export function fixedCostUsd(kind: keyof typeof FIXED_RUB): number {
  return pyRound(FIXED_RUB[kind] / usdRub(), 6);
}
