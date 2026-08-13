/**
 * Proxy to the Ideata AI API (domain AEO analytics) for the blog-writer UI.
 * Port of the blog-writer/server/api/ideata/** h3 endpoints.
 * The sk_ideata_… key lives ONLY on the server (env IDEATA_API_KEY); the frontend calls this.
 * Analysis is async: analyze → poll job → read the results.
 *
 * SCOPE. The key is platform-wide, meaning on the other side we're one big account:
 * without scoping, any user could brute-force ids to read other people's analyses (and
 * burn our money analyzing arbitrary domains). So:
 *   • analyze — only the active brand's domain (admin — any domain);
 *   • we remember our own ids (analysis/job) in the brand's KV (blog_writer_settings) and
 *     only allow access to those, others → 404;
 *   • the list is filtered by the user's brand domains.
 */
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PlanGuard } from '../../auth/plan.guard';
import { AuthService } from '../../auth/auth.service';
import { BrandsService } from '../../brands/brands.service';
import { BlogBrandContext } from '../brand-context';
import { getBrandCache, setBrandCache } from '../server/utils/store';
import {
  ideataAnalysis,
  ideataAnalyze,
  ideataConfig,
  ideataGuide,
  ideataJob,
  ideataList,
  ideataPrompts,
} from '../server/utils/ideataApi';

const GEOS = new Set(['ru', 'us', 'gb', 'de']);

/** KV key scoped to the brand: ids of analyses and jobs started by this brand. */
const OWNED_KEY = 'ideataOwned:v1';
/** How many ids we keep per brand (a log, not storage — old ones get evicted). */
const OWNED_LIMIT = 300;

interface OwnedIds {
  analyses: string[];
  jobs: string[];
}

/** Domain from a URL/string → bare host without www (domains can't be compared otherwise). */
function hostOf(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/**
 * Unwrap a promise from ideataApi and map its plain Error (with statusCode)
 * to a Nest HttpException, so the client gets the correct HTTP status/message.
 */
async function call<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (e) {
    const err = e as Error & { statusCode?: number; statusMessage?: string };
    const status = err?.statusCode;
    if (status) {
      throw new HttpException(err.statusMessage || err.message || 'Ideata error', status);
    }
    throw e;
  }
}

@Controller('blogwriter')
@UseGuards(PlanGuard)
export class IdeataController {
  constructor(
    private readonly auth: AuthService,
    private readonly brands: BrandsService,
    private readonly brandCtx: BlogBrandContext,
  ) {}

  /** Domains of the brands accessible to the user (for the list filter). */
  private async myDomains(req: Request): Promise<string[]> {
    const user = this.auth.userFromRequest(req);
    if (!user?.i) return [];
    try {
      const list = await this.brands.accessibleForUser(user.i);
      return list.map((b: any) => hostOf(b.domain || '')).filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Remember our own analysis/job id in the active brand's KV. */
  private async remember(brandId: number, patch: Partial<OwnedIds>): Promise<void> {
    if (!brandId) return;
    const cur = (await getBrandCache<OwnedIds>(brandId, OWNED_KEY)) || { analyses: [], jobs: [] };
    const merge = (a: string[] = [], add: string[] = []) =>
      [...new Set([...add, ...(a || [])])].slice(0, OWNED_LIMIT);
    await setBrandCache(brandId, OWNED_KEY, {
      analyses: merge(cur.analyses, patch.analyses),
      jobs: merge(cur.jobs, patch.jobs),
    });
  }

  /** Is this our own id (analysis or job)? Admin — always yes. */
  private async owns(req: Request, kind: keyof OwnedIds, id: string): Promise<boolean> {
    if (this.brandCtx.isAdmin(req)) return true;
    const user = this.auth.userFromRequest(req);
    if (!user?.i) return false;
    const want = String(id);
    try {
      const list = await this.brands.accessibleForUser(user.i);
      for (const b of list as any[]) {
        const owned = await getBrandCache<OwnedIds>(b.id, OWNED_KEY);
        if (owned?.[kind]?.includes(want)) return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  /** Don't confirm the existence of someone else's id — 404, same as for runs. */
  private async assertOwns(req: Request, kind: keyof OwnedIds, id: string): Promise<void> {
    if (!(await this.owns(req, kind, id))) throw new NotFoundException('Ideata: analysis not found');
  }

  /** Non-secret Ideata config for the UI: base URL and whether a key is configured (the key itself is NOT returned). */
  @Get('ideata/config')
  config() {
    const { base, hasKey } = ideataConfig();
    return { base, hasKey };
  }

  /**
   * Start a domain analysis in Ideata (server-to-server, key stays on the backend).
   * body: { domain, compare?, geo?, refresh? } → { id, job_id, status, cached }
   * Domain — only the active brand's: analysis costs money, and nobody is allowed to
   * run it against arbitrary domains using our platform key.
   */
  @Post('ideata/analyze')
  async analyze(
    @Req() req: Request,
    @Body() b: { domain?: string; compare?: string; geo?: string; refresh?: boolean } = {},
  ) {
    const domain = String(b?.domain ?? '').trim();
    if (!domain) throw new BadRequestException('domain is required');

    await this.brandCtx.assertBrandMutate(req); // viewer can't run a paid analysis
    const brand: any = await this.brandCtx.brand(req);
    const brandId = brand?.id ?? 0;
    if (!this.brandCtx.isAdmin(req)) {
      const own = hostOf(brand?.domain || '');
      if (!own) throw new BadRequestException('no active brand with a domain');
      if (hostOf(domain) !== own) {
        throw new ForbiddenException(`Analysis is only available for the active brand's domain (${own})`);
      }
    }

    const body: Record<string, unknown> = { domain };
    if (b?.compare && String(b.compare).trim()) body.compare = String(b.compare).trim();
    if (b?.geo && GEOS.has(b.geo)) body.geo = b.geo;
    if (b?.refresh) body.refresh = true;
    const res = await call<any>(ideataAnalyze(body));
    // remember OUR OWN ids — we later use them to gate access to results
    await this.remember(brandId, {
      analyses: res?.id != null ? [String(res.id)] : [],
      jobs: res?.job_id != null ? [String(res.job_id)] : [],
    });
    return res;
  }

  /** Status of an async Ideata analysis. GET → { status, log }. */
  @Get('ideata/jobs/:jobId')
  async job(@Param('jobId') jobId: string, @Req() req: Request) {
    await this.assertOwns(req, 'jobs', jobId);
    return call(ideataJob(jobId));
  }

  /** List of past Ideata analyses (reading is free) — only for the user's own domains. */
  @Get('ideata/analyses')
  async list(@Query() query: Record<string, any>, @Req() req: Request) {
    const res = await call<any>(ideataList(query));
    if (this.brandCtx.isAdmin(req)) return res;
    const mine = new Set(await this.myDomains(req));
    const keep = (row: any) => mine.has(hostOf(row?.domain || row?.site || ''));
    if (Array.isArray(res)) return res.filter(keep);
    // typical list wrappers from the API — filter the array inside, leave the rest as-is
    for (const key of ['items', 'analyses', 'results', 'data']) {
      if (Array.isArray(res?.[key])) return { ...res, [key]: res[key].filter(keep) };
    }
    return res;
  }

  /** Full analysis result (facts, llm_outputs). */
  @Get('ideata/analyses/:id')
  async analysis(@Param('id') id: string, @Req() req: Request) {
    await this.assertOwns(req, 'analyses', id);
    return call(ideataAnalysis(id));
  }

  /** AEO guide and content plan for the domain. */
  @Get('ideata/analyses/:id/guide')
  async guide(@Param('id') id: string, @Req() req: Request) {
    await this.assertOwns(req, 'analyses', id);
    return call(ideataGuide(id));
  }

  /** AI prompts/queries for the domain (vol, intent, mentioned, pos). */
  @Get('ideata/analyses/:id/prompts')
  async prompts(@Param('id') id: string, @Req() req: Request) {
    await this.assertOwns(req, 'analyses', id);
    return call(ideataPrompts(id));
  }
}
