import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PlanGuard } from '../../auth/plan.guard';
import { LoginGuard } from '../../auth/login.guard';
import { LlmRateGuard } from '../llm-rate.guard';
import { saveSettings } from '../server/utils/store';
import { resolveSettings, BRAND_SAVABLE_KEYS, SETTING_DEFAULTS, type AppSettings } from '../server/utils/appSettings';
import { checkPublicHttpsUrl } from '../server/utils/safeUrl';
import { getUnifiedCatalog, modelsForKeys } from '../server/utils/modelCatalog';
import { LLM } from '../server/utils/llm';
import { crawlBrand, composeVoice, ensureBrandVoice, hasBrandVoice, brandKnowledgeCrawl } from '../server/utils/brandVoice';
import { BlogBrandContext } from '../brand-context';

// fields coming from the "Settings" form (allow-list)
const STRING_KEYS = new Set([
  'openrouterApiKey', 'anthropicApiKey', 'geminiApiKey', 'provider', 'modelStrong', 'modelFast', 'modelResearch',
  'language', 'tone', 'persona', 'requirements', 'delivery', 'brand', 'brandFacts', 'author', 'categories', 'siteUrl',
  'extPublishUrl', 'extPublishAuthHeader', 'extPublishToken',
  // cross-posting: Telegram channel (bot token is a secret) + Dzen link
  'tgBotToken', 'tgChannel', 'dzenChannelUrl',
  'devtoApiKey', 'blueskyHandle', 'blueskyAppPassword',
  'wpMode', 'wpSiteUrl', 'wpUser', 'wpAppPassword',
  // Mastodon (instance + token), Ghost (Admin API key), Telegraph (token + signature)
  'mastodonInstance', 'mastodonToken',
  'ghostSiteUrl', 'ghostAdminKey',
  'telegraphToken', 'telegraphAuthorName',
]);
const NUMBER_KEYS = new Set([
  'maxSources', 'maxPerspectives', 'slopThreshold', 'slopMaxRewrites', 'targetWords', 'minCitations',
]);

/**
 * What settings can even be sent to the browser at all. Deliberately an ALLOW-LIST, not
 * `{...s}` with secrets scrubbed out one by one: the response used to be built with a spread,
 * and every new key added to AppSettings leaked out by default — that's how the provider
 * keys (secrets shared by the WHOLE platform, not per brand) ended up sent in
 * plaintext to any pro user. Here, a new secret doesn't reach anywhere by default,
 * and a forgotten non-secret field, at worst, just won't show up in the form.
 *
 * Whether a secret is set is shown via separate has-fields and masks (see getSettings).
 */
const PUBLIC_KEYS = [
  'provider', 'modelStrong', 'modelFast', 'modelResearch',
  'language', 'tone', 'persona', 'requirements', 'delivery', 'brand', 'brandFacts',
  'minCitations', 'author', 'categories', 'siteUrl',
  'maxSources', 'maxQueries', 'postsPerQuery', 'maxPerDomain', 'maxPerspectives',
  'fetchTimeoutMs', 'slopThreshold', 'slopMaxRewrites', 'targetWords', 'mock',
  'extPublishEnabled', 'extPublishUrl', 'extPublishAuthHeader',
  'tgPublishEnabled', 'tgChannel',
  'dzenEnabled', 'dzenChannelUrl',
  'devtoEnabled',
  'blueskyEnabled', 'blueskyHandle',
  'wpEnabled', 'wpMode', 'wpSiteUrl', 'wpUser',
  'mastodonEnabled', 'mastodonInstance',
  'ghostEnabled', 'ghostSiteUrl',
  'telegraphEnabled', 'telegraphAuthorName',
] as const satisfies readonly (keyof AppSettings)[];

/** The non-secret part of the settings, for the form. */
export function publicSettings(s: AppSettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_KEYS) out[k] = s[k];
  return out;
}

@Controller('blogwriter')
@UseGuards(LoginGuard) // the agent profile is open to all logged-in users (decision 09.08.2026); the plan gate stays only on the expensive endpoints
export class SettingsController {
  constructor(private readonly brandCtx: BlogBrandContext) {}

  /** Current settings for the active brand's form (the key is masked). */
  @Get('settings')
  async getSettings(@Req() req: Request) {
    const brand = await this.brandCtx.brand(req);
    const s = await resolveSettings(brand?.id ?? 0);
    // the brand has no voice of its own — compose it in the background (site crawl + LLM);
    // the form will show neutral defaults for now, its own voice after the next reload
    const hasOwnVoice = brand?.id ? await hasBrandVoice(brand.id) : false;
    if (brand?.id && !hasOwnVoice) void ensureBrandVoice(brand.id);
    return {
      hasOwnVoice,
      // only the allow-listed fields — no secret leaves for the browser
      ...publicSettings(s),
      hasApiKey: !!s.apiKey,
      apiKeyMasked: s.apiKey ? s.apiKey.slice(0, 8) + '…' + s.apiKey.slice(-4) : '',
      // provider keys are shared across the whole platform: only expose whether one is set
      hasAnthropicKey: !!s.anthropicKey,
      hasOpenrouterKey: !!s.openrouterKey,
      // Google AI Studio key: Gemini image generation runs on it
      hasGeminiKey: !!s.geminiKey,
      geminiKeyMasked: s.geminiKey ? s.geminiKey.slice(0, 6) + '…' + s.geminiKey.slice(-4) : '',
      // don't hand over the autopublish secret — only whether it's set
      hasExtPublishToken: !!s.extPublishToken,
      extPublishTokenMasked: s.extPublishToken ? s.extPublishToken.slice(0, 4) + '…' + s.extPublishToken.slice(-4) : '',
      // Telegram bot token is also a secret: only expose whether it's set + a mask
      hasTgBotToken: !!s.tgBotToken,
      tgBotTokenMasked: s.tgBotToken ? s.tgBotToken.slice(0, 6) + '…' + s.tgBotToken.slice(-4) : '',
      hasDevtoApiKey: !!s.devtoApiKey,
      devtoApiKeyMasked: s.devtoApiKey ? s.devtoApiKey.slice(0, 4) + '…' + s.devtoApiKey.slice(-4) : '',
      hasBlueskyAppPassword: !!s.blueskyAppPassword,
      blueskyAppPasswordMasked: s.blueskyAppPassword ? '••••-••••-••••-' + s.blueskyAppPassword.slice(-4) : '',
      hasWpAppPassword: !!s.wpAppPassword,
      hasWpOauthToken: !!s.wpOauthToken,
      wpAppPasswordMasked: s.wpAppPassword ? '••••••' + s.wpAppPassword.replace(/\s+/g, '').slice(-4) : '',
      hasMastodonToken: !!s.mastodonToken,
      mastodonTokenMasked: s.mastodonToken ? s.mastodonToken.slice(0, 4) + '…' + s.mastodonToken.slice(-4) : '',
      // Ghost Admin API key — id:secret; the id isn't secret, the secret part is: mask it whole
      hasGhostAdminKey: !!s.ghostAdminKey,
      ghostAdminKeyMasked: s.ghostAdminKey ? s.ghostAdminKey.split(':')[0] + ':••••' + s.ghostAdminKey.slice(-4) : '',
      hasTelegraphToken: !!s.telegraphToken,
      telegraphTokenMasked: s.telegraphToken ? s.telegraphToken.slice(0, 4) + '…' + s.telegraphToken.slice(-4) : '',
      // context of the brand the voice/autopublish settings are attached to
      brandId: brand?.id ?? 0,
      brandDomain: brand?.domain ?? '',
      brandName: brand?.name ?? '',
    };
  }

  /**
   * Save settings from the UI. Voice/autopublish keys (PER_BRAND_KEYS) are written
   * into the active brand's scope, everything else (provider/keys/models/pipeline) is
   * account-wide (brandId=0), shared by all brands.
   */
  @Patch('settings')
  async patchSettings(@Req() req: Request, @Body() body: Record<string, unknown>) {
    await this.brandCtx.assertBrandMutate(req); // a viewer doesn't edit brand settings
    const brandId = await this.brandCtx.brandId(req);
    const perBrand: Record<string, string> = {};
    const global: Record<string, string> = {};
    let extIgnored = false;
    const put = (k: string, val: string) => {
      // BRAND_SAVABLE_KEYS, not PER_BRAND_KEYS: this also includes keys where
      // global stays a fallback (model/volume/citations) — the "Agent Profile"
      // saves these under the brand, and they used to get silently lost for non-admins.
      if (BRAND_SAVABLE_KEYS.has(k) && brandId) perBrand[k] = val;
      // Autopublish is STRICTLY per-brand: with no active brand there's nowhere to hang it on —
      // an account-wide config (brand_id=0) was deliberately removed (see migration
      // 20260715_ext_publish_empty_default.sql), so silently writing there is not allowed.
      else if (k.startsWith('extPublish') || k.startsWith('tg') || k.startsWith('dzen')) extIgnored = true;
      else global[k] = val;
    };
    for (const [k, v] of Object.entries(body ?? {})) {
      if (STRING_KEYS.has(k) && typeof v === 'string') {
        // an empty secret doesn't overwrite the saved one (an empty field in the form = "don't change")
        if ((k === 'openrouterApiKey' || k === 'anthropicApiKey' || k === 'geminiApiKey' || k === 'extPublishToken'
          || k === 'tgBotToken' || k === 'devtoApiKey' || k === 'blueskyAppPassword' || k === 'wpAppPassword'
          || k === 'mastodonToken' || k === 'ghostAdminKey' || k === 'telegraphToken') && !v.trim()) continue;
        if (k === 'wpMode' && v !== 'app' && v !== 'oauth') continue;
        if (k === 'provider' && v !== 'anthropic' && v !== 'openrouter') continue;
        // The ingest receiver base: our own server calls out to it, so the address must
        // be a public https URL (otherwise autopublish becomes an SSRF primitive —
        // see wordpressPublish.ts, which has the same check). An empty string resets it.
        if (k === 'extPublishUrl' && v.trim()) {
          const chk = checkPublicHttpsUrl(v);
          if (!chk.ok) throw new BadRequestException(`Autopublish address rejected: ${chk.error}`);
          put(k, chk.url!);
          continue;
        }
        // A voice matching the global default = "the user hasn't changed anything": do NOT
        // persist it per-brand. Otherwise the very first "Save" (including an implicit one —
        // before an autopublish test/import) would lock in the neutral default as the
        // brand's "own voice" and permanently silence ensureBrandVoice's autogeneration
        // (and a stale form with defaults would overwrite an already-composed voice).
        if (brandId && (k === 'tone' || k === 'persona' || k === 'categories')
          && v.trim() === (SETTING_DEFAULTS as Record<string, unknown>)[k]) continue;
        put(k, v.trim());
      } else if (NUMBER_KEYS.has(k) && Number.isFinite(Number(v))) {
        put(k, String(Number(v)));
      } else if ((k === 'mock' || k === 'extPublishEnabled' || k === 'tgPublishEnabled'
        || k === 'dzenEnabled' || k === 'devtoEnabled' || k === 'blueskyEnabled' || k === 'wpEnabled'
        || k === 'mastodonEnabled' || k === 'ghostEnabled' || k === 'telegraphEnabled') && (v === true || v === false)) {
        put(k, v ? '1' : '0');
      }
    }
    if (Object.keys(perBrand).length) await saveSettings(perBrand, brandId);
    // Account-wide keys (provider, LLM keys, models, pipeline thresholds) are
    // shared across the whole platform: only an admin may change them. Otherwise any
    // pro user could swap out/burn through the shared provider key or switch the provider for everyone.
    // Non-admins can only edit per-brand (voice/autopublish); global changes are silently ignored.
    const globalSaved = Object.keys(global).length > 0 && this.brandCtx.isAdmin(req);
    if (globalSaved) await saveSettings(global, 0);
    return { ok: true, globalIgnored: Object.keys(global).length > 0 && !globalSaved, extIgnored };
  }

  /**
   * The unified model catalog (Anthropic + OpenRouter) with prices ($/1M) and each
   * model's provider route. The same list the assistant uses. ?refresh=1 forces a refresh.
   *
   * default is the brand's strong model: the action runs on it if the UI didn't pick
   * one explicitly. Returned together with the catalog so the selector immediately shows
   * the SPECIFIC model instead of an "as in settings" entry (which doesn't tell you what
   * actually runs).
   */
  @Get('models/catalog')
  async catalogModels(@Req() req: Request, @Query('refresh') refresh?: string) {
    const [cat, s] = await Promise.all([
      getUnifiedCatalog(refresh === '1'),
      resolveSettings(await this.brandCtx.brandId(req)),
    ]);
    // only show what will actually work with the current keys: without an OpenRouter key
    // everything outside Claude has nowhere to run
    const models = modelsForKeys(cat.models, { anthropicKey: s.anthropicKey, orKey: s.openrouterKey });
    return { ...cat, models, default: s.modelStrong };
  }

  /**
   * "Blog voice" from the brand's OWN SITE: crawl the active brand's domain, the LLM composes
   * a voice (brand/tone/persona/requirements/categories/language). save=true saves it straight
   * into per-brand settings, otherwise it's returned for review (the frontend fills in the form).
   * Tied to the active brand's domain — no manual presets.
   */
  @Post('voice/analyze')
  @UseGuards(PlanGuard, LlmRateGuard)
  @HttpCode(200)
  async analyzeVoice(@Req() req: Request, @Body() body: { save?: boolean; maxPages?: number }) {
    await this.brandCtx.assertBrandMutate(req); // a viewer doesn't run voice analysis/save
    const brand = await this.brandCtx.brand(req);
    if (!brand?.domain) throw new BadRequestException('no active brand with a domain');
    const s = await resolveSettings(brand.id);
    const llm = new LLM(s);
    if (llm.isMock) throw new ConflictException('an LLM key is required (mock mode) — set ANTHROPIC_API_KEY or OPENROUTER_API_KEY in the Admin panel');

    let crawl = await crawlBrand(brand.domain, { maxPages: Math.min(Number(body?.maxPages) || 10, 15) });
    // the site can't be parsed (bot protection/JS rendering) — compose from the brand's
    // onboarding data + the LLM's knowledge of the domain instead of failing with a 422
    if (!crawl.text || !crawl.pages.length) crawl = brandKnowledgeCrawl(brand, s.language);
    const voice = await composeVoice(brand.domain, crawl, llm, s);

    if (body?.save) {
      await saveSettings(
        {
          brand: voice.brand,
          tone: voice.tone,
          persona: voice.persona,
          requirements: voice.requirements,
          categories: voice.categories,
          language: voice.language,
        },
        brand.id,
      );
    }
    return { ...voice, domain: brand.domain, pages: crawl.pages, pagesCrawled: crawl.pages.length };
  }
}
