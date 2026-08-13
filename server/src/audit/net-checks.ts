/**
 * Checks that require network probes — second group of the core/site_audit.py
 * port: redirects, security headers, compression and protocol, trailing
 * slash, 404 page, broken links, duplicate title/description.
 *
 * Difference from the first group: the result depends on the moment of the
 * request, so comparisons against Python must be done on stable domains,
 * separating network noise from logic.
 *
 * Two traps that make these checks lie:
 *   • `Accept-Encoding` must explicitly ask for br, otherwise the server
 *     returns gzip and "Brotli not enabled" becomes a false accusation
 *     against a site where it is enabled. Python has a separate note about
 *     this (the brotli package in requirements);
 *   • the protocol version is taken NOT from the response, but from the ALPN
 *     TLS handshake: the response describes our client's capabilities, not
 *     the server's.
 */
import * as cheerio from 'cheerio';
import { Check, chk, plural, OK, WARN, FAIL, NA, HIGH, MED, LOW } from './types';

const TIMEOUT_MS = 15_000;
const UA = 'Mozilla/5.0 (compatible; IdeataBot/1.0; +https://ideata.io) AppleWebKit/537.36';
const MAX_LINKS = 40;      // this many links get pinged for brokenness
const LINK_WORKERS = 8;
// Ask for brotli explicitly: without this the server returns gzip, and the
// compression check lies.
const ACCEPT_ENCODING = 'br, gzip, deflate';

export interface FetchedPage {
  url: string;              // final URL after redirects
  status: number;
  headers: Record<string, string>;
  html: string;
}

const lower = (h: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k.toLowerCase()] = v; });
  return out;
};

/** GET with headers common to the audit. null — no response (timeout/DNS/dropped connection). */
export async function get(url: string, opts: { method?: string; redirect?: RequestRedirect } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: opts.method || 'GET',
      redirect: opts.redirect || 'follow',
      headers: { 'User-Agent': UA, 'Accept-Encoding': ACCEPT_ENCODING },
      signal: ac.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** http→https and www canonicalization. The only place that needs the intermediate hops. */
export async function checkRedirects(domain: string): Promise<Check[]> {
  const out: Check[] = [];

  const trace = async (start: string, limit = 6): Promise<Array<[number, string]>> => {
    const chain: Array<[number, string]> = [];
    let url = start;
    for (let i = 0; i < limit; i++) {
      const r = await get(url, { redirect: 'manual' });
      if (!r) break;
      chain.push([r.status, url]);
      const loc = r.headers.get('location');
      if (!(r.status >= 300 && r.status < 400 && loc)) break;
      try { url = new URL(loc, url).toString(); } catch { break; }
    }
    return chain;
  };

  const httpChain = await trace(`http://${domain}/`);
  if (!httpChain.length) {
    out.push(chk('redirect_https', 'Безопасность', 'HTTP → HTTPS', NA,
      'Не удалось проверить: сайт не ответил по http://'));
  } else {
    const final = httpChain[httpChain.length - 1][1];
    if (final.startsWith('https://')) {
      const code = httpChain[0][0];
      if (code === 301) {
        out.push(chk('redirect_https', 'Безопасность', 'HTTP → HTTPS', OK,
          'http:// отдаёт постоянный редирект 301 на https://'));
      } else if (code >= 300 && code < 400) {
        out.push(chk('redirect_https', 'Безопасность', 'HTTP → HTTPS', WARN,
          `Редирект есть, но код ${code}, а не 301. `
          + 'Постоянный редирект надёжнее передаёт вес ссылок.',
          { fix: 'Поменять код редиректа на 301.', impact: LOW, effort: LOW }));
      } else {
        out.push(chk('redirect_https', 'Безопасность', 'HTTP → HTTPS', OK,
          'Сайт доступен по https://'));
      }
    } else {
      out.push(chk('redirect_https', 'Безопасность', 'HTTP → HTTPS', FAIL,
        'http:// не перенаправляет на https:// — страница остаётся на незащищённом протоколе.',
        { weight: 3, fix: 'Настроить 301 с http:// на https:// на сервере или CDN.',
          impact: HIGH, effort: LOW }));
    }
  }

  if (httpChain.length > 3) {
    const n = httpChain.length - 1;
    out.push(chk('redirect_chain', 'Безопасность', 'Длина цепочки редиректов', WARN,
      `${n} ${plural(n, 'последовательный редирект', 'последовательных редиректа', 'последовательных редиректов')}. `
      + 'Каждый хоп замедляет загрузку и теряет часть веса ссылок.',
      { value: n, fix: 'Схлопнуть цепочку в один прямой редирект.', impact: LOW, effort: MED }));
  } else {
    out.push(chk('redirect_chain', 'Безопасность', 'Длина цепочки редиректов', OK,
      'Лишних редиректов нет'));
  }

  // www and bare-domain must converge on one canonical host, otherwise search
  // sees them as two different sites with identical content.
  const bare = await trace(`https://${domain}/`);
  const www = await trace(`https://www.${domain}/`);
  if (bare.length && www.length) {
    const host = (u: string) => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };
    const bLast = bare[bare.length - 1];
    const wLast = www[www.length - 1];
    const bHost = host(bLast[1]);
    const wHost = host(wLast[1]);
    if (bLast[0] < 400 && wLast[0] < 400 && bHost !== wHost) {
      out.push(chk('www_canonical', 'Безопасность', 'Канонизация www', FAIL,
        `И ${bHost}, и ${wHost} отдают страницу и не сводятся к одному хосту — `
        + 'поиск видит две копии сайта.',
        { weight: 2, fix: 'Выбрать канонический хост и поставить с другого 301 на него.',
          impact: HIGH, effort: LOW }));
    } else {
      out.push(chk('www_canonical', 'Безопасность', 'Канонизация www', OK,
        'www и основной домен сведены к одному хосту'));
    }
  } else {
    out.push(chk('www_canonical', 'Безопасность', 'Канонизация www', NA,
      'Не удалось проверить один из вариантов хоста'));
  }
  return out;
}

/** Security headers of the home page. */
export function checkHeaders(headers: Record<string, string>): Check[] {
  const out: Check[] = [];
  const h = headers;

  if ('strict-transport-security' in h) {
    out.push(chk('hsts', 'Безопасность', 'HSTS', OK,
      'Заголовок Strict-Transport-Security отдаётся'));
  } else {
    out.push(chk('hsts', 'Безопасность', 'HSTS', WARN,
      'Нет Strict-Transport-Security: первый заход по http:// успевает уйти незашифрованным.',
      { fix: 'Добавить заголовок Strict-Transport-Security: max-age=31536000.',
        impact: MED, effort: LOW }));
  }

  if ((h['x-content-type-options'] || '').toLowerCase() === 'nosniff') {
    out.push(chk('nosniff', 'Безопасность', 'X-Content-Type-Options', OK, 'nosniff включён'));
  } else {
    out.push(chk('nosniff', 'Безопасность', 'X-Content-Type-Options', WARN,
      'Нет nosniff — браузер может угадывать тип файла и исполнить загруженное как скрипт.',
      { fix: 'Добавить заголовок X-Content-Type-Options: nosniff.', impact: LOW, effort: LOW }));
  }

  if ('content-security-policy' in h) {
    out.push(chk('csp', 'Безопасность', 'Content-Security-Policy', OK, 'CSP задан'));
  } else {
    out.push(chk('csp', 'Безопасность', 'Content-Security-Policy', WARN,
      'CSP не задан — нет защиты от внедрения чужих скриптов.',
      { fix: 'Задать Content-Security-Policy — начать в режиме Report-Only, чтобы не сломать working-страницы.',
        impact: MED, effort: HIGH }));
  }

  if ('x-frame-options' in h || (h['content-security-policy'] || '').includes('frame-ancestors')) {
    out.push(chk('frame', 'Безопасность', 'Защита от кликджекинга', OK,
      'Встраивание в iframe ограничено'));
  } else {
    out.push(chk('frame', 'Безопасность', 'Защита от кликджекинга', WARN,
      'Ни X-Frame-Options, ни frame-ancestors — сайт можно встроить в чужой iframe.',
      { fix: 'Добавить X-Frame-Options: SAMEORIGIN (или frame-ancestors в CSP).',
        impact: LOW, effort: LOW }));
  }
  return out;
}

/**
 * Compression and protocol version — the cheapest speed win there is.
 * `alpn` comes from the TLS handshake (the SSL group): the HTTP response
 * describes the client's capabilities, not the server's, and can't be trusted.
 */
export function checkTransport(headers: Record<string, string>, alpn: string | null): Check[] {
  const out: Check[] = [];
  const enc = (headers['content-encoding'] || '').toLowerCase();

  if (enc.includes('br')) {
    out.push(chk('compression', 'Скорость', 'Сжатие', OK,
      'Brotli — лучшее из распространённых', { impact: MED }));
  } else if (enc.includes('gzip') || enc.includes('deflate')) {
    out.push(chk('compression', 'Скорость', 'Сжатие', WARN,
      'Работает gzip, но не Brotli. Brotli жмёт на 15-25% лучше и поддерживается всеми современными браузерами.',
      { fix: 'Включить brotli в nginx/CDN (brotli on) рядом с gzip.', impact: LOW, effort: LOW }));
  } else {
    out.push(chk('compression', 'Скорость', 'Сжатие', FAIL,
      'Страница отдаётся без сжатия — трафик и время загрузки в разы больше необходимого.',
      { fix: 'Включить gzip или brotli на сервере/CDN.', weight: 2, impact: HIGH, effort: LOW }));
  }

  if (alpn === null) {
    out.push(chk('http_version', 'Скорость', 'Версия протокола', NA,
      'Определить не удалось: сервер не назвал протокол при TLS-подключении'));
  } else if (alpn === 'h2') {
    out.push(chk('http_version', 'Скорость', 'Версия протокола', OK,
      'HTTP/2 — запросы идут параллельно по одному соединению', { value: 'HTTP/2' }));
  } else {
    out.push(chk('http_version', 'Скорость', 'Версия протокола', WARN,
      'Только HTTP/1.1: браузер грузит ресурсы по очереди, а не параллельно.',
      { value: 'HTTP/1.1', fix: 'Включить HTTP/2 на nginx/CDN (listen 443 ssl http2).',
        impact: MED, effort: LOW }));
  }
  return out;
}

/**
 * `/page` and `/page/` must resolve to the same URL, otherwise these are two
 * pages with identical content competing in search results.
 */
export async function checkTrailingSlash(baseUrl: string): Promise<Check[]> {
  let path = '/';
  try { path = new URL(baseUrl).pathname || '/'; } catch { /* keep / */ }
  if (path === '/') {
    // The home page has no trailing-slash question — nothing to check.
    return [chk('trailing_slash', 'Индексация', 'Слеш в конце URL', NA,
      'Проверяется на внутренних страницах, не на главной')];
  }
  const a = baseUrl.replace(/\/+$/, '');
  const b = `${a}/`;
  const [ra, rb] = await Promise.all([get(a), get(b)]);
  if (!ra || !rb) {
    return [chk('trailing_slash', 'Индексация', 'Слеш в конце URL', NA, 'Проверить не удалось')];
  }
  const strip = (u: string) => u.replace(/\/+$/, '');
  if (ra.status < 400 && rb.status < 400 && strip(ra.url) !== strip(rb.url)) {
    return [chk('trailing_slash', 'Индексация', 'Слеш в конце URL', WARN,
      'И /page, и /page/ отдают 200 и не сводятся друг к другу — потенциальные страницы-дубли.',
      { fix: 'Настроить 301 с одного варианта на другой.', impact: MED, effort: LOW })];
  }
  return [chk('trailing_slash', 'Индексация', 'Слеш в конце URL', OK,
    'Варианты со слешем и без сведены к одному URL')];
}

/** A nonexistent URL must return 404, not 200 with a "nice-looking" page. */
export async function check404(base: string): Promise<Check[]> {
  let probe = base;
  try { probe = new URL('/ideata-audit-404-probe-x7', base).toString(); } catch { /* leave as is */ }
  const r = await get(probe);
  if (!r) {
    return [chk('page_404', 'Индексация', 'Страница 404', NA, 'Проверить не удалось')];
  }
  if (r.status === 404) {
    return [chk('page_404', 'Индексация', 'Страница 404', OK, 'Несуществующий адрес отдаёт 404')];
  }
  if (r.status === 200) {
    return [chk('page_404', 'Индексация', 'Страница 404', FAIL,
      'Несуществующий адрес отдаёт 200 — поиск индексирует бесконечные пустышки как настоящие страницы.',
      { weight: 2,
        fix: 'Отдавать статус 404 для несуществующих адресов (для SPA — серверный фолбэк с кодом 404).',
        impact: MED, effort: MED })];
  }
  return [chk('page_404', 'Индексация', 'Страница 404', WARN,
    `Несуществующий адрес отдаёт ${r.status}, а не 404`, { value: r.status })];
}

/** Broken links. HEAD, not GET: we don't need the body, and the traffic isn't ours. */
export async function checkLinks($: cheerio.CheerioAPI, baseUrl: string): Promise<Check[]> {
  const urls: string[] = [];
  for (const el of $('a[href]').toArray()) {
    const href = ($(el).attr('href') || '').trim();
    if (/^(#|mailto:|tel:|javascript:|data:)/i.test(href)) continue;
    let full: string;
    try { full = new URL(href, baseUrl).toString(); } catch { continue; }
    if (!/^https?:\/\//.test(full)) continue;
    const clean = full.split('#')[0];
    if (!urls.includes(clean)) urls.push(clean);
  }
  const list = urls.slice(0, MAX_LINKS);
  if (!list.length) {
    return [chk('broken_links', 'Контент', 'Битые ссылки', NA, 'Ссылок на странице не нашлось')];
  }

  const probe = async (u: string): Promise<[string, number | null]> => {
    let r = await get(u, { method: 'HEAD' });
    // Some servers don't support HEAD and reply with 405/501 — retry with GET.
    if (r && [403, 405, 501].includes(r.status)) r = await get(u);
    return [u, r ? r.status : null];
  };

  const broken: string[] = [];
  for (let i = 0; i < list.length; i += LINK_WORKERS) {
    const batch = await Promise.all(list.slice(i, i + LINK_WORKERS).map(probe));
    for (const [u, code] of batch) {
      if (code !== null && code >= 400) broken.push(`${u} → ${code}`);
    }
  }

  if (!broken.length) {
    return [chk('broken_links', 'Контент', 'Битые ссылки', OK,
      `Проверено ${list.length} ${plural(list.length, 'ссылка', 'ссылки', 'ссылок')}, битых нет`,
      { value: 0 })];
  }
  return [chk('broken_links', 'Контент', 'Битые ссылки', broken.length > 2 ? FAIL : WARN,
    `${broken.length} из ${list.length} ведут в ошибку`,
    { value: broken.slice(0, 10), weight: 2 })];
}

/**
 * Duplicate title/description across several site pages.
 *
 * Pages with noindex (meta robots or the X-Robots-Tag header) are excluded:
 * they're excluded from search results by definition and can't compete
 * there — otherwise a login page and the dashboard's SPA shell would count
 * as duplicates.
 */
export async function checkDuplicates(urls: Iterable<string>): Promise<Check[]> {
  const seen: Array<[string, string, string]> = [];
  for (const u of urls) {
    const r = await get(u);
    if (!r || r.status >= 400) continue;
    const html = await r.text().catch(() => '');
    if (!html) continue;
    if ((r.headers.get('x-robots-tag') || '').toLowerCase().includes('noindex')) continue;
    const $ = cheerio.load(html);
    const robots = ($('meta[name="robots" i]').first().attr('content') || '').toLowerCase();
    if (robots.includes('noindex')) continue;
    const title = $('title').first().text().replace(/\s+/g, ' ').trim();
    const desc = ($('meta[name="description" i]').first().attr('content') || '').trim();
    seen.push([u, title, desc]);
  }
  if (seen.length < 2) {
    return [chk('duplicates', 'Контент', 'Дубли title/description', NA,
      'Не набралось страниц для сравнения')];
  }

  const dupes = (idx: 1 | 2): number => {
    const vals = seen.map((row) => row[idx]).filter(Boolean);
    return vals.length - new Set(vals).size;
  };
  const dt = dupes(1);
  const dd = dupes(2);
  if (!dt && !dd) {
    return [chk('duplicates', 'Контент', 'Дубли title/description', OK,
      `На ${seen.length} страницах теги уникальны`, { value: 0 })];
  }
  const parts: string[] = [];
  if (dt) parts.push(`${dt} повторяющихся title`);
  if (dd) parts.push(`${dd} повторяющихся description`);
  return [chk('duplicates', 'Контент', 'Дубли title/description', WARN,
    `${parts.join(' и ')} на ${seen.length} страницах — страницы конкурируют друг с другом в выдаче.`,
    { value: dt + dd, fix: 'Сделать title и description уникальными для каждой страницы.',
      impact: MED, effort: MED })];
}
