/**
 * Images for a LinkedIn post: Images API (/rest/images).
 *
 * Why this one and not the legacy /v2/assets?action=registerUpload: we
 * publish the post through /rest/posts, which accepts ONLY urn:li:image —
 * it won't take a URN from the old assets flow (urn:li:digitalmediaAsset).
 * Mixing the two API generations in one post isn't possible, so we use
 * whatever is compatible with the current publishing endpoint.
 *
 * Three steps per image:
 *   1. POST /rest/images?action=initializeUpload → { uploadUrl, image: URN }
 *   2. PUT the bytes to uploadUrl (same Bearer — the link isn't fully signed)
 *   3. put the URN into the post body
 *
 * LinkedIn only has ONE post (a thread is collapsed into a single entry), so
 * attachments here aren't split by postIndex — they're collected from all
 * posts in sequence.
 *
 * Nothing throws: a failed image shouldn't cancel publishing the text.
 */
import { type MediaFile } from '../blogwriter/server/utils/crosspostMedia';

const API = 'https://api.linkedin.com';
const TIMEOUT_MS = 60_000;

/** LinkedIn carousel (multiImage) — 2 to 9 images. */
export const MAX_IMAGES = 9;

/** w_member_social covers both publishing and upload, but only once it's granted. */
export const SCOPE_HINT =
  'reconnect your LinkedIn account in Integrations (media upload permission required)';

export interface LinkedinMediaCtx {
  token: string;
  version: string;
  /** Post author: also the owner of the uploaded image. */
  owner: string;
}

/**
 * What actually gets attached. Video on LinkedIn is a separate Videos API
 * with its own chunked multipart upload and processing wait — a separate
 * task, so video is skipped with a note rather than silently.
 */
export function pickLinkedinImages(files: MediaFile[]): { pick: MediaFile[]; note?: string } {
  const images = files.filter((f) => f.type === 'image');
  const notes: string[] = [];
  const videos = files.length - images.length;
  if (videos) notes.push(`LinkedIn doesn't support video yet — skipped ${videos}`);
  if (images.length > MAX_IMAGES) notes.push(`more than ${MAX_IMAGES} images — extras were discarded`);
  return { pick: images.slice(0, MAX_IMAGES), note: notes.length ? notes.join('; ') : undefined };
}

/** Human-readable failure text: LinkedIn's status codes alone say nothing. */
function mediaError(status: number): string {
  if (status === 401) return 'access revoked — reconnect your LinkedIn account';
  if (status === 403) return SCOPE_HINT;
  if (status === 429) return 'too frequent (429) — LinkedIn is throttling uploads';
  return `LinkedIn responded with HTTP ${status}`;
}

/** Steps 1+2: get the upload link and PUT the bytes to it. */
export async function uploadLinkedinImage(
  file: MediaFile,
  ctx: LinkedinMediaCtx,
): Promise<{ urn: string } | { error: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const init = await fetch(`${API}/rest/images?action=initializeUpload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        'Content-Type': 'application/json',
        'LinkedIn-Version': ctx.version,
        'X-Restli-Protocol-Version': '2.0.0',
      },
      body: JSON.stringify({ initializeUploadRequest: { owner: ctx.owner } }),
      signal: ctrl.signal,
    });
    if (!init.ok) return { error: mediaError(init.status) };

    const b = (await init.json().catch(() => ({}))) as {
      value?: { uploadUrl?: string; image?: string };
    };
    const uploadUrl = b.value?.uploadUrl || '';
    const urn = b.value?.image || '';
    if (!uploadUrl || !urn) return { error: 'LinkedIn did not return an upload link' };

    // Bytes go via PUT: the link is single-use but still requires authorization
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': file.mime },
      body: new Uint8Array(file.bytes),
      signal: ctrl.signal,
    });
    if (!put.ok) return { error: mediaError(put.status) };
    return { urn };
  } catch (e: any) {
    return { error: e?.name === 'AbortError' ? 'upload timeout (60s)' : (e?.message || 'network error') };
  } finally {
    clearTimeout(t);
  }
}

/**
 * The `content` block for /rest/posts. One image — a regular image post,
 * two or more — a multiImage carousel: LinkedIn treats these as different
 * fields, and won't accept a single image inside multiImage.
 */
export async function linkedinImageContent(
  files: MediaFile[],
  ctx: LinkedinMediaCtx,
): Promise<{ content?: Record<string, unknown>; error?: string }> {
  const { pick, note } = pickLinkedinImages(files);
  const notes: string[] = note ? [note] : [];

  const urns: string[] = [];
  for (const f of pick) {
    const up = await uploadLinkedinImage(f, ctx);
    if ('error' in up) notes.push(`${f.name}: ${up.error}`);
    else urns.push(up.urn);
  }

  const content = urns.length === 1
    ? { media: { id: urns[0], altText: '' } }
    : urns.length > 1
      ? { multiImage: { images: urns.map((id) => ({ id, altText: '' })) } }
      : undefined;

  return { content, error: notes.length ? notes.join('; ') : undefined };
}
