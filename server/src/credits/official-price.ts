/**
 * OFFICIAL model price — the base for credits.
 *
 * We have two different numbers, and they must not be confused:
 *
 *   1. ACTUAL — what we really pay the provider. kie sells Claude at 30-40%
 *      of the official price, and that's our margin. Lives in
 *      llm_usage.cost_rub (llmUsage.costRubLive), needed for cost reporting
 *      and margin estimates.
 *   2. OFFICIAL — the vendor's list price (Anthropic/OpenAI/Google/xAI).
 *      Credits are computed from this: 1 credit = 1 ₽ of official cost,
 *      sold for 2 ₽. Our kie savings must not leak to the client as cheap
 *      credits.
 *
 * Sources for the official price, in order of trust:
 *   a) an OpenRouter entry in the shared catalog — that price is the vendor's;
 *   b) a kie entry with a known pctOfficial → kie price / (pct/100);
 *   c) the local table below — in case the catalog is unavailable.
 */
import { getKieCatalog } from '../blogwriter/server/utils/kieCatalog';
import { getUnifiedCatalog } from '../blogwriter/server/utils/modelCatalog';

export const USD_RUB = 90;

export interface OfficialUsd {
  inUsd: number;
  outUsd: number;
  /** where the price came from — visible in the charge metadata */
  source: 'openrouter' | 'kie-pct' | 'table';
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

/** "anthropic/claude-opus-4.8", "claude-opus-4-8", "gemini-3-5-flash-openai" → "claudeopus48" */
export function normModel(id: string): string {
  return String(id || '')
    .toLowerCase()
    .replace(/^[\w.-]+\//, '')     // vendor prefix
    .replace(/-openai$/, '')       // format suffix on kie slugs
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

  // (a) vendor price from the OpenRouter part of the catalog
  try {
    const { models } = await getUnifiedCatalog();
    const or = models.find(
      (m) => m.provider === 'openrouter' && normModel(m.id) === key && m.inUsd != null && m.outUsd != null,
    );
    if (or) return { inUsd: or.inUsd!, outUsd: or.outUsd!, source: 'openrouter' };
  } catch {
    /* catalog unavailable — keep going */
  }

  // (b) kie price + known percentage of official
  try {
    const { models: kie } = await getKieCatalog();
    const k = kie.find((m) => normModel(m.id) === key || normModel(m.kieSlug) === key);
    if (k?.pctOfficial && k.inUsd != null && k.outUsd != null) {
      const f = 100 / k.pctOfficial;
      return { inUsd: k.inUsd * f, outUsd: k.outUsd * f, source: 'kie-pct' };
    }
  } catch {
    /* no kie catalog — keep going */
  }

  // (c) local table
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
