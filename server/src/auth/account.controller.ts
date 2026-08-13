import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { AuthService } from './auth.service';
import { LoginThrottleService } from './login-throttle.service';
import { CaptchaService } from './captcha.service';
import { safeNext } from './safe-next';

@Controller('auth')
export class AccountController {
  constructor(
    private auth: AuthService,
    private throttle: LoginThrottleService,
    private captcha: CaptchaService,
  ) {}

  // --- email + password --------------------------------------------------
  // Anti-bruteforce: registration always requires a captcha (spam accounts) +
  // a limit on registrations per IP; login requires a captcha after several
  // failures and a 429 lock on repeated attempts (see LoginThrottleService).
  // `captcha:true` in the response is a signal for the frontend to show
  // Turnstile and retry the request with captchaToken.
  @Post('register')
  async register(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const ip = this.throttle.clientIp(req);
    if (!this.throttle.allowRegister(ip))
      return res.status(429).json({
        ok: false,
        error: 'Too many registrations. Try again later.',
      });
    if (this.captcha.enabled && !(await this.captcha.verify(body?.captchaToken, ip)))
      return res.status(403).json({
        ok: false,
        captcha: true,
        error: 'Please confirm you are not a robot',
      });
    try {
      const user = await this.auth.registerEmail(body?.email ?? '', body?.password ?? '');
      this.throttle.recordRegister(ip);
      this.auth.setCookie(res, this.auth.sign(this.auth.sessionFor(user)));
      return res.json({ ok: true, name: user.name });
    } catch (e: any) {
      return res.status(400).json({ ok: false, error: e?.message || 'Registration error' });
    }
  }

  @Post('login')
  async login(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const ip = this.throttle.clientIp(req);
    const email = String(body?.email ?? '').trim().toLowerCase();
    const gate = this.throttle.check(email, ip);
    if (gate.retryAfterS > 0) {
      res.setHeader('Retry-After', String(gate.retryAfterS));
      return res.status(429).json({
        ok: false,
        retryAfterS: gate.retryAfterS,
        error: `Too many login attempts. Try again in ${Math.ceil(gate.retryAfterS / 60)} min.`,
      });
    }
    if (gate.captchaRequired && this.captcha.enabled) {
      if (!(await this.captcha.verify(body?.captchaToken, ip)))
        return res.status(403).json({
          ok: false,
          captcha: true,
          error: 'Please confirm you are not a robot',
        });
    }
    const user = await this.auth.loginEmail(email, body?.password ?? '');
    if (!user) {
      this.throttle.recordFail(email, ip);
      const after = this.throttle.check(email, ip);
      return res.status(401).json({
        ok: false,
        captcha: after.captchaRequired && this.captcha.enabled,
        error: 'Invalid email or password',
      });
    }
    this.throttle.recordSuccess(email);
    this.auth.setCookie(res, this.auth.sign(this.auth.sessionFor(user)));
    return res.json({ ok: true, name: user.name });
  }

  @Post('logout')
  logout(@Res() res: Response) {
    this.auth.clearCookie(res);
    return res.json({ ok: true });
  }

  // --- Google OAuth (manual code flow) -----------------------------------
  @Get('google')
  google(@Query('next') next: string, @Res() res: Response) {
    if (!this.auth.googleEnabled) return res.status(503).send('Google login is not configured');
    const state = randomBytes(16).toString('hex');
    // bind state + intended destination in a short-lived cookie (CSRF guard)
    res.cookie('g_oauth', `${state}|${safeNext(next)}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 10 * 60 * 1000,
    });
    return res.redirect(this.auth.googleAuthUrl(state));
  }

  @Get('google/callback')
  async googleCallback(@Req() req: Request, @Res() res: Response) {
    const cookie = (req as any).cookies?.g_oauth as string | undefined;
    res.clearCookie('g_oauth');
    const [savedState, savedNext] = (cookie ?? '').split('|');
    const next = safeNext(savedNext);
    const fail = () => res.redirect(`/login?error=google&next=${encodeURIComponent(next)}`);
    if (!cookie || !req.query.code || req.query.state !== savedState) return fail();
    try {
      const profile = await this.auth.exchangeGoogleCode(req.query.code as string);
      const user = await this.auth.upsertGoogleUser(profile);
      this.auth.setCookie(res, this.auth.sign(this.auth.sessionFor(user)));
      return res.redirect(next);
    } catch {
      return fail();
    }
  }
}
