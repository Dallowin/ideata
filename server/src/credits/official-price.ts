/**
 * OFFICIAL model price — the base for credits.
 *
 * Credits are priced off the vendor's list price (Anthropic/OpenAI/Google/xAI):
 * 1 credit = 1 ₽ of official cost, regardless of the route a call actually
 * took. What a call really cost is a different number and lives separately, in
 * llm_usage.cost_rub (llmUsage.costRubLive), for cost reporting.
 *
 * Sources for the official price, in order of trust:
 *   a) the shared model catalog — its prices are the vendor's list prices,
 *      whichever provider entry a model came in through;
 *   b) the local table below — in case the catalog is unavailable.
 */
import { getUnifiedCatalog } from '../blogwriter/server/utils/modelCatalog';

export const USD_RUB = 90;

export interface OfficialUsd {
  inUsd: number;
  outUsd: number;
  /** where the price came from — visible in the charge metadata */
  source: 'openrouter' | 'table';
}

/**
 * Official vendor prices, $ per 1M tokens [in, out]. Matched by slug
 * substring. Order matters: specific patterns before general ones.
 */
const LIST_USD_PER_1M: Array<{ match: RegExp; in: number; out: number }> = [
  { match: /opus/i, in: 5, out: 25 },
  { match: /sonnet/i, in: 3, out: 15 },
  { match: /haiku/i, in: 1, out: 5 },
  { match: /gemini[\w.-]*flash[\w.-]*lite/i, in: 0.1, out: 0.4 },
  { match: /gemini[\w.-]*flash/i, in: 0.3, out: 2.5 },
  { match: /gemini[\w.-]*pro/i, in: 1.25, out: 10 },
  { match: /gpt[\w.-]*nano/i, in: 0.05, out: 0.4 },
  { match: /gpt[\w.-]*mini/i, in: 0.25, out: 2 },
  { match: /gpt/i, in: 1.25, out: 10 },
  { match: /grok/i, in: 0.2, out: 0.5 },
  { match: /deepseek/i, in: 0.25, out: 0.95 },
  { match: /qwen/i, in: 0.32, out: 1.28 },
  { match: /kimi/i, in: 0.6, out: 2.5 },
];

/** "anthropic/claude-opus-4.8", "claude-opus-4-8" → "claudeopus48" */
export function normModel(id: string): string {
  return String(id || '')
    .toLowerCase()
    .replace(/^[\w.-]+\//, '')     // vendor prefix
    .replace(/[^a-z0-9]/g, '');
}

function fromTable(model: string): OfficialUsd | null {
  const p = LIST_USD_PER_1M.find((x) => x.match.test(model || ''));
  return p ? { inUsd: p.in, outUsd: p.out, source: 'table' } : null;
}

/** Official model price ($/1M). null — price unknown from any source. */
export async function officialUsd(model: string): Promise<OfficialUsd | null> {
  const key = normModel(model);
  if (!key) return null;

  // (a) vendor list price from the shared catalog
  try {
    const { models } = await getUnifiedCatalog();
    const hit = models.find(
      (m) => normModel(m.id) === key && m.inUsd != null && m.outUsd != null,
    );
    if (hit) return { inUsd: hit.inUsd!, outUsd: hit.outUsd!, source: 'openrouter' };
  } catch {
    /* catalog unavailable — keep going */
  }

  // (b) local table
  return fromTable(model);
}

/** Official cost of a call in ₽ (the base for credits). null — price unknown. */
export async function officialRub(
  model: string,
  tokensIn?: number | null,
  tokensOut?: number | null,
): Promise<number | null> {
  if (tokensIn == null || tokensOut == null) return null;
  const p = await officialUsd(model);
  if (!p) return null;
  const usd = (tokensIn / 1e6) * p.inUsd + (tokensOut / 1e6) * p.outUsd;
  return Math.round(usd * USD_RUB * 1e6) / 1e6;
}
