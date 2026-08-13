/**
 * Parity of normalize() with the golden reference from the live
 * core/site_analytic.py.
 *
 * The reference was captured by running the Python normalize() itself over 10
 * synthetic `raw` inputs covering every branch: the DataForSEO path, the keys.so
 * branch, the Similarweb panel (with and without visit history), intents/rounding,
 * dedup/cap of media mentions, gap scores, technology grouping, and the growth
 * edge case. The data is synthetic (not private), so the fixture lives right in
 * the repo - the test runs in CI without any external files. The criterion is
 * deepDiff(ported, golden) === [] for every case (collectedAt is
 * non-deterministic and is nulled out on both sides).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { normalize } from './normalize';
import { deepDiff } from '../aeo/parity/diff';
import type { Facts, Raw } from './types';

interface NormCase { raw: Raw; facts: Facts }
interface Golden { normalize: NormCase[] }

const FIXED = () => new Date('2026-01-01T00:00:00Z');
const GOLDEN: Golden = JSON.parse(
  readFileSync(join(__dirname, 'normalize.golden.json'), 'utf8'),
);

describe('normalize() - parity with the golden Python', () => {
  it('fixture loaded and is not empty', () => {
    expect(GOLDEN.normalize.length).toBeGreaterThanOrEqual(10);
  });

  it.each(GOLDEN.normalize.map((c, i) => [i, c.raw.domain ?? `#${i}`, c] as const))(
    'case %#: %s - deepDiff is empty',
    (_i, _domain, c) => {
      const got = normalize(c.raw, FIXED) as any;
      got.meta.collectedAt = null; // the reference already has collectedAt=null
      const diff = deepDiff(got, c.facts);
      if (diff.length) {
        throw new Error(
          `${diff.length} mismatches:\n${diff.slice(0, 40).join('\n')}\n` +
            `ported=${JSON.stringify(got)}`,
        );
      }
      expect(diff).toEqual([]);
    },
  );
});
