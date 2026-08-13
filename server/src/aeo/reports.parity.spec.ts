/**
 * Parity of weekly report building with live Python. The golden output was
 * captured from the oracle (`reports.compose_report` + `emails.weekly_report_email`)
 * across four aggregate fixtures and lives in _fixtures/reports_golden.json:
 *   • A_ru / A_en — full (engines, competitors, SoV, full_at, week_label);
 *   • B_ru        — empty panel (no engines/competitors, sov=None, no full_at);
 *   • C_ru        — domain/competitor with special characters (HTML/Telegram escaping).
 *
 * The aggregate fixtures in this file VERBATIM mirror the oracle script, so
 * composeReport(fixture) must match the golden output on ALL fields
 * {subject,text,html,telegram} — otherwise the port has diverged from Python.
 * We also check the pure helpers (topEngines/rivalsOf/weekDelta/fmtDate) against
 * golden.helpers, and the HTML structure (dark theme, duplicated bgcolor for
 * Outlook, escaping).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  composeReport,
  renderReportEmail,
  topEngines,
  rivalsOf,
  weekDelta,
  fmtDate,
  weekKey,
  normalizeLang,
  type ComposeReportInput,
} from './reports';

interface GoldenCase {
  subject: string;
  text: string;
  html: string;
  telegram: string;
}
interface Golden {
  A_ru: GoldenCase;
  A_en: GoldenCase;
  B_ru: GoldenCase;
  C_ru: GoldenCase;
  helpers: Record<string, unknown>;
}

const GOLDEN: Golden = JSON.parse(
  readFileSync(join(__dirname, '_fixtures', 'reports_golden.json'), 'utf8'),
);

const DASH = 'https://ideata.io/app';

// ── aggregate fixtures (verbatim from oracle_reports.py) ─────────────────────
const AGG_A = {
  kpi: { visScore: 62, sov: 18, visDelta: 5, avgPos: 2.3 },
  platforms: ['claude', 'gemini', 'perplexity', 'aio', 'gigachat', 'alice', 'yandex', 'chatgpt', 'deepseek', 'grok'],
  platMatrix: [
    { brand: 'acme.com', self: true, vals: [80, 60, 40, 0, 0, 0, 0, 55, 0, 0] },
    { brand: 'rival.com', self: false, vals: [70, 50, 30, 0, 0, 0, 0, 20, 0, 0] },
  ],
  leaderboard: [
    { brand: 'acme.com', self: true, vis: 62, sov: 18, pos: 2.3, delta: 5 },
    { brand: 'rival.com', self: false, vis: 48, sov: 22, pos: 3.1, delta: -2 },
    { brand: 'foo.com', self: false, vis: 31, sov: 12, pos: 4.0, delta: 1 },
    { brand: 'bar.com', self: false, vis: 12, sov: 5, pos: null, delta: 0 },
  ],
  visTrend: {
    weekLabels: ['2026-W31', '2026-W32', '2026-W33'],
    granularity: 'week',
    series: [
      { brand: 'acme.com', self: true, data: [50, 57, 62] },
      { brand: 'rival.com', self: false, data: [55, 50, 48] },
    ],
  },
};
const META_A = { full_at: '2026-08-04T06:00:00+00:00' };

const AGG_B = {
  kpi: { visScore: 0, sov: null, visDelta: 0 },
  platforms: ['claude', 'gemini', 'perplexity'],
  platMatrix: [{ brand: 'solo.io', self: true, vals: [0, 0, 0] }],
  leaderboard: [{ brand: 'solo.io', self: true, vis: 0, sov: 0, pos: null, delta: 0 }],
  visTrend: {
    weekLabels: ['2026-W33'],
    granularity: 'week',
    series: [{ brand: 'solo.io', self: true, data: [0] }],
  },
};

const AGG_C = {
  kpi: { visScore: 33, sov: 9, visDelta: -4 },
  platforms: ['claude', 'gemini'],
  platMatrix: [
    { brand: 'a<b>&"co.com', self: true, vals: [40, 20] },
    { brand: 'ri&val.com', self: false, vals: [10, 5] },
  ],
  leaderboard: [
    { brand: 'a<b>&"co.com', self: true, vis: 33, sov: 9, pos: 1.5, delta: -4 },
    { brand: 'ri&val.com', self: false, vis: 22, sov: 7, pos: 2.0, delta: 3 },
  ],
  visTrend: {
    weekLabels: ['2026-W32', '2026-W33'],
    granularity: 'week',
    series: [{ brand: 'a<b>&"co.com', self: true, data: [37, 33] }],
  },
};

function build(input: ComposeReportInput): GoldenCase {
  const r = composeReport(input);
  return { subject: r.subject, text: r.text, html: r.html, telegram: r.telegram };
}

describe('composeReport — parity with golden Python output', () => {
  const cases: Array<[keyof Golden, ComposeReportInput]> = [
    ['A_ru', { domain: 'acme.com', agg: AGG_A, runMeta: META_A, newCitations: 7, newSources: 3, weekLabel: '2026-W33', dashUrl: DASH, lang: 'ru' }],
    ['A_en', { domain: 'acme.com', agg: AGG_A, runMeta: META_A, newCitations: 7, newSources: 3, weekLabel: '2026-W33', dashUrl: DASH, lang: 'en' }],
    ['B_ru', { domain: 'solo.io', agg: AGG_B, runMeta: {}, newCitations: 0, newSources: 0, weekLabel: '', dashUrl: DASH, lang: 'ru' }],
    ['C_ru', { domain: 'a<b>&"co.com', agg: AGG_C, runMeta: {}, newCitations: 2, newSources: 1, weekLabel: '2026-W33', dashUrl: DASH, lang: 'ru' }],
  ];

  it.each(cases)('%s: subject', (key, input) => {
    expect(build(input).subject).toBe((GOLDEN[key] as GoldenCase).subject);
  });
  it.each(cases)('%s: text', (key, input) => {
    expect(build(input).text).toBe((GOLDEN[key] as GoldenCase).text);
  });
  it.each(cases)('%s: html (byte-for-byte)', (key, input) => {
    expect(build(input).html).toBe((GOLDEN[key] as GoldenCase).html);
  });
  it.each(cases)('%s: telegram (always ru, escape quote=false)', (key, input) => {
    expect(build(input).telegram).toBe((GOLDEN[key] as GoldenCase).telegram);
  });
});

describe('pure helpers — parity with golden.helpers', () => {
  const H = GOLDEN.helpers;

  it('topEngines(A): [(label, vis)] descending, top 3', () => {
    expect(topEngines(AGG_A)).toEqual(H.top_engines_A);
  });
  it('rivalsOf(A): leaderboard brands without self, top 3', () => {
    expect(rivalsOf(AGG_A).map((r) => r.brand)).toEqual(H.rivals_A);
  });
  it('weekDelta(A)=5 (last-previous), weekDelta(B)=0 (kpi fallback)', () => {
    expect(weekDelta(AGG_A)).toBe(H.week_delta_A);
    expect(weekDelta(AGG_B)).toBe(H.week_delta_B);
  });
  it('fmtDate: ISO/Z → DD.MM.YYYY; None/garbage → null', () => {
    expect(fmtDate('2026-08-04T06:00:00+00:00')).toBe(H.fmt_date_iso);
    expect(fmtDate('2026-08-04T06:00:00Z')).toBe(H.fmt_date_z);
    expect(fmtDate(null)).toBe(H.fmt_date_none);
    expect(fmtDate('not-a-date')).toBe(H.fmt_date_garbage);
  });
});

describe('weekKey — ISO-8601 week', () => {
  it('2026-08-10 → 2026-W33 (checked against oracle services.week_key)', () => {
    expect(weekKey(new Date(Date.UTC(2026, 7, 10)))).toBe('2026-W33');
  });
  it('year boundary: 2025-12-29 (Mon) → 2026-W01', () => {
    expect(weekKey(new Date(Date.UTC(2025, 11, 29)))).toBe('2026-W01');
  });
});

describe('renderReportEmail — email structure (dark theme, Outlook, escaping)', () => {
  const rA = composeReport({ domain: 'acme.com', agg: AGG_A, runMeta: META_A, newCitations: 7, newSources: 3, weekLabel: '2026-W33', dashUrl: DASH, lang: 'ru' });
  const rB = composeReport({ domain: 'solo.io', agg: AGG_B, runMeta: {}, newCitations: 0, newSources: 0, weekLabel: '', dashUrl: DASH, lang: 'ru' });
  const rC = composeReport({ domain: 'a<b>&"co.com', agg: AGG_C, runMeta: {}, newCitations: 2, newSources: 1, weekLabel: '2026-W33', dashUrl: DASH, lang: 'ru' });

  it('DOCTYPE + dark theme (color-scheme dark, PAGE_BG)', () => {
    const html = renderReportEmail(rA);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<meta name="color-scheme" content="dark">');
    expect(html).toContain('<meta name="supported-color-schemes" content="dark">');
    expect(html).toContain('background:#0b0b0d;');
  });

  it('duplicated bgcolor for Outlook on every fill', () => {
    const html = renderReportEmail(rA);
    // both the inline background and the bgcolor attribute with the same color
    expect(html).toContain('bgcolor="#0b0b0d" style="background:#0b0b0d;');
    expect(html).toContain('bgcolor="#141417" style="width:100%;max-width:560px;background:#141417;');
    expect(html).toContain('bgcolor="#fafafa" style="border-radius:8px;background:#fafafa;');
  });

  it('lang in <html> and localized footer (ru vs en)', () => {
    expect(renderReportEmail(rA, 'ru')).toContain('<html lang="ru"');
    expect(renderReportEmail(rA, 'ru')).toContain('Это письмо отправлено Ideata');
    expect(renderReportEmail(rA, 'en')).toContain('<html lang="en"');
    expect(renderReportEmail(rA, 'en')).toContain('Sent by Ideata');
  });

  it('delta is colored: POS green (+), NEG red (−)', () => {
    expect(renderReportEmail(rA)).toContain('color:#4ade80;font-weight:400;font-size:14px;">(+5 п.п.)');
    expect(renderReportEmail(rC)).toContain('color:#f87171;font-weight:400;font-size:14px;">(-4 п.п.)');
  });

  it('empty panel → "no engine" line, no competitors block', () => {
    const html = renderReportEmail(rB);
    expect(html).toContain('Пока ни один движок вас регулярно не называет.');
    expect(html).not.toContain('Конкуренты');
  });

  it('user-provided data is escaped (domain/competitor with special characters)', () => {
    const html = renderReportEmail(rC);
    expect(html).toContain('a&lt;b&gt;&amp;&quot;co.com'); // heading + title, quote=true
    expect(html).toContain('ri&amp;val.com'); // competitor in the ranked list
    expect(html).not.toContain('a<b>&"co.com'); // raw domain does not leak into markup
  });

  it('button links to the dashboard', () => {
    expect(renderReportEmail(rA)).toContain('<a href="https://ideata.io/app" target="_blank"');
    expect(renderReportEmail(rA)).toContain('>Открыть дашборд</a>');
  });

  it('normalizeLang: ru-RU/EN_us/empty/garbage → ru|en|ru', () => {
    expect(normalizeLang('ru-RU')).toBe('ru');
    expect(normalizeLang('EN_us')).toBe('en');
    expect(normalizeLang('')).toBe('ru');
    expect(normalizeLang('fr')).toBe('ru');
    expect(normalizeLang(null)).toBe('ru');
  });
});
