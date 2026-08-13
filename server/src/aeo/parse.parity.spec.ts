/**
 * Parity of the run parsers (`parseBrands`/`citeItems`/`classifyCitation`)
 * against the golden reference of the real core/aeo.py on REAL aeo_answers
 * responses.
 *
 * The reference was captured by running the actual Python functions
 * (parse_brands/cite_items/classify_citation) on aeo_answers rows from 10
 * trackers (EN insane.gg/miro/clash/skinpay + RU goesti/ideata/soliddent + KZ
 * zansarap), plus alias probes on live Russian text and synthetic cases
 * targeting parity risks — 7.4k pairs in
 * _fixtures/aeo_parse_corpus.json.gz. The file is large and private: it's
 * not present in CI/open source — the test gracefully skips via
 * `fs.existsSync`. Criterion: `deepDiff(ported, golden) === []` on EVERY
 * pair (deepDiff canonicalizes both arguments and distinguishes -0/0,
 * NaN==NaN).
 */
import { existsSync, readFileSync } from 'fs';
import { gunzipSync } from 'zlib';
import { join } from 'path';
import { parseBrands, citeItems, classifyCitation } from './parse';
import { deepDiff } from './parity/diff';
import type { CitationRaw } from './aggregate.types';

interface ParseCase {
  text: string | null;
  brands: string[];
  aliases: Record<string, unknown> | null;
  out: unknown;
}
interface CiteCase {
  raw: CitationRaw[] | null;
  out: unknown;
}
interface ClassifyCase {
  url: string;
  domain: string;
  competitors: string[];
  out: unknown;
}
interface Corpus {
  meta: { counts: Record<string, number>; [k: string]: unknown };
  parse_brands: ParseCase[];
  cite_items: CiteCase[];
  classify_citation: ClassifyCase[];
}

const FIXTURE = join(__dirname, '..', '..', '..', '_fixtures', 'aeo_parse_corpus.json.gz');
const maybe = existsSync(FIXTURE) ? describe : describe.skip;

/** Run pairs through the ported function, collecting the first mismatches with context. */
function checkAll<T>(
  cases: readonly T[],
  ported: (c: T) => unknown,
  golden: (c: T) => unknown,
  label: (c: T) => string,
): { total: number; mismatches: string[] } {
  const mismatches: string[] = [];
  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i];
    const diff = deepDiff(ported(c), golden(c));
    if (diff.length && mismatches.length < 30) {
      mismatches.push(
        `#${i} ${label(c)}\n   ported=${JSON.stringify(ported(c))}\n   golden=${JSON.stringify(
          golden(c),
        )}\n   paths=${diff.slice(0, 8).join(',')}`,
      );
    } else if (diff.length) {
      mismatches.push(`#${i} (…)`);
    }
  }
  return { total: cases.length, mismatches };
}

function assertClean(label: string, r: { total: number; mismatches: string[] }): void {
  if (r.mismatches.length) {
    throw new Error(
      `${label}: ${r.mismatches.length}/${r.total} mismatches:\n` +
        r.mismatches.slice(0, 30).join('\n'),
    );
  }
  expect(r.mismatches).toEqual([]);
}

const short = (s: unknown, n = 80): string => {
  const t = typeof s === 'string' ? s : JSON.stringify(s);
  return (t ?? '').length > n ? (t as string).slice(0, n) + '…' : String(t);
};

maybe('parse.ts — parity with golden Python on the real corpus', () => {
  let corpus: Corpus;

  beforeAll(() => {
    corpus = JSON.parse(gunzipSync(readFileSync(FIXTURE)).toString('utf8')) as Corpus;
  });

  it('corpus loaded and non-empty', () => {
    expect(corpus.parse_brands.length).toBeGreaterThan(0);
    expect(corpus.cite_items.length).toBeGreaterThan(0);
    expect(corpus.classify_citation.length).toBeGreaterThan(0);
  });

  it('parseBrands: deepDiff is empty on all pairs', () => {
    assertClean(
      'parseBrands',
      checkAll(
        corpus.parse_brands,
        (c) => parseBrands(c.text, c.brands, c.aliases),
        (c) => c.out,
        (c) => `brands=${JSON.stringify(c.brands)} aliases=${JSON.stringify(c.aliases)} text="${short(c.text)}"`,
      ),
    );
  });

  it('citeItems: deepDiff is empty on all pairs', () => {
    assertClean(
      'citeItems',
      checkAll(
        corpus.cite_items,
        (c) => citeItems(c.raw),
        (c) => c.out,
        (c) => `raw=${short(c.raw)}`,
      ),
    );
  });

  it('classifyCitation: deepDiff is empty on all pairs', () => {
    assertClean(
      'classifyCitation',
      checkAll(
        corpus.classify_citation,
        (c) => classifyCitation(c.url, c.domain, c.competitors),
        (c) => c.out,
        (c) => `url="${short(c.url)}" domain=${c.domain} comp=${JSON.stringify(c.competitors)}`,
      ),
    );
  });
});
