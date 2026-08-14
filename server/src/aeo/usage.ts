/**
 * Usage accounting for AEO engines in the shared `llm_usage` table — a
 * dollar-denominated port of scrapper/core/usage.py::record (lines 264-307)
 * for the Nest provider layer.
 *
 * The one-column difference from Python: Nest writes cost in DOLLARS into the
 * NEW `cost_usd` column (tokenCostUsd/fixedCostUsd from cost.ts), and leaves
 * the ruble `cost_rub` column ALONE — that one is written by live Python, and
 * this shared writer doesn't touch it (two columns, two writers, no race).
 * Everything else matches: run context (run_kind/run_id/user_id/domain/purpose)
 * + engine slug (platform) are pulled from context, cost is computed only for
 * successful calls, and the write NEVER fails the run.
 *
 * Run context flows through AsyncLocalStorage (the analog of Python's
 * contextvars run_context/platform_context): the runner wraps the run in
 * `runContext(...)`, the dispatcher wraps each engine in `platformContext(slug)`,
 * and the client underneath writes the entry without threading context through
 * signatures (usage.py:108, ask_platform:600).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { blogPrisma } from '../blogwriter/server/utils/prisma';
import { tokenCostUsd } from './cost';

/** Usage grouping: run kind/id + owner/domain/purpose + engine slug. */
export interface UsageContext {
  runKind?: string | null;
  runId?: string | null;
  userId?: number | null;
  domain?: string | null;
  purpose?: string | null;
  platform?: string | null;
}

const als = new AsyncLocalStorage<UsageContext>();

/** Current usage context (empty object outside a run). */
export function currentUsage(): UsageContext {
  return als.getStore() ?? {};
}

/**
 * Attach context to all nested entries (merges on top of the current context,
 * like Python's `purpose_context`: keeps the grouping, refines the fields).
 * Transparent across both sync and async code (ALS survives await).
 */
export function withUsage<T>(ctx: UsageContext, fn: () => T): T {
  const merged = { ...currentUsage(), ...ctx };
  return als.run(merged, fn);
}

/**
 * RUN context (port of usage.run_context): kind='aeo_run' by default, id is
 * the grouping key, purpose is derived from kind (aeo_run). Wraps the engine
 * run's runner.
 */
export function runContext<T>(
  id: string | number | null,
  fn: () => T,
  opts: { kind?: string; userId?: number | null; domain?: string | null; purpose?: string } = {},
): T {
  const kind = opts.kind ?? 'aeo_run';
  return withUsage(
    {
      runKind: kind,
      runId: id === null || id === undefined ? null : String(id),
      userId: opts.userId ?? null,
      domain: opts.domain ?? null,
      purpose: opts.purpose ?? kind,
    },
    fn,
  );
}

/** Tag the AEO engine slug for a nested call (port of usage.platform_context). */
export function platformContext<T>(slug: string | null, fn: () => T): T {
  return withUsage({ platform: slug ?? null }, fn);
}

/** A single usage entry — what the provider client knows at the call site. */
export interface UsageEntry {
  provider:
    | 'anthropic'
    | 'google'
    | 'openai'
    | 'xai'
    | 'deepseek'
    | 'perplexity'
    | 'openrouter'
    | 'yandex'
    | 'gigachat'
    | 'dataforseo';
  model?: string | null;
  status?: 'ok' | 'error';
  error?: string | null;
  latencyMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  /** Explicit dollar price (fixed cost: Neuro, DataForSEO/AIO). Honored as-is. */
  costUsd?: number | null;
  requestId?: string | null;
  grounded?: boolean;
  /** Override the engine slug from context (usually unneeded — taken from platformContext). */
  platform?: string | null;
  purpose?: string | null;
}

/**
 * Dollar cost of a usage entry (without writing it) — for parity checks/tests.
 * Honors an explicit `costUsd`; otherwise computes from tokens ONLY for
 * successful calls (a failed request usually doesn't spend money —
 * usage.py:277-282). The provider goes into the price as well: the search fee
 * depends on the route (vendor search vs the Exa plugin). Returns null when
 * there's nothing to compute from.
 */
export function costUsdFor(e: UsageEntry): number | null {
  if (e.costUsd !== undefined && e.costUsd !== null) return e.costUsd;
  if ((e.status ?? 'ok') !== 'ok') return null;
  return tokenCostUsd(e.model, e.tokensIn, e.tokensOut, { grounded: e.grounded, provider: e.provider });
}

/**
 * Write a single usage entry into `llm_usage` with `cost_usd`. Context
 * (run_kind/run_id/user_id/domain/purpose/platform) is pulled from
 * AsyncLocalStorage. NEVER throws or blocks the caller: a write error
 * (missing table/column, DB down, prisma not initialized in a test) is
 * swallowed silently — usage accounting is auxiliary and must not fail the
 * engine run.
 */
export function recordUsage(e: UsageEntry): void {
  try {
    const ctx = currentUsage();
    const platform = e.platform ?? ctx.platform ?? null;
    const purpose = e.purpose ?? ctx.purpose ?? 'aeo_run';
    const costUsd = costUsdFor(e);
    void blogPrisma()
      .llmUsage.create({
        data: {
          provider: e.provider,
          model: e.model ?? null,
          platform,
          purpose,
          runKind: ctx.runKind ?? 'aeo_run',
          runId: ctx.runId ?? null,
          userId: ctx.userId ?? null,
          domain: ctx.domain ?? null,
          status: e.status ?? 'ok',
          error: e.error ? String(e.error).slice(0, 200) : null,
          latencyMs: e.latencyMs != null ? Math.max(0, Math.round(e.latencyMs)) : null,
          tokensIn: e.tokensIn ?? null,
          tokensOut: e.tokensOut ?? null,
          // We do NOT write cost_rub — that's written by live Python; ours is cost_usd.
          costUsd: costUsd != null ? costUsd : null,
          requestId: e.requestId ? String(e.requestId).slice(0, 120) : null,
        },
      })
      .catch(() => {
        /* missing table/column/DB — accounting stays quiet, engine run is not failed */
      });
  } catch {
    /* prisma not initialized (test) / context unavailable — suppress */
  }
}

/** Short error code for the error column (port of usage.short_error: status/timeout/name). */
export function shortError(err: unknown): string {
  const status = (err as { status?: unknown })?.status;
  if (status) return String(status);
  const name = err instanceof Error ? err.constructor.name : typeof err;
  const blob = `${name} ${err instanceof Error ? err.message : String(err)}`.toLowerCase();
  if (blob.includes('timeout') || blob.includes('abort')) return 'timeout';
  if (blob.includes('connect')) return 'connect';
  return name.slice(0, 40);
}
