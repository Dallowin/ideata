/**
 * Parity regressions for `aggregateMonitoring` at the TYPE BOUNDARIES of
 * already-computed fields (findings 1-6). Reference values were captured
 * from the live Python oracle (`aeo.aggregate_monitoring`) on the same
 * inputs; they're pinned here in a unit test so the fixes can't regress
 * without needing the private golden fixture and ssh access.
 *
 *   1-3 judge int/float/bool: isinstance(x,int) in Python (bool ⊂ int, float
 *       is not) versus PyFloat from pyParse — solution_hit (recommendation)
 *       and row_judge (score) (aeo.py:2318, 2330);
 *   4   sorted() by code point on an astral engine/platform string (aeo.py:2754);
 *   5   urlsplit.lstrip(C0/space): a leading U+0001 in a citation URL (aeo.py:287);
 *   6   unbalanced IPv6 brackets → ValueError → host "" (aeo.py:289).
 */
import { aggregateMonitoring } from './aggregate';
import { PyFloat } from './pyjson';
import type { MonitoringRow } from './aggregate.types';

const RIVALS = ['rival1.com', 'rival2.com', 'rival3.com', 'rival4.com'];
const AT = '2026-07-06 12:00:00.000';

/** One window row with brand acme.com, mentioned on claude. */
function acmeRow(judge: unknown): MonitoringRow {
  return {
    run_at: AT,
    platform: 'claude',
    prompt: 'p1',
    text: 'ans',
    brands_found: [{ brand: 'acme.com', pos: 1 }],
    citations: ['https://acme.com/a'],
    sentiment: null,
    judge,
  };
}

function agg(rows: MonitoringRow[], domain = 'acme.com', competitors = RIVALS) {
  return aggregateMonitoring(rows, domain, competitors) as Record<string, any>;
}

describe('findings 1-3: judge at the int/float/bool boundary', () => {
  it('recommendation as float 70.0 (PyFloat) does NOT count the brand as a solution', () => {
    // Python: isinstance(70.0, int) == False → solutionRate 0. judgeScore 80
    // (score=80 int is counted).
    const a = agg([acmeRow({ score: 80, sentiment: 'positive', recommendation: new PyFloat(70) })]);
    expect(a.kpi.solutionRate).toBe(0);
    expect(a.promptRows[0].solution).toBe(false);
    expect(a.promptRows[0].solutionN).toBe(0);
    expect(a.solutionTrend[0]).toBe(0);
    expect(a.promptRows[0].judgeScore).toBe(80);
  });

  it('recommendation as int 70 counts the brand as a solution', () => {
    // Control for the opposite side: an int recommendation passes the threshold.
    const a = agg([acmeRow({ score: 80, sentiment: 'positive', recommendation: 70 })]);
    expect(a.kpi.solutionRate).toBe(100);
    expect(a.promptRows[0].solution).toBe(true);
  });

  it('score as float 88.0 (PyFloat) is NOT counted in judgeScore', () => {
    // Python: isinstance(88.0, int) == False → score skipped → judgeScore null.
    const a = agg([acmeRow({ score: new PyFloat(88), sentiment: 'positive', recommendation: 70 })]);
    expect(a.promptRows[0].judgeScore).toBeNull();
    expect(a.kpi.solutionRate).toBe(100); // recommendation=70 int → counted as solution
  });

  it('score as bool true is counted as 1 (bool ⊂ int in Python)', () => {
    // Python: isinstance(True, int) == True → sum([True]) == 1 → round(1) == 1.
    const a = agg([acmeRow({ score: true, sentiment: 'positive', recommendation: 70 })]);
    expect(a.promptRows[0].judgeScore).toBe(1);
    expect(a.kpi.solutionRate).toBe(100);
  });

  it('recommendation as bool true does NOT pass the threshold (1 >= 60 is false)', () => {
    // Parity control c13: True >= 60 is false on both sides.
    const a = agg([acmeRow({ score: 80, sentiment: 'positive', recommendation: true })]);
    expect(a.kpi.solutionRate).toBe(0);
  });
});

describe('finding 4: sorted() by code point on an astral platform', () => {
  it('U+FFFF comes BEFORE U+1F600 in changes.gained[].platforms', () => {
    // Python's sorted by code point: 65535 < 128512. JS's `<` by UTF-16 code
    // unit would put the surrogate 0xD83D(55357) first — that was the bug.
    const rows: MonitoringRow[] = [
      { run_at: '2026-07-06 12:00:00.000', platform: 'claude', prompt: 'G', text: 'ans',
        brands_found: [{ brand: 'rival1.com', pos: 1 }], citations: [], sentiment: null, judge: null },
      { run_at: '2026-07-07 12:00:00.000', platform: '￿', prompt: 'G', text: 'ans',
        brands_found: [{ brand: 'acme.com', pos: 1 }], citations: [], sentiment: null, judge: null },
      { run_at: '2026-07-07 12:00:00.000', platform: '\u{1F600}', prompt: 'G', text: 'ans',
        brands_found: [{ brand: 'acme.com', pos: 1 }], citations: [], sentiment: null, judge: null },
    ];
    const a = agg(rows);
    expect(a.changes.gained).toHaveLength(1);
    expect(a.changes.gained[0].prompt).toBe('G');
    expect(a.changes.gained[0].platforms).toEqual(['￿', '\u{1F600}']);
  });
});

describe('findings 5-6: urlsplit when parsing a citation host', () => {
  const minRow = (citation: string): MonitoringRow => ({
    run_at: '2026-07-13 06:10:10.973', platform: 'claude', prompt: 'q', text: '',
    brands_found: [], citations: [citation], sentiment: null, judge: null,
  });

  it('leading U+0001 is stripped (lstrip C0/space) → host reddit.com', () => {
    const a = agg([minRow('\u0001https://reddit.com')], 'insane.gg', []);
    const c = a.promptRows[0].answers[0].citations[0];
    expect(c.host).toBe('reddit.com');
    expect(c.cat).toBe('UGC (форумы, Reddit)');
    expect(a.topCiteDomains[0].d).toBe('reddit.com');
  });

  it('unbalanced IPv6 brackets → host "" (ValueError → "")', () => {
    const a = agg([minRow('http://[::1')], 'insane.gg', []);
    expect(a.promptRows[0].answers[0].citations[0].host).toBe('');
    expect(a.promptRows[0].answers[0].citations[0].cat).toBe('Другое');
    expect(a.topCiteDomains).toEqual([]);
  });
});
