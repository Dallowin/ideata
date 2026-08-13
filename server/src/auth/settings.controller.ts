import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminGuard } from './admin.guard';

/**
 * Instance settings for the OWNER (self-host): provider and integration keys.
 * Written to app_settings, from which getSettingKey reads ON TOP OF .env — without
 * them, runs/integrations don't work. Access is gated by AdminGuard (owner = the
 * first registered user, see auth.service.registerEmail). Secret values are NEVER
 * returned to the client — only "configured/not" + the last 4 characters.
 */
interface KeySpec {
  key: string;
  label: string;
  group: 'llm' | 'seo' | 'mail' | 'integrations';
  hint?: string;
  required?: boolean;
  help?: string; // link to "where to get the key"
}

export const SETTING_KEYS: KeySpec[] = [
  { key: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', group: 'llm', required: true, hint: 'chatgpt / claude / gemini / deepseek / grok / perplexity одним ключом', help: 'https://openrouter.ai/keys' },
  { key: 'DATAFORSEO_LOGIN', label: 'DataForSEO login', group: 'seo', hint: 'конкуренты и объёмы (опц.)', help: 'https://app.dataforseo.com/api-access' },
  { key: 'DATAFORSEO_PASSWORD', label: 'DataForSEO password', group: 'seo', help: 'https://app.dataforseo.com/api-access' },
  { key: 'KEYSSO_API_KEY', label: 'KeysSo API key', group: 'seo', hint: 'keyword-подсказки (опц.)', help: 'https://keys.so/dashboard/api' },
  { key: 'RESEND_API_KEY', label: 'Resend API key', group: 'mail', hint: 'недельные отчёты по email (опц.)', help: 'https://resend.com/api-keys' },
  { key: 'SMTP_FROM', label: 'From-адрес писем', group: 'mail', hint: 'напр. noreply@ваш-домен' },
  // ── "Integrations" tab entries (provider OAuth apps) ────────────────────────
  { key: 'YANDEX_CLIENT_ID', label: 'Яндекс.Метрика · Client ID', group: 'integrations', hint: 'OAuth-приложение Яндекса', help: 'https://oauth.yandex.ru/client/new' },
  { key: 'YANDEX_CLIENT_SECRET', label: 'Яндекс.Метрика · Client Secret', group: 'integrations' },
  { key: 'YANDEX_REDIRECT_URI', label: 'Яндекс.Метрика · Redirect URI', group: 'integrations', hint: 'должен совпадать с приложением: {адрес}/metrika/callback' },
  { key: 'GOOGLE_CLIENT_ID', label: 'Search Console · Client ID', group: 'integrations', hint: 'OAuth Google + вкл. Search Console API', help: 'https://console.cloud.google.com/apis/credentials' },
  { key: 'GOOGLE_CLIENT_SECRET', label: 'Search Console · Client Secret', group: 'integrations' },
  { key: 'GSC_REDIRECT_URI', label: 'Search Console · Redirect URI', group: 'integrations', hint: 'должен совпадать с приложением: {адрес}/gsc/callback' },
  // ── Blog Writer cross-posting (social OAuth apps + Telegram bot) ─────────────
  { key: 'X_CLIENT_ID', label: 'X (Twitter) · Client ID', group: 'integrations', hint: 'OAuth 2.0 app; scopes tweet.write users.read offline.access', help: 'https://developer.x.com/en/portal/dashboard' },
  { key: 'X_CLIENT_SECRET', label: 'X (Twitter) · Client Secret', group: 'integrations' },
  { key: 'X_REDIRECT_URI', label: 'X (Twitter) · Redirect URI', group: 'integrations', hint: '{адрес}/x/callback' },
  { key: 'LINKEDIN_CLIENT_ID', label: 'LinkedIn · Client ID', group: 'integrations', hint: 'продукт «Share on LinkedIn»', help: 'https://www.linkedin.com/developers/apps' },
  { key: 'LINKEDIN_CLIENT_SECRET', label: 'LinkedIn · Client Secret', group: 'integrations' },
  { key: 'LINKEDIN_REDIRECT_URI', label: 'LinkedIn · Redirect URI', group: 'integrations', hint: '{адрес}/linkedin/callback' },
  { key: 'THREADS_APP_ID', label: 'Threads · App ID', group: 'integrations', hint: 'Meta-приложение, use case «Threads API»', help: 'https://developers.facebook.com/apps' },
  { key: 'THREADS_APP_SECRET', label: 'Threads · App Secret', group: 'integrations' },
  { key: 'THREADS_REDIRECT_URI', label: 'Threads · Redirect URI', group: 'integrations', hint: '{адрес}/threads/callback' },
];

function maskTail(v: string): string {
  const s = v.trim();
  if (!s) return '';
  return s.length <= 4 ? '••••' : '••••' + s.slice(-4);
}

/**
 * Engines. Each one's model is an override of AEO_<ENGINE>_MODEL (getSettingKey).
 *   • openrouter=true: available on OpenRouter (vendor is the catalog prefix for
 *     the dropdown); in native mode uses its own provider key (nativeKeys).
 *   • openrouter=false: native only (GigaChat/Yandex — not on OpenRouter), model
 *     comes from presetModels, provider key(s) always required. help — where to get the key.
 */
interface EngineSpec {
  slug: string;
  label: string;
  key: string; // AEO_<ENGINE>_MODEL
  vendor: string; // OpenRouter catalog prefix ('' for native ones)
  default: string;
  openrouter: boolean;
  nativeKeys: string[];
  presetModels: string[];
  help: string;
}

export const ENGINE_SPECS: EngineSpec[] = [
  { slug: 'chatgpt', label: 'ChatGPT', key: 'AEO_CHATGPT_MODEL', vendor: 'openai/', default: 'openai/gpt-4o-mini', openrouter: true, nativeKeys: ['OPENAI_API_KEY'], presetModels: [], help: 'https://platform.openai.com/api-keys' },
  { slug: 'claude', label: 'Claude', key: 'AEO_CLAUDE_MODEL', vendor: 'anthropic/', default: 'anthropic/claude-haiku-4.5', openrouter: true, nativeKeys: ['ANTHROPIC_API_KEY'], presetModels: [], help: 'https://console.anthropic.com/settings/keys' },
  { slug: 'gemini', label: 'Gemini', key: 'AEO_GEMINI_MODEL', vendor: 'google/', default: 'google/gemini-2.5-flash', openrouter: true, nativeKeys: ['GEMINI_API_KEY'], presetModels: [], help: 'https://aistudio.google.com/app/apikey' },
  { slug: 'deepseek', label: 'DeepSeek', key: 'AEO_DEEPSEEK_MODEL', vendor: 'deepseek/', default: 'deepseek/deepseek-chat', openrouter: true, nativeKeys: ['DEEPSEEK_API_KEY'], presetModels: [], help: 'https://platform.deepseek.com/api_keys' },
  { slug: 'grok', label: 'Grok', key: 'AEO_GROK_MODEL', vendor: 'x-ai/', default: 'x-ai/grok-2', openrouter: true, nativeKeys: ['XAI_API_KEY'], presetModels: [], help: 'https://console.x.ai' },
  { slug: 'perplexity', label: 'Perplexity', key: 'AEO_PERPLEXITY_MODEL', vendor: 'perplexity/', default: 'perplexity/sonar', openrouter: true, nativeKeys: ['PERPLEXITY_API_KEY'], presetModels: [], help: 'https://www.perplexity.ai/account/api/keys' },
  { slug: 'gigachat', label: 'GigaChat', key: 'AEO_GIGACHAT_MODEL', vendor: '', default: 'GigaChat', openrouter: false, nativeKeys: ['GIGACHAT_API_KEY'], presetModels: ['GigaChat', 'GigaChat-Pro', 'GigaChat-Max'], help: 'https://developers.sber.ru/studio' },
  { slug: 'yandex', label: 'Yandex GPT', key: 'AEO_YANDEX_MODEL', vendor: '', default: 'yandexgpt-lite', openrouter: false, nativeKeys: ['YANDEX_SEARCH_API_KEY', 'YANDEX_CLOUD_FOLDER_ID'], presetModels: ['yandexgpt-lite', 'yandexgpt'], help: 'https://console.yandex.cloud' },
];

const ENGINE_KEYS = ENGINE_SPECS.map((e) => e.key);
const NATIVE_KEYS = ENGINE_SPECS.flatMap((e) => e.nativeKeys);
// Run mode: 'openrouter' (one key for all) | 'native' (each engine's own key).
const PROVIDER_MODE_KEY = 'AEO_PROVIDER_MODE';

// OpenRouter model catalog with an hourly cache (public list, no key needed).
let modelCache: { at: number; models: { id: string; label: string }[] } | null = null;
async function openrouterModels(): Promise<{ id: string; label: string }[]> {
  if (modelCache && Date.now() - modelCache.at < 3_600_000) return modelCache.models;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) return modelCache?.models ?? [];
    const data = (await res.json()) as { data?: Array<{ id?: string; name?: string }> };
    const models = (data?.data ?? [])
      .map((m) => ({
        id: String(m?.id || ''),
        label: String(m?.name || m?.id || '').replace(/^[^:]+:\s*/, '').trim(),
      }))
      .filter((m) => m.id.includes('/'));
    modelCache = { at: Date.now(), models };
    return models;
  } catch {
    return modelCache?.models ?? [];
  }
}

@Controller('api/settings')
@UseGuards(AdminGuard)
export class SettingsController {
  constructor(private readonly prisma: PrismaService) {}

  /** Status of each key: whether configured, its source (app_settings/env), and value tail. */
  @Get('keys')
  async list() {
    const rows = await this.prisma.appSetting.findMany({
      where: { key: { in: SETTING_KEYS.map((k) => k.key) } },
    });
    const byKey = new Map(rows.map((r) => [r.key, (r.value || '').trim()]));
    const updAt = new Map(rows.map((r) => [r.key, r.updatedAt]));
    return {
      keys: SETTING_KEYS.map((spec) => {
        const dbVal = byKey.get(spec.key) || '';
        const envVal = (process.env[spec.key] || '').trim();
        const effective = dbVal || envVal;
        const ua = updAt.get(spec.key);
        return {
          key: spec.key,
          label: spec.label,
          group: spec.group,
          hint: spec.hint ?? null,
          help: spec.help ?? null,
          required: !!spec.required,
          configured: !!effective,
          updatedAt: dbVal && ua ? new Date(ua).toISOString() : null,
          source: dbVal ? 'app_settings' : envVal ? 'env' : 'unset',
          preview: maskTail(effective),
        };
      }),
    };
  }

  /**
   * Save keys to app_settings. An empty value = clear the row (falls back to
   * .env if set there). Unknown keys are ignored. Effect takes up to 60s
   * (getAppSettings cache); new runs see it right away once the cache is reset.
   */
  @Post('keys')
  async save(@Body() body: Record<string, unknown>) {
    const allowed = new Set([
      ...SETTING_KEYS.map((k) => k.key),
      ...ENGINE_KEYS,
      ...NATIVE_KEYS,
      PROVIDER_MODE_KEY,
    ]);
    let saved = 0;
    for (const [key, raw] of Object.entries(body || {})) {
      if (!allowed.has(key)) continue;
      const value = String(raw ?? '').trim();
      if (!value) {
        await this.prisma.appSetting.deleteMany({ where: { key } });
      } else {
        await this.prisma.appSetting.upsert({
          where: { key },
          create: { key, value },
          update: { value },
        });
      }
      saved += 1;
    }
    return { ok: true, saved };
  }

  /** Current model for each engine (app_settings → env → default). */
  @Get('engines')
  async engines() {
    const keys = [...ENGINE_KEYS, ...NATIVE_KEYS, PROVIDER_MODE_KEY];
    const rows = await this.prisma.appSetting.findMany({ where: { key: { in: keys } } });
    const byKey = new Map(rows.map((r) => [r.key, (r.value || '').trim()]));
    const updAt = new Map(rows.map((r) => [r.key, r.updatedAt]));
    const eff = (k: string) => byKey.get(k) || (process.env[k] || '').trim();
    const lastUpdated = (ks: string[]): string | null => {
      const ts = ks.map((k) => updAt.get(k)).filter(Boolean).map((d) => +new Date(d as Date));
      return ts.length ? new Date(Math.max(...ts)).toISOString() : null;
    };
    const mode = eff(PROVIDER_MODE_KEY).toLowerCase() === 'native' ? 'native' : 'openrouter';
    return {
      mode,
      engines: ENGINE_SPECS.map((e) => {
        const dbVal = byKey.get(e.key) || '';
        const envVal = (process.env[e.key] || '').trim();
        const native = e.nativeKeys.map((nk) => {
          const v = eff(nk);
          return { key: nk, configured: !!v, preview: maskTail(v) };
        });
        return {
          slug: e.slug,
          label: e.label,
          key: e.key,
          vendor: e.vendor,
          default: e.default,
          openrouter: e.openrouter,
          presetModels: e.presetModels,
          help: e.help,
          model: dbVal || envVal || e.default,
          // configured = the operator explicitly chose it (app_settings); otherwise default.
          configured: !!dbVal,
          source: dbVal ? 'app_settings' : envVal ? 'env' : 'default',
          // the engine's native provider key(s) (+ status of each).
          native,
          nativeReady: native.every((n) => n.configured),
          // when it was last changed (model or native key) — for "last updated".
          updatedAt: lastUpdated([e.key, ...e.nativeKeys]),
        };
      }),
    };
  }

  /** Parsed list of OpenRouter models (id + label) for dropdowns. */
  @Get('models')
  async models() {
    return { models: await openrouterModels() };
  }
}
