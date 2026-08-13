/**
 * Shape of a single tech-audit check — ported from core/site_audit.py.
 *
 * The object shape is replicated verbatim, including the Russian text: the
 * report is already rendered in the frontend and in emails, and any mismatch
 * in a field or wording breaks the layout or forces maintaining two copies
 * of the text.
 */

export const OK = 'ok';
export const WARN = 'warn';
export const FAIL = 'fail';
export const NA = 'na';

export type CheckStatus = typeof OK | typeof WARN | typeof FAIL | typeof NA;

// Impact and effort of the fix. The (impact, effort) pair is what forms priority:
// "high impact + low effort" goes into "Quick wins".
export const HIGH = 'high';
export const MED = 'med';
export const LOW = 'low';

// Category order in the report — from "site unreachable/blocked" to "site is inconvenient".
// One source of truth, otherwise the two copies drift apart.
export const GROUP_ORDER = [
  'Безопасность', 'Индексация', 'Мета-теги', 'Контент',
  'Доступность', 'Соцсети', 'Скорость',
];

export interface Check {
  id: string;
  group: string;
  title: string;
  status: CheckStatus;
  detail: string;
  value: unknown;
  weight: number;
  fix: string;
  impact: string;
  effort: string;
}

/** `fix` — the concrete thing to do: for fail/warn this is half the report's value. */
export function chk(
  id: string, group: string, title: string, status: CheckStatus, detail: string,
  opts: { value?: unknown; weight?: number; fix?: string; impact?: string; effort?: string } = {},
): Check {
  return {
    id, group, title, status, detail,
    value: opts.value ?? null,
    weight: opts.weight ?? 1,
    fix: opts.fix ?? '',
    impact: opts.impact ?? MED,
    effort: opts.effort ?? MED,
  };
}

/** Russian plural agreement ("1 заголовок / 2 заголовка / 5 заголовков") — otherwise the text reads like a bug. */
export function plural(n: number, one: string, few: string, many: string): string {
  n = Math.abs(n);
  if (n % 10 === 1 && n % 100 !== 11) return one;
  if (n % 10 >= 2 && n % 10 <= 4 && !(n % 100 >= 12 && n % 100 <= 14)) return few;
  return many;
}

// Length thresholds — SEO-practice consensus: past 60 characters Google truncates
// the title in search results, past 160 — the description.
export const TITLE_MIN = 10;
export const TITLE_MAX = 60;
export const DESC_MIN = 50;
export const DESC_MAX = 160;
