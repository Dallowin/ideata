/**
 * Blog post covers (port of server/api/runs/[id]/cover*.post.ts + covers/[file].get.ts).
 *
 * Two-step flow: first generate an AI BACKGROUND via Nano Banana (no text — models
 * garble letters) and return {bgUrl}; the client overlays a title+logo on a canvas
 * and sends the finished JPEG composition to cover-save (RAW image/jpeg via express.raw,
 * registered in main.ts at /blogwriter/runs/:id/cover-save). GET covers/:file
 * — public serving of saved images from data/covers.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { PlanGuard } from '../../auth/plan.guard';
import { resolveSettings } from '../server/utils/appSettings';
import { coverPrompt, generateImage, geminiKey } from '../server/utils/googleImage';
import { getImageByFile, saveImage } from '../server/utils/previewStore';
import { dataDir, getRunRow, updateRun } from '../server/utils/store';
import { BlogBrandContext } from '../brand-context';

/** Mime of the bytes on disk: the generator returns png as often as jpeg. */
const sniffMime = (b: Buffer): string =>
  b.length > 8 && b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : 'image/jpeg';

@Controller('blogwriter')
export class CoversController {
  constructor(private readonly brandCtx: BlogBrandContext) {}

  /**
   * Step 1: generate an AI background via Nano Banana (Google API) and save it locally.
   * { prompt? } → { bgUrl, prompt }.
   */
  @UseGuards(PlanGuard)
  @Post('runs/:id/cover')
  async generateCover(@Param('id') id: string, @Req() req: Request, @Body() body: { prompt?: string }) {
    const row = await getRunRow(id);
    if (!row) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, row);

    const key = await geminiKey();
    if (!key) throw new BadRequestException('no Gemini key (Settings) — image generation needs a Google API key');

    const brand = (await resolveSettings(row.brandId ?? 0)).brand;
    const title = row.title || row.topic;
    const prompt = body?.prompt?.trim() || coverPrompt(title, brand);

    const { bytes: buf, mime } = await generateImage(prompt, key, { aspectRatio: '16:9' });

    const dir = join(dataDir(), 'covers');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}-bg.jpg`), buf);
    // copy in the DB: the worker's disk is a cache, not storage
    await saveImage({ runId: id, brandId: row.brandId ?? null, kind: 'bg', prompt, aspect: '16:9', mime, bytes: buf, fileName: `${id}-bg.jpg` });

    return { bgUrl: `/blogwriter/covers/${id}-bg.jpg?t=${Date.now()}`, prompt };
  }

  /**
   * Step 2: the client sent the finished composition (image/jpeg RAW) — save it as
   * the final cover <id>.jpg and write cover_url. → { coverUrl }.
   */
  @UseGuards(PlanGuard)
  @Post('runs/:id/cover-save')
  async saveCover(@Param('id') id: string, @Req() req: Request) {
    const row = await getRunRow(id);
    if (!row) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, row);

    const buf = req.body as Buffer | undefined;
    if (!Buffer.isBuffer(buf) || buf.length < 100) throw new BadRequestException('empty image');

    const dir = join(dataDir(), 'covers');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.jpg`), buf);
    await saveImage({ runId: id, brandId: row.brandId ?? null, kind: 'cover', bytes: buf, fileName: `${id}.jpg` });

    const coverUrl = `/blogwriter/covers/${id}.jpg?t=${Date.now()}`;
    await updateRun(id, { cover_url: coverUrl });
    return { coverUrl };
  }

  /** Remove a run's cover (including an AI-generated one): clears cover_url. → { ok }. */
  @UseGuards(PlanGuard)
  @Post('runs/:id/cover-clear')
  async clearCover(@Param('id') id: string, @Req() req: Request) {
    const row = await getRunRow(id);
    if (!row) throw new NotFoundException('run not found');
    await this.brandCtx.assertRunMutate(req, row);
    await updateRun(id, { cover_url: '' });
    return { ok: true };
  }

  /** Public serving of saved covers from data/covers. */
  @Get('covers/:file')
  async serve(@Param('file') file: string, @Res() res: Response) {
    const safe = (file || '').replace(/[^a-zA-Z0-9._-]/g, '');
    if (!safe) throw new NotFoundException('cover not found');
    const path = join(dataDir(), 'covers', safe);

    // Disk is a fast cache; if the file is missing (moved, cleaned up, another worker) —
    // fetch it from the DB and restore the file on disk so it's served from disk next time.
    let bytes: Buffer | null = existsSync(path) ? readFileSync(path) : null;
    let mime = bytes ? sniffMime(bytes) : 'image/jpeg';
    if (!bytes) {
      const row = await getImageByFile(safe);
      if (!row) throw new NotFoundException('cover not found');
      bytes = row.bytes;
      mime = row.mime || mime;
      try { mkdirSync(join(dataDir(), 'covers'), { recursive: true }); writeFileSync(path, bytes); } catch { /* cache is optional */ }
    }
    res.setHeader('Content-Type', mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(bytes);
  }
}
