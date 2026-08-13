/**
 * "Content factory": adapting a finished article for social media (Telegram / VK /
 * Threads / X / Zen) and publishing it there.
 *
 * POST   blogwriter/runs/:id/crosspost                  → per-platform adaptations (LLM)
 * GET    blogwriter/crosspost/platforms                 → platform profiles (for the UI)
 * POST   blogwriter/runs/:id/crosspost/publish          → publish (tg, x)
 * GET    blogwriter/runs/:id/crosspost/state            → what's already published
 * DELETE blogwriter/runs/:id/crosspost/publish/:platform → unpublish
 *
 * Connectors: Telegram (brand's bot), X, Bluesky, Mastodon and LinkedIn — all with
 * real deletion. VK and Zen — text adaptation only.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PlanGuard } from '../../auth/plan.guard';
import { BlogBrandContext } from '../brand-context';
import { adaptForPlatform, crosspostDrafts, crosspostState, saveCrosspostDrafts, saveCrosspostState, publishAdaptedBluesky, publishAdaptedLinkedin, publishAdaptedMastodon, publishAdaptedTelegram, publishAdaptedX, unpublishAdaptedBluesky, unpublishAdaptedMastodon, unpublishAdaptedTelegram, unpublishAdaptedX, type AdaptResult } from '../server/utils/crosspost';
import { MEDIA_CAP, MEDIA_MIME, mediaPostIndex, type CrosspostMedia } from '../server/utils/crosspostMedia';
import { resolveSettings } from '../server/utils/appSettings';
import { LLM } from '../server/utils/llm';
import { dataDir, getRunRow } from '../server/utils/store';
import { PLATFORM_KEYS, PLATFORM_LIST, platformProfile } from '../server/utils/pipeline/platformProfiles';
import { tgConfig } from '../server/utils/tgPublish';
import { bskyConfig } from '../server/utils/blueskyPublish';
import { mastodonConfig } from '../server/utils/mastodonPublish';
import { ThreadsService } from '../../threads/threads.service';
import { LinkedinService } from '../../linkedin/linkedin.service';
import { XService } from '../../x/x.service';

const MB = 1024 * 1024;

// Allowed media types: extension by MIME (Telegram/social media pull the file by URL).
// limit — size cap, same as in media.controller (ACCEPT): without it a RAW upload
// could write anything, any amount, to the worker's disk, and we have no disk quota.
const MEDIA_EXT: Record<string, { ext: string; kind: 'image' | 'video'; limit: number }> = {
  'image/jpeg': { ext: 'jpg', kind: 'image', limit: 20 * MB },
  'image/png': { ext: 'png', kind: 'image', limit: 20 * MB },
  'image/webp': { ext: 'webp', kind: 'image', limit: 20 * MB },
  'image/gif': { ext: 'gif', kind: 'image', limit: 40 * MB },
  'video/mp4': { ext: 'mp4', kind: 'video', limit: 100 * MB },
  'video/quicktime': { ext: 'mov', kind: 'video', limit: 100 * MB },
  'video/webm': { ext: 'webm', kind: 'video', limit: 100 * MB },
};
interface PlatformResult {
  platform: string;
  ok: boolean;
  result?: AdaptResult;
  error?: string;
}

/**
 * Media from the UI: only accept files WE uploaded. Without this check, the
 * request body could make the backend fetch an arbitrary URL (SSRF) or feed the
 * platform someone else's image. postIndex is passed through — connectors use it
 * to distribute attachments across thread posts.
 */
const MEDIA_URL_PREFIX = '/blogwriter/crosspost-media/';

function safeMediaList(raw: unknown): CrosspostMedia[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m: any) => m && typeof m.url === 'string' && m.url.includes(MEDIA_URL_PREFIX))
    .map((m: any): CrosspostMedia => ({
      url: String(m.url),
      type: m.type === 'video' ? 'video' : 'image',
      postIndex: mediaPostIndex(m.postIndex),
    }))
    .slice(0, MEDIA_CAP);
}

/**
 * Cap on the draft body. Posts themselves are already limited by per-platform
 * limits (the most generous — Zen, 8000 characters), so a genuine draft across all
 * nine platforms fits here with room to spare, while "let's save a megabyte in a
 * BLOB" gets rejected.
 */
const DRAFTS_LIMIT = 256 * 1024;

@Controller('blogwriter')
@UseGuards(PlanGuard)
export class CrosspostController {
  constructor(
    private readonly brandCtx: BlogBrandContext,
    private readonly threads: ThreadsService,
    private readonly linkedin: LinkedinService,
    private readonly x: XService,
  ) {}

  /**
   * Platforms with their readiness. Readiness is computed HERE, by the same
   * *Config as publishing: duplicate these rules in the frontend and the UI will
   * one day offer a channel that the backend silently skips.
   *
   * delivery says who sends it:
   *  · 'auto' — we send it (Telegram, X, Bluesky, Mastodon, LinkedIn);
   *  · 'rss'  — the platform pulls articles itself from our feed (Zen);
   *  · 'copy' — there's no connector at all, copy only (VK, Threads).
   */
  @Get('crosspost/platforms')
  async platforms(@Req() req: Request) {
    const brandId = await this.brandCtx.brandId(req);
    const s = await resolveSettings(brandId);
    const tg = tgConfig(s);
    const threadsConn = brandId ? await this.threads.getConnection(brandId) : null;
    const linkedinConn = brandId ? await this.linkedin.getConnection(brandId) : null;
    const xConn = brandId ? await this.x.getConnection(brandId) : null;

    const meta = (key: string): { delivery: 'auto' | 'rss' | 'copy'; ready: boolean; reason?: string } => {
      if (key === 'tg') {
        return tg.token && tg.channel
          ? { delivery: 'auto', ready: true }
          : { delivery: 'auto', ready: false, reason: 'no bot or channel configured' };
      }
      if (key === 'x') {
        // We only publish from a linked account: there's no longer a channel
        // token in settings.
        return xConn
          ? { delivery: 'auto', ready: true }
          : { delivery: 'auto', ready: false, reason: 'account not connected' };
      }
      if (key === 'bluesky') {
        const b = bskyConfig(s);
        return b.handle && b.appPassword
          ? { delivery: 'auto', ready: true }
          : { delivery: 'auto', ready: false, reason: 'no handle or app password configured' };
      }
      if (key === 'mastodon') {
        const m = mastodonConfig(s);
        return m.instance && m.token
          ? { delivery: 'auto', ready: true }
          : { delivery: 'auto', ready: false, reason: 'no instance address or token configured' };
      }
      if (key === 'linkedin') {
        // the connection lives in its own table, not in blog settings
        return linkedinConn
          ? { delivery: 'auto', ready: true }
          : { delivery: 'auto', ready: false, reason: 'account not connected' };
      }
      if (key === 'threads') {
        // The composer doesn't publish to Threads: the announcement goes out on its
        // own when the ARTICLE is published (publish.controller). Returning 'auto'
        // here would promise a button that doesn't exist — the UI already shows "Copy" next to it.
        return threadsConn
          ? { delivery: 'copy', ready: true }
          : { delivery: 'copy', ready: false, reason: 'account not connected' };
      }
      // Zen subscribes to our rss.xml and pulls articles itself — there's nothing
      // for us to "connect", and a status line is more honest than a toggle that sends nothing
      if (key === 'dzen') return { delivery: 'rss', ready: true };
      return { delivery: 'copy', ready: true };
    };

    return {
      platforms: PLATFORM_LIST.map((p) => ({
        key: p.key,
        label: p.label,
        emoji: p.emoji,
        charLimit: p.charLimit,
        thread: p.thread,
        maxPosts: p.maxPosts,
        ...meta(p.key),
      })),
    };
  }

  /**
   * Generate adaptations of the run's article for the selected platforms. Each
   * platform is processed independently: one's error doesn't bring down the rest
   * (it's returned in its own ok:false/error). Requires owner/editor role (costs LLM calls).
   */
  @Post('runs/:id/crosspost')
  async crosspost(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: { platforms?: string[] } = {},
  ) {
    const run = await getRunRow(id);
    if (!run) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, run);

    // validate and dedup the requested platforms; empty → all known ones
    const requested = Array.isArray(body?.platforms) && body.platforms.length
      ? body.platforms.map((x) => String(x || '').trim().toLowerCase())
      : PLATFORM_KEYS;
    const keys = [...new Set(requested)].filter((k) => platformProfile(k));
    if (!keys.length) throw new BadRequestException('no known platforms specified');

    if (!(run.title || '').trim() || !(run.body_md || run.body_html || '').trim()) {
      throw new BadRequestException('Finish the article first: a title and body are required');
    }

    const s = await resolveSettings(run.brandId ?? 0);
    const llm = new LLM({ ...s, usage: { ...s.usage, runId: id } });

    // platforms in parallel; isolate each one's error
    const results: PlatformResult[] = await Promise.all(
      keys.map(async (platform): Promise<PlatformResult> => {
        try {
          const result = await adaptForPlatform(run, platform, llm, s);
          return { platform, ok: true, result };
        } catch (e: any) {
          return { platform, ok: false, error: e?.message || 'adaptation error' };
        }
      }),
    );

    // Save the fresh adaptations right away: tokens were already spent on them, and
    // losing them because the frontend didn't manage (or failed) to autosave the
    // draft isn't acceptable. Merge by platform — rebuilding one doesn't erase the others.
    const fresh: Record<string, AdaptResult> = {};
    for (const r of results) if (r.ok && r.result) fresh[r.platform] = r.result;
    if (Object.keys(fresh).length) {
      try { await saveCrosspostDrafts(id, run, { adapts: fresh }); }
      catch { /* the draft is a convenience, not the result: a write error must not eat the finished texts */ }
    }

    return { runId: id, mock: llm.isMock, results };
  }

  /**
   * Silent composer autosave: the collected adaptations and their attached files.
   * Replaces the whole draft — the frontend sends the screen's current state, and
   * merging here would mean a platform the user removed resurrects.
   */
  @Patch('runs/:id/crosspost/drafts')
  async saveDrafts(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: { adapts?: Record<string, AdaptResult>; media?: Record<string, CrosspostMedia[]> } = {},
  ) {
    const run = await getRunRow(id);
    if (!run) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, run);

    const known = (raw: unknown): raw is Record<string, unknown> =>
      !!raw && typeof raw === 'object' && !Array.isArray(raw);
    if ((body.adapts && !known(body.adapts)) || (body.media && !known(body.media))) {
      throw new BadRequestException('adapts and media must be objects keyed by platform');
    }

    const adapts: Record<string, AdaptResult> = {};
    for (const [key, raw] of Object.entries(body.adapts || {})) {
      // the key must be a known platform: otherwise the draft becomes a dumping ground for arbitrary JSON
      const p = platformProfile(key);
      if (!p || !raw || typeof raw !== 'object') continue;
      // Rebuild the adaptation field by field rather than spreading the body: the
      // platform description (label/limits/emoji) comes from the profile — the
      // client can't be trusted here, and nothing but text the client itself edited goes into the DB.
      const v = raw as Partial<AdaptResult>;
      const posts = Array.isArray(v.posts) ? v.posts.map((x) => String(x ?? '')) : [];
      adapts[p.key] = {
        platform: p.key,
        label: p.label,
        emoji: p.emoji,
        format: p.format,
        charLimit: p.charLimit,
        thread: p.thread,
        posts,
        hashtags: Array.isArray(v.hashtags) ? v.hashtags.map((x) => String(x ?? '')) : [],
        warnings: Array.isArray(v.warnings) ? v.warnings.map((x) => String(x ?? '')) : [],
        charCount: posts.reduce((m, x) => Math.max(m, x.length), 0),
        mock: !!v.mock,
      };
    }

    const media: Record<string, CrosspostMedia[]> = {};
    for (const [key, value] of Object.entries(body.media || {})) {
      const p = platformProfile(key);
      if (!p) continue;
      media[p.key] = safeMediaList(value);
    }

    const size = JSON.stringify({ adapts, media }).length;
    if (size > DRAFTS_LIMIT) {
      throw new BadRequestException(`draft is too large (${Math.round(size / 1024)} KB, limit is ${DRAFTS_LIMIT / 1024} KB)`);
    }

    await saveCrosspostDrafts(id, run, { adapts, media }, false);
    return { ok: true };
  }

  /**
   * Publish an adapted post to social media. Telegram is implemented so far
   * (per-brand bot/channel from blog settings). body.posts — text from the preview
   * (possibly edited in the UI); if not provided — the adaptation is generated on the fly. Requires owner/editor.
   */
  @Post('runs/:id/crosspost/publish')
  async publish(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: { platform?: string; posts?: string[]; media?: CrosspostMedia[] } = {},
  ) {
    const run = await getRunRow(id);
    if (!run) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, run);

    const platform = String(body?.platform || '').trim().toLowerCase();
    if (!platformProfile(platform)) throw new BadRequestException('unknown platform');
    const CONNECTORS = ['tg', 'x', 'bluesky', 'mastodon', 'linkedin'];
    if (!CONNECTORS.includes(platform)) {
      throw new BadRequestException(`connector "${platform}" isn't implemented yet (coming soon)`);
    }

    // media from the UI: only URLs WE uploaded (/blogwriter/crosspost-media/...).
    // The overall MEDIA_CAP limit is for the whole thread: per-post platform limits
    // (tg 10, bluesky 4 images, mastodon 4 images or 1 video, x 4 images or 1 GIF,
    // linkedin 9 images per whole post) are enforced by the connectors, which also
    // explain any overflow in mediaError.
    const media: CrosspostMedia[] = safeMediaList(body?.media);

    const s = await resolveSettings(run.brandId ?? 0);
    // text from the UI (edited) — otherwise generate the platform adaptation on the fly
    let posts = Array.isArray(body?.posts) ? body.posts.map((x) => String(x || '')) : [];
    if (!posts.some((x) => x.trim())) {
      const llm = new LLM({ ...s, usage: { ...s.usage, runId: id } });
      posts = (await adaptForPlatform(run, platform, llm, s)).posts;
    }
    // Media is delivered to all connectors: Telegram pulls the file by URL, the
    // others (Bluesky, Mastodon, X, LinkedIn) require uploading bytes via their own
    // API — the bytes are read from disk in readLocalMedia, see crosspostMedia.ts.
    if (platform === 'x') {
      const brandId = await this.brandCtx.brandId(req);
      if (!brandId || !(await this.x.getConnection(brandId))) {
        throw new BadRequestException('X account not connected');
      }
      return publishAdaptedX(id, run, posts, brandId, this.x, media);
    }
    if (platform === 'bluesky') return publishAdaptedBluesky(id, run, posts, s, media);
    if (platform === 'linkedin') {
      return publishAdaptedLinkedin(id, run, posts, await this.brandCtx.brandId(req), this.linkedin, media);
    }
    if (platform === 'mastodon') return publishAdaptedMastodon(id, run, posts, s, media);
    return publishAdaptedTelegram(id, run, posts, s, media);
  }

  private async unpublishLinkedin(id: string, run: any, req: Request) {
    const brandId = await this.brandCtx.brandId(req);
    const prev = crosspostState(run).linkedin?.ids || [];
    if (!prev.length) return { platform: 'linkedin', ok: true, removed: 0, leftover: 0 };
    const del = await this.linkedin.remove(brandId, prev[0]!);
    if (del.ok) await saveCrosspostState(id, run, 'linkedin', null);
    return { platform: 'linkedin', ok: del.ok, removed: del.ok ? 1 : 0, leftover: del.ok ? 0 : 1, error: del.error };
  }

  /**
   * What's already published per platform plus the saved composer draft: without
   * this, the UI would show "not published" on a live thread after a page reload
   * and offer to re-run the LLM over already-collected adaptations. No network calls.
   */
  @Get('runs/:id/crosspost/state')
  async state(@Param('id') id: string, @Req() req: Request) {
    const run = await getRunRow(id);
    if (!run) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunAccess(req, run);
    const tgIds = (() => {
      try { const v = JSON.parse(run.tg_msgids_json || '[]'); return Array.isArray(v) ? v : []; }
      catch { return []; }
    })();
    return {
      runId: id,
      platforms: {
        ...crosspostState(run),
        ...(tgIds.length ? { tg: { ids: tgIds.map(String) } } : {}),
      },
      drafts: crosspostDrafts(run),
    };
  }

  /**
   * Upload media (photo/video) for a post. RAW bytes with Content-Type image/* | video/*
   * (parser in main.ts). Saved to data/crosspost-media, returns a public URL.
   * → { url, type, name }. Requires owner/editor.
   */
  @UseGuards(PlanGuard)
  @Post('runs/:id/crosspost/media')
  async uploadMedia(@Param('id') id: string, @Req() req: Request) {
    const run = await getRunRow(id);
    if (!run) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, run);

    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const spec = MEDIA_EXT[ct];
    if (!spec) throw new BadRequestException('JPEG/PNG/WebP/GIF and MP4/MOV/WebM are supported');
    const buf = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(buf) || buf.length < 64) throw new BadRequestException('empty file');
    if (buf.length > spec.limit) {
      throw new BadRequestException(
        `file is too large: ${Math.round(buf.length / MB)} MB, limit is `
        + `${Math.round(spec.limit / MB)} MB for this type`,
      );
    }

    const dir = join(dataDir(), 'crosspost-media');
    mkdirSync(dir, { recursive: true });
    // unique name: <runId>-<ts><rnd>.<ext> (no special characters from id)
    const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    const name = `${safeId}-${Date.now()}${Math.floor(Math.random() * 1e6)}.${spec.ext}`;
    writeFileSync(join(dir, name), buf);
    return { url: `/blogwriter/crosspost-media/${name}`, type: spec.kind, name };
  }

  /** Public serving of uploaded media from data/crosspost-media. */
  @Get('crosspost-media/:file')
  serveMedia(@Param('file') file: string, @Res() res: Response) {
    const safe = (file || '').replace(/[^a-zA-Z0-9._-]/g, '');
    const ext = safe.split('.').pop()?.toLowerCase() || '';
    const path = join(dataDir(), 'crosspost-media', safe);
    if (!safe || !MEDIA_MIME[ext] || !existsSync(path)) throw new NotFoundException('media not found');
    res.setHeader('Content-Type', MEDIA_MIME[ext]);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(readFileSync(path));
  }

  /** Unpublish an adapted post from social media (Telegram so far). */
  @Delete('runs/:id/crosspost/publish/:platform')
  async unpublish(
    @Param('id') id: string,
    @Param('platform') platform: string,
    @Req() req: Request,
  ) {
    const run = await getRunRow(id);
    if (!run) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, run);

    const key = String(platform || '').trim().toLowerCase();
    if (!['tg', 'x', 'bluesky', 'mastodon', 'linkedin'].includes(key)) throw new BadRequestException('unknown platform');
    const s = await resolveSettings(run.brandId ?? 0);
    if (key === 'x') {
      const brandId = await this.brandCtx.brandId(req);
      if (!brandId) throw new BadRequestException('X account not connected');
      return unpublishAdaptedX(id, run, brandId, this.x);
    }
    if (key === 'bluesky') return unpublishAdaptedBluesky(id, run, s);
    if (key === 'linkedin') return this.unpublishLinkedin(id, run, req);
    if (key === 'mastodon') return unpublishAdaptedMastodon(id, run, s);
    return unpublishAdaptedTelegram(id, run, s);
  }
}
