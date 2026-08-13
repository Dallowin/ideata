import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * NOTE: the canonical plan config lives in the scrapper's `core/plans.py`
 * (`PLAN_DEFAULTS`). This is a manual COPY of it for the NestJS API — both
 * systems sit on the same Postgres and read the same partial override from
 * the `plans` table. Keep value changes in sync with core/plans.py.
 *
 * Existing slugs, no migration: free (Free), lite (Старт), pro (Бестселлер),
 * scale (Бизнес).
 */
export interface PlanRun {
  micro: string;
  mid: string;
  full_per_month: number;
  yandex_per_month: number;
}
export interface PlanBlog {
  enabled: boolean;
  posts_per_day: number;
  opus: boolean;
}
export interface PlanReports {
  email: string | null;
  telegram: boolean;
}
export interface PlanConfig {
  title: string;
  price_month: number;
  /** Credit pool per calendar month: a single currency for on-demand LLM
   *  actions (images, posts, assistant). Monitoring is NOT included here. */
  credits_pool: number;
  prompts_pool: number;
  brands_max: number;
  run: PlanRun;
  blog: PlanBlog;
  export: string[];
  reports: PlanReports;
  seats: number | null;
  api_access: boolean;
}

export const PLAN_DEFAULTS: Record<string, PlanConfig> = {
  free: {
    title: 'Free',
    price_month: 0,
    credits_pool: 100,
    prompts_pool: 10,
    brands_max: 1,
    run: { micro: 'once', mid: 'once', full_per_month: 0, yandex_per_month: 0 },
    // The blog writer is open to everyone: the real ceiling is credits
    // (assertEnough in runs.controller before a run starts) — posts_per_day
    // never comes into play. The value stays in sync with the core/plans.py
    // mirror and with the landing page, where free already promises
    // "blog writer — {credits} credits to try".
    blog: { enabled: true, posts_per_day: 20, opus: false },
    export: [],
    reports: { email: null, telegram: false },
    seats: 1,
    api_access: false,
  },
  lite: {
    title: 'Старт',
    price_month: 1990,
    credits_pool: 400,
    prompts_pool: 25,
    brands_max: 1,
    run: { micro: '2w', mid: '2w', full_per_month: 1, yandex_per_month: 0 },
    blog: { enabled: false, posts_per_day: 0, opus: false },
    export: ['csv'],
    reports: { email: 'weekly', telegram: false },
    seats: 1,
    api_access: false,
  },
  pro: {
    title: 'Бестселлер',
    price_month: 7990,
    credits_pool: 1500,
    prompts_pool: 50,
    brands_max: 2,
    run: { micro: 'daily', mid: '3w', full_per_month: 2, yandex_per_month: 1 },
    blog: { enabled: true, posts_per_day: 2, opus: false },
    export: ['csv', 'xlsx'],
    reports: { email: 'weekly', telegram: true },
    seats: null,
    api_access: false,
  },
  scale: {
    title: 'Бизнес',
    price_month: 19990,
    credits_pool: 3000,
    prompts_pool: 125,
    brands_max: 5,
    run: { micro: 'daily', mid: '3w', full_per_month: 4, yandex_per_month: 2 },
    blog: { enabled: true, posts_per_day: 3, opus: true },
    export: ['csv', 'xlsx'],
    reports: { email: 'weekly', telegram: true },
    seats: null,
    api_access: true,
  },
};

export const PLAN_ORDER = ['free', 'lite', 'pro', 'scale'] as const;
export const KNOWN_PLANS = new Set(Object.keys(PLAN_DEFAULTS));
export const DEFAULT_PLAN = 'free';

export interface UserPlanRow {
  /** Effective (degraded) slug: an expired subscription → free. */
  plan: string;
  /** Raw slug from user_plans (before degradation). */
  rawPlan: string;
  status: string;
  expiresAt: Date | null;
  addons: Record<string, any>;
  freeRunAt: Date | null;
}

export interface PlanLimits {
  /** Effective plan slug (after degrading expired ones to free). */
  plan: string;
  /** Human-readable plan name (for limit-error/upsell text). */
  title: string;
  prompts: number;
  brands: number;
  /** credit pool per month (balance is computed by CreditsService from the ledger) */
  credits: number;
  postsPerDay: number;
  blogEnabled: boolean;
  opus: boolean;
  export: string[];
  reports: PlanReports;
  seats: number | null;
  apiAccess: boolean;
  run: PlanRun;
}

function isPlainObject(v: any): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Recursively merges override into a COPY of base (nested dicts are merged,
 *  arrays/scalars are replaced). Mirrors core/plans.py deep_merge. */
export function deepMerge<T extends Record<string, any>>(
  base: T,
  override: Record<string, any> | null | undefined,
): T {
  const out: Record<string, any> = structuredClone(base);
  for (const [k, v] of Object.entries(override || {})) {
    if (isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = structuredClone(v);
    }
  }
  return out as T;
}

function canonSlug(slug: string | null | undefined): string {
  const s = (slug || '').trim().toLowerCase();
  return KNOWN_PLANS.has(s) ? s : DEFAULT_PLAN;
}

function toInt(v: any, d = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

@Injectable()
export class PlanService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * User plan row with the same degradation as the scrapper's get_user_plan:
   * a plan is only effective with status='active' and a non-expired
   * expires_at, otherwise 'free'. No row / DB unavailable → safe free/active
   * default.
   */
  async getUserPlanRow(userId: number | undefined): Promise<UserPlanRow> {
    const fallback: UserPlanRow = {
      plan: 'free',
      rawPlan: 'free',
      status: 'active',
      expiresAt: null,
      addons: {},
      freeRunAt: null,
    };
    if (!userId) return fallback;
    try {
      const rows = await this.prisma.$queryRawUnsafe<
        {
          plan: string | null;
          status: string | null;
          expires_at: Date | null;
          addons: any;
          free_run_at: Date | null;
        }[]
      >(
        `SELECT plan, status, expires_at, addons, free_run_at
           FROM user_plans WHERE user_id = $1`,
        userId,
      );
      const r = rows?.[0];
      if (!r) return fallback;
      const rawPlan = (r.plan || 'free').toLowerCase();
      const status = (r.status || 'active').toLowerCase();
      const expiresAt = r.expires_at ? new Date(r.expires_at) : null;
      const expired = expiresAt !== null && expiresAt.getTime() <= Date.now();
      const plan = status === 'active' && !expired ? rawPlan : 'free';
      const addons = isPlainObject(r.addons) ? r.addons : {};
      return {
        plan,
        rawPlan,
        status,
        expiresAt,
        addons,
        freeRunAt: r.free_run_at ? new Date(r.free_run_at) : null,
      };
    } catch {
      return fallback;
    }
  }

  /**
   * Effective plan config: PLAN_DEFAULTS[slug] ⊕ partial DB override from the
   * `plans` table (deep-merge). Unknown slug / no table / error → pure
   * defaults (free for an unknown slug).
   */
  async getPlanConfig(slug: string | null | undefined): Promise<PlanConfig> {
    const canon = canonSlug(slug);
    const base = PLAN_DEFAULTS[canon];
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ config: any }[]>(
        `SELECT config FROM plans WHERE slug = $1`,
        canon,
      );
      const cfg = rows?.[0]?.config;
      const override = isPlainObject(cfg) ? cfg : null;
      return override ? deepMerge(base, override) : structuredClone(base);
    } catch {
      return structuredClone(base);
    }
  }

  /**
   * Effective user limits (effective plan + addons from user_plans.addons).
   * Mirrors core/plans.py resolve_limits.
   */
  async resolveLimits(userId: number | undefined): Promise<PlanLimits> {
    const row = await this.getUserPlanRow(userId);
    const cfg = await this.getPlanConfig(row.plan);
    const addons = row.addons || {};

    const basePosts = toInt(cfg.blog?.posts_per_day, 0);
    let posts = basePosts + toInt(addons.extra_posts, 0);
    let blogEnabled = !!cfg.blog?.enabled;
    if (addons.blog_addon && basePosts === 0) {
      posts = Math.max(posts, 1);
      blogEnabled = true;
    }

    return {
      plan: row.plan,
      title: cfg.title,
      prompts: toInt(cfg.prompts_pool, 0) + toInt(addons.extra_prompts, 0),
      brands: toInt(cfg.brands_max, 1) + toInt(addons.extra_brands, 0),
      credits: toInt(cfg.credits_pool, 0) + toInt(addons.extra_credits, 0),
      postsPerDay: posts,
      blogEnabled,
      opus: !!cfg.blog?.opus,
      export: Array.isArray(cfg.export) ? [...cfg.export] : [],
      reports: { ...cfg.reports },
      seats: cfg.seats ?? null,
      apiAccess: !!cfg.api_access,
      run: { ...cfg.run },
    };
  }
}
