/**
 * Credits — a single currency for on-demand LLM actions (images, posts, the
 * assistant). Monitoring is NOT included here: it has predictable cost and
 * its own plan limits.
 *
 * Storage model: only the `credit_ledger` journal (amount<0 — charge, >0 —
 * grant). The balance is NOT stored as a separate number — it's computed:
 * the plan's monthly pool + this month's grants − this month's charges. This
 * way the journal and the balance never drift apart, and "expiring at
 * month's end" happens automatically.
 *
 * 1 credit = 1 ₽ of the model's OFFICIAL cost (sold for 2 ₽). Official,
 * specifically: kie sells Claude at 30-40% of the vendor's price, and that
 * difference is our margin, not a discount for the client. What we actually
 * pay the provider lives separately, in llm_usage.cost_rub (see
 * official-price.ts).
 */
import { HttpException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlanService } from '../plans/plans.service';
import { officialRub, officialUsd } from './official-price';

/** Rate for converting dollar model prices to rubles (= credits). */
export const USD_RUB = 90;

/** $ per action → credits (minimum 1, rounded up to a whole number). */
export function creditsForUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd <= 0) return 1;
  return Math.max(1, Math.ceil(usd * USD_RUB));
}

/**
 * Markup on image generation.
 *
 * Text credits are computed from the vendor's OFFICIAL price, and we pay kie
 * roughly a third of that — meaning a credit spent on text costs us ~0.3 ₽.
 * Images have no official price in the catalog, only our purchase price per
 * image, and the price used to be set directly from that: an image credit
 * cost us 0.9 ₽, three times more. The same pool meant something different
 * depending on what it was spent on.
 *
 * The multiplier evens out the scale: an image costs the client more
 * credits, but a credit costs us roughly the same everywhere.
 */
export const IMAGE_MARKUP = 3;

/** Image price in credits, based on our purchase price per image. */
export function creditsForImageUsd(usd: number): number {
  return creditsForUsd(usd * IMAGE_MARKUP);
}

/**
 * Typical token spend for an article (sum of pipeline stages: research →
 * draft → gates). Needed to show the price BEFORE starting a run and to
 * avoid letting generation start with a known-empty balance. The actual
 * charge is computed from llm_usage after the run.
 */
export const POST_TOKENS = { in: 90_000, out: 25_000 };

/**
 * Typical spend for a SINGLE question to the assistant: brand snapshot +
 * message history on input, a short answer on output (maxTokens there is
 * 700). Needed to avoid letting a call start with an empty balance; the
 * actual charge is computed from the returned call's price.
 */
export const ASK_TOKENS = { in: 8_000, out: 700 };

export interface CreditBalance {
  /** monthly plan pool */
  pool: number;
  /** purchased/granted this month */
  granted: number;
  /** spent this month */
  spent: number;
  /** what's left */
  balance: number;
  plan: string;
  /** accounting unavailable (no table/DB) — gate is not applied, to avoid blocking the product */
  degraded: boolean;
}

@Injectable()
export class CreditsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly plans: PlanService,
  ) {}

  /**
   * Balance. On paid plans the pool renews every calendar month; on free
   * it's ONE-TIME — the landing page promises "100 credits, once", not
   * monthly. Implemented via the journal window: free counts charges over
   * all time, paid plans count the current month. Otherwise a free account
   * would burn 100 ₽ worth of cost every month forever. Never throws.
   */
  async balance(userId: number): Promise<CreditBalance> {
    // OSS: billing/credits removed — accounting is "not set up" (degraded), gate not applied.
    const limits = await this.plans.resolveLimits(userId);
    return { pool: 0, granted: 0, spent: 0, balance: 0, plan: limits.plan, degraded: true };
  }

  /**
   * Charge credits. Throws 402 if the balance is insufficient.
   * Call order: assert first (before expensive generation), then charge once
   * it actually succeeds — otherwise we'd charge for failed provider responses.
   */
  async assertEnough(userId: number, credits: number): Promise<CreditBalance> {
    const b = await this.balance(userId);
    if (b.degraded) return b; // accounting not set up — don't block
    if (b.balance < credits) {
      throw new HttpException(
        `Не хватает кредитов: нужно ${credits}, на балансе ${b.balance}. Пополните пакет или выберите модель дешевле.`,
        402,
      );
    }
    return b;
  }

  /** Record a movement. Never throws: the journal must not fail a completed action. */
  async record(
    userId: number,
    amount: number,
    reason: string,
    model?: string | null,
    meta?: Record<string, unknown> | null,
  ): Promise<void> {
    try {
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO credit_ledger (user_id, amount, reason, model, meta)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        userId, Math.trunc(amount), reason, model || null, meta ? JSON.stringify(meta) : null,
      );
    } catch { /* no table / DB unavailable — don't fail the action */ }
  }

  /**
   * Estimated cost of a single article in credits for model `model`.
   * Price is OFFICIAL (see official-price): credits are computed from the
   * vendor price, not from what we actually pay kie. A model with no price →
   * a conservative 15.
   */
  async estimatePost(model: string | null | undefined): Promise<number> {
    const p = await officialUsd(String(model || ''));
    if (!p) return 15;
    const usd = (POST_TOKENS.in / 1e6) * p.inUsd + (POST_TOKENS.out / 1e6) * p.outUsd;
    return creditsForUsd(usd);
  }

  /** Charge for a successful action (credits > 0 → recorded as negative). */
  charge(userId: number, credits: number, reason: string, model?: string | null, meta?: Record<string, unknown> | null) {
    return this.record(userId, -Math.abs(credits), reason, model, meta);
  }

  /** Refund reserved credits (the action didn't go through). */
  refund(userId: number, credits: number, reason: string, model?: string | null, meta?: Record<string, unknown> | null) {
    return this.record(userId, Math.abs(credits), reason, model, { ...(meta || {}), refund: true });
  }

  /**
   * ATOMIC reservation: balance check and charge in ONE transaction under a
   * per-user advisory lock.
   *
   * Why separate from assertEnough+charge: generation happens between them,
   * and two parallel requests reading the same balance would both pass the
   * gate, both charge, and the balance would go negative (classic TOCTOU).
   * The lock is taken by user_id and held until the transaction ends, so a
   * competing call sees the already-charged amount.
   *
   * Reserved BEFORE the expensive call, and refunded on failure — otherwise
   * atomicity isn't achievable: a transaction can't stay open for the entire
   * duration of generation.
   *
   * @returns how much was reserved (0 — accounting unavailable, gate not applied)
   * @throws 402 if the balance is insufficient
   */
  async reserve(
    userId: number,
    credits: number,
    reason: string,
    model?: string | null,
    meta?: Record<string, unknown> | null,
  ): Promise<number> {
    // OSS: no credit gate — always allowed, nothing is reserved.
    void userId; void reason; void model; void meta;
    return credits;
  }

  /**
   * Estimate for a single question to the assistant. A model with no price
   * in the catalog → 2 credits (a cheap question on a fast model costs
   * pennies, but the gate needs to know something).
   */
  async estimateAsk(model: string | null | undefined): Promise<number> {
    const p = await officialUsd(String(model || ''));
    if (!p) return 2;
    const usd = (ASK_TOKENS.in / 1e6) * p.inUsd + (ASK_TOKENS.out / 1e6) * p.outUsd;
    return creditsForUsd(usd);
  }

  /**
   * Charge at the OFFICIAL cost of the call in rubles. Rounded up to a whole
   * credit (minimum 1) — same as posts and images: the journal is
   * integer-only, and there's no point splitting kopecks at a sale price of
   * 2 ₽ per credit.
   * @returns how much was charged (0 — price unknown, nothing to charge)
   */
  async chargeRub(
    userId: number,
    rub: number | null | undefined,
    reason: string,
    model?: string | null,
    meta?: Record<string, unknown> | null,
  ): Promise<number> {
    const v = Number(rub || 0);
    if (!(v > 0)) return 0;
    const credits = Math.max(1, Math.ceil(v));
    await this.charge(userId, credits, reason, model, { ...(meta || {}), rub: Math.round(v * 100) / 100 });
    return credits;
  }

  /**
   * Charge for a call by token count: the price is official, regardless of
   * which provider the call actually went through.
   */
  async chargeCall(
    userId: number,
    model: string,
    tokensIn: number | null | undefined,
    tokensOut: number | null | undefined,
    reason: string,
    meta?: Record<string, unknown> | null,
  ): Promise<number> {
    const rub = await officialRub(model, tokensIn, tokensOut);
    return this.chargeRub(userId, rub, reason, model, meta);
  }
}
