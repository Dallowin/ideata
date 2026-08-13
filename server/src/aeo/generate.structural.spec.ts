/**
 * STRUCTURAL acceptance test for the LLM part of generatePrompts. Generation
 * output is non-deterministic (model text + set randomization in Python), so
 * it can't be checked with a golden "panel == panel" comparison. Instead we
 * run the FULL filter pipeline over a FIXED mock candidate list (via the
 * `deps.sources.fromKeywords` test seam — the analog of the mock Analyzer in
 * Python) and check STRUCTURAL invariants of the final panel:
 *   • n clamp (len ≤ n);
 *   • 0 near-duplicates (dropNearDuplicates is idempotent on the output);
 *   • ≥90% looksHuman (sources are gated by _looks_human);
 *   • competitor-name share within the [competitorFloor, competitorCap]
 *     corridor (exactly [10%, 20%] for n=10);
 *   • for a ru project, a high Cyrillic share — on a REALISTIC mock
 *     generation (see the honest caveat below about what the pipeline does
 *     NOT guarantee).
 *
 * The mock is deliberately "dirty": exact and near-duplicates, non-human
 * strings (a raw keyword with no address, two questions in one string),
 * prompts naming competitors, Latin script.
 */
import {
  generatePrompts,
  competitorCap,
  competitorFloor,
  dropNearDuplicates,
  hasCompetitor,
  competitorBrands,
  type PromptRow,
  type GenerateDeps,
} from './generate';
import { normPrompt, looksHuman } from './text';

// ── acceptance utilities ─────────────────────────────────────────────────────

/**
 * A prompt is "Russian" if ≥50% of ITS letters are Cyrillic. The threshold is
 * per-prompt, not per-letter across the whole panel: a real ru prompt
 * legitimately contains Latin tech terms (CRM, email, B2B, CS GO), and the
 * "95% Cyrillic share" here means the share of PROMPTS that are Russian, not
 * the share of Cyrillic characters (otherwise "порекомендуй crm" would be
 * penalized for its 3 Latin letters). This is the same way detect_lang
 * (aeo.py:1324) measures language.
 */
function isRussianPrompt(p: string): boolean {
  const letters = [...p].filter((c) => /\p{L}/u.test(c));
  if (!letters.length) return false;
  const cyr = letters.filter((c) => /\p{Script=Cyrillic}/u.test(c)).length;
  return cyr / letters.length >= 0.5;
}

/** Share of panel prompts that are Russian (see isRussianPrompt). */
function russianShare(prompts: string[]): number {
  if (!prompts.length) return 0;
  return prompts.filter(isRussianPrompt).length / prompts.length;
}

/** Share of panel prompts that pass _looks_human. */
function looksHumanRatio(prompts: string[]): number {
  if (!prompts.length) return 1;
  return prompts.filter((p) => looksHuman(p)).length / prompts.length;
}

/** Whether there are exact duplicates by normalized text. */
function hasExactDupes(panel: PromptRow[]): boolean {
  const seen = new Set<string>();
  for (const p of panel) {
    const k = normPrompt(p.prompt);
    if (seen.has(k)) return true;
    seen.add(k);
  }
  return false;
}

/** Build a source PromptRow (source='real', volume null — like the RU keyword branch). */
function row(prompt: string, intent: string, topic: string | null = null): PromptRow {
  return { prompt, intent, topic, volume: null, source: 'real' };
}

/**
 * Deps with a mock fromKeywords source (the analog of the mock Analyzer
 * `az`): REPLACES the LLM keyword branch with a fixed candidate list. `ask`
 * is not set → the remaining LLM branches are empty (siteSections/
 * competitor/generated), like az=None.
 */
function fixedSource(rows: PromptRow[]): GenerateDeps {
  return { sources: { fromKeywords: async () => rows } };
}

// ── ru project: dirty mock with competitors ──────────────────────────────────

/**
 * 8 clean Cyrillic "human" prompts (different intents/topics, no duplicates),
 * 3 naming competitors, 1 exact duplicate, 1 near-duplicate, 2 non-human.
 */
const MESSY_RU: PromptRow[] = [
  row('посоветуй crm для небольшого агентства', 'best'),
  row('какой сервис email рассылок выбрать новичку', 'how_to_choose'),
  row('сколько стоит облачная телефония для офиса', 'pricing'),
  row('стоит ли переходить на новую аналитику отзывы', 'reviews'),
  row('что лучше для планирования задач в команде', 'comparison'),
  row('как выбрать хостинг для интернет магазина', 'how_to_choose'),
  row('порекомендуй сервис аналитики для маркетолога', 'best'),
  row('какие есть альтернативы дорогим таск трекерам', 'alternatives'),
  // competitors (clash/insane)
  row('что лучше clash или другие сервисы для новичка', 'comparison'),
  row('стоит ли insane или есть надёжнее', 'reviews'),
  row('альтернативы clash для команды из пяти человек', 'alternatives'),
  // exact duplicate #1 and near-duplicate #1 (same intent best) — both must collapse
  row('посоветуй crm для небольшого агентства', 'best'),
  row('порекомендуй crm небольшому агентству', 'best'),
  // non-human: raw keyword with no address; two questions in one string
  row('виртуальная атс купить москва', 'use_case'),
  row('какой crm выбрать? какие есть варианты?', 'how_to_choose'),
];

const N = 10;
const RU_COMPETITORS = ['Clash.gg', 'Insane.gg'];

describe('generatePrompts — structural acceptance of the LLM part (ru, dirty mock)', () => {
  let panel: PromptRow[];
  let prompts: string[];

  beforeAll(async () => {
    panel = await generatePrompts('example.io', [], {
      n: N,
      lang: 'ru',
      competitors: RU_COMPETITORS,
      deps: fixedSource(MESSY_RU),
    });
    prompts = panel.map((p) => p.prompt);
  });

  it('pipeline ran: panel is non-empty and not fallback', () => {
    expect(panel.length).toBeGreaterThan(3);
    expect(panel.every((p) => p.source !== 'fallback')).toBe(true);
  });

  it('n clamp: panel length ≤ n', () => {
    expect(panel.length).toBeLessThanOrEqual(N);
  });

  it('0 near-duplicates: dropNearDuplicates is idempotent and there are no exact duplicates', () => {
    expect(dropNearDuplicates(panel).length).toBe(panel.length);
    expect(hasExactDupes(panel)).toBe(false);
    // exact duplicate and near-duplicate #1 in the mock list — #1 appears exactly once in the final panel.
    const c1 = normPrompt('посоветуй crm для небольшого агентства');
    expect(prompts.filter((p) => normPrompt(p) === c1).length).toBe(1);
  });

  it('≥90% looksHuman: non-human candidates are filtered out', () => {
    expect(looksHumanRatio(prompts)).toBeGreaterThanOrEqual(0.9);
    // specifically: the raw keyword and the double question didn't make it into the panel.
    expect(prompts).not.toContain('виртуальная атс купить москва');
    expect(prompts).not.toContain('какой crm выбрать? какие есть варианты?');
  });

  it('competitor corridor: name share within [floor, cap] = [10%, 20%] at n=10', () => {
    const brands = competitorBrands(RU_COMPETITORS);
    const compCount = panel.filter((p) => hasCompetitor(p, brands)).length;
    expect(compCount).toBeGreaterThanOrEqual(competitorFloor(N));
    expect(compCount).toBeLessThanOrEqual(competitorCap(N));
    // n=10 → floor=1 (10%), cap=2 (20%): the share is within the nominal 10-20% corridor.
    const share = compCount / panel.length;
    expect(share).toBeGreaterThanOrEqual(0.1);
    expect(share).toBeLessThanOrEqual(0.2);
  });

  it('ru project: Cyrillic share is high (mock without Latin models the ru instruction)', () => {
    expect(russianShare(prompts)).toBeGreaterThanOrEqual(0.95);
  });
});

// ── clean ru mock: Cyrillic only (as an instructed LLM would produce) ────────

describe('generatePrompts — Cyrillic share on a realistic ru generation', () => {
  it('panel ≥95% Cyrillic when generation is Cyrillic (no comp)', async () => {
    const clean = MESSY_RU.slice(0, 8); // 8 clean Cyrillic ones
    const panel = await generatePrompts('example.io', [], {
      n: N,
      lang: 'ru',
      competitors: [],
      deps: fixedSource([
        ...clean,
        row('как перенести данные в новый сервис без потерь', 'use_case'),
        row('что выбрать для командной работы над документами', 'comparison'),
      ]),
    });
    const prompts = panel.map((p) => p.prompt);
    expect(panel.length).toBeGreaterThanOrEqual(4);
    expect(russianShare(prompts)).toBeGreaterThanOrEqual(0.95);
  });
});

// ── HONEST CAVEAT: what the pipeline does NOT guarantee ──────────────────────

describe('generatePrompts — boundary of structural acceptance (honest)', () => {
  /**
   * Latin script in a ru project is NOT filtered out by a deterministic
   * filter: _looks_human also accepts English addresses (it has EN markers
   * recommend/best/…), and there is no cyrillic gate inside generate_prompts.
   * The 95% Cyrillic share in prod is a property of GENERATION (the model is
   * instructed to write in Russian), not of a post-filter. So a Latin
   * "human" prompt does survive to the panel — this is a deliberate
   * boundary, and it can't be closed with a test on live generation (it
   * would need an actual model call).
   */
  it('a Latin looksHuman prompt in a ru project SURVIVES to the panel (not a guarantee)', async () => {
    const latin = 'recommend a cheap crm for a small startup team';
    expect(looksHuman(latin)).toBe(true); // an EN address passes _looks_human
    const panel = await generatePrompts('example.io', [], {
      n: N,
      lang: 'ru',
      competitors: [],
      deps: fixedSource([row(latin, 'best'), ...MESSY_RU.slice(0, 8)]),
    });
    const prompts = panel.map((p) => p.prompt);
    expect(prompts).toContain(latin); // the pipeline did NOT remove it
    // and precisely because of it the Cyrillic share drops below 95% —
    // confirming the 95% guarantee is NOT deterministic, but a property of generation.
    expect(russianShare(prompts)).toBeLessThan(0.95);
  });

  it('empty generation → deterministic template fallback (source=fallback)', async () => {
    const panel = await generatePrompts('mybrand.io', [], {
      n: N,
      lang: 'ru',
      competitors: [],
      deps: fixedSource([]), // the model produced nothing
    });
    expect(panel.length).toBeGreaterThan(0);
    expect(panel.every((p) => p.source === 'fallback')).toBe(true);
    // fallback is NOT filtered by looks_human (the last line of defense), but it is Cyrillic.
    expect(russianShare(panel.map((p) => p.prompt))).toBeGreaterThan(0.5);
  });

  it('en project: same pipeline, Latin script is appropriate — fallback is English', async () => {
    const panel = await generatePrompts('mybrand.io', [], {
      n: N,
      lang: 'en',
      competitors: [],
      deps: fixedSource([]),
    });
    expect(panel.every((p) => p.source === 'fallback')).toBe(true);
    expect(panel.some((p) => /what is/i.test(p.prompt))).toBe(true);
  });
});
