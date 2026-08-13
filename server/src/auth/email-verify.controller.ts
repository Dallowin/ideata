import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpException,
  NotFoundException,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { HttpDetailFilter } from '../common/http-detail.filter';
import { LoginGuard } from './login.guard';
import { CurrentUser } from './current-user.decorator';
import type { SessionUser } from './auth.service';
import { EmailVerifyService } from './email-verify.service';

/**
 * Email verification — a native port of three FastAPI endpoints (app.py:2214-2299):
 *   • POST /api/public/auth/send-verify   — code to the current user (session);
 *   • POST /api/public/auth/verify-email  — check the code (session);
 *   • GET  /api/public/auth/verify-email  — confirmation via the link from the email.
 *
 * Session mechanics come from auth.service via LoginGuard/@CurrentUser (the `_cw`
 * cookie — DO NOT touch). All gate/code logic lives in EmailVerifyService. HttpDetailFilter
 * returns errors as {detail} (the /api/public/* frontend contract).
 */
@UseFilters(HttpDetailFilter)
@Controller('api/public/auth')
export class EmailVerifyController {
  constructor(private readonly verify: EmailVerifyService) {}

  /** Email language for the request — a port of _req_lang (app.py:2171-2195). */
  private reqLang(req: Request): string {
    const cookieLang = (req.cookies?.ideata_lang || '').toString().trim();
    if (cookieLang) return cookieLang;
    const head = (req.headers['accept-language'] || '').toString().split(',')[0];
    return head.split(';')[0].trim();
  }

  @Post('send-verify')
  @UseGuards(LoginGuard)
  async sendVerify(@CurrentUser() user: SessionUser, @Req() req: Request) {
    const uid = Number(user?.i) || 0;
    if (!uid) throw new HttpException('Authorization required', 401);
    const r = await this.verify.sendUserCode(uid, this.reqLang(req));
    if ('ok' in r) {
      if (r.ok === 'sent') return { sent: true };
      if (r.ok === 'verified') return { verified: true };
      return { skipped: true, reason: r.reason };
    }
    if (r.error === 'no_user') throw new NotFoundException('user not found');
    if (r.error === 'no_email')
      throw new BadRequestException('This account has no email to verify');
    if (r.error === 'cooldown')
      throw new HttpException(`Code already sent. Try again in ${r.retryAfterS}s.`, 429);
    // send_failed
    throw new HttpException('Failed to send the email. Try again later.', 502);
  }

  @Post('verify-email')
  @UseGuards(LoginGuard)
  async verifyEmail(@CurrentUser() user: SessionUser, @Body() body: { code?: string }) {
    const uid = Number(user?.i) || 0;
    if (!uid) throw new HttpException('Authorization required', 401);
    const code = String(body?.code || '').trim();
    if (!code) throw new BadRequestException('Enter the code from the email');
    const r = await this.verify.confirmUser(uid, code);
    if ('ok' in r) return { verified: true };
    if (r.error === 'locked')
      throw new HttpException(
        `Too many attempts. Try again in ${Math.ceil(r.retryAfterS / 60)} min.`,
        429,
      );
    throw new BadRequestException('Invalid or expired code. Request a new one.');
  }

  /**
   * Click on the link from the email (no session). Returns a simple HTML
   * success/error page — a port of api_public_verify_email_link (app.py:2277-2299).
   */
  @Get('verify-email')
  @Header('Content-Type', 'text/html; charset=utf-8')
  async verifyEmailLink(@Query('email') email = '', @Query('code') code = ''): Promise<string> {
    const ok = email && code ? await this.verify.confirmByAddress(email, code) : false;
    const msg = ok
      ? 'Email confirmed. You can return to the dashboard.'
      : 'The link is invalid or the code has expired. Request a new code from the dashboard.';
    const color = ok ? '#16a34a' : '#b91c1c';
    return (
      '<!doctype html><meta charset=utf-8>' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Email confirmation</title>' +
      "<div style='font:16px/1.5 system-ui;max-width:32rem;margin:18vh auto;" +
      `text-align:center;color:#333'><h1 style='font-weight:600;color:${color}'>` +
      `${ok ? 'Done' : 'Failed'}</h1><p>${msg}</p>` +
      "<p><a href='/app'>Open dashboard</a></p></div>"
    );
  }
}
