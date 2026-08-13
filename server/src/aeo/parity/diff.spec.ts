/**
 * Basic tests for the parity harness: canonicalization and diff finding.
 *
 * We test exactly what it exists for: key order and Set traversal order do
 * NOT affect the result, while any real divergence comes back as a path that
 * can be tracked down by hand across two dumps.
 */
import { canonicalize, deepDiff } from './diff';

describe('canonicalize', () => {
  it('sorts object keys at every level', () => {
    const a = { b: 1, a: { z: 1, y: 2 } };
    const b = { a: { y: 2, z: 1 }, b: 1 };
    expect(JSON.stringify(canonicalize(a))).toBe(JSON.stringify(canonicalize(b)));
    expect(JSON.stringify(canonicalize(a))).toBe('{"a":{"y":2,"z":1},"b":1}');
  });

  it('preserves array order — it is meaningful', () => {
    expect(canonicalize([3, 1, 2])).toEqual([3, 1, 2]);
  });

  it('reduces a Set to a sorted array', () => {
    expect(canonicalize(new Set(['crm', 'аео', 'brand']))).toEqual([
      'brand',
      'crm',
      'аео',
    ]);
    expect(canonicalize(new Set(['b', 'a']))).toEqual(
      canonicalize(new Set(['a', 'b'])),
    );
  });

  it('reduces a Map to an object with sorted keys', () => {
    const m = new Map<string, number>([
      ['b', 2],
      ['a', 1],
    ]);
    expect(JSON.stringify(canonicalize(m))).toBe('{"a":1,"b":2}');
  });

  it('reduces a Date to an ISO string', () => {
    expect(canonicalize(new Date('2026-08-09T10:00:00.000Z'))).toBe(
      '2026-08-09T10:00:00.000Z',
    );
  });

  it('is idempotent', () => {
    const once = canonicalize({ b: new Set([2, 1]), a: [{ y: 1, x: 2 }] });
    expect(canonicalize(once)).toEqual(once);
  });
});

describe('deepDiff', () => {
  it('identical structures with different key order — no divergence', () => {
    expect(deepDiff({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toEqual([]);
  });

  it('finds a divergence in a nested value and returns the path', () => {
    const a = { rows: [{ brand: 'ozon', vis: 62 }] };
    const b = { rows: [{ brand: 'ozon', vis: 63 }] };
    expect(deepDiff(a, b)).toEqual(['$.rows[0].vis']);
  });

  it('reports a key missing on one side', () => {
    expect(deepDiff({ a: 1 }, { a: 1, b: 2 })).toEqual(['$.b']);
    expect(deepDiff({ a: 1, b: undefined }, { a: 1 })).toEqual(['$.b']);
  });

  it('reports extra array elements by index', () => {
    expect(deepDiff([1, 2], [1, 2, 3, 4])).toEqual(['$[2]', '$[3]']);
  });

  it('type mismatch — path to the value itself', () => {
    expect(deepDiff({ a: [1] }, { a: { '0': 1 } })).toEqual(['$.a']);
    expect(deepDiff(1, '1')).toEqual(['$']);
  });

  it('escapes a key that does not look like an identifier', () => {
    expect(deepDiff({ 'a b': 1 }, { 'a b': 2 })).toEqual(['$["a b"]']);
  });

  it('NaN equals NaN — a metric with no data does not "diverge" from itself', () => {
    expect(deepDiff({ v: NaN }, { v: NaN })).toEqual([]);
  });

  it('-0 and 0 are considered different — we do not lose pyRound\'s zero sign', () => {
    expect(deepDiff({ delta: -0 }, { delta: 0 })).toEqual(['$.delta']);
  });

  it('a Set is compared regardless of insertion order', () => {
    expect(deepDiff(new Set(['a', 'b']), new Set(['b', 'a']))).toEqual([]);
    expect(deepDiff(new Set(['a', 'b']), new Set(['a', 'c']))).toEqual(['$[1]']);
  });

  it('collects all divergences, not just the first', () => {
    const a = { x: 1, y: 2, z: { q: 1 } };
    const b = { x: 9, y: 2, z: { q: 9 } };
    expect(deepDiff(a, b)).toEqual(['$.x', '$.z.q']);
  });
});
