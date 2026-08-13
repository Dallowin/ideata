/**
 * Publishing blog-writer runs to Ideata's native blog.
 * Port of the blog-writer/server/api/blog/{config.get, publish/[id].post, publish/[id].delete} h3 endpoints.
 * The external Insane blog (base/hasToken) has been replaced by native publishing via Prisma BlogPost,
 * so config tells the UI that the environment is "native" and no token is required.
 */
import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { PlanGuard } from '../../auth/plan.guard';
import { publishRunToBlog, removeRunFromBlog } from '../publish';
import { ThreadsService } from '../../threads/threads.service';
import { threadsAnnounce } from '../server/utils/threadsAnnounce';
import { bskyTest } from '../server/utils/blueskyPublish';
import { wpTest } from '../server/utils/wordpressPublish';
import { ChannelPick, listChannels } from '../server/utils/publishChannels';
import { mastodonTest } from '../server/utils/mastodonPublish';
import { ghostTest } from '../server/utils/ghostPublish';
import { telegraphCreateAccount, telegraphTest } from '../server/utils/telegraphPublish';
import { devtoTest } from '../server/utils/devtoPublish';
import { testExternal } from '../server/utils/extPublish';
import { tgTest } from '../server/utils/tgPublish';
import { resolveSettings } from '../server/utils/appSettings';
import { getRunRow, saveSettings } from '../server/utils/store';
import {
  SCHEDULE_BLOG_CHANNELS,
  SCHEDULE_SOCIAL_CHANNELS,
  mergeScheduleStatuses,
  runSchedule,
  saveSchedule,
  toIsoUtc,
  validateEntries,
  type ScheduleEntry,
} from '../server/utils/publishSchedule';
import { extImportPreview, importFromExternal } from '../extImport';
import { BlogBrandContext } from '../brand-context';

@Controller('blogwriter')
@UseGuards(PlanGuard)
export class PublishController {
  constructor(
    private readonly brandCtx: BlogBrandContext,
    private readonly threads: ThreadsService,
  ) {}
  /** Non-secret blog API config for the UI: native publishing, no token needed. */
  @Get('blog/config')
  config() {
    return { env: 'native', configured: true };
  }

  /**
   * Publish/update a run in the native blog (idempotent on run.blog_post_id).
   * body: { status?: 'draft'|'published', locale? }
   */
  @Post('blog/publish/:id')
  async publish(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: { status?: 'draft' | 'published'; locale?: string; channels?: string[] } = {},
  ) {
    const run = await getRunRow(id);
    await this.brandCtx.assertRunMutate(req, run);
    const result = await publishRunToBlog(id, {
      status: body?.status, locale: body?.locale, channels: body?.channels,
    });

    /**
     * Announce on Threads. This lives here rather than in publish.ts because the
     * connection lives in the main database and is obtained by the service via DI,
     * while publish.ts is a plain module with no container.
     *
     * There's no un-publish on purpose: the Threads API can't delete posts, and
     * pretending we "removed" it would be a lie. This is noted on the channel card.
     */
    let threads: { ok: boolean; ids: string[]; error?: string } | undefined;
    const brandId = await this.brandCtx.brandId(req);
    const conn = brandId ? await this.threads.getConnection(brandId) : null;
    // Threads follows the same one-time selection as the other channels. There's no
    // "un-publish" branch for it here, and there can't be: their API can't delete posts.
    const pick = new ChannelPick(body?.channels);
    if (conn && pick.wants('threads') && result.status === 'published' && result.url) {
      threads = await this.threads.publishThread(conn, threadsAnnounce(run?.title || '', result.url));
    }
    return { ...result, threads };
  }

  /**
   * Unpublish a run's post from the blog and clear the publish state.
   * We return a detailed report: the external copy may NOT have been removed
   * (the receiver was unreachable), in which case the article is still live on the
   * brand's site — the frontend must show this, not paint "removed" just because a request was made.
   */
  @Delete('blog/publish/:id')
  async remove(@Param('id') id: string, @Req() req: Request) {
    await this.brandCtx.assertRunMutate(req, await getRunRow(id));
    const report = await removeRunFromBlog(id);
    return { deleted: report.cleared, ...report };
  }

  /** Auto-publish test: sends a sample post to the active brand's endpoint. */
  @Post('blog/ext-publish/test')
  async extPublishTest(@Req() req: Request) {
    const s = await resolveSettings(await this.brandCtx.brandId(req));
    return testExternal(s);
  }

  /** dev.to key check: asks for the profile, doesn't risk publishing. */
  @Post('blog/devto/test')
  async devtoTestEndpoint(@Req() req: Request) {
    const s = await resolveSettings(await this.brandCtx.brandId(req));
    return devtoTest(s);
  }

  /** Bluesky access check: opens a session and drops it. Publishes nothing. */
  @Post('blog/bluesky/test')
  async blueskyTestEndpoint(@Req() req: Request) {
    const s = await resolveSettings(await this.brandCtx.brandId(req));
    return bskyTest(s);
  }

  /**
   * Where this article can go: a list of channels with readiness and the default
   * checkbox value. Readiness is computed on the backend by the same *Config as
   * publishing — duplicating these rules on the frontend means one day offering a
   * channel that the backend will silently skip.
   */
  @Get('blog/channels')
  async channels(@Req() req: Request) {
    const brandId = await this.brandCtx.brandId(req);
    const s = await resolveSettings(brandId);
    const list = listChannels(s);
    // Threads doesn't live in blog settings but in its own table — appended here
    const conn = brandId ? await this.threads.getConnection(brandId) : null;
    if (conn) {
      list.push({ key: 'threads', label: 'Threads', ready: true, enabled: true });
    }
    return { channels: list };
  }

  /**
   * The article's auto-posting schedule: where and when it goes out on its own.
   * → { entries, channels } — the channel list comes in the same response, so the
   * frontend doesn't keep its own copy (which would silently drift, just like with channel readiness).
   */
  @Get('runs/:id/publish-schedule')
  async schedule(@Param('id') id: string, @Req() req: Request) {
    const run = await getRunRow(id);
    if (!run) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunAccess(req, run);
    return {
      entries: runSchedule(run),
      channels: { blog: [...SCHEDULE_BLOG_CHANNELS], social: [...SCHEDULE_SOCIAL_CHANNELS] },
    };
  }

  /**
   * Replace the whole schedule (like the composer's draft autosave): the frontend
   * sends the current calendar state, and merging here would mean a date the user
   * deleted resurrects on the next tick.
   *
   * The MEMBERSHIP of entries is set by the client, but the STATUS is set by the
   * server: the schedule is changed both by the scheduler and by an open tab's
   * autosave, which can easily arrive with a stale copy. Taking the status from the
   * body would mean reverting an already-sent entry back to planned and publishing
   * it a second time. A changed time is treated as a reschedule — such an entry
   * legitimately becomes planned and goes out again.
   */
  @Patch('runs/:id/publish-schedule')
  async saveScheduleEndpoint(
    @Param('id') id: string,
    @Req() req: Request,
    @Body() body: { entries?: unknown } = {},
  ) {
    const run = await getRunRow(id);
    if (!run) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, run);

    const parsed = validateEntries(body?.entries ?? []);
    if ('error' in parsed) throw new BadRequestException(parsed.error);

    const entries = mergeScheduleStatuses(runSchedule(run), parsed.entries);
    return { ok: true, entries: await saveSchedule(id, entries) };
  }

  /**
   * A single date move (drag&drop in the calendar). A dedicated endpoint rather
   * than a PATCH of the whole schedule: dragging the entire array for one card
   * would overwrite entries the scheduler already processed while the calendar was open.
   *
   * We only move entries that haven't gone out yet: for done/running, the entry has
   * already fired, and a new date wouldn't change anything — we can't silently pretend it did.
   */
  @Patch('runs/:id/publish-schedule/:entryId')
  async moveScheduleEntry(
    @Param('id') id: string,
    @Param('entryId') entryId: string,
    @Req() req: Request,
    @Body() body: { at?: string } = {},
  ) {
    const run = await getRunRow(id);
    if (!run) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, run);

    const at = toIsoUtc(body?.at);
    if (!at) throw new BadRequestException('at — send time in ISO format');

    const entries = runSchedule(run);
    const idx = entries.findIndex((e) => e.id === entryId);
    if (idx < 0) throw new NotFoundException('schedule entry not found');
    const prev = entries[idx];
    if (prev.status === 'running') throw new BadRequestException('entry is already being sent — cannot reschedule');
    // clear the error and the previous-send mark: the entry waits for its date again
    const moved: ScheduleEntry = { id: prev.id, channel: prev.channel, at, status: 'planned' };
    entries[idx] = moved;
    const saved = await saveSchedule(id, entries);
    return { ok: true, entry: moved, entries: saved };
  }

  /** WordPress access check: asks the site about itself, publishes nothing. */
  @Post('blog/wordpress/test')
  async wordpressTestEndpoint(@Req() req: Request) {
    const s = await resolveSettings(await this.brandCtx.brandId(req));
    return wpTest(s);
  }

  /** Mastodon check: asks the instance who we are. Publishes nothing. */
  @Post('blog/mastodon/test')
  async mastodonTestEndpoint(@Req() req: Request) {
    const s = await resolveSettings(await this.brandCtx.brandId(req));
    return mastodonTest(s);
  }

  /** Ghost check: asks the site about itself. Publishes nothing. */
  @Post('blog/ghost/test')
  async ghostTestEndpoint(@Req() req: Request) {
    const s = await resolveSettings(await this.brandCtx.brandId(req));
    return ghostTest(s);
  }

  /** Telegraph token check: account data. Publishes nothing. */
  @Post('blog/telegraph/test')
  async telegraphTestEndpoint(@Req() req: Request) {
    const s = await resolveSettings(await this.brandCtx.brandId(req));
    return telegraphTest(s);
  }

  /**
   * Create a Telegraph account and save the token to the brand. Otherwise the
   * channel can't be connected at all: telegra.ph's UI has no token, it lives in
   * the browser's localStorage. auth_url is given to the user once — they use it to claim the account.
   */
  @Post('blog/telegraph/create-account')
  async telegraphCreateAccountEndpoint(@Req() req: Request) {
    await this.brandCtx.assertBrandMutate(req);
    const brandId = await this.brandCtx.brandId(req);
    const s = await resolveSettings(brandId);
    const short = (s.brand || 'ideata').replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'ideata';
    const res = await telegraphCreateAccount(short, s.telegraphAuthorName || s.brand || short, s.siteUrl || '');
    if (!res.ok) return { ok: false, error: res.error };
    // write the token scoped to the brand — same as the other channel secrets
    await saveSettings({ telegraphToken: res.token, telegraphEnabled: '1' }, brandId);
    return { ok: true, authUrl: res.authUrl, tokenMasked: res.token.slice(0, 4) + '…' + res.token.slice(-4) };
  }

  /** Telegram crossposting test: sends a short message to the brand's channel and deletes it. */
  @Post('blog/tg-publish/test')
  async tgPublishTest(@Req() req: Request) {
    const s = await resolveSettings(await this.brandCtx.brandId(req));
    return tgTest(s);
  }

  /**
   * Import preview: how many posts on the receiver (GET /blog/ingest) + samples.
   * Writes nothing to the DB. Reads the active brand's ext-config.
   */
  @Get('blog/ext-import/preview')
  async extImportPreviewEndpoint(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('locale') locale?: string,
    @Query('category') category?: string,
  ) {
    // allowSelf: self-host import reads the ENTIRE native blog (including drafts) —
    // a non-admin shouldn't be able to pull someone else's content by pointing extPublishUrl=ideata.io
    return extImportPreview(
      { status, locale, category, allowSelf: this.brandCtx.isAdmin(req) },
      await this.brandCtx.brandId(req),
    );
  }

  /**
   * Import: pull the receiver's existing posts into blog-writer (drafts of the
   * active brand). body: { status?, locale?, category?, max? }
   */
  @Post('blog/ext-import')
  async extImportEndpoint(
    @Req() req: Request,
    @Body() body: { status?: string; locale?: string; category?: string; max?: number } = {},
  ) {
    await this.brandCtx.assertBrandMutate(req); // viewer can't import posts
    return importFromExternal(
      {
        status: body?.status,
        locale: body?.locale,
        category: body?.category,
        max: body?.max,
        allowSelf: this.brandCtx.isAdmin(req),
      },
      await this.brandCtx.brandId(req),
    );
  }
}
