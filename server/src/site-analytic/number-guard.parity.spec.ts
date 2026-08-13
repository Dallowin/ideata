/**
 * Parity of the deterministic number-guard against the LIVE Python oracle
 * (startup_scraper.core.aa_agents). The golden was captured on synthetic input
 * (scratchpad/gen_fixtures.py) and lives in _fixtures/number-guard.golden.json:
 *
 *   • build_digest       — facts + keywords digest (byte-for-byte structure);
 *   • allowed_numbers    — the allowed-number set (compared as a sorted array);
 *   • numbers_violations — "large" invented numbers from texts (order matters, we
 *     check the greedy regex: "5000 7777 7777" glues into a single token,
 *     ru separators 12.300/12,300, non-breaking space, numeric leaves ignored).
 *
 * Any divergence here = drift of the anti-hallucination guard.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { buildDigest, allowedNumbers, numbersViolations, filterViolations } from './number-guard';

interface Golden {
  digestCases: Array<{
    name: string;
    facts: Record<string, unknown>;
    rawKeywords: unknown[] | null;
    digest: Record<string, unknown>;
    allowed: number[];
  }>;
  violCases: Array<{ name: string; obj: unknown; allowed: number[]; bad: number[] }>;
}

const golden: Golden = JSON.parse(
  readFileSync(join(__dirname, '_fixtures', 'number-guard.golden.json'), 'utf8'),
);

describe('build_digest — digest structure (aa_agents.py:44)', () => {
  it.each(golden.digestCases.map((c) => [c.name, c] as const))(
    'case %s',
    (_name, c) => {
      expect(buildDigest(c.facts, c.rawKeywords)).toEqual(c.digest);
    },
  );
});

describe('allowed_numbers — the allowed set (aa_agents.py:96)', () => {
  it.each(golden.digestCases.map((c) => [c.name, c] as const))(
    'case %s',
    (_name, c) => {
      const got = [...allowedNumbers(c.digest)].sort((a, b) => a - b);
      expect(got).toEqual(c.allowed);
    },
  );
});

describe('numbers_violations — invented "large" numbers (aa_agents.py:110)', () => {
  it.each(golden.violCases.map((c) => [c.name, c] as const))(
    'case %s',
    (_name, c) => {
      expect(numbersViolations(c.obj, new Set(c.allowed))).toEqual(c.bad);
    },
  );
});

describe('filterViolations — the _checked post-check (aa_agents.py:434)', () => {
  const allowed = new Set<number>([1234, 129000]);
  it('a clean object passes through untouched', () => {
    const obj = [{ t: 'до 1234 клиентов' }];
    expect(filterViolations(obj, allowed)).toBe(obj);
  });
  it('list: the item with an invented number is dropped, the rest survive', () => {
    const obj = [{ t: 'рост до 1234' }, { t: 'взлёт до 500000' }, { t: 'без чисел' }];
    expect(filterViolations(obj, allowed)).toEqual([{ t: 'рост до 1234' }, { t: 'без чисел' }]);
  });
  it('a list made entirely of violators → null', () => {
    expect(filterViolations([{ t: 'до 999999' }], allowed)).toBeNull();
  });
  it('a non-list with a violator → null', () => {
    expect(filterViolations({ t: 'до 888888' }, allowed)).toBeNull();
  });
  it('null → null', () => {
    expect(filterViolations(null, allowed)).toBeNull();
  });
});
