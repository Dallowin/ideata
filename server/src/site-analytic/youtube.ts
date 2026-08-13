/**
 * Port of core/social.py::youtube_interest — the "video" media block of the
 * analysis: interest in the niche on YouTube (number of videos + total views of
 * the top results) and up to 8 mention cards (channel/views/likes/date/duration).
 * Uses the free YOUTUBE_API_KEY; no key or no query → null.
 *
 * Three Data API calls in sequence: search.list → videos.list (snippet +
 * statistics for the found ids) → channels.list (subscribers). The second and
 * third calls have NO status check and are entirely wrapped in "try/except:
 * pass" — a failing enrichment call simply leaves fields empty without breaking
 * the block (same as in Python). The transport is injectable (`get`) — we do not
 * burn live YouTube quota, and parity runs on synthetic data
 * (youtube.parity.spec.ts) with the same URL-based routing.
 *
 * Footguns: `_to_int` (toIntLoose) with k/m suffixes for view counts;
 * `subs.get(channelId)` → null when missing; `desc[:200]` counts code points;
 * mentions order = ids order (the search.list order), not videos.list order.
 */
import { toIntLoose, cpSlice, isDict } from './pyutil';
import { makeFetchGet, type HttpGet } from './http';

const SEARCH = 'https://www.googleapis.com/youtube/v3/search';
const VIDEOS = 'https://www.googleapis.com/youtube/v3/videos';
const CHANNELS = 'https://www.googleapis.com/youtube/v3/channels';
const TIMEOUT_MS = 20_000;

export interface YoutubeMention {
  title: unknown;
  url: string;
  channel: unknown;
  subs: number | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  time: unknown;
  dur: unknown;
  desc: string;
}

export interface YoutubeInterest {
  video_results: number | null;
  top_views: number;
  titles: unknown[];
  mentions: YoutubeMention[];
}

export interface YoutubeOptions {
  apiKey?: string | null;
  region?: string | null;
  shorts?: boolean;
  get?: HttpGet;
}

const dict = (v: unknown): Record<string, unknown> => (isDict(v) ? v : {});
const listOr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export async function youtubeInterest(
  query: string,
  opts: YoutubeOptions = {},
): Promise<YoutubeInterest | null> {
  const key = opts.apiKey ?? process.env.YOUTUBE_API_KEY ?? null;
  if (!key || !query) return null;
  const get = opts.get ?? makeFetchGet({ timeoutMs: TIMEOUT_MS });

  // ── search.list (status is checked here; failure/non-JSON → the whole block is null) ──
  const searchParams: Record<string, unknown> = {
    part: 'snippet', q: query, type: 'video', maxResults: 10, key,
  };
  if (opts.shorts) searchParams.videoDuration = 'short';
  if (opts.region) searchParams.regionCode = opts.region;

  const sResp = await get(SEARCH, searchParams);
  if (sResp === null) return null; // httpx.get raised
  if (sResp.status !== 200) return null;
  if (!isDict(sResp.body)) return null; // r.json() returned a non-object → like AttributeError→None
  const data = sResp.body;

  const items = listOr(data.items);
  const total = toIntLoose(dict(data.pageInfo).totalResults);
  const ids: string[] = [];
  for (const i of items) {
    const id = dict(i).id;
    if (isDict(id) && id.videoId) ids.push(String(id.videoId));
  }

  let views = 0;
  const mentions: YoutubeMention[] = [];
  if (ids.length) {
    const stats: Record<string, Record<string, unknown>> = {};
    // videos.list — no status gate, entirely best-effort (Python try/except: pass)
    try {
      const vResp = await get(VIDEOS, {
        part: 'snippet,statistics,contentDetails', id: ids.join(','), key,
      });
      if (vResp && isDict(vResp.body)) {
        for (const it of listOr(vResp.body.items)) {
          const rec = dict(it);
          stats[String(rec.id)] = rec;
          views += toIntLoose(dict(rec.statistics).viewCount) ?? 0;
        }
      }
    } catch {
      /* pass */
    }

    // channels.list — subscribers, also best-effort. The chan_ids order does not
    // affect the result (subs is a dict keyed by channelId).
    const chanIds = [
      ...new Set(
        ids
          .map((i) => dict(dict(stats[i]).snippet).channelId)
          .filter((c): c is string => !!c)
          .map(String),
      ),
    ];
    const subs: Record<string, number | null> = {};
    if (chanIds.length) {
      try {
        const cResp = await get(CHANNELS, {
          part: 'statistics', id: chanIds.slice(0, 50).join(','), key,
        });
        if (cResp && isDict(cResp.body)) {
          for (const ch of listOr(cResp.body.items)) {
            const rec = dict(ch);
            subs[String(rec.id)] = toIntLoose(dict(rec.statistics).subscriberCount);
          }
        }
      } catch {
        /* pass */
      }
    }

    for (const vid of ids.slice(0, 8)) {
      const it = dict(stats[vid]);
      const sn = dict(it.snippet);
      const st = dict(it.statistics);
      const channelId = sn.channelId;
      const descRaw = sn.description;
      mentions.push({
        title: sn.title ?? null,
        url: `https://youtube.com/watch?v=${vid}`,
        channel: sn.channelTitle ?? null,
        subs: (typeof channelId === 'string' ? subs[channelId] : undefined) ?? null,
        views: toIntLoose(st.viewCount),
        likes: toIntLoose(st.likeCount),
        comments: toIntLoose(st.commentCount),
        time: sn.publishedAt ?? null,
        dur: dict(it.contentDetails).duration ?? null,
        desc: cpSlice(typeof descRaw === 'string' ? descRaw : '', 200),
      });
    }
  }

  const titles = items.slice(0, 5).map((i) => dict(dict(i).snippet).title ?? null);
  return { video_results: total, top_views: views, titles, mentions };
}
