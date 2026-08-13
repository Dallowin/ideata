/**
 * Autoposting scheduler: once a minute picks up schedule entries that are due
 * and sends the article to their channel. Lives as a module service rather than a plain
 * module in server/utils because publishing to X and LinkedIn goes through
 * DI services (their connections live in the main database).
 *
 * What matters here:
 *  · claiming an entry via re-reading the run (claimEntry) — a double tick doesn't
 *    publish twice, even if the previous one hasn't finished yet;
 *  · a channel error is stored on the entry itself (status='error') and is NOT retried:
 *    a silent retry loop either spams the platform with duplicates or burns tokens
 *    on adaptation; a retry is a deliberate user action;
 *  · no single error takes down the interval: a failed tick logs and waits for the next one.
 */
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { LinkedinService } from '../linkedin/linkedin.service';
import { XService } from '../x/x.service';
import { publishRunToBlog, type PublishResult } from './publish';
import { resolveSettings } from './server/utils/appSettings';
import {
  adaptForPlatform,
  crosspostDrafts,
  publishAdaptedBluesky,
  publishAdaptedLinkedin,
  publishAdaptedMastodon,
  publishAdaptedTelegram,
  publishAdaptedX,
} from './server/utils/crosspost';
import type { CrosspostMedia } from './server/utils/crosspostMedia';
import { LLM } from './server/utils/llm';
import {
  claimEntry,
  dueEntries,
  finishEntry,
  isBlogChannel,
  parseSchedule,
  type ScheduleBlogChannel,
  type ScheduleEntry,
  type ScheduleSocialChannel,
} from './server/utils/publishSchedule';
import { getRunRow, listRunSchedules, type RunRow } from './server/utils/store';

const TICK_MS = 60_000;

/** Channel key → the publishRunToBlog result field we use to judge success. */
const BLOG_RESULT_KEY: Record<ScheduleBlogChannel, keyof PublishResult> = {
  external: 'external',
  devto: 'devto',
  wordpress: 'wordpress',
  ghost: 'ghost',
  telegraph: 'telegraph',
};

@Injectable()
export class PublishScheduler implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly x: XService,
    private readonly linkedin: LinkedinService,
  ) {}

  private timer: NodeJS.Timeout | null = null;
  /** a tick taking longer than a minute is normal (LLM + platform network calls); don't stack them */
  private busy = false;

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    // don't keep the event loop alive for an empty schedule (matters for tests/CLI)
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over the schedules. Public so a test can trigger a tick manually. */
  async tick(now: Date = new Date()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      // runs with a non-empty schedule — a single query, without article bodies
      const rows = await listRunSchedules();
      for (const row of rows) {
        for (const due of dueEntries(parseSchedule(row.publish_schedule_json), now)) {
          // re-read the run: the entry may have been claimed by the previous tick or removed by the user
          const entry = await claimEntry(row.id, due.id);
          if (!entry) continue;
          try {
            await this.send(row.id, entry);
            await finishEntry(row.id, entry.id, { ok: true });
            console.log('[publish-schedule] sent', row.id, entry.channel, entry.at);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            await finishEntry(row.id, entry.id, { ok: false, error: msg });
            console.warn('[publish-schedule] channel rejected it', row.id, entry.channel, msg);
          }
        }
      }
    } catch (e) {
      // a tick failing shouldn't take the interval down with it — DB hiccuped, we'll try again next minute
      console.warn('[publish-schedule] tick failed', e instanceof Error ? e.message : e);
    } finally {
      this.busy = false;
    }
  }

  /** Send the article to the entry's channel. Failure goes out as an exception whose text lands in the entry's error field. */
  private async send(runId: string, entry: ScheduleEntry): Promise<void> {
    const run = await getRunRow(runId);
    if (!run) throw new Error('article was deleted');
    if (isBlogChannel(entry.channel)) return this.sendToBlogChannel(run, entry.channel);
    return this.sendToSocial(run, entry.channel);
  }

  /**
   * Blog channel: the same path as the "Publish" button, but with a SINGLE channel in
   * channels[] — the one-off channel selection is already handled by publishing, and an
   * unchecked box there means "skip this time", not "unpublish".
   */
  private async sendToBlogChannel(run: RunRow, channel: ScheduleBlogChannel): Promise<void> {
    const res = await publishRunToBlog(run.id, {
      status: 'published',
      locale: run.locale || undefined,
      channels: [channel],
    });
    // For the brand that owns the native blog, "the site" IS blog_posts itself: the post
    // was created, and a missing external ingest doesn't make the send a failure
    if (channel === 'external' && res.postId > 0) return;
    const r = res[BLOG_RESULT_KEY[channel]] as { ok?: boolean; error?: string } | undefined;
    if (r?.ok) return;
    throw new Error(r?.error || 'the channel rejected the article — check its settings');
  }

  /**
   * Social: text is taken from the composer draft (tokens have already been spent on it,
   * and it may have been hand-edited). If there's no draft for the platform, adapt it on the
   * fly with the same adaptForPlatform, otherwise the scheduled post simply won't go out.
   */
  private async sendToSocial(run: RunRow, channel: ScheduleSocialChannel): Promise<void> {
    const s = await resolveSettings(run.brandId ?? 0);
    const drafts = crosspostDrafts(run);
    const media: CrosspostMedia[] = drafts?.media?.[channel] || [];
    let posts = (drafts?.adapts?.[channel]?.posts || []).map((x) => String(x || ''));
    if (!posts.some((x) => x.trim())) {
      const llm = new LLM({ ...s, usage: { ...s.usage, runId: run.id } });
      posts = (await adaptForPlatform(run, channel, llm, s)).posts;
    }

    const res = await this.publishSocial(run, channel, posts, s, media);
    if (!res.ok) throw new Error(res.error || 'the platform rejected the post');
  }

  private async publishSocial(
    run: RunRow,
    channel: ScheduleSocialChannel,
    posts: string[],
    s: Awaited<ReturnType<typeof resolveSettings>>,
    media: CrosspostMedia[],
  ): Promise<{ ok: boolean; error?: string }> {
    // X and LinkedIn publish from the brand's linked account — without a brand
    // (a legacy run) there's nowhere to send to, and that can't be swallowed silently
    const brandId = run.brandId ?? 0;
    if (channel === 'x') {
      if (!brandId) throw new Error('article has no brand attached — cannot determine the X account');
      return publishAdaptedX(run.id, run, posts, brandId, this.x, media);
    }
    if (channel === 'linkedin') {
      if (!brandId) throw new Error('article has no brand attached — cannot determine the LinkedIn account');
      return publishAdaptedLinkedin(run.id, run, posts, brandId, this.linkedin, media);
    }
    if (channel === 'bluesky') return publishAdaptedBluesky(run.id, run, posts, s, media);
    if (channel === 'mastodon') return publishAdaptedMastodon(run.id, run, posts, s, media);
    return publishAdaptedTelegram(run.id, run, posts, s, media);
  }
}
