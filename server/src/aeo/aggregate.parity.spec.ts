/**
 * Parity of `aggregateMonitoring` against the golden Python reference on four
 * real monitoring windows (trackers 2 and 7 × horizons of 26 and 4 weeks).
 *
 * The reference — a dump of `aggregate_monitoring` from core/aeo.py, captured
 * on the same aeo_answers rows — lives in
 * _fixtures/aeo_golden_monitoring.json.gz. The file is large and private:
 * it's not present in CI/open source — the test gracefully skips via
 * `fs.existsSync`. Criterion: `deepDiff(our aggregate, golden.agg) === []`
 * on every window; deepDiff already canonicalizes both arguments, so key
 * order and Set iteration order don't affect the result.
 */
import { existsSync, readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import { aggregateMonitoring } from './aggregate';
import { deepDiff } from './parity/diff';
import type { MonitoringRow } from './aggregate.types';

interface GoldenWindow {
  domain: string;
  competitors: string[];
  platforms: string[];
  rows: MonitoringRow[];
  agg: unknown;
}

const FIXTURE = join(
  __dirname,
  '..',
  '..',
  '..',
  '_fixtures',
  'aeo_golden_monitoring.json.gz',
);
const WINDOWS = ['t2_w26', 't2_w4', 't7_w26', 't7_w4'] as const;

const maybe = existsSync(FIXTURE) ? describe : describe.skip;

maybe('aggregateMonitoring — parity with golden Python', () => {
  let golden: Record<string, GoldenWindow>;

  beforeAll(() => {
    golden = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString('utf8'));
  });

  it.each(WINDOWS)('%s: deepDiff is empty', (key) => {
    const w = golden[key];
    const got = aggregateMonitoring(w.rows, w.domain, w.competitors, {
      platforms: w.platforms,
    });
    const diff = deepDiff(got, w.agg);
    if (diff.length) {
      // The first mismatches go right into the assertion message, to see the path.
      throw new Error(
        `${key}: ${diff.length} mismatches:\n` + diff.slice(0, 40).join('\n'),
      );
    }
    expect(diff).toEqual([]);
  });
});
