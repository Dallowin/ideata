import { cpSlice, get, intTrunc, pyFloatRepr, pyOr, pyRound, truthy } from './pyhelpers';

describe('pyhelpers — Python semantics', () => {
  it('pyRound — banker rounding (half-to-even), not Math.round', () => {
    // Diverge from Math.round: 0.5→0, 2.5→2, 12.5→12; agree: 1.5→2, 3.5→4.
    expect(pyRound(0.5)).toBe(0);
    expect(pyRound(1.5)).toBe(2);
    expect(pyRound(2.5)).toBe(2);
    expect(pyRound(3.5)).toBe(4);
    expect(pyRound(12.5)).toBe(12);
    expect(pyRound(-0.5)).toBe(0);
    expect(pyRound(87.5)).toBe(88);
    expect(pyRound(2.5, 1)).toBe(2.5);
  });

  it('pyFloatRepr — str(float): integers get ".0", fractions get the shortest form', () => {
    expect(pyFloatRepr(3)).toBe('3.0');
    expect(pyFloatRepr(2.5)).toBe('2.5');
    expect(pyFloatRepr(10)).toBe('10.0');
    expect(pyFloatRepr(4.2)).toBe('4.2');
  });

  it('cpSlice — slicing by code points (emoji are not torn apart)', () => {
    expect(cpSlice('abcdef', 3)).toBe('abc');
    expect(cpSlice('', 5)).toBe('');
    expect(cpSlice('привет', 3)).toBe('при');
    // 👍 = 2 UTF-16 units, but 1 code point
    expect(cpSlice('👍👍👍', 2)).toBe('👍👍');
  });

  it('truthy — bool(x) truthiness', () => {
    for (const v of [null, undefined, false, '', 0, [], {}]) expect(truthy(v)).toBe(false);
    for (const v of [1, -1, 'x', [0], { a: 1 }, true]) expect(truthy(v)).toBe(true);
  });

  it('pyOr — a or b; undefined/0/"" → the right-hand side', () => {
    expect(pyOr(0, 7)).toBe(7);
    expect(pyOr('', 'x')).toBe('x');
    expect(pyOr(undefined, null)).toBe(null);
    expect(pyOr(5, 9)).toBe(5);
    expect(pyOr(null, 'd')).toBe('d');
  });

  it('get — d.get(key): missing/undefined → null, 0/false preserved', () => {
    expect(get({ a: 0 }, 'a')).toBe(0);
    expect(get({ a: false }, 'a')).toBe(false);
    expect(get({}, 'x')).toBe(null);
    expect(get(null, 'x')).toBe(null);
    expect(get({ a: undefined }, 'a')).toBe(null);
  });

  it('intTrunc — int() truncation toward zero', () => {
    expect(intTrunc(3.9)).toBe(3);
    expect(intTrunc(-3.9)).toBe(-3);
    expect(intTrunc('5')).toBe(5);
    expect(intTrunc(null)).toBe(0);
  });
});
