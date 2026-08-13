/**
 * Media upload to X: v2 POST /2/media/upload under the same OAuth2 user token
 * as publishing. Lives in a separate module from x.service — that one handles
 * tokens and threads, this one handles bytes and platform rules.
 *
 * Three things that make this more than "just multipart":
 *
 *  1. A SEPARATE SCOPE. Text can be published with tweet.write, but uploading
 *     a file requires media.write. Tokens issued before the scope existed get
 *     403 on upload, and the ONLY fix is reconnecting the account — so 403 is
 *     translated into a human-readable hint instead of "HTTP 403".
 *  2. Simple (non-chunked) upload accepts up to 5 MB on X. Above that it's
 *     INIT/APPEND/FINALIZE, a separate story; we honestly skip such files with
 *     a note.
 *  3. GIF on X isn't treated as an image: it can't be mixed with photos and
 *     only one is ever taken.
 *
 * Nothing throws: a failed upload shouldn't cancel publishing the text.
 */
import { type MediaFile } from '../blogwriter/server/utils/crosspostMedia';

const UPLOAD = 'https://api.x.com/2/media/upload';
const TIMEOUT_MS = 60_000;

/** Ceiling for a simple upload. Above this, chunked INIT/APPEND/FINALIZE is required. */
export const SIMPLE_LIMIT = 5 * 1024 * 1024;
/** Hard platform limit: 4 images PER TWEET (not per thread). */
export const MAX_IMAGES = 4;

/**
 * The only fix for a 403 on upload is reconnecting the account: the scope is
 * granted on the consent screen, and there's no way to add it to a token
 * retroactively.
 */
export const SCOPE_HINT =
  'reconnect your X account in Integrations (media upload permission required)';

/**
 * What actually gets uploaded to one tweet. Video is skipped: it needs a
 * chunked upload with its own processing status — a separate task. Only one
 * GIF is taken, without siblings: X doesn't accept a GIF alongside photos.
 */
export function pickXMedia(files: MediaFile[]): { pick: MediaFile[]; note?: string } {
  const images = files.filter((f) => f.type === 'image');
  const notes: string[] = [];
  const videos = files.length - images.length;
  if (videos) notes.push(`X doesn't support video yet — skipped ${videos}`);

  const gifs = images.filter((f) => f.mime === 'image/gif');
  let pick: MediaFile[];
  if (gifs.length) {
    // GIF doesn't coexist with photos or with a second GIF — take the first
    pick = gifs.slice(0, 1);
    if (images.length > 1) notes.push('X only allows one GIF without other images — the rest were skipped');
  } else {
    pick = images.slice(0, MAX_IMAGES);
    if (images.length > MAX_IMAGES) notes.push(`more than ${MAX_IMAGES} images — extras were discarded`);
  }
  return { pick, note: notes.length ? notes.join('; ') : undefined };
}

/** Human-readable upload failure text: X's status codes alone don't explain anything. */
function uploadError(status: number, body: unknown): string {
  if (status === 401) return 'access revoked — reconnect your X account';
  if (status === 403) return SCOPE_HINT;
  if (status === 413) return 'file too large for X';
  if (status === 429) return 'X upload rate limit exceeded (429) — try again later';
  const detail = (() => {
    const b = body as { detail?: string; title?: string; error?: string } | null;
    return b?.detail || b?.title || b?.error || '';
  })();
  return detail ? `${detail} (HTTP ${status})` : `X responded with HTTP ${status}`;
}

/**
 * Upload a single file and get a media_id. Content-Type isn't set manually —
 * fetch sets the boundary (same as the Mastodon upload).
 */
export async function uploadXMedia(
  file: MediaFile,
  token: string,
): Promise<{ id: string } | { error: string }> {
  if (file.bytes.length > SIMPLE_LIMIT) {
    return { error: `larger than ${Math.round(SIMPLE_LIMIT / (1024 * 1024))} MB — X won't accept this file via simple upload` };
  }

  const form = new FormData();
  form.append('media', new Blob([new Uint8Array(file.bytes)], { type: file.mime }), file.name);
  // media_category determines how X processes the file: without it, a GIF ends up as a static image
  form.append('media_category', file.mime === 'image/gif' ? 'tweet_gif' : 'tweet_image');

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(UPLOAD, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
      signal: ctrl.signal,
    });
  } catch (e: any) {
    return { error: e?.name === 'AbortError' ? 'upload timeout (60s)' : (e?.message || 'network error') };
  } finally {
    clearTimeout(t);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) return { error: uploadError(res.status, body) };
  // v2 returns data.id, but older responses carry media_id_string — take whichever exists
  const b = body as { data?: { id?: string }; media_id_string?: string } | null;
  const id = b?.data?.id || b?.media_id_string || '';
  return id ? { id } : { error: 'X did not return an attachment id' };
}

/**
 * media_ids for a SINGLE thread tweet. Returns both the ids and an
 * explanation of what didn't make it: the post number is required in the
 * text — otherwise the warning can't be tied back to the thread.
 */
export async function xMediaIds(
  files: MediaFile[],
  token: string,
  postNo: number,
): Promise<{ ids: string[]; error?: string }> {
  const where = `post ${postNo}`;
  const { pick, note } = pickXMedia(files);
  const notes: string[] = note ? [`${where}: ${note}`] : [];

  const ids: string[] = [];
  for (const f of pick) {
    const up = await uploadXMedia(f, token);
    if ('error' in up) notes.push(`${f.name}: ${up.error}`);
    else ids.push(up.id);
  }
  return { ids, error: notes.length ? notes.join('; ') : undefined };
}
