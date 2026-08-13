/**
 * Indexing, SSL, and speed — the third group of the core/site_audit.py port.
 *
 * This is where Ideata's signature check lives: an AI crawler blocked in
 * robots.txt means a guaranteed zero in that engine's answers, no matter how
 * much content the site has. This isn't "security" — it's opting out of AI visibility.
 */
import * as cheerio from 'cheerio';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { Check, chk, OK, WARN, FAIL, NA, HIGH, MED, LOW } from './types';
import { blocksAll, blockedAiBots } from './robots';
import { SslInfo } from './ssl';
import { get } from './net-checks';

// An SPA with an index.html fallback returns 200 with the home page markup
// for ANY path — that's how llms.txt and robots.txt that don't exist on the
// site used to be "found": a proper text file doesn't start with <!doctype/<html.
const HTML_MARKER = /^(?:\s|<!--[\s\S]*?-->|<\?xml[^>]*\?>)*(?:<!doctype\b|<html\b)/i;

/**
 * A 200 for /llms.txt or /robots.txt doesn't yet mean the file exists —
 * check the start of the response (accounting for BOM and leading whitespace).
 */
export function looksLikeHtml(text: string): boolean {
  return HTML_MARKER.test(String(text || '').replace(/^﻿/, '').slice(0, 300));
}

/**
 * URLs from a sitemap or sitemapindex. null = the XML didn't parse.
 *
 * The validator here is mandatory: the parser alone is too tolerant — it
 * silently digests both an HTML page instead of a sitemap (SPA fallback) and
 * truncated XML, returning an empty list. And that's a completely different
 * diagnosis: "the sitemap is empty" (WARN) instead of "the sitemap URL
 * doesn't serve XML" (FAIL). Python gets a ParseError from ElementTree at
 * this point, and the behavior needs to match.
 */
export function sitemapUrls(text: string): string[] | null {
  const body = String(text || '').trim();
  if (!body) return null;
  if (XMLValidator.validate(body) !== true) return null;
  let tree: unknown;
  try {
    // removeNSPrefix — a sitemap is almost always in the sitemaps.org namespace,
    // and without stripping the prefix the tags aren't found.
    tree = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true }).parse(body);
  } catch {
    return null;
  }
  if (!tree || typeof tree !== 'object') return null;

  const out: string[] = [];
  const walk = (node: unknown, key?: string): void => {
    if (Array.isArray(node)) { node.forEach((v) => walk(v, key)); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, k);
      return;
    }
    if (key === 'loc') {
      const s = String(node ?? '').trim();
      if (s) out.push(s);
    }
  };
  walk(tree);
  return out;
}

/** Types from JSON-LD markup — read by both search and AI. */
export function schemaTypes($: cheerio.CheerioAPI): string[] {
  const types: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') {
      const t = (node as Record<string, unknown>)['@type'];
      for (const v of Array.isArray(t) ? t : [t]) {
        if (typeof v === 'string' && !types.includes(v)) types.push(v);
      }
      Object.values(node as Record<string, unknown>).forEach(walk);
    }
  };
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    try {
      walk(JSON.parse($(el).text() || ''));
    } catch {
      continue; // broken JSON-LD isn't rare
    }
  }
  return types;
}

/** robots.txt, AI crawler access, sitemap, meta robots, llms.txt, Schema.org. */
export async function checkIndexing(
  base: string, $: cheerio.CheerioAPI, robotsTxt: string,
): Promise<Check[]> {
  const out: Check[] = [];

  if (robotsTxt) {
    if (blocksAll(robotsTxt)) {
      out.push(chk('robots', 'Индексация', 'robots.txt', FAIL,
        'Disallow: / для всех ботов — сайт целиком закрыт от индексации.',
        { weight: 3,
          fix: 'Убрать Disallow: / из секции User-agent: * (закрывать только служебные разделы).',
          impact: HIGH, effort: LOW }));
    } else {
      out.push(chk('robots', 'Индексация', 'robots.txt', OK,
        'Есть и не закрывает сайт целиком'));
    }

    const blocked = blockedAiBots(robotsTxt);
    if (blocked.length) {
      out.push(chk('ai_bots', 'Индексация', 'Доступ ИИ-краулеров', FAIL,
        `В robots.txt закрыты: ${blocked.slice(0, 6).join(', ')}`
        + `${blocked.length > 6 ? ' и другие' : ''}. `
        + 'Эти движки не смогут прочитать сайт — в их ответах вас не будет.',
        { value: blocked, weight: 2,
          fix: 'Разрешить в robots.txt краулеров тех движков, в чьих ответах хотите '
             + 'появляться (GPTBot, ClaudeBot, PerplexityBot, Google-Extended).',
          impact: HIGH, effort: LOW }));
    } else {
      out.push(chk('ai_bots', 'Индексация', 'Доступ ИИ-краулеров', OK,
        'ChatGPT, Perplexity и Google AI могут читать сайт'));
    }
  } else {
    out.push(chk('robots', 'Индексация', 'robots.txt', WARN,
      'Файла нет — боты обойдут сайт «как получится», без ваших правил.',
      { fix: 'Добавить /robots.txt со ссылкой на sitemap.', impact: LOW, effort: LOW }));
    out.push(chk('ai_bots', 'Индексация', 'Доступ ИИ-краулеров', OK,
      'Ограничений для ИИ-краулеров нет'));
  }

  // First the sitemap from robots.txt, otherwise the standard location.
  // Declared ≠ working, so the file is actually fetched and parsed.
  const declared = [...String(robotsTxt || '').matchAll(/^\s*sitemap:\s*(\S+)/gim)]
    .map((m) => m[1]);
  let smUrl = declared[0];
  if (!smUrl) {
    try { smUrl = new URL('/sitemap.xml', base).toString(); } catch { smUrl = `${base}/sitemap.xml`; }
  }
  const sm = await get(smUrl);
  const smText = sm && sm.status < 400 ? await sm.text().catch(() => '') : '';
  if (!sm || sm.status >= 400 || !smText.trim()) {
    out.push(chk('sitemap', 'Индексация', 'sitemap.xml', FAIL,
      declared.length ? `Не открывается: ${smUrl}`
        : 'Не найден ни в robots.txt, ни по /sitemap.xml — поиск ищет страницы только по ссылкам.',
      { weight: 2, fix: 'Сгенерировать sitemap.xml и указать его в robots.txt строкой Sitemap:.',
        impact: MED, effort: MED }));
  } else {
    const urls = sitemapUrls(smText);
    if (urls === null) {
      out.push(chk('sitemap', 'Индексация', 'sitemap.xml', FAIL,
        `Отдаётся, но это не валидный XML: ${smUrl} — поиск такую карту не прочитает.`,
        { weight: 2, fix: 'Проверить, что по адресу карты отдаётся XML, а не HTML-страница.',
          impact: MED, effort: MED }));
    } else if (!urls.length) {
      out.push(chk('sitemap', 'Индексация', 'sitemap.xml', WARN,
        'Валидный XML, но ни одного URL внутри',
        { value: 0, fix: 'Наполнить sitemap ссылками на страницы сайта.',
          impact: MED, effort: MED }));
    } else {
      const isIndex = smText.slice(0, 400).toLowerCase().includes('<sitemapindex');
      out.push(chk('sitemap', 'Индексация', 'sitemap.xml', OK,
        `${urls.length} URL${isIndex ? ' (индекс карт сайта)' : ''}`, { value: urls.length }));
    }
  }

  const robotsMeta = ($('meta[name="robots" i]').first().attr('content') || '').toLowerCase();
  if (robotsMeta.includes('noindex')) {
    out.push(chk('noindex', 'Индексация', 'meta robots', FAIL,
      'На главной стоит noindex — страница не попадёт в поиск.',
      { weight: 3, fix: 'Убрать noindex из <meta name="robots"> на публичных страницах.',
        impact: HIGH, effort: LOW }));
  } else {
    out.push(chk('noindex', 'Индексация', 'meta robots', OK, 'Страница открыта для индексации'));
  }

  let llmsUrl = `${base}/llms.txt`;
  try { llmsUrl = new URL('/llms.txt', base).toString(); } catch { /* leave as is */ }
  const llms = await get(llmsUrl);
  const llmsText = llms && llms.status === 200 ? await llms.text().catch(() => '') : '';
  // HTML instead of llms.txt is the home page's SPA fallback, not a real file:
  // without this check such sites got a false "llms.txt exists".
  if (llmsText.trim() && !looksLikeHtml(llmsText)) {
    out.push(chk('llms_txt', 'Индексация', 'llms.txt', OK,
      'Есть — ИИ-ассистентам дана карта сайта'));
  } else {
    out.push(chk('llms_txt', 'Индексация', 'llms.txt', WARN,
      'Нет llms.txt — ChatGPT и Perplexity разбирают сайт без подсказок о структуре.',
      { fix: 'Положить /llms.txt с описанием проекта и ссылками на ключевые страницы.',
        impact: MED, effort: LOW }));
  }

  const types = schemaTypes($);
  if (types.length) {
    out.push(chk('schema', 'Индексация', 'Schema.org', OK,
      `Разметка есть: ${types.slice(0, 6).join(', ')}`, { value: types.slice(0, 12) }));
  } else {
    out.push(chk('schema', 'Индексация', 'Schema.org', WARN,
      'Нет JSON-LD разметки — поиск и ИИ разбирают смысл страницы вслепую.',
      { fix: 'Добавить JSON-LD (Organization/Product, а для вопросов-ответов — FAQPage).',
        impact: MED, effort: MED }));
  }
  return out;
}

/**
 * SSL certificate. `info` is passed in from outside: the tech passport needs
 * the same response too, and an extra TLS handshake just for this would be
 * paying for nothing.
 */
export function checkSslChecks(info: SslInfo | null): Check[] {
  if (info === null) {
    return [chk('ssl', 'Безопасность', 'SSL-сертификат', NA,
      'Порт 443 не отвечает — HTTPS на домене не поднят')];
  }
  const out: Check[] = [];
  if (info.valid) {
    out.push(chk('ssl', 'Безопасность', 'SSL-сертификат', OK,
      `Действителен, выдан: ${info.issuer || 'неизвестный УЦ'}`));
  } else {
    out.push(chk('ssl', 'Безопасность', 'SSL-сертификат', FAIL,
      info.error || 'Сертификат не прошёл проверку',
      { weight: 3, fix: 'Перевыпустить сертификат (Let\'s Encrypt бесплатно) и проверить цепочку.',
        impact: HIGH, effort: MED }));
  }

  const days = info.days_left;
  if (days === null) {
    out.push(chk('ssl_expiry', 'Безопасность', 'Срок сертификата', NA,
      'Дату истечения прочитать не удалось'));
  } else if (days < 0) {
    out.push(chk('ssl_expiry', 'Безопасность', 'Срок сертификата', FAIL,
      `Истёк ${Math.abs(days)} дн. назад — браузеры показывают предупреждение вместо сайта.`,
      { value: days, weight: 3, fix: 'Продлить сертификат и включить автопродление.',
        impact: HIGH, effort: LOW }));
  } else if (days < 14) {
    out.push(chk('ssl_expiry', 'Безопасность', 'Срок сертификата', WARN,
      `Истекает через ${days} дн. Проверьте автопродление.`,
      { value: days, fix: 'Убедиться, что автопродление работает (certbot renew / настройки CDN).',
        impact: MED, effort: LOW }));
  } else {
    out.push(chk('ssl_expiry', 'Безопасность', 'Срок сертификата', OK,
      `Действителен ещё ${days} дн.`, { value: days }));
  }
  return out;
}

export interface Cwv {
  perf_score: number | null;
  lcp: number | null;   // seconds
  cls: number | null;
  inp: number | null;   // milliseconds
}

/** Core Web Vitals from PageSpeed Insights: one request, mobile — what Google ranks by. */
export async function fetchCwv(domain: string, apiKey = ''): Promise<Cwv | null> {
  if (!domain) return null;
  const params = new URLSearchParams({
    url: `https://${domain}/`, strategy: 'mobile', category: 'performance',
  });
  if (apiKey) params.set('key', apiKey);

  const r = await get(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`);
  if (!r || r.status !== 200) return null;
  let lh: any;
  try {
    lh = (await r.json())?.lighthouseResult || {};
  } catch {
    return null;
  }
  // Number(null) === 0 — nulls must be filtered out BEFORE the cast, otherwise
  // a missing score becomes zero, and the site gets "0/100, site is slow"
  // instead of "no data". Python raises on float(None) here and honestly
  // returns None.
  const toNum = (v: unknown): number | null => {
    if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const num = (key: string): number | null => toNum(lh?.audits?.[key]?.numericValue);
  const score = toNum(lh?.categories?.performance?.score);
  const lcpMs = num('largest-contentful-paint');
  const cls = num('cumulative-layout-shift');
  const inpMs = num('interaction-to-next-paint');

  const out: Cwv = {
    perf_score: score === null ? null : Math.round(score * 100),
    lcp: lcpMs === null ? null : Number((lcpMs / 1000).toFixed(1)),
    cls: cls === null ? null : Number(cls.toFixed(2)),
    inp: inpMs === null ? null : Math.round(inpMs),
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

/** Speed score and the three Core Web Vitals metrics. */
export function checkSpeed(cwv: Cwv | null): Check[] {
  if (!cwv) {
    return [chk('cwv', 'Скорость', 'Core Web Vitals', NA, 'PageSpeed Insights не ответил')];
  }
  const out: Check[] = [];
  const score = cwv.perf_score;
  if (score === null) {
    out.push(chk('cwv', 'Скорость', 'Оценка скорости', NA, 'Нет данных'));
  } else if (score >= 90) {
    out.push(chk('cwv', 'Скорость', 'Оценка скорости', OK, `${score}/100 (mobile)`, { value: score }));
  } else if (score >= 50) {
    out.push(chk('cwv', 'Скорость', 'Оценка скорости', WARN,
      `${score}/100 (mobile) — есть что ускорять`,
      { value: score, fix: 'Смотреть отчёт PageSpeed: обычно виноваты картинки и объём JS.',
        impact: MED, effort: HIGH }));
  } else {
    out.push(chk('cwv', 'Скорость', 'Оценка скорости', FAIL,
      `${score}/100 (mobile) — сайт медленный`,
      { value: score, weight: 2,
        fix: 'Начать с картинок (webp/avif + lazy-loading) и объёма JS — обычно они и есть причина.',
        impact: HIGH, effort: HIGH }));
  }

  if (cwv.lcp !== null) {
    const st = cwv.lcp <= 2.5 ? OK : (cwv.lcp <= 4 ? WARN : FAIL);
    // toFixed(1), not the raw number: LCP is rounded to tenths, and Python
    // prints "3.0 с", whereas JS would drop the decimal down to "3 с".
    out.push(chk('lcp', 'Скорость', 'LCP (отрисовка главного блока)', st,
      `${cwv.lcp.toFixed(1)} с (норма ≤ 2.5 с)`, { value: cwv.lcp }));
  }
  if (cwv.cls !== null) {
    const st = cwv.cls <= 0.1 ? OK : (cwv.cls <= 0.25 ? WARN : FAIL);
    out.push(chk('cls', 'Скорость', 'CLS (скачки вёрстки)', st,
      `${cwv.cls} (норма ≤ 0.1)`, { value: cwv.cls }));
  }
  if (cwv.inp !== null) {
    const st = cwv.inp <= 200 ? OK : (cwv.inp <= 500 ? WARN : FAIL);
    out.push(chk('inp', 'Скорость', 'INP (отклик на клик)', st,
      `${cwv.inp} мс (норма ≤ 200 мс)`, { value: cwv.inp }));
  }
  return out;
}
