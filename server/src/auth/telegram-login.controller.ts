import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { safeNext } from './safe-next';

// The Telegram widget only renders on the domain set via BotFather /setdomain
// (admin.ideata.io); nginx proxies /public-auth/* here, and the `_cw` cookie lands
// on COOKIE_DOMAIN (.ideata.io) and is shared with the apex — same as /tg/* in
// auth.controller. Its own AUTH_BASE, so it doesn't depend on that controller.
const AUTH_BASE = process.env.PUBLIC_AUTH_BASE ?? 'https://admin.ideata.io';

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * PUBLIC login via Telegram for the showcase frontend — a native port of
 * app.py:3311-3335 (/public-login + /public-auth/telegram). Separate from
 * /tg/* (auth.controller): that one is the dashboard/admin login (the session
 * carries a=user.isAdmin per TELEGRAM_ALLOWED_IDS), while THIS ONE lets ANY
 * Telegram user into the public dashboard and NEVER grants admin.
 *
 * AUDIT FIX (fail-open): in Python, is_allowed(user_id) returns True when
 * TELEGRAM_ALLOWED_IDS is empty (auth.py:139), and /public-auth/telegram never
 * checked the list at all — it just set an `_ss` session, so is_admin_session on
 * that session → is_allowed → "empty list = admin for everyone". Here the public
 * session is HARD-signed with `a: false`, so it NEVER grants admin, no matter what
 * TELEGRAM_ALLOWED_IDS is. HMAC verification (verifyTelegramHash) and freshness
 * (isFresh) come from auth.service (constant-time timingSafeEqual, DO NOT touch).
 */
@Controller()
export class TelegramLoginController {
  constructor(private readonly auth: AuthService) {}

  @Get('public-login')
  publicLogin(
    @Query('next') next: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    const callback = `${AUTH_BASE}/public-auth/telegram?next=${encodeURIComponent(safeNext(next))}`;
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

  @Get('public-auth/telegram')
  async publicAuthTelegram(@Req() req: Request, @Res() res: Response) {
    const params: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query))
      if (typeof v === 'string' && k !== 'next') params[k] = v;
    const next = safeNext(req.query.next as string | undefined);
    const back = (e: string) =>
      res.redirect(`/public-login?error=${e}&next=${encodeURIComponent(next)}`);

    if (!this.auth.verifyTelegramHash(params)) return back('invalid_hash');
    if (!this.auth.isFresh(params.auth_date ?? '0')) return back('auth_expired');

    // We create/refresh the users row same as the dashboard login, but sign the
    // session with a:false — the public login NEVER carries admin (see the audit
    // fix above). Even if upsertUser sets users.is_admin=true (an allow-listed
    // user), THIS cookie stays non-admin; such a person reaches admin via /tg/*.
    const user = await this.auth.upsertUser(params);
    const token = this.auth.sign({
      i: user.id,
      t: user.tgId != null ? Number(user.tgId) : 0,
      n: user.name || user.username || 'Аноним',
      a: false,
    });
    this.auth.setCookie(res, token);
    res.redirect(next);
  }
}
