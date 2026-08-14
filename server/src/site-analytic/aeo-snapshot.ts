/**
 * AEO recon inside the analysis — port of core/site_analytic.py::_run_aeo_snapshot
 * (site_analytic.py:711-910). N prompts × AI engines → the AEO block of facts for
 * the "AI Search" tab + a raw run (monitoring seed) + validated competitors.
 *
 * COMPOSITION on top of the existing aeo/*: generatePrompts (target-audience panel)
 * → runSnapshot (engines, network via the provider dispatcher) → buildCompetitors
 * (candidate validation) → re-parsing brands_found against the real players →
 * sentimentBatch → judgeAnswers → aggregateFacts (aggregate.ts, ≠
 * aggregate_monitoring). Fail-soft like Python: empty engine responses →
 * panelOnlyBlock (prompts + status), a failure in validation/sentiment/seeding —
 * the run still lives.
 *
 * The UNIFIED BRAND PANEL and monitoring seed ("2 in 1") are tied to the DB
 * (aeo_trackers/aeo_answers/brands/user_plans) — split out behind the injectable
 * AeoSnapshotStore. Without a store (or lite, or no user_id), the Python "no
 * tracker" branch runs: the panel is generated from scratch, the tracker isn't
 * synced, no monitoring point is written. Providers and the store are mocked in
 * tests — no live API/LLM burned.
 */
import { get, isDict, pyOr, truthy, cpSlice } from './pyhelpers';
import { pyStrip } from '../aeo/parse';
import { isRuDomain } from './geo';
import { askFlashJson } from '../aeo/run';
import {
  runSnapshot,
  judgeAnswers,
  sentimentBatch,
  type SnapshotAnswer,
  type SentimentEntry,
} from '../aeo/run';
import {
  generatePrompts,
  productBrief,
  type GenerateContext,
  type KeywordRow,
  type KwSuggestionRow,
} from '../aeo/generate';
import {
  normalizePanel,
  dropFallback,
  promptStatus,
  promptCount as promptCountFn,
  type PanelEntry,
} from '../aeo/panel';
import { normPrompt } from '../aeo/text';
import { parseBrands } from '../aeo/parse';
import { platformsFor, availablePlatforms } from '../aeo/engines';
import { DEFAULT_PLATFORMS } from '../aeo/providers/dispatcher';
import { aggregateFacts, panelOnlyBlock } from '../aeo/aggregate';
import {
  buildCompetitors as buildCompetitorsImpl,
  onboardingCompetitors as onboardingCompetitorsImpl,
  type CandidateRow,
  type BuildCompetitorsInput,
  type AskJson,
} from './competitors';
import type { Facts, Raw } from './types';

// ── geo map (site_analytic.py:37-45 _WORLD_LOCATIONS → GEO_LOCATIONS) ────────

const WORLD_LOCATIONS: ReadonlyArray<[string, number, string]> = [
  ['US', 2840, 'en'], ['IN', 2356, 'en'], ['BR', 2076, 'pt'],
  ['GB', 2826, 'en'], ['DE', 2276, 'de'], ['FR', 2250, 'fr'],
  ['ES', 2724, 'es'], ['IT', 2380, 'it'], ['MX', 2484, 'es'],
  ['ID', 2360, 'id'], ['JP', 2392, 'ja'], ['NL', 2528, 'nl'],
  ['PL', 2616, 'pl'], ['TR', 2792, 'tr'], ['CA', 2124, 'en'],
  ['AU', 2036, 'en'],
];
const GEO_LOCATIONS: Record<string, [number, string]> = Object.fromEntries(
  WORLD_LOCATIONS.map(([c, loc, lang]) => [c.toLowerCase(), [loc, lang]]),
);

// ── prompt language detection from content (aeo.py:1317-1341) ────────────────

/** `str(x or "")`. */
function pyStrOr(v: unknown): string {
  return truthy(v) ? String(v) : '';
}

const isAlpha = (ch: string): boolean => /\p{L}/u.test(ch);

/** `_cyrillic_ratio` (aeo.py:1317): share of Cyrillic among letters (U+0400..U+04FF). */
function cyrillicRatio(text: string): number {
  const letters = Array.from(text || '').filter(isAlpha);
  if (!letters.length) return 0;
  let cyr = 0;
  for (const c of letters) if (c >= 'Ѐ' && c <= 'ӿ') cyr += 1;
  return cyr / letters.length;
}

/**
 * `detect_lang` (aeo.py:1324): prompt language from the ACTUAL content of the
 * homepage + top keywords (not the TLD). A notable Cyrillic share → ru; too
 * few letters → fallback.
 */
export function detectLang(
  context: unknown,
  keywords: unknown[],
  fallback: string | null = 'en',
): string | null {
  const parts: string[] = [];
  if (isDict(context)) {
    for (const k of ['title', 'description', 'h1', 'hero_text']) parts.push(pyStrOr(get(context, k)));
  }
  for (const k of (keywords || []).slice(0, 30)) parts.push(pyStrOr(get(k, 'keyword')));
  const blob = parts.join(' ');
  if (Array.from(blob).filter(isAlpha).length < 20) return fallback;
  return cyrillicRatio(blob) >= 0.3 ? 'ru' : 'en';
}

// ── panel: merge / active / texts (aeo.py:858-956) ────────────────────────────

/** `active_prompts` (aeo.py:858): only active ones (suggested/inactive not run). */
function activePrompts(panel: unknown[]): unknown[] {
  return (panel || []).filter((p) => promptStatus(p) === 'active');
}

/** `prompt_texts` (aeo.py:864): panel → texts, dedup by normPrompt, order preserved. */
function promptTexts(panel: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of panel || []) {
    const raw = isDict(p) ? get(p, 'prompt') : p;
    const t = pyStrip(pyStrOr(raw));
    if (!t) continue;
    const k = normPrompt(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** `merge_panels` (aeo.py:941): curated core + top-up by generation to n, deduped. */
function mergePanels(existing: unknown[], fresh: unknown[], n: number): PanelEntry[] {
  const out = dropFallback(normalizePanel(existing));
  const seen = new Set(out.map((p) => normPrompt(p.prompt)));
  for (const p of dropFallback(normalizePanel(fresh, { defaultSource: 'generated' }))) {
    if (out.length >= n) break;
    const k = normPrompt(p.prompt);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out.slice(0, n);
}

// ── DB store (unified brand panel + monitoring seed) ─────────────────────────

/** Minimal tracker row the snapshot needs. */
export interface SnapshotTracker {
  id: number;
  prompts: unknown;
}

/**
 * Seam to the AEO DB (aeo_trackers/aeo_answers/brands/user_plans). Each method
 * is fail-soft on the caller's side: a failure narrows behavior down to the
 * Python "no tracker" branch, but doesn't fail the analysis.
 */
export interface AeoSnapshotStore {
  /** effective_plan(user_id) → plan (for prompt_count). */
  effectivePlan(userId: number): Promise<string | null>;
  /** find_aeo_tracker(domain, user_id, include_paused=True). */
  findTracker(domain: string, userId: number): Promise<SnapshotTracker | null>;
  /** brand_aliases(user_id, domain) — confirmed brand spellings. */
  brandAliases(userId: number, domain: string): Promise<string[]>;
  /** prompt_pool_left — remaining account prompt pool (null = no clamping). */
  promptPoolLeft(userId: number, excludeTrackerId: number | null): Promise<number | null>;
  /** update_aeo_tracker(id, prompts=merged) — syncs the top-up into the tracker. */
  updateTrackerPrompts(trackerId: number, prompts: PanelEntry[]): Promise<void>;
  /** "2 in 1": analysis run → monitoring point (insert_aeo_answers + last_run_at). */
  seedMonitoring(
    trackerId: number,
    runAt: Date,
    answers: SnapshotAnswer[],
    sentiment: Record<string, SentimentEntry> | null,
  ): Promise<void>;
}

/** No-op store: the Python "no tracker" branch (panel from scratch, no sync/seed). */
export const NULL_SNAPSHOT_STORE: AeoSnapshotStore = {
  async effectivePlan() {
    return null;
  },
  async findTracker() {
    return null;
  },
  async brandAliases() {
    return [];
  },
  async promptPoolLeft() {
    return null;
  },
  async updateTrackerPrompts() {
    /* no-op */
  },
  async seedMonitoring() {
    /* no-op */
  },
};

// ── injections (for tests with mock providers) ────────────────────────────────

export interface AeoSnapshotDeps {
  runSnapshot?: typeof runSnapshot;
  judgeAnswers?: typeof judgeAnswers;
  sentimentBatch?: typeof sentimentBatch;
  generatePrompts?: typeof generatePrompts;
  buildCompetitors?: (input: BuildCompetitorsInput) => Promise<CandidateRow[]>;
  onboardingCompetitors?: (domain: string) => Promise<string[]>;
  platformsFor?: (profile: string) => Promise<string[]>;
  availablePlatforms?: (platforms: readonly string[]) => Promise<string[]>;
  /** prompt_count(plan) accounting for AEO_PROMPTS (env by default). */
  promptCount?: (plan: string | null | undefined) => number;
  /** flash-JSON for buildCompetitors and generatePrompts.deps.ask. */
  askJson?: AskJson;
  /** dataforseo.keyword_suggestions for generatePrompts.deps. */
  keywordSuggestions?: (seed: string, limit: number) => Promise<KwSuggestionRow[] | null>;
  store?: AeoSnapshotStore;
}

export interface SnapshotOpts {
  userId?: number | null;
  lite?: boolean;
  progress?: (label: string) => void;
  /** override for the number of prompts (usually null → plan/default). */
  nPrompts?: number | null;
}

export interface AeoSnapshotResult {
  block: Record<string, unknown>;
  run: Record<string, unknown> | null;
  competitors?: CandidateRow[] | null;
}

const dedup = <T>(xs: T[]): T[] => [...new Set(xs)];

const ENGINES_NOTE =
  'ИИ-движки не ответили. Проверьте ANTHROPIC_API_KEY / OPENROUTER_API_KEY ' +
  '(валидность/баланс) и перепрогоните разбор.';

/**
 * Port of _run_aeo_snapshot (site_analytic.py:711-910). The LLM-key/AEO_SNAPSHOT
 * gate lives on the caller's side (LiveLlmLayer); here — the recon core. Returns
 * {block, run, competitors}, or a panel-only block when the engines stay silent.
 */
export async function runAeoSnapshotCore(
  domain: string,
  facts: Facts,
  raw: Raw,
  opts: SnapshotOpts = {},
  deps: AeoSnapshotDeps = {},
): Promise<AeoSnapshotResult> {
  const runSnapshotFn = deps.runSnapshot ?? runSnapshot;
  const judgeAnswersFn = deps.judgeAnswers ?? judgeAnswers;
  const sentimentBatchFn = deps.sentimentBatch ?? sentimentBatch;
  const generatePromptsFn = deps.generatePrompts ?? generatePrompts;
  const buildCompetitorsFn = deps.buildCompetitors ?? buildCompetitorsImpl;
  const onboardingCompetitorsFn = deps.onboardingCompetitors ?? onboardingCompetitorsImpl;
  const platformsForFn = deps.platformsFor ?? platformsFor;
  const availablePlatformsFn = deps.availablePlatforms ?? availablePlatforms;
  const promptCount =
    deps.promptCount ?? ((plan) => promptCountFn(plan, process.env.AEO_PROMPTS ?? null));
  const ask = deps.askJson ?? askFlashJson;
  const store = deps.store ?? NULL_SNAPSHOT_STORE;
  const progress = opts.progress;
  const lite = !!opts.lite;
  const userId = opts.userId ?? null;

  let nPrompts: number | null = opts.nPrompts ?? null;
  let tracker: SnapshotTracker | null = null;
  let brandAliases: string[] = [];
  if (userId && !lite) {
    try {
      const plan = await store.effectivePlan(userId);
      tracker = await store.findTracker(domain, userId);
      brandAliases = await store.brandAliases(userId, domain);
      if (nPrompts === null) {
        nPrompts = promptCount(plan);
        const poolLeft = await store.promptPoolLeft(userId, tracker?.id ?? null);
        if (poolLeft !== null) nPrompts = Math.min(nPrompts, Math.max(5, poolLeft));
      }
    } catch {
      tracker = null; // the analysis is still valid without a tracker (site_analytic.py:760)
    }
  }
  if (lite) nPrompts = Math.min(nPrompts ?? 10, 10); // free panel — 10 prompts
  if (nPrompts === null) nPrompts = promptCount(null);

  let competitors = (pyOr(get(facts, 'competitors'), []) as any[])
    .filter((c) => truthy(get(c, 'domain')))
    .map((c) => get(c, 'domain') as string)
    .slice(0, 3);
  const ru = isRuDomain(domain);
  const crawlCtx = pyOr(get(facts, 'crawl'), get(raw, 'crawl')) as GenerateContext | null;
  const lang = detectLang(crawlCtx, (pyOr(get(raw, 'keywords'), []) as any[]), ru ? 'ru' : 'en');

  let loc: number;
  let lc: string;
  if (lang === 'ru') {
    loc = 2643;
    lc = 'ru';
  } else {
    const geoKey = String(pyOr(get(pyOr(get(facts, 'meta'), {}), 'geo'), 'us')).toLowerCase();
    [loc, lc] = GEO_LOCATIONS[geoKey] ?? GEO_LOCATIONS.us;
  }

  const platforms = lite
    ? await availablePlatformsFn(
        dedup([...(await platformsForFn('micro')), ...(await platformsForFn('mid'))]),
      )
    : await availablePlatformsFn(DEFAULT_PLATFORMS);

  const existing = dropFallback(
    normalizePanel(pyOr(get(pyOr(tracker, {}), 'prompts'), []) as unknown[]),
  );

  let panel: PanelEntry[];
  if (existing.length && existing.length + 5 >= nPrompts) {
    // The tracker's panel is already full (5-slack) — run it as-is, no new generation.
    panel = existing.slice(0, nPrompts);
  } else {
    progress?.('AEO: generating prompts');
    const fresh = await generatePromptsFn(domain, pyOr(get(raw, 'keywords'), []) as KeywordRow[], {
      n: nPrompts,
      lang: lang ?? (ru ? 'ru' : 'en'),
      context: crawlCtx,
      competitors,
      deps: { ask, keywordSuggestions: deps.keywordSuggestions },
    });
    const merged = mergePanels(existing, fresh, nPrompts);
    panel = merged.length ? merged : (fresh as unknown as PanelEntry[]);
    if (tracker && merged.length && JSON.stringify(merged) !== JSON.stringify(existing)) {
      try {
        await store.updateTrackerPrompts(tracker.id, merged);
      } catch {
        /* the sync failing doesn't fail the analysis (site_analytic.py:811) */
      }
    }
  }

  const prompts = promptTexts(activePrompts(panel));
  const answers = await runSnapshotFn(domain, competitors, prompts, {
    platforms,
    grounded: !lite,
    locationCode: loc,
    languageCode: lc,
    aliases: { [domain]: brandAliases },
  });

  if (!answers.length) {
    // Fail-soft: the key is there, prompts are there, but ALL engines came back empty.
    progress?.('AEO: engines unavailable — check ANTHROPIC_API_KEY / OPENROUTER_API_KEY');
    return { block: panelOnlyBlock(panel, platforms, { note: ENGINES_NOTE }), run: null };
  }

  // Competitor validation: the SEO domains were only candidates (site_analytic.py:835).
  let validated: CandidateRow[] | null = null;
  try {
    progress?.('AEO: validating competitors');
    const about = productBrief(crawlCtx, domain);
    validated = await buildCompetitorsFn({
      domain,
      about,
      seoRows: (pyOr(get(facts, 'competitors'), []) as any[]),
      answers,
      onboarding: await onboardingCompetitorsFn(domain),
      ask,
    });
  } catch {
    /* a broken list is worse than the old one (site_analytic.py:849) */
  }
  if (validated && validated.length) {
    competitors = validated
      .filter((c) => truthy(get(c, 'domain')) || truthy(get(c, 'name')))
      .map((c) => pyOr(get(c, 'domain'), get(c, 'name')) as string)
      .slice(0, 5);
    // Re-parse mentions against the VALIDATED brands (no aliases, same as Python).
    const brands = [domain, ...competitors];
    for (const a of answers) a.brands_found = parseBrands(a.text, brands);
  }

  progress?.('AEO: sentiment');
  const brandTexts: Record<string, string[]> = {};
  for (const a of answers) {
    for (const bf of a.brands_found) (brandTexts[bf.brand] ??= []).push(a.text);
  }
  const sentiment = await sentimentBatchFn(brandTexts);

  progress?.('AEO: scoring answers');
  await judgeAnswersFn(answers, domain, competitors);

  // Panel metadata map → enriches the prompt rows (frequency/intent/topic).
  const promptMeta: Record<string, { volume?: number | null; intent?: string | null; topic?: string | null }> = {};
  for (const p of panel) {
    const pr = get(p, 'prompt');
    if (truthy(pr)) {
      promptMeta[normPrompt(pr as string)] = {
        volume: get(p, 'volume'),
        intent: get(p, 'intent'),
        topic: get(p, 'topic'),
      };
    }
  }
  const block = aggregateFacts(answers as any[], domain, competitors, {
    platforms,
    sentiment,
    promptMeta,
  });

  // Raw run for seeding monitoring (full text — the first run).
  const run = {
    answers: answers.map((a) => ({
      platform: a.platform,
      prompt: a.prompt,
      text: cpSlice(pyStrOr(a.text), 12000),
      brands_found: a.brands_found ?? [],
      citations: a.citations ?? [],
      judge: a.judge ?? null,
    })),
    sentiment,
    competitors,
    prompts: panel,
    platforms: [...platforms],
  };

  // "2 in 1": the user already has a tracker for this domain → the run = a monitoring point.
  if (tracker) {
    try {
      await store.seedMonitoring(tracker.id, new Date(), answers, sentiment);
    } catch {
      /* a monitoring failure doesn't fail the analysis (site_analytic.py:906) */
    }
  }

  return { block, run, competitors: validated };
}
