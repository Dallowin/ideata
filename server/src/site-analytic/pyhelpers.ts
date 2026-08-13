/**
 * Small Python semantics that the parity of site_analytic.normalize rests on.
 *
 * The heavy/exact primitives come from the canonical AEO port: `pyRound`
 * (banker rounding over the exact double — core/*.py uses `round()` everywhere)
 * and `pyStrip` (the Python-regex whitespace class). Here we keep only what the
 * normalizer reads directly: Python truthiness (`bool(x)`), the `or` operator,
 * `.get()` defaulting to None and string slicing by CODE POINTS (`s[:n]`).
 */
export { pyRound } from '../aeo/text';

export function isDict(v: unknown): v is Record<string, any> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Python truthiness `bool(x)`: None/False/0/0.0/""/[]/{} → false. Exactly like
 * the local pyTruthy in aeo/panel.ts:73 (the same contract across the whole port).
 */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '') return false;
  if (typeof v === 'number') return v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return true;
}

/**
 * Python's `a or b`: the left side if truthy, otherwise the right one. A truthy
 * `a` is never null/undefined (truthy cuts those off), so we narrow the type to
 * NonNullable<A>|B — otherwise passthrough fields from loose Raw would drag
 * undefined into the strict Facts.
 */
export function pyOr<A, B>(a: A, b: B): NonNullable<A> | B {
  return truthy(a) ? (a as NonNullable<A>) : b;
}

/**
 * Python's `d.get(key)` — the value by key or None. A missing key and
 * `undefined` are coerced to `null` (Python does not distinguish "no key" from
 * None, and it is null, not undefined, that must reach the front end).
 */
export function get(o: unknown, key: string): any {
  if (!isDict(o)) return null;
  const v = o[key];
  return v === undefined ? null : v;
}

/** Python's `s[:n]` slice by code points (not by UTF-16 units). */
export function cpSlice(s: string, n: number): string {
  if (n <= 0) return '';
  return Array.from(s).slice(0, n).join('');
}

/** Python's `int(x)` for the already-numeric pos_dist buckets: truncate TOWARD ZERO. */
export function intTrunc(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/**
 * Representation of a Python `float` inside an f-string (`str(float)`): an
 * integral value prints with a trailing ".0" (`str(3.0)=="3.0"`), a fractional
 * one with the shortest round-trip representation (matches V8 `String(number)`).
 * Needed exactly where Python puts a float into text — `_fmt_views` prints
 * `round(n/1e6, 1)` as "2.5M" and "3.0M".
 */
export function pyFloatRepr(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  return Number.isInteger(v) ? v.toFixed(1) : String(v);
}
