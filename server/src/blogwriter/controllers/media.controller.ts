/**
 * Media inside the article body: file uploads, the article's media library,
 * public serving, and link recognition for embedding.
 *
 * Storage scheme — same as covers (covers.controller): the file is written to
 * disk AND a copy to Postgres, and served from disk with a DB fallback and
 * cache restoration. Disk here is exactly a cache: /blogwriter/media/<file>
 * links are baked into the body of a published article and must survive a
 * deploy and a server move.
 */
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PlanGuard } from '../../auth/plan.guard';
import { AuthService } from '../../auth/auth.service';
import { BlogBrandContext } from '../brand-context';
import { resolveEmbed, type EmbedDescriptor } from '../server/utils/embedProviders';
import { unfurl } from '../server/utils/unfurl';
import {
  deleteMedia,
  getMediaByFile,
  getMediaOwner,
  listRunMedia,
  saveMedia,
  type MediaKind,
} from '../server/utils/mediaStore';
import { dataDir, getRunRow } from '../server/utils/store';

const MB = 1024 * 1024;

interface MimeSpec {
  ext: string;
  kind: MediaKind;
  limit: number;
}

/**
 * What we accept at all. A whitelist, not "everything except": image/svg+xml is
 * DELIBERATELY not here — SVG is an executable document, and we serve images
 * from our own domain, meaning a script inside it would run in our origin.
 */
const ACCEPT: Record<string, MimeSpec> = {
  'image/jpeg': { ext: 'jpg', kind: 'image', limit: 20 * MB },
  'image/png': { ext: 'png', kind: 'image', limit: 20 * MB },
  'image/webp': { ext: 'webp', kind: 'image', limit: 20 * MB },
  'image/gif': { ext: 'gif', kind: 'image', limit: 20 * MB },
  'image/avif': { ext: 'avif', kind: 'image', limit: 20 * MB },

  'video/mp4': { ext: 'mp4', kind: 'video', limit: 100 * MB },
  'video/webm': { ext: 'webm', kind: 'video', limit: 100 * MB },
  'video/quicktime': { ext: 'mov', kind: 'video', limit: 100 * MB },

  'audio/mpeg': { ext: 'mp3', kind: 'audio', limit: 40 * MB },
  'audio/ogg': { ext: 'ogg', kind: 'audio', limit: 40 * MB },
  'audio/wav': { ext: 'wav', kind: 'audio', limit: 40 * MB },
  'audio/x-wav': { ext: 'wav', kind: 'audio', limit: 40 * MB },
  'audio/mp4': { ext: 'm4a', kind: 'audio', limit: 40 * MB },
  'audio/webm': { ext: 'weba', kind: 'audio', limit: 40 * MB },
  'audio/aac': { ext: 'aac', kind: 'audio', limit: 40 * MB },

  'application/pdf': { ext: 'pdf', kind: 'file', limit: 100 * MB },
  'application/zip': { ext: 'zip', kind: 'file', limit: 100 * MB },
  'text/plain': { ext: 'txt', kind: 'file', limit: 100 * MB },
  'text/csv': { ext: 'csv', kind: 'file', limit: 100 * MB },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: 'docx', kind: 'file', limit: 100 * MB },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: 'xlsx', kind: 'file', limit: 100 * MB },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { ext: 'pptx', kind: 'file', limit: 100 * MB },
};

/** Reverse map for serving from disk when there's no DB row (migration hasn't run yet). */
const EXT_MIME: Record<string, string> = Object.entries(ACCEPT).reduce<Record<string, string>>(
  (acc, [mime, spec]) => { if (!acc[spec.ext]) acc[spec.ext] = mime; return acc; },
  {},
);

const MEDIA_DIR = 'blog-media';

/** Human-readable limit for the error text. */
function mb(bytes: number): string {
  return `${Math.round(bytes / MB)} MB`;
}

/* ------------------------------------------------- image dimensions by hand */

/**
 * Image width/height from the file headers. Done by hand because pulling in
 * sharp/image-size as a dependency for just two numbers costs more than forty
 * lines: all the formats we need keep the dimensions in the first bytes.
 * null — format not recognized (AVIF, corrupt file): then we simply don't return w/h.
 */
function imageSize(buf: Buffer, mime: string): { width: number; height: number } | null {
  try {
    if (mime === 'image/png' && buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
      // IHDR is always the first chunk: length(4) + 'IHDR'(4) + width(4) + height(4)
      if (buf.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }

    if (mime === 'image/gif' && buf.length > 10 && buf.subarray(0, 3).toString('latin1') === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }

    if (mime === 'image/jpeg' && buf.length > 4 && buf.readUInt16BE(0) === 0xffd8) {
      // walk segment markers until the first SOF (that's where the dimensions live)
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; } // align to a marker
        const marker = buf[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = buf.readUInt16BE(i + 2);
        if (len < 2) return null;
        const isSof = (marker >= 0xc0 && marker <= 0xc3)
          || (marker >= 0xc5 && marker <= 0xc7)
          || (marker >= 0xc9 && marker <= 0xcb)
          || (marker >= 0xcd && marker <= 0xcf);
        if (isSof) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
        if (marker === 0xda) return null; // scan data started — no SOF will follow now
        i += 2 + len;
      }
      return null;
    }

    if (mime === 'image/webp' && buf.length > 30
      && buf.subarray(0, 4).toString('latin1') === 'RIFF'
      && buf.subarray(8, 12).toString('latin1') === 'WEBP') {
      const chunk = buf.subarray(12, 16).toString('latin1');
      const data = 20; // RIFF(12) + fourcc(4) + size(4)
      if (chunk === 'VP8 ') {
        // 3 bytes frame tag, 3 bytes sync code, then 14-bit dimensions
        if (buf[data + 3] !== 0x9d || buf[data + 4] !== 0x01 || buf[data + 5] !== 0x2a) return null;
        return {
          width: buf.readUInt16LE(data + 6) & 0x3fff,
          height: buf.readUInt16LE(data + 8) & 0x3fff,
        };
      }
      if (chunk === 'VP8L') {
        if (buf[data] !== 0x2f) return null;
        const bits = buf.readUInt32LE(data + 1);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') {
        // canvas dimensions — 24-bit little-endian, minus one
        const w = buf[data + 4] | (buf[data + 5] << 8) | (buf[data + 6] << 16);
        const h = buf[data + 7] | (buf[data + 8] << 8) | (buf[data + 9] << 16);
        return { width: w + 1, height: h + 1 };
      }
    }
  } catch {
    /* corrupt headers — dimensions aren't required */
  }
  return null;
}

@Controller('blogwriter')
export class MediaController {
  constructor(
    private readonly brandCtx: BlogBrandContext,
    private readonly auth: AuthService,
  ) {}

  private userId(req: Request): number {
    const u = this.auth.userFromRequest(req);
    if (!u?.i) throw new UnauthorizedException('Account login required');
    return u.i;
  }

  /**
   * Upload a file into the article. RAW bytes, Content-Type = the actual MIME
   * (the parser is registered in main.ts), original name — in X-File-Name,
   * encodeURIComponent (otherwise Cyrillic wouldn't fit in an HTTP header).
   * → { url, id, kind, mime, name, size, width?, height? }
   */
  @UseGuards(PlanGuard)
  @Post('runs/:id/media')
  async upload(@Param('id') id: string, @Req() req: Request) {
    const run = await getRunRow(id);
    if (!run) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, run);

    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const spec = ACCEPT[mime];
    if (!spec) {
      throw new BadRequestException(
        `Format "${mime || 'unknown'}" is not supported. Allowed: JPEG, PNG, WebP, GIF, AVIF, `
        + 'MP4, WebM, MOV, MP3, OGG, WAV, M4A, AAC, PDF, ZIP, TXT, CSV, DOCX, XLSX, PPTX. '
        + "SVG isn't accepted — it can contain executable code.",
      );
    }

    const buf = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(buf) || buf.length < 16) throw new BadRequestException('Empty file');
    if (buf.length > spec.limit) {
      throw new BadRequestException(
        `File too large: ${mb(buf.length)} against a limit of ${mb(spec.limit)} for this type`,
      );
    }

    // original name: decode, strip paths (…/../ in the name) and trim the tail length
    let origName = '';
    try {
      origName = decodeURIComponent(String(req.headers['x-file-name'] || ''));
    } catch {
      origName = String(req.headers['x-file-name'] || '');
    }
    origName = origName.replace(/[\\/]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);

    const safeRunId = String(id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    const fileName = `${safeRunId}-${randomBytes(8).toString('hex')}.${spec.ext}`;
    const size = spec.kind === 'image' ? imageSize(buf, mime) : null;

    // the DB copy is the primary store; disk is a serving cache (and a fallback if
    // the migration hasn't run yet and saveMedia returned null)
    const mediaId = await saveMedia({
      userId: this.auth.userFromRequest(req)?.i ?? null,
      brandId: run.brandId ?? null,
      runId: id,
      kind: spec.kind,
      mime,
      bytes: buf,
      fileName,
      origName,
      width: size?.width ?? null,
      height: size?.height ?? null,
    });
    const dir = join(dataDir(), MEDIA_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, fileName), buf);

    return {
      url: `/blogwriter/media/${fileName}`,
      id: mediaId ?? 0,
      kind: spec.kind,
      mime,
      name: origName || fileName,
      size: buf.length,
      ...(size ? { width: size.width, height: size.height } : {}),
    };
  }

  /** Article's media library — newest first. → { items: [...] } */
  @UseGuards(PlanGuard)
  @Get('runs/:id/media')
  async library(@Param('id') id: string, @Req() req: Request) {
    const run = await getRunRow(id);
    if (!run) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunAccess(req, run);
    const rows = await listRunMedia(id);
    return {
      items: rows.map((r) => ({
        id: r.id,
        url: `/blogwriter/media/${r.fileName}`,
        kind: r.kind,
        mime: r.mime,
        name: r.name,
        size: r.size,
        width: r.width,
        height: r.height,
        createdAt: r.createdAt,
      })),
    };
  }

  /**
   * Recognize a link for insertion. { url } → a media-block descriptor.
   * Known providers are resolved locally (embedProviders); an unknown link is
   * unfurled for og tags. An unfurl error is not a 500: we return a card with the host.
   */
  @UseGuards(PlanGuard)
  @Post('media/embed')
  async embed(@Body() body: { url?: string }): Promise<EmbedDescriptor | {
    kind: 'link'; provider: string; src: string; href: string;
    title: string; desc: string; thumb: string; site: string; ratio: number;
  }> {
    const raw = String(body?.url || '').trim();
    if (!raw) throw new BadRequestException('Provide a link');
    let u: URL;
    try {
      u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    } catch {
      throw new BadRequestException("This doesn't look like a link");
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new BadRequestException('Only http and https links are supported');
    }
    const href = u.toString();
    const site = u.hostname.replace(/^www\./, '');

    const known = resolveEmbed(href);
    if (known) return known;

    const og = await unfurl(href);
    return {
      kind: 'link',
      provider: '',
      src: '',
      href,
      title: og?.title || site,
      desc: og?.desc || '',
      thumb: og?.thumb || '',
      site: og?.site || site,
      ratio: 0,
    };
  }

  /**
   * Remove media from the article's library. → { ok: true }
   *
   * Rights are checked by the file's BRAND (owner/editor), not "I uploaded it":
   * media lives in the workspace's shared article, and an editor must be able to
   * remove a colleague's image. Legacy rows with no brand keep the old "own only" rule.
   */
  @UseGuards(PlanGuard)
  @Delete('media/:id')
  async remove(@Param('id') id: string, @Req() req: Request) {
    const userId = this.userId(req);
    const mediaId = Number(id);
    const owner = await getMediaOwner(mediaId);
    if (!owner) throw new NotFoundException('File not found');

    // the brand is taken from the run (more current than the row's denormalized
    // brand_id); if the run no longer exists — from the row itself
    const run = owner.runId ? await getRunRow(owner.runId) : undefined;
    const brandId = run?.brandId ?? owner.brandId ?? 0;
    if (brandId) {
      await this.brandCtx.assertRunMutate(req, { brandId });
    } else if (owner.userId && owner.userId !== userId && !this.brandCtx.isAdmin(req)) {
      throw new NotFoundException('File not found'); // no one's run, someone else's row
    }

    // SQL condition — second line of defense: a row with a brand is removable
    // only within its own brand scope, a legacy row with no brand only if it's your own
    const fileName = await deleteMedia(
      mediaId,
      owner.brandId ? { brandId: owner.brandId } : { userId: owner.userId ?? userId },
    );
    if (!fileName) throw new NotFoundException('File not found');
    // a disk cache with no DB row is useless
    try { rmSync(join(dataDir(), MEDIA_DIR, fileName), { force: true }); } catch { /* cache is optional */ }
    return { ok: true };
  }

  /**
   * Public media serving (no auth — files sit inside published articles).
   * Disk → DB fallback with cache restoration.
   * Range support is mandatory: without 206, seeking in <video>/<audio> doesn't
   * work — Safari won't even start playback.
   */
  @Get('media/:file')
  async serve(@Param('file') file: string, @Req() req: Request, @Res() res: Response) {
    const safe = (file || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safe) throw new NotFoundException('File not found');
    const path = join(dataDir(), MEDIA_DIR, safe);
    let onDisk = existsSync(path);

    // on a DB-cache hit, we only pull the metadata (mime, original name) —
    // no reason to read a 100 MB bytea just for headers
    const meta = await getMediaByFile(safe, !onDisk);
    if (!onDisk) {
      const restored = meta?.bytes ?? null;
      if (!restored) throw new NotFoundException('File not found');
      try {
        mkdirSync(join(dataDir(), MEDIA_DIR), { recursive: true });
        writeFileSync(path, restored);
        onDisk = true;
      } catch { /* cache is optional — serve from memory */ }
      if (!onDisk) return this.sendBuffer(req, res, restored, safe, meta);
    }

    // from disk — streamed: a 100 MB video is read in chunks, not loaded whole
    // on every request (the player sends chunked range requests while seeking)
    const total = statSync(path).size;
    const hit = this.range(req, res, safe, meta, total);
    if (!hit) return;
    createReadStream(path, { start: hit.start, end: hit.end }).pipe(res);
  }

  /**
   * Common headers + Range parsing. Returns the range to serve, or null if the
   * response is already closed (416). Split out from serve because the same code
   * also serves a DB buffer when the disk cache is unavailable (read-only FS).
   */
  private range(
    req: Request,
    res: Response,
    safe: string,
    meta: { mime?: string; kind?: MediaKind; origName?: string | null } | null,
    total: number,
  ): { start: number; end: number } | null {
    const ext = safe.split('.').pop()?.toLowerCase() || '';
    const mime = meta?.mime || EXT_MIME[ext] || 'application/octet-stream';
    const kind = meta?.kind || (mime.split('/')[0] as MediaKind);

    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Accept-Ranges', 'bytes');
    // documents are served inline with the original name: otherwise the browser
    // downloads the file under a technical <run>-<hex>.pdf
    if (kind === 'file') {
      const name = meta?.origName || safe;
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
    }

    const m = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
    if (m && (m[1] || m[2])) {
      // "bytes=-500" — the last 500 bytes, "bytes=100-" — from 100 to the end
      const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2] || 0));
      const end = m[1] ? Math.min(total - 1, m[2] ? Number(m[2]) : total - 1) : total - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
        res.status(416).setHeader('Content-Range', `bytes */${total}`);
        res.end();
        return null;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', String(end - start + 1));
      return { start, end };
    }

    res.setHeader('Content-Length', String(total));
    return { start: 0, end: Math.max(0, total - 1) };
  }

  /** Serve from memory — only when the disk cache couldn't be written. */
  private sendBuffer(
    req: Request,
    res: Response,
    bytes: Buffer,
    safe: string,
    meta: { mime?: string; kind?: MediaKind; origName?: string | null } | null,
  ) {
    const hit = this.range(req, res, safe, meta, bytes.length);
    if (!hit) return;
    res.end(bytes.subarray(hit.start, hit.end + 1));
  }
}
