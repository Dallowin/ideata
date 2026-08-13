/**
 * Score, categories, action plan — port of core/site_audit.py's scoring.
 *
 * Pure logic with no network calls: input is a list of checks, output is
 * numbers and a fix order. This is exactly the layer that answers the one
 * question a person has left after an audit: where to start.
 */
import { Check, GROUP_ORDER, OK, WARN, FAIL, NA, HIGH, MED, LOW } from './types';

/**
 * 0-100. `na` doesn't participate: missing data isn't the site's fault.
 * `warn` costs half the weight, `fail` costs the full weight.
 */
export function score(checks: Check[]): number {
  const total = checks
    .filter((c) => c.status !== NA)
    .reduce((sum, c) => sum + c.weight, 0);
  if (!total) return 0;
  const lost = checks
    .filter((c) => c.status === FAIL || c.status === WARN)
    .reduce((sum, c) => sum + c.weight * (c.status === FAIL ? 1.0 : 0.5), 0);
  return Math.max(0, Math.round(((total - lost) / total) * 100));
}

export interface CategoryScore {
  group: string;
  score: number;
  fails: number;
  warns: number;
}

/**
 * Per-category score, using the same weighting as the overall score.
 *
 * A single number for the whole site hides imbalance: 75/100 could mean
 * "everything's evenly mediocre" or "SEO is perfect but there's no security
 * at all" — those are different sites with different actions. A category
 * that's entirely `na` (e.g. Speed, when PageSpeed didn't respond) isn't
 * shown: an empty zero block would lie.
 */
export function categoryScores(checks: Check[]): CategoryScore[] {
  const out: CategoryScore[] = [];
  for (const group of GROUP_ORDER) {
    const items = checks.filter((c) => c.group === group);
    if (!items.length || items.every((c) => c.status === NA)) continue;
    out.push({
      group,
      score: score(items),
      fails: items.filter((c) => c.status === FAIL).length,
      warns: items.filter((c) => c.status === WARN).length,
    });
  }
  return out;
}

// Fix order: first what breaks indexing and access, then cosmetics.
const PRIORITY_RANK: Record<string, number> = {
  [`${FAIL}|${HIGH}`]: 0, [`${FAIL}|${MED}`]: 1, [`${FAIL}|${LOW}`]: 2,
  [`${WARN}|${HIGH}`]: 3, [`${WARN}|${MED}`]: 4, [`${WARN}|${LOW}`]: 5,
};

export interface PlanItem {
  id: string; group: string; title: string; detail: string;
  fix: string; impact: string; effort: string; status: string;
}

export interface ActionPlan {
  critical: PlanItem[];
  quick: PlanItem[];
  later: PlanItem[];
  total: number;
}

/**
 * Problems → "Critical / Quick wins / Later".
 *
 * A flat list of thirty items doesn't say where to start — and that's the
 * one question a person has after an audit. "Quick" = high/medium impact at
 * low effort: fixable in an evening. Critical stays critical even if it takes
 * a while to fix.
 */
export function actionPlan(checks: Check[]): ActionPlan {
  const problems = checks.filter((c) => c.status === FAIL || c.status === WARN);
  // Stable sort: items with equal priority keep their original order, same
  // as in Python (list.sort guarantees stability).
  problems.sort((a, b) => {
    const ra = PRIORITY_RANK[`${a.status}|${a.impact}`] ?? 9;
    const rb = PRIORITY_RANK[`${b.status}|${b.impact}`] ?? 9;
    return ra - rb || (-a.weight) - (-b.weight);
  });

  const critical: PlanItem[] = [];
  const quick: PlanItem[] = [];
  const later: PlanItem[] = [];

  for (const c of problems) {
    const item: PlanItem = {
      id: c.id, group: c.group, title: c.title, detail: c.detail,
      fix: c.fix, impact: c.impact, effort: c.effort, status: c.status,
    };
    if (c.status === FAIL && c.impact === HIGH) critical.push(item);
    else if (c.effort === LOW && (c.impact === HIGH || c.impact === MED)) quick.push(item);
    else later.push(item);
  }
  return { critical, quick, later, total: problems.length };
}

/**
 * "What's good" — only passing checks. A report made entirely of complaints
 * reads like a verdict; a person also needs to see what doesn't need touching.
 */
export function passed(checks: Check[]) {
  return checks
    .filter((c) => c.status === OK)
    .map((c) => ({ id: c.id, group: c.group, title: c.title, detail: c.detail }));
}

/** Status summary — four numbers under the report header. */
export function summarize(checks: Check[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of [OK, WARN, FAIL, NA]) {
    out[s] = checks.filter((c) => c.status === s).length;
  }
  return out;
}
