import { safeNext, DEFAULT_NEXT } from './safe-next';

describe('safeNext', () => {
  it('passes through relative paths', () => {
    expect(safeNext('/app')).toBe('/app');
    expect(safeNext('/r/abc?x=1')).toBe('/r/abc?x=1');
  });

  it('cuts off protocol-relative redirects', () => {
    // the exact hole that existed in prod
    expect(safeNext('//example.com')).toBe(DEFAULT_NEXT);
    expect(safeNext('///example.com')).toBe(DEFAULT_NEXT);
    expect(safeNext('/\\example.com')).toBe(DEFAULT_NEXT);
    expect(safeNext('/\\/example.com')).toBe(DEFAULT_NEXT);
  });

  it('cuts off masking via spaces and control characters', () => {
    expect(safeNext('  //example.com')).toBe(DEFAULT_NEXT);
    expect(safeNext('\t//example.com')).toBe(DEFAULT_NEXT);
    expect(safeNext('\n//example.com')).toBe(DEFAULT_NEXT);
  });

  it('passes through absolute URLs only on our own hosts', () => {
    expect(safeNext('https://ideata.io/app')).toBe('https://ideata.io/app');
    expect(safeNext('https://app.ideata.io/')).toBe('https://app.ideata.io/');
    expect(safeNext('http://admin.ideata.io/x')).toBe('http://admin.ideata.io/x');
  });

  it('cuts off foreign hosts, including lookalikes', () => {
    expect(safeNext('https://example.com')).toBe(DEFAULT_NEXT);
    expect(safeNext('https://ideata.io.evil.com')).toBe(DEFAULT_NEXT);
    expect(safeNext('https://notideata.io')).toBe(DEFAULT_NEXT);
    expect(safeNext('https://evil.com/?x=https://ideata.io')).toBe(DEFAULT_NEXT);
  });

  it('cuts off non-http schemes', () => {
    expect(safeNext('javascript:alert(1)')).toBe(DEFAULT_NEXT);
    expect(safeNext('data:text/html,<script>')).toBe(DEFAULT_NEXT);
  });

  it('sends empty and garbage input to the default', () => {
    expect(safeNext('')).toBe(DEFAULT_NEXT);
    expect(safeNext(undefined)).toBe(DEFAULT_NEXT);
    expect(safeNext(null)).toBe(DEFAULT_NEXT);
    expect(safeNext('не-урл')).toBe(DEFAULT_NEXT);
  });
});
