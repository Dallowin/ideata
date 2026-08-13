/**
 * Per-run cost accumulator for DataForSEO.
 *
 * Python sums `cost` (USD) from every response into a module global
 * (dataforseo.cost_reset/cost_total, dataforseo.py:100-122) and puts the
 * total in facts.meta.cost_usd → site_analyses.cost_cents. In Nest the
 * client is a singleton, and a module global would immediately mix the cost
 * of parallel runs. Instead we use AsyncLocalStorage: the service wraps
 * `collect` in `runWithCostMeter(meter, …)`, and every client call inside
 * that async context (including geo overviews parallelized via Promise.all)
 * sees ITS OWN counter. Outside the context — no-op, so existing client
 * calls (discover/aeo) are unaffected.
 */
import { AsyncLocalStorage } from 'async_hooks';

export interface CostSink {
  addUsd(cost: number): void;
}

export class CostMeter implements CostSink {
  private totalUsd = 0;
  addUsd(cost: number): void {
    if (Number.isFinite(cost) && cost > 0) this.totalUsd += cost;
  }
  totalUsdCost(): number {
    return this.totalUsd;
  }
}

export const dfsCostCtx = new AsyncLocalStorage<CostSink>();

/** Run `fn` with a counter visible to all DataForSEO client calls made inside it. */
export function runWithCostMeter<T>(meter: CostSink, fn: () => Promise<T>): Promise<T> {
  return dfsCostCtx.run(meter, fn);
}
