import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { safeNext } from './safe-next';

// The Telegram Login Widget only renders on the domain linked via BotFather
// /setdomain (admin.ideata.io), so nginx proxies /tg/* from BOTH domains
// to this controller; the session cookie lands on .ideata.io and is
// shared with the apex.
const AUTH_BASE = process.env.PUBLIC_AUTH_BASE ?? 'https://admin.ideata.io';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

@Controller('tg')
export class AuthController {
  constructor(private auth: AuthService) {}

  @Get('login')
  login(@Query('next') next: string, @Query('error') error: string, @Res() res: Response) {
    const callback = `${AUTH_BASE}/tg/callback?next=${encodeURIComponent(safeNext(next))}`;
    const err =
      error === 'invalid_hash'
        ? 'Не удалось проверить подпись Telegram — попробуй ещё раз.'
        : error === 'auth_expired'
          ? 'Сессия логина устарела — попробуй ещё раз.'
          : '';
    res.type('html').send(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Вход — ideata</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#f8fafc;font-family:system-ui,-apple-system,sans-serif;color:#0f172a}
  .card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:40px 44px;
        text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.05)}
  h1{font-size:20px;margin:0 0 6px} p{color:#64748b;font-size:14px;margin:0 0 22px}
  .err{color:#e11d48;font-size:13px;margin-top:14px}
  a{color:#94a3b8;font-size:12px;text-decoration:none;display:block;margin-top:22px}
</style></head><body><div class="card">
  <h1>ideata<span style="color:#f97316">.</span></h1>
  <p>Войди через Telegram, чтобы комментировать<br>и генерировать промпты</p>
  <script async src="https://telegram.org/js/telegram-widget.js?22"
    data-telegram-login="${esc(this.auth.botUsername)}" data-size="large"
    data-auth-url="${esc(callback)}" data-request-access="write"></script>
  ${err ? `<div class="err">${esc(err)}</div>` : ''}
  <a href="${esc(safeNext(next))}">← вернуться без входа</a>
</div></body></html>`);
  }

  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query))
      if (typeof v === 'string' && k !== 'next') params[k] = v;
    const next = safeNext(req.query.next as string | undefined);
    const back = (e: string) =>
      res.redirect(`/tg/login?error=${e}&next=${encodeURIComponent(next)}`);

    if (!this.auth.verifyTelegramHash(params)) return back('invalid_hash');
    if (!this.auth.isFresh(params.auth_date ?? '0')) return back('auth_expired');

    const user = await this.auth.upsertUser(params);
    const token = this.auth.sign({
      i: user.id,
      t: Number(user.tgId),
      n: user.name || user.username || 'Аноним',
      a: user.isAdmin,
    });
    this.auth.setCookie(res, token);
    res.redirect(next);
  }

  @Get('logout')
  logout(@Query('next') next: string, @Res() res: Response) {
    this.auth.clearCookie(res);
    if (next) return res.redirect(safeNext(next));
    res.json({ authed: false });
  }
}
