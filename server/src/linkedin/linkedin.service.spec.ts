/**
 * LinkedIn REST API version. It's month-based and lives for about a year: a
 * hardcoded constant eventually stops working, which already happened with
 * '202405'. We check that it's computed from the date and stays within
 * month boundaries.
 */
import { apiVersion } from './linkedin.service'

describe('apiVersion', () => {
  it('steps back two months: the current month may not be released yet', () => {
    expect(apiVersion(new Date('2026-08-09T00:00:00Z'))).toBe('202606')
  })

  it('rolls over the year boundary correctly', () => {
    expect(apiVersion(new Date('2027-01-15T00:00:00Z'))).toBe('202611')
    expect(apiVersion(new Date('2027-02-01T00:00:00Z'))).toBe('202612')
  })

  it('is always six digits with a leading zero on the month', () => {
    expect(apiVersion(new Date('2026-11-30T23:59:59Z'))).toMatch(/^\d{6}$/)
    expect(apiVersion(new Date('2026-03-01T00:00:00Z'))).toBe('202601')
  })

  it('is never from the future: it must already have been released', () => {
    const now = new Date('2026-08-09T00:00:00Z')
    expect(Number(apiVersion(now))).toBeLessThan(202608)
  })
})
