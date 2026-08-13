/**
 * Utility for checking two computation paths against each other — the
 * groundwork for an "old vs new" harness.
 *
 * The Python → NestJS migration proceeds piece by piece, and each piece needs
 * proof that the new path produces EXACTLY the same result as the old one.
 * This can't be checked by eye: engine responses are nested structures with
 * hundreds of keys, and a one-percent divergence looks there exactly like a
 * match.
 *
 * Two primitives here, nothing AEO-specific — the code is deliberately
 * shared, meant to be called from both tests and one-off parity-check
 * scripts:
 *   - `canonicalize` — a deterministic view of a value (object keys sorted,
 *     Set/Map reduced to a comparable shape);
 *   - `deepDiff` — a list of PATHS where values diverge, empty when equal.
 *
 * Values are compared via `Object.is`, not `===`: `NaN` equals `NaN`
 * (otherwise any metric with no data would "diverge" from itself), and `-0`
 * and `0` are considered DIFFERENT — Python's `round(-0.04, 1)` gives exactly
 * `-0.0`, and silently losing that sign would be a shame.
 */
import { PyFloat } from '../pyjson';

/** Path to a value inside a structure: `$`, `$.brand`, `$.rows[3].vis`. */
export type DiffPath = string;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' &&
  v !== null &&
  !Array.isArray(v) &&
  !(v instanceof Date) &&
  !(v instanceof Set) &&
  !(v instanceof Map);

/** String key for stably sorting already-canonicalized values. */
function stableKey(value: unknown): string {
  if (value === undefined) return 'u';
  if (value === null) return 'n';
  const t = typeof value;
  if (t === 'string') return `s${value as string}`;
  if (t === 'number' || t === 'bigint' || t === 'boolean') return `p${String(value)}`;
  if (Array.isArray(value)) return `a[${value.map(stableKey).join(',')}]`;
  if (isPlainObject(value)) {
    return `o{${Object.keys(value)
      .map((k) => `${k}:${stableKey(value[k])}`)
      .join(',')}}`;
  }
  return `x${String(value)}`;
}

/**
 * Deterministic view of a value: identical data → identical structure and
 * identical key order, no matter how many times it's assembled.
 *
 * ARRAY element order is preserved — it's meaningful there (the order of
 * brands in a response), but `Set` gets sorted: it's unordered by definition,
 * and traversal order depends on insertion order. `Map` becomes an object
 * with sorted keys, `Date` becomes an ISO string.
 */
export function canonicalize(value: unknown): unknown {
  // Python float from pyParse → its numeric value. Otherwise PyFloat as an
  // object would land in isPlainObject and get canonicalized into
  // {value: N}, while Python prints a bare number; PyFloat never appears in
  // production, so this branch is dead there.
  if (value instanceof PyFloat) return value.value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Set) {
    return [...value]
      .map(canonicalize)
      .sort((a, b) => (stableKey(a) < stableKey(b) ? -1 : stableKey(a) > stableKey(b) ? 1 : 0));
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].map(
      ([k, v]) => [String(k), canonicalize(v)] as const,
    );
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    return Object.fromEntries(entries);
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function childPath(path: DiffPath, key: string): DiffPath {
  return IDENT_RE.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

function walk(a: unknown, b: unknown, path: DiffPath, out: DiffPath[]): void {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      out.push(path);
      return;
    }
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i += 1) {
      if (i >= a.length || i >= b.length) out.push(`${path}[${i}]`);
      else walk(a[i], b[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) {
      out.push(path);
      return;
    }
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const key of keys) {
      const inA = Object.prototype.hasOwnProperty.call(a, key);
      const inB = Object.prototype.hasOwnProperty.call(b, key);
      if (!inA || !inB) out.push(childPath(path, key));
      else walk(a[key], b[key], childPath(path, key), out);
    }
    return;
  }
  if (!Object.is(a, b)) out.push(path);
}

/**
 * Paths where `a` and `b` diverge. An empty array means the values match.
 *
 * Both arguments are canonicalized first, so key order and `Set` traversal
 * order don't affect the result. A key missing on one side, or an extra
 * array element, also ends up in the list — as the path to that key/index.
 */
export function deepDiff(a: unknown, b: unknown): DiffPath[] {
  const out: DiffPath[] = [];
  walk(canonicalize(a), canonicalize(b), '$', out);
  return out;
}
