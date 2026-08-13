/**
 * Parity of the NATIVE dashboard assembly (assembleDashboard) with live Python
 * (services.aeo_aggregates) across four real windows: trackers 2 and 7 ×
 * 26- and 4-week horizons.
 *
 * Goldens (large and private — not in CI/open source, the test gracefully
 * skips via existsSync):
 *   • _fixtures/aeo_dashboard_payload.json.gz — the full 18-field payload,
 *     captured from live Python (the reference for 17 tracker fields);
 *   • _fixtures/aeo_golden_monitoring.json.gz — the raw aeo_answers rows for
 *     the same windows (assembly input) + the tracker's platforms + agg
 *     (Python's aggregate of THESE rows).
 *
 * Assembly runs FROM the monitoring golden's rows + tracker fields from the
 * payload golden. So the reference is:
 *   • the 17 tracker fields (everything but aggregates) — from the payload
 *     (stable across snapshots; we compare deepDiff(got without aggregates,
 *     payload without aggregates));
 *   • aggregates — from monitoring.agg: this is Python's aggregate of EXACTLY
 *     the rows we assemble from (the same sample), so it's a correct same-
 *     batch reference.
 *
 * Why aggregates is NOT taken from the payload: the two goldens were captured
 * by DIFFERENT Python calls at different moments. For t2_w4 (insane.gg — a
 * dogfooding tracker, run daily, 'day' granularity) the rows dump has ONE more
 * intraday run than the aggregates payload (runs 9 vs 8; the last day and
 * kpi.visScore are the same). This is a discrepancy between the TWO snapshots,
 * not the code: aggregateMonitoring(rows) === mon.agg on all windows
 * (aggregate.parity.spec), and mon.agg === payload.aggregates on 3 of 4
 * windows (all but t2_w4). We pin aggregates to the same-batch mon.agg.
 *
 * Criterion: deepDiff(assembled, reference) === [] on every window (deepDiff
 * canonicalizes both arguments — key order doesn't matter).
 *
 * plan='scale': in the golden, promptCap=125 for BOTH trackers, and 125 is
 * PLAN_PROMPT_COUNTS.scale (the prompt pool for the "Business" plan). Both
 * owners resolve to scale (admin/business), the global AEO_PROMPTS isn't set,
 * so promptCount('scale', null) === 125 reproduces the reference.
 */
import { existsSync, readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import { assembleDashboard, naiveTs, type AssembleTracker } from './aeo-read.service';
import { deepDiff } from './parity/diff';
import type { MonitoringRow } from './aggregate.types';

const FIXTURES = join(__dirname, '..', '..', '..', '_fixtures');
const PAYLOAD = join(FIXTURES, 'aeo_dashboard_payload.json.gz');
const MONITORING = join(FIXTURES, 'aeo_golden_monitoring.json.gz');
const WINDOWS = ['t2_w26', 't2_w4', 't7_w26', 't7_w4'] as const;

/** The plan that yields promptCap=125 (see the header comment). */
const PLAN = 'scale';

interface MonWindow {
  domain: string;
  competitors: string[];
  platforms: string[];
  rows: MonitoringRow[];
  agg: Record<string, unknown>;
}

/**
 * Tracker fields for assembleDashboard, sourced from the golden payload's
 * fields. platforms isn't stored separately in the payload (it's
 * tracker.platforms) — we take it from the monitoring window, the exact list
 * Python used to compute agg. run_meta is reconstructed from the already-
 * mapped microAt/midAt/fullAt/yandexAt (services.aeo_aggregates unpacks
 * run_meta.{micro,mid,full,yandex}_at into exactly these fields).
 */
function trackerFrom(pay: any, mon: MonWindow): AssembleTracker {
  return {
    id: pay.id,
    domain: pay.domain,
    competitors: pay.competitors,
    prompts: pay.prompts,
    platforms: mon.platforms,
    active: pay.active,
    last_run_at: pay.last_run_at,
    prompts_limit: pay.promptsLimit,
    run_meta: {
      micro_at: pay.microAt,
      mid_at: pay.midAt,
      full_at: pay.fullAt,
      yandex_at: pay.yandexAt,
    },
  };
}

/** Window reference: 17 payload fields + aggregates from the same-batch mon.agg. */
function expectedFor(pay: any, mon: MonWindow): Record<string, unknown> {
  const aggregates = mon.agg && Object.keys(mon.agg).length ? mon.agg : null;
  return { ...pay, aggregates };
}

const maybe = existsSync(PAYLOAD) && existsSync(MONITORING) ? describe : describe.skip;

maybe('assembleDashboard — full payload parity with live Python', () => {
  let payload: Record<string, any>;
  let monitoring: Record<string, MonWindow>;

  beforeAll(() => {
    payload = JSON.parse(gunzipSync(readFileSync(PAYLOAD)).toString('utf8'));
    monitoring = JSON.parse(gunzipSync(readFileSync(MONITORING)).toString('utf8'));
  });

  it.each(WINDOWS)('%s: deepDiff of the full payload is empty', (key) => {
    const pay = payload[key];
    const mon = monitoring[key];
    const activeJob = pay.running ? 1 : null; // running=false → no active job
    const got = assembleDashboard(trackerFrom(pay, mon), mon.rows, activeJob, PLAN, null);

    // 17 tracker fields — exactly as in the live payload (aggregates excluded).
    const topDiff = deepDiff(
      { ...got, aggregates: null },
      { ...pay, aggregates: null },
    );
    if (topDiff.length) {
      throw new Error(
        `${key} tracker fields: ${topDiff.length} discrepancies:\n` +
          topDiff.slice(0, 40).join('\n'),
      );
    }
    expect(topDiff).toEqual([]);

    // Full payload against the same-batch reference (aggregates ← mon.agg).
    const diff = deepDiff(got, expectedFor(pay, mon));
    if (diff.length) {
      throw new Error(
        `${key}: ${diff.length} discrepancies:\n` + diff.slice(0, 40).join('\n'),
      );
    }
    expect(diff).toEqual([]);
  });

  /**
   * risk #1 — run_at as a JS Date (how Prisma reads a naive timestamp) gives
   * the same result as Python's run_at string.
   *
   *   (a) direct bucket proof: for EVERY row in the window,
   *       naiveTs(new Date(iso+'Z'))[:10] === str(run_at)[:10]. Prisma reads a
   *       naive timestamp as UTC — the wall-clock doesn't shift, the date
   *       doesn't drift.
   *   (b) end-to-end parity: rows with run_at=Date, normalized as in
   *       mapAnswerRows (naiveTs), assemble into the SAME payload as the rows
   *       do. answeredAt survives into the payload only for the last run's
   *       rows, and those round-trip Date→naiveTs without loss; earlier runs
   *       only feed the bucketed aggregates (the [:10] slice), where the
   *       bucket is identical per (a).
   */
  it.each(WINDOWS)('%s: run_at as a Date ≡ a string', (key) => {
    const pay = payload[key];
    const mon = monitoring[key];
    // (a)
    for (const r of mon.rows) {
      const s = String(r.run_at);
      const asDate = new Date(s.replace(' ', 'T') + 'Z');
      expect(naiveTs(asDate).slice(0, 10)).toBe(s.slice(0, 10));
    }
    // (b)
    const dateRows: MonitoringRow[] = mon.rows.map((r) => ({
      ...r,
      run_at: naiveTs(new Date(String(r.run_at).replace(' ', 'T') + 'Z')),
    }));
    const activeJob = pay.running ? 1 : null;
    const got = assembleDashboard(trackerFrom(pay, mon), dateRows, activeJob, PLAN, null);
    const diff = deepDiff(got, expectedFor(pay, mon));
    if (diff.length) {
      throw new Error(
        `${key} (Date): ${diff.length} discrepancies:\n` + diff.slice(0, 40).join('\n'),
      );
    }
    expect(diff).toEqual([]);
  });
});
