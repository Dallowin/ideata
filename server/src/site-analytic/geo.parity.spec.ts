/**
 * Parity of the worldwide geo estimate (mergeOverviews / bestLocale) against the
 * golden Python (site_analytic._merge_overviews / _best_locale) on synthetic sets
 * of per-market overviews: a full set, an empty one, a single zero market, and a
 * tie on organic_etv (which checks the "first maximum" rule). The fixture is the
 * same normalize.golden.json (geo section). best_locale arrives as [loc, lang].
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { mergeOverviews, bestLocale } from './geo';
import { deepDiff } from '../aeo/parity/diff';

interface GeoCase {
  overviews: Record<string, Record<string, any>>;
  geo: string;
  merged: Record<string, any> | null;
  best_locale: [number, string];
}
interface Golden { geo: GeoCase[] }

const GOLDEN: Golden = JSON.parse(
  readFileSync(join(__dirname, 'normalize.golden.json'), 'utf8'),
);

describe('geo - mergeOverviews/bestLocale parity with the golden Python', () => {
  it('fixture is not empty', () => {
    expect(GOLDEN.geo.length).toBeGreaterThanOrEqual(4);
  });

  it.each(GOLDEN.geo.map((c, i) => [i, c] as const))('geo case %#: merged', (_i, c) => {
    const diff = deepDiff(mergeOverviews(c.overviews), c.merged);
    if (diff.length) throw new Error(`merged mismatches: ${diff.join(', ')}`);
    expect(diff).toEqual([]);
  });

  it.each(GOLDEN.geo.map((c, i) => [i, c] as const))('geo case %#: bestLocale', (_i, c) => {
    expect(bestLocale(c.overviews, c.geo)).toEqual(c.best_locale);
  });
});
