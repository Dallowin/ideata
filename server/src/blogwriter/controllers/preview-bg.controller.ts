/**
 * Image generation for the cover builder (/blog/preview).
 *   • the endpoint is NOT tied to an article (run) — only to the user;
 *   • available to any logged-in user (LoginGuard), not just Pro;
 *   • no cap on quantity — paid for from the credits balance (CreditsService).
 *     Price = our cost per image × IMAGE_MARKUP: without the markup, a credit
 *     spent on an image would cost us three times more than a credit spent on text
 *     (text is priced off the vendor's official price, and we pay a third of it);
 *   • with the user's own (BYO) kie.ai key (user_ai_keys) — generation is free for us
 *     and no credits are deducted: the user pays the provider directly;
 *   • the user picks the model from the text→image catalog (imageCatalog).
 *
 * The text-free image (models garble letters) is saved to data/covers and served
 * via the same public GET /blogwriter/covers/:file as covers.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../../auth/auth.service';
import { PrismaService } from '../../prisma/prisma.service';
import { LoginGuard } from '../../auth/login.guard';
import { CreditsService, creditsForImageUsd } from '../../credits/credits.service';
import { DEFAULT_IMAGE_MODEL, findImageModel, getImageCatalog } from '../server/utils/imageCatalog';
import { generateImage, kieKey } from '../server/utils/nanoBanana';
import { deleteScene, listImages, listScenes, saveImage, saveScene } from '../server/utils/previewStore';
import { dataDir } from '../server/utils/store';
import { resolveSettings } from '../server/utils/appSettings';
import { LLM } from '../server/utils/llm';
import { findLanguage } from '../shared/languages';
import { BlogBrandContext } from '../brand-context';

const ASPECTS = new Set(['16:9', '1:1', '9:16', '4:3', '3:2', '2:3', '3:4']);

/**
 * Image price when the catalog didn't return a price. Equal to the most expensive
 * known model with markup (Nano Banana Pro, $0.09 × 3 → 25 credits): when the price
 * is unknown, err in our own favor, otherwise a catalog scrape failure becomes a fire sale.
 */
const IMAGE_PRICE_FALLBACK = 25;

@UseGuards(LoginGuard)
@Controller('blogwriter')
export class PreviewBgController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly brandCtx: BlogBrandContext,
    private readonly credits: CreditsService,
  ) {}

  private userId(req: Request): number {
    const u = this.auth.userFromRequest(req);
    if (!u?.i) throw new UnauthorizedException('Account login required');
    return u.i;
  }

  /** User's BYO key (or ''), safe against the table not existing. */
  private async ownKey(userId: number): Promise<string> {
    try {
      const rows = await this.prisma.$queryRawUnsafe<{ kie_key: string }[]>(
        'SELECT kie_key FROM user_ai_keys WHERE user_id = $1', userId);
      return (rows?.[0]?.kie_key || '').trim();
    } catch { return ''; }
  }

  /** Status for the UI: credits balance, own key. There's no more quantity limit. */
  @Get('preview/status')
  async status(@Req() req: Request) {
    const userId = this.userId(req);
    const [hasOwnKey, balance] = await Promise.all([
      this.ownKey(userId).then((k) => !!k),
      this.credits.balance(userId),
    ]);
    return { ...balance, hasOwnKey };
  }

  /**
   * Catalog of image generation models (text→image only) with price in OUR
   * credits per image. ?refresh=1 — re-scrape kie.
   */
  @Get('preview/image-models')
  async imageModels(@Query('refresh') refresh?: string) {
    const { models, scrapedAt, stale } = await getImageCatalog(refresh === '1');
    return {
      models: models.map((m) => ({
        id: m.id,
        label: m.label,
        usdPerImage: m.usdPerImage,
        credits: m.usdPerImage != null ? creditsForImageUsd(m.usdPerImage) : null,
      })),
      defaultModel: DEFAULT_IMAGE_MODEL,
      scrapedAt,
      stale,
    };
  }

  /** Save/clear the user's own kie.ai key. { key } (empty — clear it). */
  @Post('preview/key')
  async saveKey(@Req() req: Request, @Body() body: { key?: string }) {
    const userId = this.userId(req);
    const key = (body?.key || '').trim();
    await this.prisma.$executeRawUnsafe(
      `INSERT INTO user_ai_keys (user_id, kie_key, updated_at) VALUES ($1, $2, now())
         ON CONFLICT (user_id) DO UPDATE SET kie_key = EXCLUDED.kie_key, updated_at = now()`,
      userId, key);
    return { hasOwnKey: !!key };
  }

  /**
   * Generate a background. { prompt, aspectRatio?, model? }
   * → { url, model, credits, balance, usingOwnKey }.
   * Credits are deducted ONLY for successful generation, and only when using our own key.
   */
  @Post('preview/background')
  async background(
    @Req() req: Request,
    @Body() body: { prompt?: string; aspectRatio?: string; model?: string },
  ) {
    const userId = this.userId(req);
    const prompt = (body?.prompt || '').trim();
    if (prompt.length < 2) throw new BadRequestException('describe the background in a few words');
    const aspect = ASPECTS.has(body?.aspectRatio || '') ? body!.aspectRatio! : '16:9';

    // only accept a model from the catalog — an arbitrary slug would go straight to the jobs API
    const wanted = (body?.model || '').trim() || DEFAULT_IMAGE_MODEL;
    const model = await findImageModel(wanted);
    if (!model) throw new BadRequestException('unknown generation model');

    const own = await this.ownKey(userId);
    const usingOwnKey = !!own;
    // Price unknown (catalog scrape failed) → use NOT 1 credit but the upper bound
    // of known models: otherwise the most expensive model would go for the price of
    // one, and a catalog failure would turn into a fire sale.
    const price = model.usdPerImage != null
      ? creditsForImageUsd(model.usdPerImage)
      : IMAGE_PRICE_FALLBACK;

    const key = own || await kieKey();
    if (!key) throw new BadRequestException('no kie.ai key — add your own key to generate a background');

    // With their own key the user pays directly → we don't touch credits.
    // Otherwise reserve BEFORE generation: the balance check and deduction happen in
    // one transaction under a lock (see CreditsService.reserve). Previously this was
    // assertEnough → generate → charge, and concurrent requests read the same
    // balance: both passed the gate and drove the balance negative.
    // A failure is returned via a refund — "pay only for success" is preserved.
    const reserved = usingOwnKey
      ? 0
      : await this.credits.reserve(userId, price, 'image', model.id, { aspect, kind: 'preview_bg' });
    const refund = (why: string) =>
      reserved ? this.credits.refund(userId, reserved, 'image', model.id, { kind: 'preview_bg', why }) : undefined;

    // "No text": the model garbles letters, and the builder overlays its own text.
    const full = `${prompt}. Абстрактный фон/обои для превью, современно, атмосферно. `
      + 'БЕЗ текста, БЕЗ букв, БЕЗ надписей, без логотипов.';

    let tempUrl: string;
    try {
      tempUrl = await generateImage(full, key, { aspectRatio: aspect, model: model.id });
    } catch (e: any) {
      await refund('generate_failed');
      const msg = String(e?.message || '');
      // OUR kie account ran out of balance — this isn't about the user's credits,
      // and retrying is pointless: tell them plainly what to do.
      if (msg.startsWith('KIE_NO_CREDITS')) {
        throw new HttpException(
          usingOwnKey
            ? 'Your kie.ai key ran out of balance — top up your kie.ai account.'
            : `Image provider declined: insufficient kie.ai balance for model "${model.label}". `
              + 'Pick a cheaper model or top up the kie.ai account.',
          503,
        );
      }
      throw new BadGatewayException(msg || 'image generation failed');
    }
    const img = await fetch(tempUrl, { signal: AbortSignal.timeout(30_000) }).catch(async (e) => {
      await refund('download_failed');
      throw new BadGatewayException(e?.message || 'failed to download the generated image');
    });
    if (!img.ok) {
      await refund('download_failed');
      throw new BadGatewayException('failed to download the generated image');
    }
    const buf = Buffer.from(await img.arrayBuffer());

    // The image goes to the DB — it survives server relocation and disk cleanup.
    // We also put a copy on disk as before: it's a serving cache and a safety net in
    // case the migration hasn't landed yet (then saveImage returns null).
    const file = `bgp-${userId}-${randomBytes(6).toString('hex')}.jpg`;
    const imageId = await saveImage({
      userId,
      brandId: await this.brandCtx.brandId(req).catch(() => null),
      kind: 'bg',
      model: model.id,
      prompt,
      aspect,
      credits: usingOwnKey ? 0 : price,
      bytes: buf,
      fileName: file,
    });
    const dir = join(dataDir(), 'covers');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), buf);

    // credits were already deducted by the reservation above (one transaction with the check)
    const balance = await this.credits.balance(userId);
    return {
      url: `/blogwriter/covers/${file}?t=${Date.now()}`,
      imageId,
      model: model.id,
      credits: usingOwnKey ? 0 : price,
      balance: balance.balance,
      usingOwnKey,
    };
  }

  /* ------------------------------------------------------ studio templates */

  /** User's saved templates (used to live in the browser's localStorage). */
  @Get('preview/scenes')
  async scenes(@Req() req: Request) {
    return { scenes: await listScenes(this.userId(req)) };
  }

  /** Save a template. { name, scene } → catalog entry. */
  @Post('preview/scenes')
  async addScene(@Req() req: Request, @Body() body: { name?: string; scene?: any }) {
    const userId = this.userId(req);
    const scene = body?.scene;
    if (!scene || typeof scene !== 'object' || !Array.isArray(scene.objects)) {
      throw new BadRequestException('a canvas scene is required');
    }
    const brandId = await this.brandCtx.brandId(req).catch(() => null);
    const saved = await saveScene(userId, String(body?.name || '').trim(), scene, brandId);
    if (!saved) throw new BadGatewayException('failed to save the template');
    return saved;
  }

  /** Delete your own template. */
  @Delete('preview/scenes/:id')
  async removeScene(@Req() req: Request, @Param('id') id: string) {
    const ok = await deleteScene(this.userId(req), Number(id));
    if (!ok) throw new NotFoundException('template not found');
    return { ok: true };
  }

  /**
   * The user's generation history — what was drawn and with which model.
   * ?kind=bg — studio backgrounds only (the "already generated" gallery), 'cover' —
   * finished article covers; no param — everything.
   */
  @Get('preview/images')
  async images(@Req() req: Request, @Query('kind') kind?: string) {
    const k = kind === 'bg' || kind === 'cover' ? kind : undefined;
    return { images: await listImages(this.userId(req), k) };
  }

  /** Translate short preview strings to a language (for multilingual versions).
   *  { texts: string[], targetLang } → { texts: string[] } (same order/length). */
  @Post('preview/translate')
  async translate(@Req() req: Request, @Body() body: { texts?: string[]; targetLang?: string }) {
    this.userId(req);
    const texts = Array.isArray(body?.texts) ? body!.texts.slice(0, 60).map((t) => String(t ?? '')) : [];
    if (!texts.length) throw new BadRequestException('no strings to translate');
    const langName = findLanguage(body?.targetLang || '')?.prompt || (body?.targetLang || 'английский');

    const s = await resolveSettings(await this.brandCtx.brandId(req));
    const llm = new LLM(s);
    // number the non-empty strings and translate them in one request; leave empty ones untouched
    const idx = texts.map((t, i) => [i, t] as const).filter(([, t]) => t.trim());
    const out = texts.slice();
    if (idx.length) {
      const system = 'Ты — переводчик-локализатор коротких строк для дизайна превью (заголовки, подписи, плашки). '
        + 'Переводишь кратко и естественно, сохраняя тон. НЕ переводишь названия брендов/продуктов, числа, коды и URL.';
      const prompt = `Переведи каждую строку на ${langName}. Строки — элементы дизайна (заголовок/подпись/кнопка), держи их КОРОТКИМИ.\n`
        + 'Верни РОВНО по одной строке на элемент в формате «[[номер]] перевод», без пояснений:\n\n'
        + idx.map(([i, t]) => `[[${i}]] ${t.replace(/\n/g, ' ')}`).join('\n');
      try {
        const res = await llm.complete(prompt, { system, maxTokens: 1500, temperature: 0.3 });
        for (const line of res.split('\n')) {
          const m = line.match(/^\s*\[\[(\d+)\]\]\s*(.*)$/);
          if (m) { const i = Number(m[1]); if (i >= 0 && i < out.length && m[2].trim()) out[i] = m[2].trim(); }
        }
      } catch (e: any) {
        throw new BadGatewayException(e?.message || 'translation failed');
      }
    }
    return { texts: out, mock: llm.isMock };
  }
}
