/**
 * Top-level orchestration of a single tracker's AEO run — port of
 * scrapper/web/jobs.py::_process_aeo (jobs.py:685-892). Reads the tracker,
 * gathers the active prompt panel and the engine mix per plan profile, runs
 * the snapshot(s) (run.ts), judges and computes sentiment, persists answers
 * into aeo_answers, and updates the run timestamps on the tracker.
 *
 * Engine spend (llm_usage.cost_usd) is recorded BY ITSELF, inside the provider
 * clients (anthropic/google/openrouter → recordUsage, usage.ts): the whole run is wrapped in
 * runContext ('aeo_run', `${tid}:${date}`), so every spend point picks up the
 * run's run_id/domain/user_id without manual threading (port of
 * usage.run_context, jobs.py:786). There are no manual recordUsage calls here —
 * that's the whole point of AsyncLocalStorage.
 *
 * Writing answers uses createMany({skipDuplicates}) instead of Python's
 * row-by-row INSERT (storage.insert_aeo_answers, storage.py:2724): production
 * has a unique index uniq_aeo_answer (tracker_id, run_at, platform, md5(prompt)),
 * so a repeat row is swallowed by ON CONFLICT DO NOTHING rather than failing
 * the run. The sentiment service row uses platform='_sentiment', prompt=''
 * (storage.py:2743-2749).
 *
 * DELIBERATELY OUT OF SCOPE FOR THE PORT (listed in the return value as
 * coverage-gaps): initial config gathering (competitor-discovery via
 * dataforseo/keysso and generate_prompts — external LLM/SERP services),
 * key-gating available_platforms (an unavailable engine already returns null
 * from askPlatform — no money burned) and the full GEO_LOCATIONS geo map.
 * NOW PORTED (engines.ts, money-safety critical): profile engine mix via
 * platformsFor — with the AEO_PROFILE_* admin overrides and the global
 * AEO_ENGINES_OFF kill switch — and the yandex-profile clamp by frequency
 * (topVolumePrompts + yandexPromptsMax). This used to be a static
 * PROFILE_PLATFORMS: an engine the admin had disabled still went into the run,
 * and Neuro ran the whole panel — both were extra spend beyond what Python
 * does. The run's core (panel → engines → snapshot → judge → write →
 * timestamps) is ported literally.
 */
import type { Prisma } from '@prisma/client';
import { blogPrisma } from '../blogwriter/server/utils/prisma';
import { runContext } from './usage';
import {
  platformsFor,
  platformsForLang,
  topVolumePrompts,
  yandexPromptsMax,
} from './engines';
import {
  normalizePanel,
  promptStatus,
  normalizeProjectLang,
  type PanelEntry,
} from './panel';
import { normPrompt } from './text';
import { isDict, pyStrip, pyStrOrEmpty, type AliasMap } from './parse';
import {
  runSnapshot,
  judgeAnswers,
  sentimentBatch,
  type SnapshotAnswer,
  type SentimentEntry,
} from './run';

// ── plan engine profiles (aeo.py:186-198) ─────────────────────────────────────
// The profile mix (PROFILE_PLATFORMS) and grounded mode (GROUNDED_PROFILES) now
// live in engines.ts together with the live override resolution; here we pull
// them via platformsFor(profile) rather than a static table (otherwise the kill
// switch/overrides wouldn't apply).

const KNOWN_PROFILES = ['micro', 'mid', 'full', 'yandex'] as const;

// ── Python-ish helpers ────────────────────────────────────────────────────────

/** Python's `int(v)` in try/except → null (bool→0/1, number→truncate, string→strict). */
function pyInt(v: unknown): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string') {
    const t = v.trim();
    return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : null;
  }
  return null;
}

/** Python-style slice `s[:n]` by code points (storage.py:2737 `[:12000]`). */
function cpSlice(s: string, n: number): string {
  let out = '';
  let i = 0;
  for (const ch of s) {
    if (i >= n) break;
    out += ch;
    i += 1;
  }
  return out;
}

/** jobs._tracker_run_meta (jobs.py:608-616): jsonb|text|None → timestamps dict. */
export function normalizeRunMeta(meta: unknown): Record<string, unknown> {
  let m: unknown = meta;
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m);
    } catch {
      m = null;
    }
  }
  return isDict(m) ? m : {};
}

// ── panel → active prompt texts (aeo.py:858-880, 934-938) ────────────────────

/** `drop_fallback` (aeo.py:934): template fallback prompts — not a live panel. */
function dropFallback(panel: PanelEntry[]): PanelEntry[] {
  return panel.filter((p) => p.source !== 'fallback');
}

/** `active_prompts` (aeo.py:858): only active ones (suggested/inactive are not run). */
function activePrompts(panel: PanelEntry[]): PanelEntry[] {
  return panel.filter((p) => promptStatus(p) === 'active');
}

/** `prompt_texts` (aeo.py:864): panel → texts, dedup by normPrompt, order preserved. */
function promptTexts(panel: PanelEntry[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of panel) {
    const t = pyStrip(pyStrOrEmpty(p.prompt));
    if (!t) continue;
    const k = normPrompt(t);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

// ── project language / market (aeo.py:platforms_for_lang; jobs.py:713-715) ───

/** RU domain/geo → Russian market (simplified port of is_ru_domain; geo map omitted). */
function isRuDomain(domain: string, geo: string | null | undefined): boolean {
  return (
    /\.(ru|su|рф|xn--p1ai)$/i.test(domain) || (geo || '').toLowerCase() === 'ru'
  );
}

// ── writing answers (storage.insert_aeo_answers, storage.py:2724) ────────────

/**
 * Port of insert_aeo_answers (storage.py:2724) onto Prisma: answer rows go via
 * createMany({skipDuplicates}) (production has the unique index uniq_aeo_answer),
 * the sentiment service row is a separate insert (platform='_sentiment',
 * prompt=''). Returns the number of ANSWER rows inserted (excluding the
 * sentiment row). judge is written only when it's a dict (otherwise NULL —
 * monitoring tolerates old runs without a judge, storage.py:2729-2741).
 */
export async function writeAnswers(
  trackerId: number,
  runAt: Date,
  answers: SnapshotAnswer[],
  sentiment: Record<string, SentimentEntry> | null,
  db: Pick<Prisma.TransactionClient, 'aeoAnswer'> = blogPrisma(),
): Promise<number> {
  let inserted = 0;
  if (answers.length) {
    const data: Prisma.AeoAnswerCreateManyInput[] = answers.map((a) => ({
      trackerId,
      runAt,
      platform: a.platform,
      prompt: a.prompt,
      rawText: cpSlice(a.text || '', 12000),
      brandsFound: (a.brands_found ?? []) as unknown as Prisma.InputJsonValue,
      citations: (a.citations ?? []) as unknown as Prisma.InputJsonValue,
      judge: isDict(a.judge)
        ? (a.judge as unknown as Prisma.InputJsonValue)
        : undefined,
    }));
    const res = await db.aeoAnswer.createMany({ data, skipDuplicates: true });
    inserted = res.count;
  }
  if (sentiment) {
    await db.aeoAnswer.createMany({
      data: [
        {
          trackerId,
          runAt,
          platform: '_sentiment',
          prompt: '',
          sentiment: sentiment as unknown as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
  }
  return inserted;
}

// ── running a single tracker ──────────────────────────────────────────────────

export interface ProcessAeoResult {
  trackerId: number;
  profiles: string[];
  /** engines that actually went into the run (lite + full + yandex) */
  platforms: string[];
  prompts: number;
  answers: number;
  inserted: number;
}

/**
 * Port of _process_aeo (jobs.py:685). `profile` is a single profile or a list;
 * garbage is filtered out, empty → default ['micro','mid'] (jobs.py:704-707).
 * The whole run happens inside a single runContext('aeo_run',
 * `${trackerId}:${date}`), so engine spend is grouped by run (jobs.py:786).
 */
export async function processAeoRun(
  trackerId: number,
  profile: string | string[] = ['micro', 'mid'],
): Promise<ProcessAeoResult> {
  // jobs.py:704-707 — valid profiles from PROFILE_PLATFORMS; empty → micro+mid.
  let profiles = (Array.isArray(profile) ? profile : [profile]).filter((p) =>
    (KNOWN_PROFILES as readonly string[]).includes(p),
  );
  if (!profiles.length) profiles = ['micro', 'mid'];

  const tracker = await blogPrisma().aeoTracker.findUnique({
    where: { id: trackerId },
  });
  if (!tracker) throw new Error(`aeo_tracker #${trackerId} not found`);

  const domain = tracker.domain;
  const competitors = (
    Array.isArray(tracker.competitors) ? (tracker.competitors as unknown[]) : []
  ).filter((c): c is string => !!c && typeof c === 'string');

  // jobs.py:713-715 — market (search engines' location/language) by domain/geo.
  const ru = isRuDomain(domain, tracker.geo);
  const locationCode = ru ? 2643 : 2840;
  const languageCode = ru ? 'ru' : 'en';

  // jobs.py:746-747 — PROJECT language gate: on a non-Russian project, Russian-
  // market engines produce systematically false zeros → we strip them
  // (platformsForLang). Unknown language (null) — leave the mix UNTOUCHED: as in
  // jobs.py's `_for_lang`, when plang=null the full list is returned as-is
  // (platformsForLang(null) would otherwise strip out RU).
  const plang = normalizeProjectLang(tracker.lang);
  const forLang = (slugs: readonly string[]): string[] =>
    plang ? platformsForLang(slugs, plang) : [...slugs];

  // jobs.py:749-763 — engine mix per profile via platformsFor(): the mix from
  // AEO_PROFILE_* and the global AEO_ENGINES_OFF kill switch apply live (no
  // restart needed). On a full-day, full's slugs are removed from micro (same
  // engine in search-grounded mode — we don't double it up).
  const runFull = profiles.includes('full');
  const fullSet = new Set(forLang(await platformsFor('full')));
  const lite: string[] = [];
  if (profiles.includes('micro')) {
    lite.push(
      ...forLang(await platformsFor('micro')).filter(
        (p) => !(runFull && fullSet.has(p)),
      ),
    );
  }
  if (profiles.includes('mid'))
    lite.push(...forLang(await platformsFor('mid')));
  const liteList = [...new Set(lite)]; // jobs.py:758 — don't run the same slug twice
  const fullList = runFull ? [...fullSet] : [];
  const yandexList = profiles.includes('yandex')
    ? forLang(await platformsFor('yandex'))
    : [];
  const allPlatforms = [...liteList, ...fullList, ...yandexList];
  if (!allPlatforms.length) {
    // jobs.py:777-782 — nothing left after filtering (diagnosis ≠ "no engines responded").
    throw new Error(
      `no engines available for the run (project language: ${plang ?? 'unknown'}, ` +
        `profiles: ${profiles.join(', ')})`,
    );
  }

  // jobs.py:725-727 — active panel prompts (suggested/inactive excluded).
  const panel = dropFallback(normalizePanel(tracker.prompts ?? []));
  let prompts = promptTexts(activePrompts(panel));
  // jobs.py:832-838 — prompts_limit: how many active prompts to actually run (clamped ≥5).
  const limitRaw = tracker.promptsLimit;
  if (limitRaw !== null && limitRaw !== undefined) {
    const n = pyInt(limitRaw);
    if (n !== null)
      prompts = prompts.slice(0, Math.max(5, Math.min(n, prompts.length)));
  }

  // jobs.py:845 — confirmed brand spellings from the brand card (best-effort).
  let aliases: AliasMap;
  if (tracker.brandId) {
    try {
      const brand = await blogPrisma().brand.findUnique({
        where: { id: tracker.brandId },
        select: { aliases: true },
      });
      const list = Array.isArray(brand?.aliases)
        ? (brand!.aliases as unknown[])
        : [];
      if (list.length) aliases = { [domain]: list };
    } catch {
      /* no brand card/table — run without aliases (visibility may be understated) */
    }
  }

  // jobs.py:784-786 — run context: run_id = tracker + date (UTC).
  const runDate = new Date().toISOString().slice(0, 10);
  return runContext(
    `${trackerId}:${runDate}`,
    async (): Promise<ProcessAeoResult> => {
      const answers: SnapshotAnswer[] = [];
      // jobs.py:849-868 — three snapshots: lite (grounded=false), full/yandex
      // (grounded=true), merged into one combined answers list.
      if (liteList.length) {
        answers.push(
          ...(await runSnapshot(domain, competitors, prompts, {
            platforms: liteList,
            grounded: false,
            locationCode,
            languageCode,
            aliases,
          })),
        );
      }
      if (fullList.length) {
        answers.push(
          ...(await runSnapshot(domain, competitors, prompts, {
            platforms: fullList,
            grounded: true,
            locationCode,
            languageCode,
            aliases,
          })),
        );
      }
      if (yandexList.length) {
        // jobs.py:859-868 — Neuro is expensive (fixed price per answer): we don't
        // run the whole panel, only the top prompts by volume (topVolumePrompts ×
        // yandexPromptsMax). Without the clamp, the yandex profile would cost
        // more than Python on long panels.
        const yaPrompts = topVolumePrompts(
          panel,
          prompts,
          await yandexPromptsMax(),
        );
        answers.push(
          ...(await runSnapshot(domain, competitors, yaPrompts, {
            platforms: yandexList,
            grounded: true,
            locationCode,
            languageCode,
            aliases,
          })),
        );
      }
      if (!answers.length) throw new Error('no platform responded');

      // jobs.py:872-876 — sentiment over answer excerpts where the brand is mentioned.
      const brandTexts: Record<string, string[]> = {};
      for (const a of answers) {
        for (const bf of a.brands_found)
          (brandTexts[bf.brand] ??= []).push(a.text);
      }
      const sentiment = await sentimentBatch(brandTexts);
      // jobs.py:880 — LLM judge fills in the judge field on answers in place.
      await judgeAnswers(answers, domain, competitors);

      // jobs.py:882-892 — write answers + update run timestamps per profile.
      const runAt = new Date();
      const inserted = await writeAnswers(trackerId, runAt, answers, sentiment);
      const meta = normalizeRunMeta(tracker.runMeta);
      const iso = runAt.toISOString();
      for (const p of profiles) meta[`${p}_at`] = iso;
      await blogPrisma().aeoTracker.update({
        where: { id: trackerId },
        data: {
          lastRunAt: runAt,
          runMeta: meta as unknown as Prisma.InputJsonValue,
        },
      });

      return {
        trackerId,
        profiles,
        platforms: allPlatforms,
        prompts: prompts.length,
        answers: answers.length,
        inserted,
      };
    },
    { kind: 'aeo_run', userId: tracker.userId, domain },
  );
}
