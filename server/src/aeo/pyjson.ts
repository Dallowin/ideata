/**
 * Python-style typing of JSON numbers — needed by the parity-check runner.
 *
 * `aggregate_monitoring` reads already-computed judge fields (`recommendation`,
 * `score`) via `isinstance(x, int)` (aeo.py:2318, 2330). CPython's `json.load`
 * distinguishes `int` (a literal with no dot or exponent) from `float`
 * (`70.0`, `7e1`), and `bool` is a separate type, but `isinstance(True, int)`
 * is true (bool subclasses int). Plain `JSON.parse` ERASES this distinction:
 * both `70` and `70.0` become the same number `70`, so a judge float becomes
 * indistinguishable from an int, and solution_hit/row_judge silently diverge
 * from Python (findings 1-3).
 *
 * Here the distinction is restored exactly as in CPython: a numeric literal
 * with a dot/exponent is wrapped in `PyFloat` (Python's `float`), an integer
 * literal stays a plain `number` (Python's `int`), `true`/`false` come through
 * as `boolean` (Python's `bool`). The literal's source text is taken from
 * `JSON.parse`'s reviver context ("source text access", V8 ≥ 12 / Node ≥ 21).
 *
 * This is an artifact of CHECKING against the oracle on identical JSON. In
 * production the judge arrives from Prisma already as a plain number (the
 * driver erases the int/float distinction at the JS boundary), so PyFloat
 * never appears there, and aggregate behaves as before: `isPyInt(number)` is
 * true.
 */

/** Python's `float`, parsed from a literal containing a dot or exponent. */
export class PyFloat {
  constructor(readonly value: number) {}
}

/** `JSON.parse`'s reviver context (access to the literal's source text). */
interface ReviverContext {
  source?: string;
}

/**
 * `json.loads` with int/float/bool preserved as in CPython. A numeric literal
 * containing `.`, `e`, or `E` → `PyFloat`; an integer literal → `number`.
 * Other values (strings, bool, null, objects, arrays) are left unchanged.
 */
export function pyParse(text: string): unknown {
  return JSON.parse(
    text,
    (_key: string, value: unknown, context?: ReviverContext): unknown => {
      if (
        typeof value === 'number' &&
        context !== undefined &&
        typeof context.source === 'string' &&
        /[.eE]/.test(context.source)
      ) {
        return new PyFloat(value);
      }
      return value;
    },
  );
}
