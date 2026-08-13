/**
 * Python odds and ends shared by the site-analytic ports (meta-ads / youtube /
 * competitors). We keep them in a separate module with targeted parity tests
 * (pyutil.spec.ts) so that the tricky functions — slicing by code points, `int()`
 * with k/m suffixes, `str.title()` — are verified against CPython once and reused,
 * instead of being rewritten from memory in every collector.
 */

/** A dict in the Python sense — a mapping object (not an array, not null). */
export function isDict(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Python falsiness: None/False/""/0/-0 AND EMPTY containers `[]`/`{}`. Needed
 * everywhere Python writes `x or default` / `if x` over values from JSON — `!x`
 * in JS would treat `[]`/`{}` as truthy. (NaN does not occur in JSON.)
 */
export function pyFalsy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '') return true;
  if (typeof v === 'number') return v === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (isDict(v)) return Object.keys(v).length === 0;
  return false;
}

/** `x or fallback` over a JSON value (Python truthiness of the operand). */
export function pyOr<T>(v: unknown, fallback: T): unknown | T {
  return pyFalsy(v) ? fallback : v;
}

/** Python's `s[:n]` slice — by CODE POINTS, not by UTF-16 units. */
export function cpSlice(s: string, n: number): string {
  if (n <= 0) return '';
  return Array.from(s).slice(0, n).join('');
}

/** String length in code points (Python's `len`). */
export function cpLen(s: string): number {
  return Array.from(s).length;
}

/**
 * `str.title()` — "Every Word Capitalized". A word = a run of consecutive cased
 * characters; for our inputs (publisher_platforms: facebook / instagram /
 * audience_network / messenger) cased == letter, while a digit/`_`/space/
 * punctuation breaks the word. First letter of a word → upper, the rest → lower.
 * 'audience_network' → 'Audience_Network', 'INSTAGRAM' → 'Instagram'.
 */
export function pyTitle(s: string): string {
  let out = '';
  let prevCased = false;
  for (const ch of s) {
    if (/\p{L}/u.test(ch)) {
      out += prevCased ? ch.toLowerCase() : ch.toUpperCase();
      prevCased = true;
    } else {
      out += ch;
      prevCased = false;
    }
  }
  return out;
}

/**
 * Port of research.py::_to_int — '500k'/'1.2M'/'12,000'/12000 → int; junk/None →
 * null. Numbers are truncated toward zero (Python's `int(float)`); a string:
 * strip → lower → drop commas and spaces → `^([\d.]+)\s*([km])?` → float×multiplier.
 * A broken float ('12.5.6', '.', '') → null, exactly as `float()` raises ValueError.
 */
export function toIntLoose(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'boolean') return v ? 1 : 0; // Python int(True)=1 (dead branch)
  const s = String(v).trim().toLowerCase().split(',').join('').split(' ').join('');
  const m = s.match(/^([\d.]+)\s*([km])?/);
  if (!m) return null;
  const g1 = m[1];
  const num = g1 === '' ? NaN : Number(g1); // Number('')===0, but float('')→error
  if (!Number.isFinite(num)) return null;
  const mult = m[2] === 'k' ? 1_000 : m[2] === 'm' ? 1_000_000 : 1;
  return Math.trunc(num * mult);
}
