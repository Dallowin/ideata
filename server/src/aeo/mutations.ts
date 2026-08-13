/**
 * Native AEO tracker mutations (Prisma) — a port of tracker writes from
 * scrapper/web/services.py, previously proxied to Python via the internal loop:
 *
 *   • setAeoPrompts     (services.py:492) — PUT-replace the prompt panel + a run;
 *   • refreshAeoTracker (services.py:533) — manual run of the prompts only;
 *   • setAeoCompetitors (services.py:557) — who to compare the brand against;
 *   • setAeoPromptsLimit (services.py:596) — how many panel prompts to run;
 *   • mutateAeoPrompts  (services.py:771) — point-in-time panel status changes
 *     (add/accept/reject/archive/reactivate/delete/set_topic/rename_topic/
 *     clear_topic).
 *
 * Layers:
 *   • PURE core (no Nest/Prisma, parity-tested against live Python in
 *     mutations.spec): capText/capPanel (money length caps), normalizeCompetitors,
 *     parsePromptsLimit, mutatePanel (point-mutation decision logic).
 *     normalizePanel/promptStatus/promptCount are reused from panel.ts (already
 *     byte-for-byte with Python) — not duplicated here.
 *   • AeoMutationsService — Prisma wrapper: loads the tracker, gates the owner
 *     (AeoReadService.assertCanMutate, fail-closed), counts quotas against the
 *     DB, writes the panel/competitors/limit, enqueues a run (enqueueRun from
 *     queue.ts — dedupes the active job itself).
 *
 * MONEY FIXES (audit; these did NOT exist in Python — set_aeo_prompts was a
 * spend amplifier). Marked `[$]`:
 *   [$1] length cap on EACH record: prompt ≤300 code points, topic ≤60 —
 *        otherwise a 1MB string would land in the panel and in a paid engine
 *        run (capPanel);
 *   [$2] overall cap on the NUMBER of panel records = 3×prompt pool, COUNTING
 *        suggested and inactive: Python's active quota counts only `active`,
 *        so thousands of status:suggested records bloated the jsonb and
 *        bypassed the quota (setAeoPrompts);
 *   [$3] run dedup: enqueueRun first looks for an active aeo job on the tracker
 *        (find_active_aeo_job) — a repeated POST prompts does NOT spawn a
 *        second paid run (in Python, set_aeo_prompts called enqueue_aeo
 *        unconditionally).
 */
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AeoTracker, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PlanService } from '../plans/plans.service';
import { AeoReadService } from './aeo-read.service';
import { cleanDomain } from '../public-api/clean-domain';
import { enqueueRun } from './queue/queue';
import {
  normalizePanel,
  promptStatus,
  promptCount,
  dropFallback,
  normalizeProjectLang,
  type PanelEntry,
} from './panel';
import { normPrompt, cpLength } from './text';
import { isDict, pyStrip, pyStrOrEmpty } from './parse';
import {
  generatePrompts,
  keywordsAboutSite,
  type GenerateDeps,
  type GenerateContext,
  type KeywordRow,
  type PromptRow,
} from './generate';
import { askFlashJson } from './run';
import { crawlHomepage } from './crawl';
import { DataForSeoClient, supportsDataForSeo } from '../discover/dataforseo.client';
import { KeysSoClient } from '../discover/keysso.client';

// ── money caps ────────────────────────────────────────────────────────────────

/** [$1] Max code points in a panel prompt's text. */
export const MAX_PROMPT_LEN = 300;
/** [$1] Max code points in a prompt's topic. Matches the new_topic cap in
 *  rename_topic (services.py:889), now applied to ALL records. */
export const MAX_TOPIC_LEN = 60;
/** [$2] Multiplier for the overall panel record-count cap relative to the pool. */
export const PANEL_RECORDS_FACTOR = 3;

// ── Python-isms ───────────────────────────────────────────────────────────────

/** Python truthiness of `if x`: None/False/0/-0/""/[]/{} — falsy. */
function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '') return false;
  if (typeof v === 'number') return v !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return true;
}

/** Python's `s[:n]` — a slice by CODE POINTS (not UTF-16 units). */
function cpSlice(s: string, n: number): string {
  if (n <= 0) return '';
  return Array.from(s).slice(0, n).join('');
}

/**
 * `int(v)` for prompts_limit (services.py:616) inside try/except(TypeError,
 * ValueError): bool→0/1, finite number→truncation TOWARD ZERO, string→strict
 * integer (int("5.0") raises ValueError), anything else (None is already
 * filtered by the caller, list/dict/nan/inf) → raises. The raise is converted
 * by the caller into 400 "prompts_limit must be an integer".
 */
function pyIntStrict(v: unknown): number {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new BadRequestException('prompts_limit must be an integer');
    return Math.trunc(v);
  }
  if (typeof v === 'string') {
    const t = pyStrip(v);
    if (/^[+-]?\d+$/.test(t)) {
      const n = Number(t);
      if (Number.isFinite(n)) return Math.trunc(n);
    }
  }
  throw new BadRequestException('prompts_limit must be an integer');
}

const clampInt = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n));

// ── [$1] money caps on panel record length ───────────────────────────────────

/**
 * Trim a single panel string by code points (Python's `s[:n]`). Empty/non-
 * string → "".
 */
export function capText(s: unknown, max: number): string {
  return cpSlice(typeof s === 'string' ? s : '', max);
}

/**
 * [$1] Apply the money length caps to EVERY record of an already-normalized
 * panel: prompt → ≤MAX_PROMPT_LEN, topic → ≤MAX_TOPIC_LEN. Trimming CAN collapse
 * two long prompts into a single key — hence a RE-dedup by normalized text
 * (first wins), same as normalizePanel. The lean canon is preserved (status/
 * suggested_at are left alone). Python had no such cap — this is an added
 * safeguard.
 */
export function capPanel(
  panel: PanelEntry[],
  maxPrompt = MAX_PROMPT_LEN,
  maxTopic = MAX_TOPIC_LEN,
): PanelEntry[] {
  const out: PanelEntry[] = [];
  const seen = new Set<string>();
  for (const p of panel) {
    const prompt = cpSlice(p.prompt, maxPrompt);
    if (!prompt) continue; // shouldn't go empty (source prompt is non-empty), but guard anyway
    const k = normPrompt(prompt);
    if (seen.has(k)) continue;
    seen.add(k);
    const topic =
      p.topic === null || p.topic === undefined ? null : cpSlice(p.topic, maxTopic) || null;
    out.push({ ...p, prompt, topic });
  }
  return out;
}

/** Freeform input → panel canon with the money caps applied ([$1]). */
export function sanitizePanel(prompts: unknown): PanelEntry[] {
  return capPanel(normalizePanel(prompts));
}

// ── competitors (services.py:557-593) ────────────────────────────────────────

/**
 * Port of the pure part of set_aeo_competitors: freeform domain list → clean,
 * no own domain, no dupes, max 10 (the run compares against at most four, but
 * we keep up to ten, like the admin editor). Not a list → 400. clean_domain is
 * applied through pyStrOrEmpty (Python's `str(v or "")`: 0/False/[] → "", same
 * as Python's clean_domain).
 */
export function normalizeCompetitors(
  competitors: unknown,
  selfDomain: string,
): string[] {
  if (!Array.isArray(competitors)) {
    throw new BadRequestException('competitors must be a list');
  }
  const self = cleanDomain(selfDomain);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of competitors) {
    const d = cleanDomain(pyStrOrEmpty(c));
    // your own domain in the competitor list would make the brand its own
    // competitor — share of voice would silently drift (services.py:583-584)
    if (!d || d === self || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
  }
  return out.slice(0, 10);
}

// ── prompts limit (services.py:596-623) ──────────────────────────────────────

/**
 * Port of the pure part of set_aeo_prompts_limit: None → null (plan cap);
 * otherwise int(prompts_limit) clamped to [5, cap]. Invalid integer → 400.
 * `raw === null|undefined` covers both an explicit null and a missing key
 * (payload.get → None).
 */
export function parsePromptsLimit(raw: unknown, cap: number): number | null {
  if (raw === null || raw === undefined) return null;
  const n = pyIntStrict(raw);
  return clampInt(n, 5, cap);
}

// ── point panel mutations (services.py:771-902) ──────────────────────────────

/** Args for a point panel mutation (the mutate route's body). */
export interface MutateArgs {
  texts?: unknown;
  text?: unknown;
  topic?: unknown;
  newTopic?: unknown;
}

/** services.py:767-768 — the allowed point-mutation actions. */
export const MUTATE_ACTIONS: ReadonlySet<string> = new Set([
  'add',
  'accept',
  'reject',
  'archive',
  'reactivate',
  'delete',
  'set_topic',
  'rename_topic',
  'clear_topic',
]);

/** Normalized action slug (Python's `str(action or "").strip()`). */
export function normalizeAction(action: unknown): string {
  return pyStrip(pyStrOrEmpty(action));
}

/** normPrompt on top of Python's `str(t or "")` — the dedup/match key for text. */
function keyOf(t: unknown): string {
  return normPrompt(pyStrOrEmpty(t));
}

/**
 * Key set from texts: `{_norm_prompt(t) for t in texts if str(t or "").strip()}`
 * (services.py:798-799).
 */
function textKeySet(texts: unknown): Set<string> {
  const set = new Set<string>();
  const list = Array.isArray(texts) ? texts : [];
  for (const t of list) {
    if (pyStrip(pyStrOrEmpty(t))) set.add(keyOf(t));
  }
  return set;
}

/**
 * Port of mutate_aeo_prompts's decision logic (services.py:794-902) WITHOUT the
 * DB: input is the tracker's raw prompt list + action + args + the effective
 * active `cap`. Returns a NEW canon panel (normalize_panel at the end, as in
 * Python). Throws:
 *   • 400 unknown action / text required / topic required / new_topic required /
 *     new_topic too long;
 *   • 409 {error:'quota', cap} when the active cap is exceeded.
 *
 * The money length caps ([$1]) are NOT applied here — the caller (capPanel)
 * applies them, so this function stays 1:1-parity with the extracted Python.
 */
export function mutatePanel(
  inputPanel: unknown,
  action: string,
  args: MutateArgs,
  cap: number,
): PanelEntry[] {
  const act = normalizeAction(action);
  if (!MUTATE_ACTIONS.has(act)) {
    throw new BadRequestException(`unknown action: ${act || '?'}`);
  }
  const keySet = textKeySet(args.texts);
  // Copy each record: point edits (pop/set status) must not mutate the
  // test's/caller's input (Python works on a fresh normalize_panel).
  let panel: PanelEntry[] = normalizePanel(inputPanel).map((p) => ({ ...p }));
  const byKey = new Map<string, PanelEntry>();
  for (const p of panel) byKey.set(normPrompt(p.prompt), p);
  const activeNow = panel.filter((p) => promptStatus(p) === 'active').length;
  const quota = (add: number): void => {
    if (activeNow + add > cap) {
      // services.py:824 — the 409 body is exactly {error:quota, cap} (the front end reads cap).
      throw new ConflictException({ error: 'quota', cap });
    }
  };
  const makeActive = (p: PanelEntry): void => {
    delete p.status;
    delete p.suggested_at;
  };

  if (act === 'add') {
    const t = pyStrip(pyStrOrEmpty(args.text));
    if (!t) throw new BadRequestException('text required');
    const existing = byKey.get(normPrompt(t));
    if (existing) {
      // already in the panel: make it active (reuse the row, don't spawn a dupe)
      if (promptStatus(existing) !== 'active') {
        quota(1);
        makeActive(existing);
      }
    } else {
      quota(1);
      panel.push(
        ...normalizePanel([{ prompt: t, topic: args.topic, source: 'manual' }]),
      );
    }
  } else if (act === 'accept') {
    const targets = panel.filter(
      (p) => keySet.has(normPrompt(p.prompt)) && promptStatus(p) === 'suggested',
    );
    quota(targets.length);
    for (const p of targets) makeActive(p);
  } else if (act === 'reject') {
    panel = panel.filter(
      (p) => !(keySet.has(normPrompt(p.prompt)) && promptStatus(p) === 'suggested'),
    );
  } else if (act === 'archive') {
    for (const p of panel) {
      if (keySet.has(normPrompt(p.prompt)) && promptStatus(p) === 'active') {
        p.status = 'inactive';
        delete p.suggested_at;
      }
    }
  } else if (act === 'reactivate') {
    const targets = panel.filter(
      (p) => keySet.has(normPrompt(p.prompt)) && promptStatus(p) === 'inactive',
    );
    quota(targets.length);
    for (const p of targets) delete p.status;
  } else if (act === 'delete') {
    panel = panel.filter(
      (p) => !(keySet.has(normPrompt(p.prompt)) && promptStatus(p) === 'inactive'),
    );
  } else if (act === 'set_topic') {
    // (str(topic).strip() or None) if topic else None
    const topicVal = pyTruthy(args.topic)
      ? pyStrip(pyStrOrEmpty(args.topic)) || null
      : null;
    for (const p of panel) {
      if (keySet.has(normPrompt(p.prompt))) p.topic = topicVal;
    }
  } else {
    // rename_topic | clear_topic
    const src = pyStrip(pyStrOrEmpty(args.topic)).toLowerCase();
    if (!src) throw new BadRequestException('topic required');
    let dst: string | null;
    if (act === 'rename_topic') {
      dst = pyStrip(pyStrOrEmpty(args.newTopic));
      if (!dst) throw new BadRequestException('new_topic required');
      if (cpLength(dst) > MAX_TOPIC_LEN) {
        throw new BadRequestException('new_topic too long');
      }
    } else {
      dst = null;
    }
    for (const p of panel) {
      if (pyStrip(pyStrOrEmpty(p.topic)).toLowerCase() === src) p.topic = dst;
    }
  }
  // final normalization (dedup/lean canon), as in services.py:898.
  return normalizePanel(panel);
}

// ── Prisma wrapper ───────────────────────────────────────────────────────────

/** setAeoPrompts response shape (services.py:530, the job_id key matches Python). */
export interface SetPromptsResult {
  id: number;
  prompts: PanelEntry[];
  job_id: number;
}

@Injectable()
export class AeoMutationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
    private readonly aeoRead: AeoReadService,
    private readonly dfs: DataForSeoClient,
    private readonly keysso: KeysSoClient,
  ) {}

  /** Loads the tracker and gates the mutation fail-closed (404 missing/other's, 403 viewer). */
  private async loadForMutate(
    trackerId: number,
    userId: number | null | undefined,
  ): Promise<AeoTracker> {
    const tracker = await this.prisma.aeoTracker.findUnique({
      where: { id: trackerId },
    });
    if (!tracker) throw new NotFoundException('tracker not found');
    await this.aeoRead.assertCanMutate(tracker.userId, userId);
    return tracker;
  }

  /**
   * Port of services._account_limits (services.py:39-57): (limits, title) or
   * null (no gating). null — no user / no users row / admin / plan unreadable.
   * Difference from effectivePlan: here an admin FALLS OUT of the gate (None,
   * None in Python), rather than degrading to scale.
   */
  private async accountLimits(
    ownerUserId: number | null | undefined,
  ): Promise<{ prompts: number; title: string } | null> {
    if (!ownerUserId) return null;
    let u: { isAdmin: boolean } | null;
    try {
      u = await this.prisma.user.findUnique({
        where: { id: ownerUserId },
        select: { isAdmin: true },
      });
    } catch {
      return null; // no users table → don't gate (Python except → None,None)
    }
    if (!u) return null; // no users row → plan unknown (effective_plan None)
    if (u.isAdmin) return null; // the pool doesn't limit admins
    try {
      const limits = await this.plans.resolveLimits(ownerUserId);
      return { prompts: limits.prompts, title: limits.title };
    } catch {
      return null;
    }
  }

  /**
   * Port of storage.count_active_prompts_for_user (storage.py:748-773): number
   * of ACTIVE prompts across the owner's trackers (a string/object with no
   * status, or status='active', counts as active), optionally excluding one
   * tracker. No table / broken jsonb → 0.
   */
  private async countActivePromptsForUser(
    ownerUserId: number | null | undefined,
    excludeTrackerId?: number,
  ): Promise<number> {
    if (!ownerUserId) return 0;
    const cond = excludeTrackerId != null ? ' AND t.id <> $2' : '';
    const params: unknown[] = [ownerUserId];
    if (excludeTrackerId != null) params.push(excludeTrackerId);
    try {
      const rows = await this.prisma.$queryRawUnsafe<Array<{ n: bigint | number | null }>>(
        `SELECT COALESCE(SUM(cnt),0) AS n FROM (` +
          `  SELECT (SELECT COUNT(*) FROM jsonb_array_elements(` +
          `     COALESCE(t.prompts,'[]'::jsonb)) e ` +
          `   WHERE jsonb_typeof(e) <> 'object' ` +
          `      OR COALESCE(e->>'status','active')='active') AS cnt ` +
          `  FROM aeo_trackers t WHERE t.user_id = $1${cond}` +
          `) s`,
        ...params,
      );
      const n = rows?.[0]?.n;
      return n == null ? 0 : Number(n);
    } catch {
      return 0;
    }
  }

  /**
   * Port of storage.prompt_pool_left (storage.py:791-815): remaining account
   * pool = plan+addon limit − active prompts in the OTHER trackers. null (no
   * limiting) — no user / no users row / admin / plan read failure.
   */
  private async promptPoolLeft(
    ownerUserId: number | null | undefined,
    excludeTrackerId?: number,
  ): Promise<number | null> {
    if (!ownerUserId) return null;
    let u: { isAdmin: boolean } | null;
    try {
      u = await this.prisma.user.findUnique({
        where: { id: ownerUserId },
        select: { isAdmin: true },
      });
    } catch {
      return null;
    }
    if (!u || u.isAdmin) return null; // no users row (plan unknown) / admin
    try {
      const limits = await this.plans.resolveLimits(ownerUserId);
      const used = await this.countActivePromptsForUser(ownerUserId, excludeTrackerId);
      return Math.max(0, limits.prompts - used);
    } catch {
      return null;
    }
  }

  /** The owner's plan prompt cap (prompt_count(effective_plan)). */
  private async promptCapFor(ownerUserId: number | null | undefined): Promise<number> {
    const [plan, setting] = await Promise.all([
      this.aeoRead.effectivePlan(ownerUserId),
      this.aeoRead.readAeoPromptsSetting(),
    ]);
    return promptCount(plan, setting);
  }

  /**
   * setAeoPrompts (services.py:492-530): PUT-replace the panel + a run.
   * Money fixes: [$1] length caps (sanitizePanel), [$2] overall record-count
   * cap (3×pool, counting suggested/inactive), [$3] run dedup (enqueueRun).
   */
  async setAeoPrompts(
    trackerId: number,
    prompts: unknown,
    userId: number | null | undefined,
  ): Promise<SetPromptsResult> {
    const tracker = await this.loadForMutate(trackerId, userId);
    const owner = tracker.userId;
    const panel = sanitizePanel(prompts); // [$1]
    if (!panel.length) throw new BadRequestException('prompts required');

    const limits = await this.accountLimits(owner);
    // [$2] overall record-count cap = 3×pool; pool = plan limit, and for the
    // unlimited case (admin/no user) — the plan's prompt_count (clamped ≤150 →
    // absolute cap 450). Otherwise thousands of status:suggested records bypass
    // the active quota.
    const pool = limits ? limits.prompts : await this.promptCapFor(owner);
    const maxRecords = PANEL_RECORDS_FACTOR * pool;
    if (panel.length > maxRecords) {
      throw new BadRequestException(
        `Too many prompts: at most ${maxRecords} records in the panel ` +
          `(including suggested and archived) — remove some`,
      );
    }
    // Active quota (services.py:514-523): active in the new panel + active in
    // the other trackers ≤ plan limit, otherwise 402.
    if (limits) {
      const cap = limits.prompts;
      const activeNew = panel.filter((p) => promptStatus(p) === 'active').length;
      const others = await this.countActivePromptsForUser(owner, trackerId);
      if (activeNew + others > cap) {
        throw new HttpException(
          `Limit of ${cap} prompts on the ${limits.title} plan — ` +
            `disable some or upgrade the plan`,
          402,
        );
      }
    }
    await this.prisma.aeoTracker.update({
      where: { id: trackerId },
      data: { prompts: panel as unknown as Prisma.InputJsonValue },
    });
    // [$3] enqueueRun dedupes the tracker's active job itself
    // (find_active_aeo_job): a repeated POST prompts doesn't spawn a second paid
    // run. user_id = the caller (as in services.py:528).
    const res = await enqueueRun({
      trackerId,
      domain: tracker.domain,
      userId: userId ?? null,
      source: 'manual',
    });
    return { id: trackerId, prompts: panel, job_id: res.scrapeJobId };
  }

  /**
   * refreshAeoTracker (services.py:533-554): a manual run of the prompts only.
   * Dedup [$3]: an active job on the tracker already exists → 409
   * {status:'running'} (we do NOT enqueue a second run). user_id = the owner
   * (services.py:552).
   */
  async refreshAeoTracker(
    trackerId: number,
    userId: number | null | undefined,
  ): Promise<{ status: 'queued'; job_id: number }> {
    const tracker = await this.loadForMutate(trackerId, userId);
    const res = await enqueueRun({
      trackerId,
      domain: tracker.domain,
      userId: tracker.userId,
      source: 'manual',
    });
    if (!res.enqueued) {
      // enqueued=false ⇒ an active job already existed, no new row was created.
      throw new ConflictException({ status: 'running' });
    }
    return { status: 'queued', job_id: res.scrapeJobId };
  }

  /** setAeoCompetitors (services.py:557-593). An empty list is a legitimate value. */
  async setAeoCompetitors(
    trackerId: number,
    competitors: unknown,
    userId: number | null | undefined,
  ): Promise<{ id: number; competitors: string[] }> {
    const tracker = await this.loadForMutate(trackerId, userId);
    const comps = normalizeCompetitors(competitors, tracker.domain);
    await this.prisma.aeoTracker.update({
      where: { id: trackerId },
      data: { competitors: comps as unknown as Prisma.InputJsonValue },
    });
    return { id: trackerId, competitors: comps };
  }

  /** setAeoPromptsLimit (services.py:596-623). None → plan cap; clamped to [5,cap]. */
  async setAeoPromptsLimit(
    trackerId: number,
    promptsLimit: unknown,
    userId: number | null | undefined,
  ): Promise<{ id: number; promptsLimit: number | null; promptCap: number }> {
    const tracker = await this.loadForMutate(trackerId, userId);
    const cap = await this.promptCapFor(tracker.userId);
    const val = parsePromptsLimit(promptsLimit, cap);
    await this.prisma.aeoTracker.update({
      where: { id: trackerId },
      data: { promptsLimit: val },
    });
    return { id: trackerId, promptsLimit: val, promptCap: cap };
  }

  /**
   * mutateAeoPrompts (services.py:771-902): point-in-time panel status changes.
   * Order matches Python — action is validated FIRST (400 before the owner
   * gate). cap = prompt_pool_left (remaining account pool), otherwise the
   * plan's prompt_count. The final panel goes through the money length caps
   * ([$1], capPanel).
   */
  async mutateAeoPrompts(
    trackerId: number,
    action: unknown,
    args: MutateArgs,
    userId: number | null | undefined,
  ): Promise<{ ok: true; panel: PanelEntry[] }> {
    const act = normalizeAction(action);
    if (!MUTATE_ACTIONS.has(act)) {
      throw new BadRequestException(`unknown action: ${act || '?'}`);
    }
    const tracker = await this.loadForMutate(trackerId, userId);
    const owner = tracker.userId;
    let cap = await this.promptCapFor(owner);
    const poolLeft = await this.promptPoolLeft(owner, trackerId);
    if (poolLeft !== null) cap = poolLeft;
    // mutatePanel = pure decision logic; capPanel = the money length cap [$1].
    const panel = capPanel(mutatePanel(tracker.prompts ?? [], act, args, cap));
    await this.prisma.aeoTracker.update({
      where: { id: trackerId },
      data: { prompts: panel as unknown as Prisma.InputJsonValue },
    });
    return { ok: true, panel };
  }

  /** `int(n)` for suggest: bool→0/1, number→truncation, string→strict integer; else 10. */
  private parseSuggestN(n: unknown): number {
    let v = 10;
    if (typeof n === 'boolean') v = n ? 1 : 0;
    else if (typeof n === 'number' && Number.isFinite(n)) v = Math.trunc(n);
    else if (typeof n === 'string' && /^[+-]?\d+$/.test(n.trim())) v = parseInt(n.trim(), 10);
    return Math.max(1, Math.min(20, v)); // clamp [1,20] (services.py:704)
  }

  /**
   * `domain_keywords_for` (aeo.py:1256-1292) — domain keywords from the source
   * that COVERS the country: RU → Keys.so, otherwise → DataForSEO Labs. The
   * off-industry filter (keywordsAboutSite) is applied on top. Source failure →
   * empty list (doesn't fail suggest).
   */
  private async domainKeywordsFor(
    domain: string,
    supported: boolean,
    context: GenerateContext | null,
  ): Promise<KeywordRow[]> {
    let rows: unknown[] | null = null;
    try {
      rows = supported
        ? await this.dfs.domainKeywords(domain, 80)
        : await this.keysso.domainKeywords(domain, 80);
    } catch {
      rows = null;
    }
    const filtered = ((rows || []) as KeywordRow[]).filter((r) => isDict(r) && pyTruthy(r.keyword));
    return keywordsAboutSite(filtered, context, domain);
  }

  /**
   * suggestAeoPrompts (port of services.py:688-764) — synchronously generate
   * LLM prompt suggestions and place them in the tracker's panel with
   * status=suggested (candidates, not yet run). The owner is gated by
   * loadForMutate (403 viewer, 404 other's/missing). n is clamped to [1,20]
   * (default 10); dedup by normalized text against the WHOLE panel. Candidate
   * language = the run's language (aeo_trackers.lang), otherwise by domain
   * (RU/EN). Keywords come from the request body, otherwise from the country's
   * source's domain keywords. Generation is best-effort: its failure → an empty
   * set of suggestions, not a 500.
   */
  async suggestAeoPrompts(
    trackerId: number,
    n: unknown,
    keywords: unknown,
    userId: number | null | undefined,
  ): Promise<{ suggested: PanelEntry[] }> {
    const nn = this.parseSuggestN(n);
    const tracker = await this.loadForMutate(trackerId, userId);
    const domain = tracker.domain;
    const existing = normalizePanel(tracker.prompts ?? []);
    const competitors = Array.isArray(tracker.competitors) ? (tracker.competitors as unknown[]) : [];
    const trackerLang = normalizeProjectLang(tracker.lang);
    const supported = supportsDataForSeo(domain);
    // Candidate language = the run's language (from homepage content),
    // otherwise by domain — otherwise the panel drifts: the run in English,
    // suggestions in Russian.
    const lang = trackerLang ?? (supported ? 'en' : 'ru');

    const exclude = new Set(existing.map((p) => normPrompt(p.prompt)));

    // Crawling the homepage feeds the OFF-INDUSTRY filter (_keywords_about_site)
    // and the generator's product brief. Port of services.py:729-731: best-
    // effort, any failure/private host → null (the filter becomes inert, like
    // the context=None branch in Python) — suggest doesn't fail, it just loses
    // grounding.
    const context: GenerateContext | null = await crawlHomepage(domain);

    const kws: KeywordRow[] =
      Array.isArray(keywords) && keywords.length
        ? (keywords as KeywordRow[])
        : await this.domainKeywordsFor(domain, supported, context);

    // request extra headroom for dedup against the already-existing panel.
    const want = Math.max(5, Math.min(80, nn + existing.length));

    const deps: GenerateDeps = {
      ask: askFlashJson,
      keywordSuggestions: supported
        ? (seed, limit) => this.dfs.keywordSuggestions(seed, limit)
        : undefined,
    };

    let fresh: PromptRow[] = [];
    try {
      fresh = await generatePrompts(domain, kws, { n: want, lang, context, competitors, deps });
    } catch {
      fresh = []; // best-effort: an LLM/SERP failure doesn't fail the request
    }

    const now = new Date().toISOString();
    const suggested: PanelEntry[] = [];
    for (const p of dropFallback(normalizePanel(fresh, { defaultSource: 'generated' }))) {
      const k = normPrompt(p.prompt);
      if (exclude.has(k)) continue;
      exclude.add(k);
      suggested.push({ ...p, status: 'suggested', suggested_at: now });
      if (suggested.length >= nn) break;
    }

    if (suggested.length) {
      const panel = normalizePanel([...existing, ...suggested]);
      await this.prisma.aeoTracker.update({
        where: { id: trackerId },
        data: { prompts: panel as unknown as Prisma.InputJsonValue },
      });
    }
    // return the canon of the new candidates (with status/suggested_at).
    return { suggested: normalizePanel(suggested) };
  }
}
