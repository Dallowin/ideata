/**
 * Weekly user-facing AEO reports (emails) — a port of scrapper/web/reports.py
 * (built from aggregate_monitoring) and scrapper/web/emails.py (the HTML email
 * template). The run engine and dashboard already live in Nest; this is the last
 * missing product layer.
 *
 * Three layers:
 *   • PURE port (tested against the live Python golden output, no DB access):
 *     - composeReport(...)      — reports.compose_report: agg → {subject,text,html,telegram};
 *     - renderReportEmail(r,l)  — emails.weekly_report_email: report → HTML email
 *       (dark theme, EN/RU, duplicated bgcolor for Outlook, escaping of user-provided
 *       data). The html inside composeReport is built by exactly this function.
 *   • DB port: buildWeeklyReport(tracker) — reports.report_for_tracker on top of
 *     aggregateMonitoring (8-week window, weekly citations, brand language).
 *   • Delivery (gated by REPORTS_ENABLED + plan + weekly report_log idempotency):
 *     runWeeklyReports/sendUserReports via mail.sendMail. The scheduler (repeatable,
 *     Mondays) lives in queue.ts (registerWeeklyReportsScheduler). This file only
 *     builds and sends; the worker calls it on tick. The Telegram channel is NOT
 *     ported (Nest has no owner-DM sender) — email-only, see coverage-gaps.
 *
 * Parity of compose_report/weekly_report_email is proven by reports.parity.spec.ts
 * against a golden dump from Python (the reference oracle) across four aggregate
 * fixtures (full/empty-panel/special-characters, RU+EN) — no discrepancies allowed.
 */
import { blogPrisma } from '../blogwriter/server/utils/prisma';
import { pyRound } from './text';
import { citeItems, host } from './parse';
import { normalizeProjectLang } from './panel';
import { aggregateMonitoring, DEFAULT_PLATFORMS } from './aggregate';
import type { MonitoringRow } from './aggregate.types';
import { sendMail, mailConfigured, type MailTransport } from './mail';

// ── human-readable engine labels (aeo.py:250) ────────────────────────────────
/** Engine slug → label (for the "Engines that mention you most" lines). */
export const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  claude: 'Claude',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  aio: 'AI Overviews',
  gigachat: 'GigaChat',
  alice: 'Алиса',
  yandex: 'Яндекс Поиск',
  chatgpt: 'ChatGPT',
  deepseek: 'DeepSeek',
  grok: 'Grok',
};

const DASHBOARD_URL_DEFAULT = 'https://ideata.io/app';

// ── email dark theme palette (emails.py:42-60) ───────────────────────────────
const INK = '#f4f4f5';
const GRAY = '#a1a1aa';
const HAIRLINE = '#2a2a31';
const PAGE_BG = '#0b0b0d';
const CARD_BG = '#141417';
const ACCENT = '#fb923c';
const POS = '#4ade80';
const NEG = '#f87171';
const BTN_BG = '#fafafa';
const BTN_FG = '#111114';
const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial," +
  "'Apple Color Emoji','Segoe UI Emoji',sans-serif";

const DEFAULT_LANG = 'ru';
export type ReportLang = 'ru' | 'en';

// ── email string dictionary (emails.py:63-183; weekly-relevant keys only) ────
type StrDict = Record<string, string>;
const T: Record<string, StrDict> = {
  ru: {
    footer1: 'Это письмо отправлено Ideata — мониторинг AI-видимости бренда · ideata.io',
    footer2: 'Если вы не запрашивали письмо — просто игнорируйте.',
    wk_week: 'Неделя {week} · {domain}',
    wk_sub: 'Свежий срез AI-видимости вашего бренда за неделю.',
    wk_visibility: 'Видимость бренда',
    wk_sov: 'Доля упоминаний (SoV)',
    wk_engines: 'Движки, где вас упоминают чаще всего',
    wk_no_engines: 'Пока ни один движок вас регулярно не называет.',
    wk_rivals: 'Конкуренты',
    wk_cites: 'За неделю: <b>{cites}</b> новых цитат из <b>{srcs}</b> источников',
    wk_full: 'Полный срез цитат: {at}',
    wk_button: 'Открыть дашборд',
    wk_title: 'Недельный отчёт · {domain}',
    wk_pre: 'Видимость {vis}% за неделю · {domain}',
    pp_unit: ' п.п.',
    subj_weekly: 'Ideata: недельный отчёт по {domain}',
    wtxt_head: 'Отчёт за неделю по {domain}',
    wtxt_week: 'Неделя {week}',
    wtxt_vis: 'Видимость бренда: {vis}% ({delta} п.п. за неделю)',
    wtxt_sov: 'Доля упоминаний (SoV): {sov}%',
    wtxt_engines: 'Движки, где вас упоминают чаще всего:',
    wtxt_rivals: 'Конкуренты (видимость):',
    wtxt_cites: 'За неделю: {cites} новых цитат из {srcs} источников',
    wtxt_full: 'Полный срез цитат: {at}',
    wtxt_dash: 'Панель: {url}',
  },
  en: {
    footer1: 'Sent by Ideata — AI visibility monitoring for your brand · ideata.io',
    footer2: "If you didn't request this email, just ignore it.",
    wk_week: 'Week {week} · {domain}',
    wk_sub: "This week's snapshot of your brand's AI visibility.",
    wk_visibility: 'Brand visibility',
    wk_sov: 'Share of voice (SoV)',
    wk_engines: 'Engines that mention you most',
    wk_no_engines: 'No engine mentions you regularly yet.',
    wk_rivals: 'Competitors',
    wk_cites: 'This week: <b>{cites}</b> new citations from <b>{srcs}</b> sources',
    wk_full: 'Full citation snapshot: {at}',
    wk_button: 'Open dashboard',
    wk_title: 'Weekly report · {domain}',
    wk_pre: 'Visibility {vis}% this week · {domain}',
    pp_unit: ' pp',
    subj_weekly: 'Ideata: weekly report for {domain}',
    wtxt_head: 'Weekly report for {domain}',
    wtxt_week: 'Week {week}',
    wtxt_vis: 'Brand visibility: {vis}% ({delta} pp this week)',
    wtxt_sov: 'Share of voice (SoV): {sov}%',
    wtxt_engines: 'Engines that mention you most:',
    wtxt_rivals: 'Competitors (visibility):',
    wtxt_cites: 'This week: {cites} new citations from {srcs} sources',
    wtxt_full: 'Full citation snapshot: {at}',
    wtxt_dash: 'Dashboard: {url}',
  },
};

/**
 * Language tag → supported email code (emails.normalize_lang:188-198): `ru`,
 * `RU`, `ru-RU`, `en_US`, None → 'ru'/'en'; anything unrecognized → 'ru' (an
 * email in an unknown language is worse than one in Russian). Differs from
 * normalizeProjectLang: there null means "language undetermined", here it's
 * always a concrete code.
 */
export function normalizeLang(lang: unknown): ReportLang {
  const code = String(lang ?? '')
    .trim()
    .toLowerCase()
    .replace(/_/g, '-');
  if (!code) return DEFAULT_LANG;
  const head = code.split('-')[0];
  return head === 'ru' || head === 'en' ? head : DEFAULT_LANG;
}

/** String by key, falling back to Russian (emails._t:201-203). */
function tRaw(lang: string, key: string): string {
  const dict = T[lang] ?? T[DEFAULT_LANG];
  return dict[key] || T[DEFAULT_LANG][key];
}

/** Public wrapper with language normalization (emails.t:206-211). */
export function t(lang: unknown, key: string): string {
  return tRaw(normalizeLang(lang), key);
}

/** Python-style str.format(**kwargs) for our named `{key}` placeholders. */
function fmt(template: string, params: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) =>
    k in params ? String(params[k] ?? '') : `{${k}}`,
  );
}

// ── escaping ──────────────────────────────────────────────────────────────────

/** HTML escaping, quote=True (emails._esc:214-217): & < > " ' — order matters. */
function escHtml(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** Telegram escaping, quote=False (telegram._esc:25-26): only & < >. */
function escTg(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ── Python-ish bits ───────────────────────────────────────────────────────────

/** `x or 0` for a numeric aggregate field: non-number/non-finite → 0. */
function numOr0(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** `int(round(x or 0))` with banker's rounding (aggregate uses the same pyRound). */
function rInt(v: unknown): number {
  return pyRound(numOr0(v));
}

/**
 * Signed delta (reports._sign:83-89 / emails._sign:320-322): `+5`/`-3`/`0`.
 * Non-number → 0 (Python's float()-except). Rounding is banker's (pyRound).
 */
function pySign(n: unknown): string {
  const r = rInt(n);
  return r > 0 ? `+${r}` : String(r);
}

/** ISO timestamp → 'DD.MM.YYYY' (reports._fmt_date:72-80); None/garbage → null. */
export function fmtDate(v: unknown): string | null {
  if (v === null || v === undefined || v === '' || v === 0 || v === false) return null;
  const s = String(v).replace('Z', '+00:00');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
}

// ── reading from the aggregate (reports.py:92-122) ────────────────────────────

/**
 * The aggregate is read defensively (like Python's .get), so the input is
 * `unknown`: a concrete MonitoringAgg from aggregateMonitoring and a mock
 * object from a test are equally valid here. Parsing goes through asObj/asArr,
 * without trusting the shape.
 */
type Agg = unknown;

function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** Top engines with mentions (reports._top_engines:92-104): [(label, vis)]. */
export function topEngines(agg: Agg, limit = 3): Array<[string, number]> {
  const a = asObj(agg);
  const platforms = asArr(a.platforms) as string[];
  const selfRow = (asArr(a.platMatrix) as Record<string, unknown>[]).find((r) => r && r.self);
  const vals = asArr(asObj(selfRow).vals);
  const pairs: Array<[string, number]> = [];
  const n = Math.min(platforms.length, vals.length);
  for (let i = 0; i < n; i += 1) {
    const v = numOr0(vals[i]);
    if (v > 0) pairs.push([platforms[i], v]);
  }
  pairs.sort((x, y) => y[1] - x[1]); // -x[1]: descending by vis, stable
  return pairs.slice(0, limit).map(([code, v]) => [PLATFORM_LABELS[code] ?? code, v]);
}

/** Top competitors by visibility (reports._rivals:107-110): leaderboard without self. */
export function rivalsOf(agg: Agg, limit = 3): Array<{ brand: string; vis: number }> {
  const lb = asArr(asObj(agg).leaderboard) as Record<string, unknown>[];
  return lb
    .filter((r) => r && !r.self)
    .slice(0, limit)
    .map((r) => ({ brand: String(r.brand ?? ''), vis: numOr0(r.vis) }));
}

/** Weekly visibility change (reports._week_delta:113-122). */
export function weekDelta(agg: Agg): number {
  const series = asArr(asObj(asObj(agg).visTrend).series) as Record<string, unknown>[];
  const selfSeries = series.find((s) => s && s.self);
  const data = asArr(asObj(selfSeries).data);
  if (data.length >= 2) {
    return rInt(numOr0(data[data.length - 1]) - numOr0(data[data.length - 2]));
  }
  return rInt(asObj(asObj(agg).kpi).visDelta);
}

// ── master switch and dashboard URL (reports.py:47-55) ───────────────────────

/** REPORTS_ENABLED=0/false/no/off mutes all delivery (reports.reports_enabled). */
export function reportsEnabled(): boolean {
  const v = (process.env.REPORTS_ENABLED ?? '1').toLowerCase();
  return !['0', 'false', 'no', 'off'].includes(v);
}

/** Dashboard URL for the button/subtitle (reports.dashboard_url:53-55). */
export function dashboardUrl(): string {
  return (process.env.REPORTS_DASHBOARD_URL || '').trim() || DASHBOARD_URL_DEFAULT;
}

/** ISO-8601 UTC week as `YYYY-Www` (services.week_key:73-75; isocalendar). */
export function weekKey(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const firstThu = new Date(Date.UTC(isoYear, 0, 4));
  const firstThuDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstThuDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

// ── HTML building blocks of the email (emails.py:220-330) ────────────────────

/** Hidden preheader (emails._preheader:220-228). */
function preheader(text: string): string {
  const pad = '&#847;&zwnj;&nbsp;'.repeat(30);
  return (
    '<span style="display:none!important;visibility:hidden;mso-hide:all;opacity:0;' +
    'color:transparent;height:0;width:0;max-height:0;max-width:0;overflow:hidden;' +
    `font-size:1px;line-height:1px;">${escHtml(text)}${pad}</span>`
  );
}

/** Table-based button — a light chip with dark text (emails.button:231-243). */
function button(label: string, url: string): string {
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" ' +
    'style="margin:8px 0 4px;"><tr>' +
    `<td align="center" bgcolor="${BTN_BG}" style="border-radius:8px;background:${BTN_BG};">` +
    `<a href="${escHtml(url)}" target="_blank" ` +
    `style="display:inline-block;padding:13px 26px;font-family:${FONT};` +
    `font-size:14px;font-weight:600;line-height:1;color:${BTN_FG};` +
    `text-decoration:none;border-radius:8px;">${escHtml(label)}</a>` +
    '</td></tr></table>'
  );
}

/** Base email shell (emails._shell:246-295). Duplicated bgcolor for Outlook. */
function shell(title: string, contentHtml: string, pre: string, lang: string): string {
  const l = normalizeLang(lang);
  return (
    '<!DOCTYPE html>\n' +
    `<html lang="${l}" xmlns="http://www.w3.org/1999/xhtml">\n` +
    '<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    '<meta http-equiv="X-UA-Compatible" content="IE=edge">\n' +
    '<meta name="color-scheme" content="dark">\n' +
    '<meta name="supported-color-schemes" content="dark">\n' +
    `<title>${escHtml(title)}</title>\n` +
    '</head>\n' +
    `<body style="margin:0;padding:0;background:${PAGE_BG};` +
    '-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">\n' +
    `${preheader(pre)}\n` +
    '<table role="presentation" width="100%" cellpadding="0" ' +
    `cellspacing="0" border="0" bgcolor="${PAGE_BG}" ` +
    `style="background:${PAGE_BG};width:100%;">\n` +
    '<tr><td align="center" style="padding:32px 12px;">\n' +
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" ' +
    `border="0" bgcolor="${CARD_BG}" style="width:100%;max-width:560px;` +
    `background:${CARD_BG};border:1px solid ${HAIRLINE};border-radius:12px;">\n` +
    `<tr><td bgcolor="${CARD_BG}" style="padding:32px 32px 4px;font-family:${FONT};">` +
    `<span style="font-size:20px;font-weight:600;color:${INK};letter-spacing:-0.01em;">Ideata` +
    `<span style="color:${ACCENT};">.</span></span></td></tr>\n` +
    `<tr><td bgcolor="${CARD_BG}" style="padding:12px 32px 32px;font-family:${FONT};">\n` +
    `${contentHtml}\n` +
    '</td></tr>\n' +
    '</table>\n' +
    '<table role="presentation" width="560" cellpadding="0" cellspacing="0" ' +
    'border="0" style="width:100%;max-width:560px;">\n' +
    `<tr><td style="padding:20px 32px 4px;font-family:${FONT};` +
    `font-size:12px;line-height:1.6;color:${GRAY};">` +
    `${tRaw(l, 'footer1')}<br>${tRaw(l, 'footer2')}</td></tr>\n` +
    '</table>\n' +
    '</td></tr>\n' +
    '</table>\n' +
    '</body>\n</html>'
  );
}

/** Content H1 heading (emails._h1:299-301). */
function h1(text: string): string {
  return (
    `<div style="font-size:22px;font-weight:600;line-height:1.3;color:${INK};` +
    `margin:4px 0 8px;">${escHtml(text)}</div>`
  );
}

/** Subtitle (emails._sub:304-306). */
function sub(text: string): string {
  return (
    `<div style="font-size:14px;line-height:1.6;color:${GRAY};` +
    `margin:0 0 24px;">${escHtml(text)}</div>`
  );
}

/** Colored delta (emails._delta_span:325-330): green(+)/red(−)/gray(0). */
function deltaSpan(delta: number, unit: string): string {
  const d = rInt(delta);
  const color = d > 0 ? POS : d < 0 ? NEG : GRAY;
  return `<span style="color:${color};font-weight:400;font-size:14px;">(${pySign(d)}${escHtml(unit)})</span>`;
}

/** "Label → value" KPI table (emails._kpi_rows:392-404); value is already HTML. */
function kpiRows(rows: Array<[string, string]>): string {
  const cells = rows
    .map(([label, value], i) => {
      const top = i === 0 ? '' : `border-top:1px solid ${HAIRLINE};`;
      return (
        `<tr><td style="padding:12px 0;${top}font-size:14px;color:${GRAY};">` +
        `${escHtml(label)}</td>` +
        `<td align="right" style="padding:12px 0;${top}font-size:14px;` +
        `font-weight:600;color:${INK};">${value}</td></tr>`
      );
    })
    .join('');
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ' +
    `border="0" style="margin:4px 0 20px;">${cells}</table>`
  );
}

/** Numbered "name — value" list (emails._ranked_list:407-419); empty → ''. */
function rankedList(title: string, items: Array<[string, string]>): string {
  if (!items.length) return '';
  const lis = items
    .map(
      ([name, val], idx) =>
        `<div style="font-size:14px;line-height:1.9;color:${INK};">` +
        `<span style="color:${GRAY};">${idx + 1}.</span> ${escHtml(name)} ` +
        `<span style="color:${GRAY};">— ${escHtml(val)}</span></div>`,
    )
    .join('');
  return (
    `<div style="font-size:13px;font-weight:600;color:${GRAY};` +
    'text-transform:uppercase;letter-spacing:0.04em;margin:20px 0 8px;">' +
    `${escHtml(title)}</div>${lis}`
  );
}

// ── report model ────────────────────────────────────────────────────────────

export interface WeeklyReportRival {
  brand: string;
  vis: number;
}

/** A finished report: computed model + assembled subject/text/html/telegram. */
export interface WeeklyReport {
  domain: string;
  weekLabel: string;
  lang: ReportLang;
  visibility: number;
  delta: number;
  sov: number | null;
  engines: Array<[string, number]>;
  rivals: WeeklyReportRival[];
  newCitations: number;
  newSources: number;
  fullAt: string | null;
  dashUrl: string;
  subject: string;
  text: string;
  html: string;
  telegram: string;
}

/**
 * Weekly report HTML email (port of emails.weekly_report_email:422-483). Reads
 * the report's already-computed fields; `lang` overrides the report's language
 * (for explicit rendering). Dark theme, duplicated bgcolor for Outlook, all
 * user-provided data escaped.
 */
export function renderReportEmail(report: WeeklyReport, lang?: unknown): string {
  const l = normalizeLang(lang ?? report.lang);
  const domain = report.domain;
  const vis = rInt(report.visibility);
  const dash = report.dashUrl || DASHBOARD_URL_DEFAULT;
  const engines = report.engines || [];
  const rivals = report.rivals || [];
  const weekLabel = report.weekLabel || '';

  const heading = weekLabel ? fmt(tRaw(l, 'wk_week'), { week: weekLabel, domain }) : domain;

  const kpi: Array<[string, string]> = [
    [tRaw(l, 'wk_visibility'), `${vis}% ${deltaSpan(report.delta, tRaw(l, 'pp_unit'))}`],
  ];
  if (report.sov !== null && report.sov !== undefined) {
    kpi.push([tRaw(l, 'wk_sov'), `${rInt(report.sov)}%`]);
  }

  let enginesBlock = rankedList(
    tRaw(l, 'wk_engines'),
    engines.map(([label, v]) => [label, `${rInt(v)}%`]),
  );
  if (!enginesBlock) {
    enginesBlock =
      `<div style="font-size:14px;line-height:1.6;color:${GRAY};margin:16px 0 0;">` +
      `${tRaw(l, 'wk_no_engines')}</div>`;
  }

  const rivalsBlock = rankedList(
    tRaw(l, 'wk_rivals'),
    rivals.map((r) => [r.brand, `${rInt(r.vis)}%`]),
  );

  const citeLine =
    `<div style="font-size:14px;line-height:1.6;color:${INK};margin:20px 0 0;">` +
    fmt(tRaw(l, 'wk_cites'), { cites: Math.trunc(report.newCitations), srcs: Math.trunc(report.newSources) }) +
    '</div>';
  const fullLine = report.fullAt
    ? `<div style="font-size:13px;line-height:1.6;color:${GRAY};margin:4px 0 0;">` +
      fmt(tRaw(l, 'wk_full'), { at: escHtml(report.fullAt) }) +
      '</div>'
    : '';

  const content =
    h1(heading) +
    sub(tRaw(l, 'wk_sub')) +
    kpiRows(kpi) +
    enginesBlock +
    rivalsBlock +
    citeLine +
    fullLine +
    ('<div style="margin:24px 0 0;">' + button(tRaw(l, 'wk_button'), dash) + '</div>');

  return shell(
    fmt(tRaw(l, 'wk_title'), { domain }),
    content,
    fmt(tRaw(l, 'wk_pre'), { vis, domain }),
    l,
  );
}

/** composeReport input — matches the arguments of reports.compose_report. */
export interface ComposeReportInput {
  domain: string;
  agg: Agg;
  runMeta?: Record<string, unknown> | null;
  newCitations?: number;
  newSources?: number;
  weekLabel?: string;
  dashUrl?: string;
  lang?: unknown;
}

/**
 * Build a report from monitoring aggregates (port of reports.compose_report:125-218)
 * → {subject,text,html,telegram} + the computed model. Pure function: tests feed
 * a mock aggregate. The Telegram text is INTENTIONALLY Russian (a separate owner
 * channel) and is escaped with quote=False, like telegram._esc.
 */
export function composeReport(input: ComposeReportInput): WeeklyReport {
  const runMeta = input.runMeta || {};
  const kpi = asObj(asObj(input.agg).kpi);
  const vis = rInt(kpi.visScore);
  const delta = weekDelta(input.agg);
  const sovRaw = kpi.sov;
  const sov = sovRaw === null || sovRaw === undefined ? null : (sovRaw as number);
  const engines = topEngines(input.agg);
  const rivals = rivalsOf(input.agg);
  const fullAt = fmtDate((runMeta as Record<string, unknown>).full_at);
  const lang = normalizeLang(input.lang);
  const domain = input.domain;
  const weekLabel = input.weekLabel || '';
  const dashUrl = input.dashUrl || DASHBOARD_URL_DEFAULT;
  const newCitations = Math.trunc(input.newCitations ?? 0);
  const newSources = Math.trunc(input.newSources ?? 0);
  const s = (key: string): string => tRaw(lang, key);

  const subject = fmt(s('subj_weekly'), { domain });

  // ── plain text ───
  const lines: string[] = [fmt(s('wtxt_head'), { domain })];
  if (weekLabel) lines.push(fmt(s('wtxt_week'), { week: weekLabel }));
  lines.push('');
  lines.push(fmt(s('wtxt_vis'), { vis, delta: pySign(delta) }));
  if (sov !== null) lines.push(fmt(s('wtxt_sov'), { sov: rInt(sov) }));
  lines.push('');
  if (engines.length) {
    lines.push(s('wtxt_engines'));
    engines.forEach(([label, v], i) => lines.push(`  ${i + 1}. ${label} — ${rInt(v)}%`));
  } else {
    lines.push(s('wk_no_engines'));
  }
  lines.push('');
  if (rivals.length) {
    lines.push(s('wtxt_rivals'));
    rivals.forEach((r, i) => lines.push(`  ${i + 1}. ${r.brand} — ${rInt(r.vis)}%`));
    lines.push('');
  }
  lines.push(fmt(s('wtxt_cites'), { cites: newCitations, srcs: newSources }));
  if (fullAt) lines.push(fmt(s('wtxt_full'), { at: fullAt }));
  lines.push('');
  lines.push(fmt(s('wtxt_dash'), { url: dashUrl }));
  const text = lines.join('\n');

  // ── Telegram (parse_mode=HTML, always Russian) ──
  const tg: string[] = [`📊 <b>Недельный отчёт: ${escTg(domain)}</b>`];
  if (weekLabel) tg.push(`<i>${escTg(weekLabel)}</i>`);
  tg.push('');
  tg.push(`Видимость: <b>${vis}%</b> (${pySign(delta)} п.п. за неделю)`);
  if (sov !== null) tg.push(`Доля упоминаний: ${rInt(sov)}%`);
  tg.push('');
  if (engines.length) {
    tg.push('<b>Движки с упоминаниями:</b>');
    engines.forEach(([label, v], i) => tg.push(`  ${i + 1}. ${escTg(label)} — ${rInt(v)}%`));
  }
  if (rivals.length) {
    tg.push('');
    tg.push('<b>Конкуренты:</b>');
    rivals.forEach((r, i) => tg.push(`  ${i + 1}. ${escTg(r.brand)} — ${rInt(r.vis)}%`));
  }
  tg.push('');
  tg.push(`За неделю: ${newCitations} новых цитат из ${newSources} источников`);
  if (fullAt) tg.push(`Полный срез цитат: ${escTg(fullAt)}`);
  tg.push('');
  tg.push(`<a href="${escTg(dashUrl)}">Открыть панель</a>`);
  const telegram = tg.join('\n');

  const report: WeeklyReport = {
    domain,
    weekLabel,
    lang,
    visibility: vis,
    delta,
    sov,
    engines,
    rivals,
    newCitations,
    newSources,
    fullAt,
    dashUrl,
    subject,
    text,
    html: '',
    telegram,
  };
  // html is built by exactly weekly_report_email — the single source of email markup.
  report.html = renderReportEmail(report, lang);
  return report;
}

// ── DB port: building a report for a tracker (reports.report_for_tracker:242-270) ─

/** Tracker fields needed to build a report (shape of Prisma aeo_trackers). */
export interface WeeklyReportTracker {
  id: number;
  domain: string;
  competitors?: unknown;
  platforms?: unknown;
  brandId?: number | null;
  lang?: unknown;
  runMeta?: unknown;
}

/** run_meta (jsonb|string|null) → dict of timestamps (reports._tracker_run_meta:230-239). */
function normalizeRunMeta(meta: unknown): Record<string, unknown> {
  let m: unknown = meta;
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m);
    } catch {
      m = null;
    }
  }
  return m && typeof m === 'object' && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}

/** Naive-timestamp Prisma Date → Python-style string (matches the [:10] bucket). */
function naiveTs(v: Date | string): string {
  if (v instanceof Date) {
    const iso = v.toISOString();
    return `${iso.slice(0, 10)} ${iso.slice(11, 23)}`;
  }
  return String(v);
}

interface AnswerRow {
  runAt: Date;
  platform: string;
  prompt: string;
  rawText: string | null;
  brandsFound: unknown;
  citations: unknown;
  sentiment: unknown;
  judge: unknown;
}

/** (citation count, unique source count) over a set of rows (reports._citation_stats:222-227). */
function citationStats(rows: AnswerRow[]): [number, number] {
  const urls: string[] = [];
  for (const r of rows) {
    if (r.platform === '_sentiment') continue;
    for (const c of citeItems(r.citations as never)) urls.push(c.url);
  }
  const hosts = new Set<string>();
  for (const u of urls) {
    const h = host(u);
    if (h) hosts.add(h);
  }
  return [urls.length, hosts.size];
}

/**
 * Language of the weekly email (reports._tracker_lang:273-296): brands.language →
 * aeo_trackers.lang → 'ru'. Never throws: the email's language is not a reason
 * to skip sending it.
 */
async function trackerLang(tracker: WeeklyReportTracker): Promise<ReportLang> {
  try {
    let brandLang: unknown = null;
    if (tracker.brandId) {
      const brand = await blogPrisma().brand.findUnique({
        where: { id: tracker.brandId },
        select: { language: true },
      });
      brandLang = brand?.language ?? null;
    }
    const lang = normalizeProjectLang(brandLang) ?? normalizeProjectLang(tracker.lang);
    return normalizeLang(lang);
  } catch {
    return 'ru';
  }
}

/**
 * Build a report for a single tracker from storage (port of reports.report_for_tracker):
 * an 8-week window of aeo_answers → aggregate_monitoring, citations from the last
 * 7 days as the week's new items. null means no data yet (the tracker has never
 * run): the report is not sent. `now`/`dashUrl` are injected by tests.
 */
export async function buildWeeklyReport(
  tracker: WeeklyReportTracker,
  opts: { now?: Date; dashUrl?: string } = {},
): Promise<WeeklyReport | null> {
  const now = opts.now ?? new Date();
  const domain = tracker.domain;
  const competitors = (Array.isArray(tracker.competitors) ? tracker.competitors : []).filter(
    (c): c is string => !!c && typeof c === 'string',
  );
  const platforms =
    Array.isArray(tracker.platforms) && tracker.platforms.length
      ? (tracker.platforms as string[])
      : [...DEFAULT_PLATFORMS];

  const since8w = new Date(now.getTime() - 8 * 7 * 86400000);
  const answerRows = (await blogPrisma().aeoAnswer.findMany({
    where: { trackerId: tracker.id, runAt: { gte: since8w } },
    orderBy: { runAt: 'asc' },
    select: {
      runAt: true,
      platform: true,
      prompt: true,
      rawText: true,
      brandsFound: true,
      citations: true,
      sentiment: true,
      judge: true,
    },
  })) as AnswerRow[];

  const rows: MonitoringRow[] = answerRows.map((r) => ({
    run_at: naiveTs(r.runAt),
    platform: r.platform,
    prompt: r.prompt,
    text: r.rawText,
    brands_found: (r.brandsFound as MonitoringRow['brands_found']) ?? null,
    citations: (r.citations as MonitoringRow['citations']) ?? null,
    sentiment: (r.sentiment as MonitoringRow['sentiment']) ?? null,
    judge: r.judge ?? null,
  }));

  const agg = aggregateMonitoring(rows, domain, competitors, { platforms });
  if (!Object.keys(agg).length) return null; // empty window — report not sent

  // Citations/sources from the last 7 days (the week's new items).
  const since1w = new Date(now.getTime() - 7 * 86400000);
  const weekRows = answerRows.filter((r) => r.runAt >= since1w);
  const [newCitations, newSources] = citationStats(weekRows);

  const lang = await trackerLang(tracker);
  return composeReport({
    domain,
    agg,
    runMeta: normalizeRunMeta(tracker.runMeta),
    newCitations,
    newSources,
    weekLabel: weekKey(now),
    dashUrl: opts.dashUrl ?? dashboardUrl(),
    lang,
  });
}

// ── weekly idempotency (report_log; storage.report_already_sent:2483) ────────

/**
 * Was this channel already SUCCESSFULLY sent to this user this week? Only
 * ok=TRUE counts — a failed attempt does not block a retry (storage.report_already_sent).
 * No table/DB → false (better a retry than silence): delivery is not blocked.
 */
export async function reportAlreadySent(
  userId: number,
  kind: string,
  wk: string,
): Promise<boolean> {
  try {
    const row = await blogPrisma().reportLog.findFirst({
      where: { userId, kind, weekKey: wk, ok: true },
      select: { id: true },
    });
    return !!row;
  } catch {
    return false;
  }
}

/**
 * Record the fact of delivery — upsert on (user_id, kind, week_key) with ok/detail
 * (storage.mark_report_sent:2494). A retry overwrites the mark: a failure that
 * turns into a success is marked ok=TRUE. detail is truncated to 500. Never throws.
 */
export async function markReportSent(
  userId: number,
  kind: string,
  wk: string,
  opts: { ok?: boolean; detail?: string } = {},
): Promise<void> {
  const ok = opts.ok ?? true;
  const detail = (opts.detail ?? '').slice(0, 500);
  try {
    await blogPrisma().reportLog.upsert({
      where: { userId_kind_weekKey: { userId, kind, weekKey: wk } },
      create: { userId, kind, weekKey: wk, ok, detail },
      update: { ok, detail, sentAt: new Date() },
    });
  } catch {
    /* no table/DB — the mark is not critical for email delivery */
  }
}

// ── delivery (reports.send_user_reports:313 / run_weekly_reports:394) ────────

/** Which channels the owner is entitled to by plan (reports._report_channels:300-310). */
export interface ReportChannels {
  email: boolean;
  telegram: boolean;
}

/** Channel resolver by plan (the worker builds it from PlanService.resolveLimits). */
export type ChannelsResolver = (userId: number) => Promise<ReportChannels>;

export interface RunWeeklyOpts {
  /** Plan gate for channels (email==='weekly'?, telegram?) — injected, DI-free. */
  channelsFor: ChannelsResolver;
  now?: Date;
  /** Bypass weekly idempotency (manual trigger/test); the plan is still respected. */
  force?: boolean;
  /** Restrict to a single user (send-now). */
  onlyUserId?: number;
  /** Mail transport — tests inject a spy (no network). */
  transport?: MailTransport;
}

export interface UserReportResult {
  userId: number;
  email: boolean;
  telegram: boolean;
}

// "Mail not configured" warning — logged once per delivery run (reports._WARNED_NO_SMTP).
let warnedNoMail = false;

/** Active trackers of a single owner (storage.active_trackers_for_user:2467). */
async function activeTrackersForUser(userId: number): Promise<WeeklyReportTracker[]> {
  const rows = await blogPrisma().aeoTracker.findMany({
    where: { active: true, userId },
    orderBy: { id: 'asc' },
    select: { id: true, domain: true, competitors: true, platforms: true, brandId: true, lang: true, runMeta: true },
  });
  return rows as WeeklyReportTracker[];
}

/** Owners of active trackers — report candidates (storage.report_recipient_user_ids:2474). */
async function reportRecipientUserIds(): Promise<number[]> {
  const rows = await blogPrisma().aeoTracker.findMany({
    where: { active: true, userId: { not: null } },
    distinct: ['userId'],
    orderBy: { userId: 'asc' },
    select: { userId: true },
  });
  return rows.map((r) => r.userId as number).filter((id): id is number => id != null);
}

/**
 * Build and send reports for all of a single user's active trackers (port of
 * reports.send_user_reports:313-391) — EMAIL channel. Gated by plan + weekly
 * idempotency (force bypasses idempotency, the plan is still respected). Telegram
 * is NOT ported (Nest has no owner-DM sender) — see coverage-gaps.
 */
export async function sendUserReports(userId: number, opts: RunWeeklyOpts): Promise<UserReportResult> {
  const now = opts.now ?? new Date();
  const wk = weekKey(now);
  const out: UserReportResult = { userId, email: false, telegram: false };

  const channels = await opts.channelsFor(userId);
  if (!channels.email && !channels.telegram) return out; // free / plan without reports

  let email = '';
  try {
    const u = await blogPrisma().user.findUnique({ where: { id: userId }, select: { email: true } });
    email = (u?.email || '').trim();
  } catch {
    email = '';
  }

  const trackers = await activeTrackersForUser(userId);
  if (!trackers.length) return out;
  const built = await Promise.all(
    trackers.map((tr) => buildWeeklyReport(tr, { now }).catch(() => null)),
  );
  const reports = built.filter((r): r is WeeklyReport => r !== null);
  if (!reports.length) return out;

  const wantEmail =
    channels.email && !!email && (opts.force || !(await reportAlreadySent(userId, 'email', wk)));
  if (wantEmail) {
    if (!mailConfigured()) {
      if (!warnedNoMail) {
        // eslint-disable-next-line no-console
        console.warn('[reports] mail not configured (no RESEND/BREVO, no SMTP_HOST) — email reports skipped');
        warnedNoMail = true;
      }
    } else {
      let sent = 0;
      let errs = '';
      for (const rep of reports) {
        const res = await sendMail(
          { to: email, subject: rep.subject, text: rep.text, html: rep.html },
          { transport: opts.transport },
        );
        if (res.sent) sent += 1;
        else errs = res.error || errs;
      }
      const ok = sent > 0;
      await markReportSent(userId, 'email', wk, {
        ok,
        detail: ok ? `${sent}/${reports.length} sent` : `error: ${errs}`.slice(0, 200),
      });
      out.email = ok;
    }
  }

  return out;
}

/**
 * Walk all owners of active trackers and send the reports their plan entitles
 * them to (port of reports.run_weekly_reports:394-428). Master switch
 * REPORTS_ENABLED=0 → empty result. One user failing does not break the run.
 * Returns the list of users to whom at least one channel actually went out.
 */
export async function runWeeklyReports(opts: RunWeeklyOpts): Promise<{ sent: UserReportResult[] }> {
  warnedNoMail = false; // one warning per run
  if (!reportsEnabled()) return { sent: [] };
  const now = opts.now ?? new Date();
  const runOpts = { ...opts, now };
  const uids =
    opts.onlyUserId != null ? [opts.onlyUserId] : await reportRecipientUserIds();
  const sent: UserReportResult[] = [];
  for (const uid of uids) {
    try {
      const res = await sendUserReports(uid, runOpts);
      if (res.email || res.telegram) sent.push(res);
    } catch {
      /* one user failing does not break the run (reports.py:419) */
    }
  }
  return { sent };
}
