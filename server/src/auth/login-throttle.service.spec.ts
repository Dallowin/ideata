import { LoginThrottleService } from './login-throttle.service';

describe('LoginThrottleService', () => {
  let svc: LoginThrottleService;
  const EMAIL = 'user@example.com';
  const IP = '203.0.113.7';

  beforeEach(() => {
    svc = new LoginThrottleService();
    jest.useFakeTimers({ now: new Date('2026-07-23T12:00:00Z') });
  });
  afterEach(() => jest.useRealTimers());

  it('clean account: no captcha and no lock', () => {
    const g = svc.check(EMAIL, IP);
    expect(g.retryAfterS).toBe(0);
    expect(g.captchaRequired).toBe(false);
  });

  it('requires a captcha after 3 failures by email', () => {
    for (let i = 0; i < 3; i++) svc.recordFail(EMAIL, IP);
    expect(svc.check(EMAIL, IP).captchaRequired).toBe(true);
    // a different email from the same IP — no captcha yet (IP threshold is higher)
    expect(svc.check('other@example.com', IP).captchaRequired).toBe(false);
  });

  it('locks for 15 minutes after 10 failures by email', () => {
    for (let i = 0; i < 10; i++) svc.recordFail(EMAIL, IP);
    const g = svc.check(EMAIL, IP);
    expect(g.retryAfterS).toBeGreaterThan(0);
    expect(g.retryAfterS).toBeLessThanOrEqual(15 * 60);
    // lock expired — let it through (but the captcha stays: lockCount is nonzero,
    // while fails is reset — so there's no captcha from the fail counter)
    jest.advanceTimersByTime(15 * 60 * 1000 + 1000);
    expect(svc.check(EMAIL, IP).retryAfterS).toBe(0);
  });

  it('a repeat lock is longer than the first (exponential)', () => {
    for (let i = 0; i < 10; i++) svc.recordFail(EMAIL, IP);
    const first = svc.check(EMAIL, IP).retryAfterS;
    jest.advanceTimersByTime((first + 1) * 1000);
    for (let i = 0; i < 10; i++) svc.recordFail(EMAIL, IP);
    const second = svc.check(EMAIL, IP).retryAfterS;
    expect(second).toBeGreaterThan(first);
  });

  it('bruteforcing MANY accounts from one IP: captcha after 10, lock after 30', () => {
    for (let i = 0; i < 10; i++) svc.recordFail(`u${i}@x.com`, IP);
    expect(svc.check('fresh@x.com', IP).captchaRequired).toBe(true);
    for (let i = 10; i < 30; i++) svc.recordFail(`u${i}@x.com`, IP);
    expect(svc.check('fresh2@x.com', IP).retryAfterS).toBeGreaterThan(0);
    // a victim on a different IP isn't affected
    expect(svc.check('fresh2@x.com', '198.51.100.1').retryAfterS).toBe(0);
  });

  it('a successful login resets the email counter', () => {
    for (let i = 0; i < 3; i++) svc.recordFail(EMAIL, IP);
    svc.recordSuccess(EMAIL);
    expect(svc.check(EMAIL, IP).captchaRequired).toBe(false);
  });

  it('failures expire after the 15-minute window', () => {
    for (let i = 0; i < 3; i++) svc.recordFail(EMAIL, IP);
    jest.advanceTimersByTime(16 * 60 * 1000);
    expect(svc.check(EMAIL, IP).captchaRequired).toBe(false);
  });

  it('registrations: no more than 5 per hour from an IP', () => {
    for (let i = 0; i < 5; i++) {
      expect(svc.allowRegister(IP)).toBe(true);
      svc.recordRegister(IP);
    }
    expect(svc.allowRegister(IP)).toBe(false);
    jest.advanceTimersByTime(61 * 60 * 1000);
    expect(svc.allowRegister(IP)).toBe(true);
  });

  it('clientIp prefers cf-connecting-ip over x-forwarded-for', () => {
    const req: any = {
      headers: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8, 9.9.9.9' },
      ip: '10.0.0.1',
    };
    expect(svc.clientIp(req)).toBe('1.2.3.4');
    delete req.headers['cf-connecting-ip'];
    expect(svc.clientIp(req)).toBe('5.6.7.8');
  });
});
