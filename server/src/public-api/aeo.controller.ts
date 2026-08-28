import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UnauthorizedException,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { LoginGuard, PaidPlanGuard } from '../auth/login.guard';
import { CurrentUser } from '../auth/current-user.decorator';
import type { SessionUser } from '../auth/auth.service';
import { PrismaService } from '../prisma/prisma.service';
import { cleanDomain } from './clean-domain';
import { HttpDetailFilter } from '../common/http-detail.filter';
import { AeoReadService } from '../aeo/aeo-read.service';
import { AeoMutationsService } from '../aeo/mutations';
import { AeoTrackerProvisioningService } from '../aeo/tracker-provisioning.service';

// UA classifier → (bot, vendor): substring match on the UA (lowercased). The list
// grows without redeploying the client-side collector — classification runs server-side.
// A copy of the scrapper's _BOT_UA_MAP; once /scrape/* is retired, this stays the only one.
const BOT_UA_MAP: Array<[string, [string, string]]> = [
  ['gptbot', ['GPTBot', 'OpenAI']],
  ['oai-searchbot', ['OAI-SearchBot', 'OpenAI']],
  ['chatgpt-user', ['ChatGPT-User', 'OpenAI']],
  ['claudebot', ['ClaudeBot', 'Anthropic']],
  ['claude-user', ['Claude-User', 'Anthropic']],
  ['claude-searchbot', ['Claude-SearchBot', 'Anthropic']],
  ['anthropic-ai', ['anthropic-ai', 'Anthropic']],
  ['perplexitybot', ['PerplexityBot', 'Perplexity']],
  ['perplexity-user', ['Perplexity-User', 'Perplexity']],
  ['google-extended', ['Google-Extended', 'Google']],
  ['googleother', ['GoogleOther', 'Google']],
  ['bingbot', ['Bingbot', 'Microsoft']],
  ['applebot-extended', ['Applebot-Extended', 'Apple']],
  ['applebot', ['Applebot', 'Apple']],
  ['amazonbot', ['Amazonbot', 'Amazon']],
  ['meta-externalagent', ['Meta-ExternalAgent', 'Meta']],
  ['facebookbot', ['FacebookBot', 'Meta']],
  ['bytespider', ['Bytespider', 'ByteDance']],
  ['cohere-training-data-crawler', ['Cohere-Crawler', 'Cohere']],
  ['cohere-ai', ['cohere-ai', 'Cohere']],
  ['duckassistbot', ['DuckAssistBot', 'DuckDuckGo']],
  ['youbot', ['YouBot', 'You.com']],
  ['diffbot', ['Diffbot', 'Diffbot']],
  ['yandexadditional', ['YandexAdditional', 'Yandex']],
];

function classifyBot(ua: string): [string, string] | null {
  const s = String(ua || '').toLowerCase();
  if (!s) return null;
  for (const [needle, out] of BOT_UA_MAP) {
    if (s.includes(needle)) return out;
  }
  return null;
}

// During the transition period, BOTH scrapper and api issue/verify ingest tokens,
// so BOT_INGEST_SECRET must be set explicitly and identically on both services:
// their fallbacks differ (scrapper falls back to its SESSION_SECRET, here to ours),
// and on the fallback the tokens would silently diverge.
function botIngestSecret(): string {
  return (
    process.env.BOT_INGEST_SECRET ||
    process.env.SESSION_SECRET ||
    'insecure-change-me'
  );
}

function botTokenFor(userId: number): string {
  const sig = createHmac('sha256', botIngestSecret())
    .update(`botingest:${userId}`)
    .digest('hex')
    .slice(0, 16);
  return `bt_${userId}_${sig}`;
}

function userFromBotToken(token: string | undefined): number | null {
  const t = String(token || '').trim();
  if (!t.startsWith('bt_')) return null;
  const parts = t.split('_');
  if (parts.length < 3) return null;
  const uid = Number(parts[1]);
  const sig = parts.slice(2).join('_');
  if (!Number.isInteger(uid) || uid <= 0) return null;
  const expected = botTokenFor(uid).split('_').slice(2).join('_');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return uid;
}

/**
 * AEO monitoring, the read half + bot hit ingestion — a port of
 * api_public_aeo_list / api_public_bots / api_public_bot_token /
 * api_public_bot_hit from FastAPI. Tracker aggregates (GET aeo/{id}) and all
 * runs remain the scrapper's job until the internal channel: they call
 * aggregate_monitoring/enqueue in the Python core.
 */
@UseFilters(HttpDetailFilter)
@Controller('api/public/aeo')
export class AeoController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aeoRead: AeoReadService,
    private readonly mutations: AeoMutationsService,
    private readonly trackerProvisioning: AeoTrackerProvisioningService,
  ) {}

  /**
   * FAIL-CLOSED gate for tracker MUTATION, modeled on Python's
   * services._assert_can_mutate (services.py:94-105): owner/editor pass; viewer →
   * 403; foreign / no owner / no caller → 404 (don't leak existence). Python calls
   * set_aeo_prompts with check_owner=False — the whole gate lives on Nest.
   *
   * The old check (`if tracker.userId && userId && tracker.userId !== userId
   * → 403`, :121) was leaky: it let anyone through to a tracker WITHOUT an owner,
   * skipped the check when userId was missing, threw 403 (existence leak) AND CUT OFF
   * team access. Reads (GET :id) are gated by AeoReadService.getDashboard (assertCanRead).
   */
  private async assertCanMutate(trackerId: number, userId: number | undefined) {
    const tracker = await this.prisma.aeoTracker.findUnique({
      where: { id: trackerId },
    });
    if (!tracker) throw new NotFoundException('tracker not found');
    await this.aeoRead.assertCanMutate(tracker.userId, userId);
    return tracker;
  }

  @Post('track')
  @UseGuards(PaidPlanGuard)
  async track(
    @Body()
    payload: {
      domain?: string;
      competitors?: string[];
      analysis_id?: number;
    },
    @CurrentUser() user: SessionUser,
  ) {
    return this.trackerProvisioning.provisionForUser({
      userId: user.i,
      domain: payload?.domain,
      competitors: payload?.competitors,
      analysisId: payload?.analysis_id ?? null,
    });
  }

  @Get()
  @UseGuards(LoginGuard)
  async list(@CurrentUser() user: SessionUser) {
    const rows = await this.prisma.aeoTracker.findMany({
      where: { userId: user.i },
      // FastAPI contract: fresh runs on top, trackers without runs go last.
      orderBy: [{ lastRunAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }],
    });
    return {
      items: rows.map((r) => ({
        id: r.id,
        domain: r.domain,
        competitors: (r.competitors as unknown[]) || [],
        geo: r.geo,
        active: !!r.active,
        last_run_at: r.lastRunAt,
      })),
      total: rows.length,
    };
  }

  @Get('bot-token')
  @UseGuards(LoginGuard)
  botToken(@CurrentUser() user: SessionUser) {
    if (!user.i) {
      throw new BadRequestException('could not identify the user');
    }
    return {
      token: botTokenFor(user.i),
      ingestUrl: 'https://ideata.io/scrape/aeo/bot-hit',
    };
  }

  @Post('bot-hit')
  async botHit(
    @Body() payload: Record<string, unknown> | undefined,
    @Headers('x-ingest-token') ingestToken: string | undefined,
  ) {
    const uid = userFromBotToken(ingestToken);
    if (!uid) throw new UnauthorizedException('Invalid ingest token');
    const domain = cleanDomain(String(payload?.domain ?? ''));
    if (!domain || !domain.includes('.')) {
      throw new BadRequestException('domain required');
    }
    const countsRaw = payload?.counts;
    const uasRaw = payload?.uas;
    const counts =
      countsRaw && typeof countsRaw === 'object' && !Array.isArray(countsRaw)
        ? (countsRaw as Record<string, unknown>)
        : {};
    const uas = Array.isArray(uasRaw) ? uasRaw : [];

    // (bot, vendor) → [hits, sampleUa] — same as agg in the FastAPI version
    const agg = new Map<string, [string, string, number, string | null]>();
    let accepted = 0;
    let dropped = 0;
    for (const [name, nRaw] of Object.entries(counts).slice(0, 60)) {
      const n = Number(nRaw);
      if (!Number.isFinite(n) || n <= 0) continue;
      const hit = classifyBot(name);
      const [bot, vendor] = hit ?? [String(name).slice(0, 40), ''];
      const key = `${bot} ${vendor}`;
      const prev = agg.get(key);
      agg.set(key, [
        bot,
        vendor,
        (prev?.[2] ?? 0) + Math.trunc(n),
        prev?.[3] ?? null,
      ]);
      accepted += Math.trunc(n);
    }
    for (const ua of uas.slice(0, 10000)) {
      const hit = classifyBot(String(ua));
      if (!hit) {
        dropped += 1;
        continue;
      }
      const [bot, vendor] = hit;
      const key = `${bot} ${vendor}`;
      const prev = agg.get(key);
      agg.set(key, [
        bot,
        vendor,
        (prev?.[2] ?? 0) + 1,
        String(ua).slice(0, 300),
      ]);
      accepted += 1;
    }
    if (agg.size === 0) return { ok: true, accepted: 0, dropped };

    const day = new Date(new Date().toISOString().slice(0, 10)); // UTC day
    for (const [, [bot, vendor, hits, sample]] of agg) {
      await this.prisma.botHit.upsert({
        where: {
          userId_domain_bot_day: { userId: uid, domain, bot, day },
        },
        create: {
          userId: uid,
          domain,
          bot,
          vendor,
          day,
          hits,
          lastUa: sample,
        },
        update: {
          hits: { increment: hits },
          vendor,
          ...(sample ? { lastUa: sample } : {}),
          updatedAt: new Date(),
        },
      });
    }
    return { ok: true, accepted, dropped, bots: agg.size };
  }

  @Get('bots')
  @UseGuards(LoginGuard)
  async bots(
    @CurrentUser() user: SessionUser,
    @Query('domain') domainQ = '',
    @Query('weeks') weeksQ = '8',
  ) {
    const dom = cleanDomain(domainQ);
    if (!user.i || !dom) {
      return { hasData: false, domain: dom, bots: [], series: [], total: 0 };
    }
    const weeks = Math.max(1, Math.min(Number(weeksQ) || 8, 26));
    const since = new Date(Date.now() - weeks * 7 * 86400_000);

    const byBot = await this.prisma.botHit.groupBy({
      by: ['bot', 'vendor'],
      where: { userId: user.i, domain: dom, day: { gte: since } },
      _sum: { hits: true },
      _max: { day: true },
      orderBy: { _sum: { hits: 'desc' } },
    });
    const byDay = await this.prisma.botHit.groupBy({
      by: ['day'],
      where: { userId: user.i, domain: dom, day: { gte: since } },
      _sum: { hits: true },
    });

    const bots = byBot.map((r) => ({
      name: r.bot,
      vendor: r.vendor || '',
      visits: r._sum.hits ?? 0,
      lastSeen: r._max.day ? r._max.day.toISOString().slice(0, 10) : null,
    }));
    const dayMap = new Map(
      byDay.map((r) => [r.day.toISOString().slice(0, 10), r._sum.hits ?? 0]),
    );
    const series: Array<{ label: string; hits: number }> = [];
    const today = new Date(new Date().toISOString().slice(0, 10));
    for (let w = weeks; w > 0; w--) {
      const wkStart = new Date(today.getTime() - w * 7 * 86400_000)
        .toISOString()
        .slice(0, 10);
      const wkEnd = new Date(today.getTime() - (w - 1) * 7 * 86400_000)
        .toISOString()
        .slice(0, 10);
      let wkHits = 0;
      for (const [d, v] of dayMap) if (d >= wkStart && d < wkEnd) wkHits += v;
      series.push({
        label: w === 1 ? 'сейчас' : `−${w - 1} нед`,
        hits: wkHits,
      });
    }
    const total = bots.reduce((s, b) => s + b.visits, 0);
    return { hasData: total > 0, domain: dom, bots, series, total, weeks };
  }

  // ':id' routes are declared AFTER the static ones (bots/bot-token/bot-hit),
  // so they don't shadow them. Reading aggregates goes through AeoReadService.getDashboard:
  // a single fail-closed owner gate + AEO_READ_MODE mode (shadow by default:
  // computes both native+Python, diffs them, logs, and returns the Python result).
  @Get(':id')
  @UseGuards(LoginGuard)
  async get(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: SessionUser,
    @Query('weeks') weeksQ = '8',
  ) {
    const weeks = Math.max(1, Math.min(Number(weeksQ) || 8, 26));
    return this.aeoRead.getDashboard(id, weeks, user.i);
  }

  // ── Tracker mutations: NATIVE via AeoMutationsService (Prisma). Owner gate,
  // quotas and money caps live in the service. nginx still routes POST to Python
  // (flip later), so these handlers are currently "warmed up but idle." Only what's
  // NOT ported is proxied (suggest — external LLM/SERP).

  /**
   * Curate the prompt panel (PUT semantics). Login + owner (checked in the service).
   * → {id, prompts, job_id}. 400 prompts required / too many entries,
   * 402 plan limit, 403 viewer, 404 foreign/not found. Port of set_aeo_prompts.
   */
  @Post(':id/prompts')
  @UseGuards(LoginGuard)
  setPrompts(
    @Param('id', ParseIntPipe) id: number,
    @Body() payload: { prompts?: unknown },
    @CurrentUser() user: SessionUser,
  ) {
    return this.mutations.setAeoPrompts(id, payload?.prompts, user.i);
  }

  /**
   * Manual run of just the tracker's prompts. Paywall (PaidPlanGuard → 402) +
   * owner. 202 {status:queued, job_id} | 409 {status:running} if a run is already
   * in progress | 404. Port of refresh_aeo_tracker.
   */
  @Post(':id/refresh')
  @HttpCode(202)
  @UseGuards(PaidPlanGuard)
  refresh(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: SessionUser,
  ) {
    return this.mutations.refreshAeoTracker(id, user.i);
  }

  /**
   * LLM-generated prompt suggestions for the panel (status=suggested) — NATIVE via
   * AeoMutationsService (a port of services.suggest_aeo_prompts): generation on top
   * of generatePrompts + a write with status=suggested, deduped against the whole panel.
   * Paywall (PaidPlanGuard → 402) + owner (the owner gate assertCanMutate lives inside
   * the service: 403 viewer, 404 foreign/not found). → {suggested:[...]}.
   */
  @Post(':id/prompts/suggest')
  @UseGuards(PaidPlanGuard)
  suggest(
    @Param('id', ParseIntPipe) id: number,
    @Body() payload: { n?: number; keywords?: unknown } | undefined,
    @CurrentUser() user: SessionUser,
  ) {
    return this.mutations.suggestAeoPrompts(
      id,
      payload?.n,
      payload?.keywords,
      user.i,
    );
  }

  /**
   * Targeted panel mutations (lifecycle statuses). Paywall + owner.
   * → {ok:true, panel:[...]} | 409 {error:quota, cap:N} | 400 unknown action /
   * text|topic|new_topic required | 404. Port of mutate_aeo_prompts.
   */
  @Post(':id/prompts/mutate')
  @UseGuards(PaidPlanGuard)
  mutate(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    payload:
      | {
          action?: unknown;
          texts?: unknown;
          text?: unknown;
          topic?: unknown;
          new_topic?: unknown;
        }
      | undefined,
    @CurrentUser() user: SessionUser,
  ) {
    const p = payload || {};
    return this.mutations.mutateAeoPrompts(
      id,
      p.action,
      { texts: p.texts, text: p.text, topic: p.topic, newTopic: p.new_topic },
      user.i,
    );
  }

  /**
   * Owner edits to the tracker: {prompts_limit?, competitors?}. Login + owner.
   * Keys are checked by PRESENCE (competitors=[] is a legitimate "remove all");
   * an empty body applies the default limit. Port of api_public_aeo_update (app.py:2818).
   */
  @Patch(':id')
  @UseGuards(LoginGuard)
  async update(
    @Param('id', ParseIntPipe) id: number,
    @Body()
    payload: { prompts_limit?: unknown; competitors?: unknown } | undefined,
    @CurrentUser() user: SessionUser,
  ) {
    const p = payload || {};
    const has = (k: string) => Object.prototype.hasOwnProperty.call(p, k);
    const out: Record<string, unknown> = {};
    if (has('competitors')) {
      Object.assign(
        out,
        await this.mutations.setAeoCompetitors(id, p.competitors, user.i),
      );
    }
    if (has('prompts_limit') || Object.keys(out).length === 0) {
      Object.assign(
        out,
        await this.mutations.setAeoPromptsLimit(id, p.prompts_limit, user.i),
      );
    }
    return out;
  }
}
