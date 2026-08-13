/**
 * Pipeline settings (port of blog_agent/config.py): env defaults from runtimeConfig,
 * overridden by values from the settings table (edited on the "Settings" page).
 */
import { allSettings, getAppSettings } from './store'
import { blogPrisma } from './prisma'
import type { LlmUsageContext } from './llmUsage'

// Settings that belong to a SPECIFIC brand (voice + auto-publishing).
// Everything else (provider/keys/models/pipeline knobs) is account-wide (brandId=0),
// shared across all brands. The settings controller splits saving by scope.
export const PER_BRAND_KEYS = new Set([
  'brand', 'brandFacts', 'siteUrl', 'language', 'tone', 'persona', 'requirements', 'delivery', 'author', 'categories',
  'extPublishEnabled', 'extPublishUrl', 'extPublishAuthHeader', 'extPublishToken',
  // cross-posting: Telegram channel (user's own bot) + Dzen (still a stub link)
  'tgPublishEnabled', 'tgBotToken', 'tgChannel',
  'dzenEnabled', 'dzenChannelUrl',
  // dev.to: publishing an article with the brand's personal key, canonical points to the original
  'devtoEnabled', 'devtoApiKey',
  // Bluesky: post announcement via an app password (not the account's main password)
  'blueskyEnabled', 'blueskyHandle', 'blueskyAppPassword',
  // WordPress: application password (any self-hosted) or OAuth via WordPress.com
  // (which also covers self-hosted via Jetpack)
  'wpEnabled', 'wpMode', 'wpSiteUrl', 'wpUser', 'wpAppPassword', 'wpOauthToken',
  // Mastodon: instance URL + app token (federation means there's no single host)
  'mastodonEnabled', 'mastodonInstance', 'mastodonToken',
  // Ghost: Admin API key in id:secret form, used to issue a JWT
  'ghostEnabled', 'ghostSiteUrl', 'ghostAdminKey',
  // Telegraph: the token can only be obtained via createAccount — they have no UI for it
  'telegraphEnabled', 'telegraphToken', 'telegraphAuthorName',
])

/**
 * Keys that CAN be saved in a brand's scope, but for which the account-wide
 * value remains a FALLBACK. The difference from PER_BRAND_KEYS is essential:
 * PER_BRAND_KEYS also get stripped from the base on merge (strictly each
 * brand's own), while these don't — so a brand without its own value keeps
 * falling back to the global one (shared model, shared target word count).
 *
 * Needed for the "Agent Profile": it sends modelStrong/targetWords/minCitations
 * for a specific brand, and since those weren't per-brand, for a non-admin they
 * silently fell into the global bucket and got discarded there (only an admin
 * can edit global).
 */
export const BRAND_SAVABLE_KEYS = new Set([
  ...PER_BRAND_KEYS,
  'modelStrong', 'targetWords', 'minCitations',
])

export interface AppSettings {
  provider: 'kie' | 'openrouter'
  apiKey: string // key of the ACTIVE provider
  kieKey: string // kie key (for per-model routing: Claude runs cheaply through kie)
  openrouterKey: string // OpenRouter key (everything that isn't Claude: deepseek/qwen/…)
  modelStrong: string
  modelFast: string
  modelResearch: string // research (search queries + theses) — separate model, defaults to Gemini
  language: string
  tone: string
  persona: string // agent's system persona (who's writing and to what end)
  requirements: string // hard requirements for every article (disclaimers, guardrails)
  delivery: string // "delivery and uniqueness": how to write specifically for this brand so the text feels distinctly its own (positioning, voice, stance)
  brand: string
  brandFacts: string // REAL facts about the brand/product — the only legitimate source of "our experience" (E-E-A-T Experience)
  minCitations: number // minimum external source links in an article (E-E-A-T gate)
  author: string // default post author (empty → "{brand} editorial team")
  categories: string // comma-separated list of categories (hints in the editor)
  siteUrl: string // public blog URL for share links (e.g. https://example.com)
  maxSources: number
  maxQueries: number // how many search queries to generate per topic (research fan-out)
  postsPerQuery: number // how many posts to take from results per query
  maxPerDomain: number // max posts from a single domain (so one blog doesn't dominate)
  maxPerspectives: number
  fetchTimeoutMs: number
  slopThreshold: number
  slopMaxRewrites: number
  targetWords: number
  mock: boolean
  // auto-publish to an external REST API (webhook)
  extPublishEnabled: boolean
  extPublishUrl: string
  extPublishAuthHeader: string
  extPublishToken: string
  // cross-posting to a Telegram channel via the user's own per-brand bot (not the login bot)
  tgPublishEnabled: boolean
  tgBotToken: string // @BotFather bot token (secret)
  tgChannel: string // @username or -100…id of the channel where the bot is an admin
  // cross-posting to Dzen — for now just a flag + channel link (publishing isn't automated)
  dzenEnabled: boolean
  dzenChannelUrl: string
  /** dev.to: official API by key, the only platform of this size
   *  with canonical_url support — the copy links back to the original instead of competing with it */
  devtoEnabled: boolean
  devtoApiKey: string // secret from dev.to settings (Account → Extensions → API keys)
  /** Bluesky: the only live social network where programmatic publishing of
   *  your own content is standard — no review, no money, no rule-bending */
  blueskyEnabled: boolean
  blueskyHandle: string // name.bsky.social or a custom domain
  blueskyAppPassword: string // secret: Settings → App Passwords
  /**
   * WordPress. Two ways to reach the same thing:
   *  · 'app'   — application password, works on any self-hosted install without plugins;
   *  · 'oauth' — WordPress.com, which also covers self-hosted via Jetpack.
   */
  wpEnabled: boolean
  wpMode: 'app' | 'oauth'
  wpSiteUrl: string
  wpUser: string
  wpAppPassword: string // secret
  wpOauthToken: string // secret; issued by WordPress.com's OAuth flow
  /** Mastodon: federation means the instance URL is user-supplied. Programmatic
   *  publishing of your own content there is standard — no app review and no money */
  mastodonEnabled: boolean
  mastodonInstance: string // https://mastodon.social etc.
  mastodonToken: string // secret: Settings → Development → application (write:statuses)
  /** Ghost: Admin API key in id:secret form; requests are signed with a short-lived JWT */
  ghostEnabled: boolean
  ghostSiteUrl: string
  ghostAdminKey: string // secret
  /** Telegraph: there's no token at all in their UI — we create the account on the user's behalf */
  telegraphEnabled: boolean
  telegraphToken: string // secret; issued by createAccount
  telegraphAuthorName: string // byline under the article (empty → brand name)
  // Brand context for LLM cost tracking (owner + domain). Passed down to the LLM,
  // which appends run_id. Only present when resolveSettings was called with a brand.
  usage?: LlmUsageContext
}

export const SETTING_DEFAULTS = {
  language: 'ru',
  tone: 'экспертный, без воды, конкретный, с примерами; пишем для практиков, а не для SEO-роботов',
  // Neutral placeholder persona, until ensureBrandVoice composes the brand's OWN
  // voice. The opening is deliberately NOT like the old "insane" preset ("You are
  // an SEO/AEO specialist with 10 years of experience…") — an identical opening
  // was mistaken for "the insane template again". Structured system prompt (in the
  // style of LobeHub agent): sections via markdown headings. The front-end profile
  // shows this as a single document; the pipeline injects it into each step's system prompt.
  persona: [
    '# Роль',
    'Ты — senior-редактор блога бренда и практик AEO: владеешь ремеслом от начала до конца — '
      + 'исследование темы, архитектура нарратива, инженерия заголовков, читательский опыт на странице, '
      + 'ведение контент-плана и разбор аналитики после публикации. Пишешь для людей в первую очередь и '
      + 'для AI-движков во вторую, и оцениваешь каждый абзац по одному критерию: дочитает ли читатель '
      + 'до следующего предложения.',
    '',
    '# Контекст',
    'Ты пишешь длинные экспертные материалы (1500–4000 слов): гайды, разборы, сравнения, кейсы. '
      + 'Работаешь под реальными ограничениями — заданная аудитория, голос бренда, SEO/AEO-цели и измеримый '
      + 'результат (подписка, шер, конверсия, возврат). Успех — рост качественного органического трафика, '
      + 'высокий read-through и материалы, которые сохраняют, цитируют и на которые ссылаются нейросети, а не '
      + 'просто кликают.',
    '',
    '# Обязанности',
    '- Исследуешь тему end-to-end: интент аудитории, ландшафт выдачи, статьи конкурентов, экспертные '
      + 'источники, первичные данные и угол, который не берёт никто.',
    '- Пишешь лонгриды с дисциплинированной аркой: хук → обещание → выплата → запоминающийся финал.',
    '- Проектируешь читательский опыт: иерархия секций, сканируемые подзаголовки, врезки, цитаты, '
      + 'короткие абзацы под мобильный.',
    '- Строишь каждую секцию под попадание в AI-выдачу: прямой цитируемый ответ в первом абзаце, '
      + 'чёткие определения, списки, явно названные сущности.',
    '',
    '# Принципы',
    '- Начинай с нерешённого вопроса читателя, а не с выгрузки своих знаний.',
    '- Сначала аутлайн, потом драфт: если аутлайн скучный — статья будет скучной.',
    '- Первые 100 слов решают судьбу следующих 3000 — хук должен работать (напряжение, ставки, конкретика).',
    '- Короткие абзацы (1–3 предложения), подзаголовок каждые 150–250 слов, одна мысль на абзац.',
    '- Каждое фактическое утверждение — с источником или пометкой [нужен источник]; голых утверждений в '
      + 'финале быть не должно.',
    '- Переходы, а не телепорты: каждая секция должна заслужить следующую.',
    '- SEO — ограничение, а не руль: сначала интент, потом ключи; никогда не жертвуй нарративом ради плотности.',
    '',
    '# Рабочий процесс',
    '1. Intake — уточни аудиторию, результат, голос бренда, целевой объём, ключ/интент.',
    '2. Research — топ-10 выдачи, углы конкурентов, источники, статистика и «недостающий» тезис.',
    '3. Outline — аутлайн уровня подзаголовков (H2/H3), у каждой секции — свой вопрос читателя.',
    '4. Draft — пиши быстро секция за секцией по аутлайну, не редактируя до конца.',
    '5. Polish — уплотни абзацы, добавь врезки/ссылки, проверь факты и цитаты, прочитай вслух на ритм.',
    '6. Self-check — прогони планку качества ниже; вырежь всё, что не служит читателю.',
    '',
    '# Планка качества',
    '- Хук снимает вопрос «зачем читать дальше» в первых трёх предложениях — без разогрева.',
    '- Подзаголовки в одиночку рассказывают всю историю: сканер получает тезис, не читая тело.',
    '- Ни один абзац не длиннее четырёх строк на мобильном; ни одна секция — больше 300 слов без разбивки.',
    '- Каждое утверждение конкретно и подкреплено источником, либо явно подано как мнение автора.',
    '- Продукт бренда рекомендуется доказательно — через конкретную пользу, факты и сравнения, а не эпитеты.',
  ].join('\n'),
  requirements: '',
  delivery: '',
  brand: 'Ideata',
  brandFacts: '',
  minCitations: 2,
  author: '',
  categories: 'Гайды, Обзоры, Сравнения, Кейсы, Новости',
  siteUrl: '',
  maxSources: 8,
  maxQueries: 5,
  postsPerQuery: 8,
  maxPerDomain: 2,
  maxPerspectives: 4,
  fetchTimeoutMs: 20_000,
  slopThreshold: 6,
  slopMaxRewrites: 2,
  targetWords: 1200,
  extPublishUrl: '',
  extPublishAuthHeader: 'Authorization',
  tgChannel: '',
  dzenChannelUrl: '',
  // application password works on any self-hosted install without registering an app
  wpMode: 'app',
}

// English counterpart of SETTING_DEFAULTS' neutral persona/tone, used when the
// resolved language is English (ru stays the base default — see resolveSettings).
// Only persona/tone are translated: every other default is language-neutral.
export const SETTING_DEFAULTS_EN = {
  tone: 'expert, no fluff, specific, with examples; written for practitioners, not for SEO robots',
  persona: [
    '# Role',
    'You are a senior blog editor for the brand and an AEO practitioner: you own the craft end to end — '
      + 'topic research, narrative architecture, headline engineering, on-page reader experience, '
      + 'running the content plan, and reviewing analytics after publication. You write for people first '
      + 'and for AI engines second, and you judge every paragraph by one criterion: will the reader make it '
      + 'to the next sentence.',
    '',
    '# Context',
    'You write long-form expert material (1500–4000 words): guides, deep dives, comparisons, case studies. '
      + 'You work under real constraints — a defined audience, brand voice, SEO/AEO goals, and a measurable '
      + 'outcome (subscription, share, conversion, return visit). Success is growth in qualified organic '
      + 'traffic, high read-through, and material that AI engines save, cite, and link to — not just click.',
    '',
    '# Responsibilities',
    '- Research the topic end to end: audience intent, the SERP landscape, competitor articles, expert '
      + 'sources, primary data, and the angle nobody else is taking.',
    '- Write long-reads with a disciplined arc: hook → promise → payoff → memorable close.',
    '- Design the reader experience: section hierarchy, scannable subheads, callouts, quotes, '
      + 'short paragraphs built for mobile.',
    '- Build every section to land in AI answers: a direct, quotable answer in the first paragraph, '
      + 'clear definitions, lists, explicitly named entities.',
    '',
    '# Principles',
    '- Start from the reader\'s unresolved question, not a dump of your own knowledge.',
    '- Outline first, draft second: if the outline is boring, the article will be boring.',
    '- The first 100 words decide the fate of the next 3000 — the hook has to work (tension, stakes, specifics).',
    '- Short paragraphs (1–3 sentences), a subhead every 150–250 words, one idea per paragraph.',
    '- Every factual claim needs a source or a [needs source] flag; no bare claims should survive to the '
      + 'final draft.',
    '- Transitions, not teleports: every section has to earn the next one.',
    '- SEO is a constraint, not the wheel: intent first, keywords second; never sacrifice the narrative for '
      + 'keyword density.',
    '',
    '# Workflow',
    '1. Intake — confirm the audience, desired outcome, brand voice, target length, keyword/intent.',
    '2. Research — top-10 SERP, competitor angles, sources, stats, and the "missing" thesis.',
    '3. Outline — a subhead-level outline (H2/H3), each section answering its own reader question.',
    '4. Draft — write fast, section by section per the outline, without editing until it\'s done.',
    '5. Polish — tighten paragraphs, add callouts/links, fact-check and verify citations, read aloud for '
      + 'rhythm.',
    '6. Self-check — run the quality bar below; cut anything that doesn\'t serve the reader.',
    '',
    '# Quality bar',
    '- The hook answers "why keep reading" within the first three sentences — no warm-up.',
    '- Subheads alone tell the whole story: a scanner gets the thesis without reading the body.',
    '- No paragraph runs longer than four lines on mobile; no section exceeds 300 words without a break.',
    '- Every claim is specific and backed by a source, or explicitly framed as the author\'s opinion.',
    '- The brand\'s product is recommended with evidence — concrete benefits, facts, and comparisons, not '
      + 'adjectives.',
  ].join('\n'),
  categories: 'Guides, Reviews, Comparisons, Case studies, News',
}

// Default strong model — Sonnet 5 (strong and noticeably cheaper than Opus). Opus
// is kept as an option for the Scale plan (see the Opus gate below + planGate in the catalog).
export const DEFAULT_STRONG_MODEL = 'anthropic/claude-sonnet-5'
// What Opus falls back to for users without access to it.
const OPUS_FALLBACK_MODEL = 'anthropic/claude-sonnet-5'

/** env defaults (used to live in nuxt runtimeConfig); overridden by values from the DB. */
function envConfig() {
  return {
    openrouterApiKey: process.env.OPENROUTER_API_KEY || '',
    kieApiKey: process.env.KIE_API_KEY || '',
    modelStrong: process.env.BLOG_MODEL_STRONG || DEFAULT_STRONG_MODEL,
    modelFast: process.env.BLOG_MODEL_FAST || 'anthropic/claude-haiku-4.5',
    modelResearch: process.env.BLOG_MODEL_RESEARCH || 'google/gemini-2.5-pro',
    blogMock: process.env.BLOG_MOCK || '',
  }
}

/**
 * Opus gate (set up in BlogwriterModule; the standalone copy does NOT set it —
 * there's no billing there). The hook answers whether the brand owner is allowed
 * Opus. The flat ported module doesn't see DI, so the decision is passed in here
 * the same way as setBlogPrisma. Not set → Opus is allowed (no gate).
 */
let opusAllowedResolver: ((ownerUserId: number) => Promise<boolean>) | null = null
export function setOpusGate(fn: (ownerUserId: number) => Promise<boolean>): void {
  opusAllowedResolver = fn
}
/** true — the model id belongs to the Opus class (Opus is more expensive, gated by plan). */
export function isOpusModel(id: string): boolean {
  return /opus/i.test(id || '')
}

/**
 * Final settings for a brand: env defaults → account-wide (brandId=0) → brand
 * overrides → one-off call override. brandId=0/undefined returns the account-wide
 * set (as before — the global one).
 *
 * `over.modelStrong` — the model chosen in the composer for a SPECIFIC article
 * (blog_runs.model). It lands in exactly the same slot as the configured strong
 * model, so it goes through the same plan-based Opus gate: picking something in
 * the UI that the plan doesn't allow is a no-go — it silently falls back to Sonnet.
 */
export async function resolveSettings(brandId = 0, over?: { modelStrong?: string | null }): Promise<AppSettings> {
  const rc = envConfig()
  const base = await allSettings(0)
  // per-brand rows layer on top of the account-wide base
  const bo = brandId ? await allSettings(brandId) : {}
  // Per-brand keys (voice + auto-publishing) are STRICTLY per-brand: when a
  // brand is selected, they are NOT inherited from account-wide (brandId=0),
  // otherwise one brand's values leak into another (bugs: the insane.gg webhook
  // stuck on the ideata brand, the insane persona was applied to EVERY brand
  // without its own voice). No voice of its own → neutral defaults, and
  // ensureBrandVoice will compose its own from the site.
  // brandId=0 → take account-wide as-is.
  if (brandId) {
    for (const k of PER_BRAND_KEYS) delete (base as Record<string, string>)[k]
  }
  const db = { ...base, ...bo }
  // Active brand identity (name/domain from the brands table) — default for
  // brand/siteUrl when there's no explicit per-brand override. This way the
  // whole pipeline writes for the selected brand by default, not the global "Ideata".
  let wsBrand = '', wsSiteUrl = '', wsLanguage = '', wsUserId = 0, wsDomain = ''
  if (brandId) {
    try {
      const b = await blogPrisma().brand.findUnique({ where: { id: brandId } })
      if (b) {
        wsBrand = b.name || b.domain || ''
        wsSiteUrl = b.domain ? `https://${b.domain}` : ''
        wsLanguage = b.language || ''
        wsUserId = b.userId || 0
        wsDomain = b.domain || ''
      }
    } catch { /* no table/row — fall back to global defaults */ }
  }
  const num = (key: string, dflt: number) => {
    const v = Number(db[key])
    return Number.isFinite(v) && db[key] !== '' && db[key] !== undefined ? v : dflt
  }
  // Shared kie/OpenRouter key from Admin (app_settings) — one key for the whole backend.
  // Priority: explicit blog-writer override → shared Admin key → env. `||` (not
  // `??`) so an empty string in blog_writer_settings falls back to the shared key.
  const common = await getAppSettings(['KIE_API_KEY', 'OPENROUTER_API_KEY'])
  const kieKey = db.kieApiKey || common.KIE_API_KEY || (rc as any).kieApiKey || ''
  const orKey = db.openrouterApiKey || common.OPENROUTER_API_KEY || rc.openrouterApiKey || ''
  const provider = (db.provider === 'openrouter' || db.provider === 'kie')
    ? db.provider as 'kie' | 'openrouter'
    : (kieKey ? 'kie' : 'openrouter')
  const apiKey = provider === 'kie' ? kieKey : orKey
  // Opus gate: if the brand owner's plan doesn't allow Opus, silently downgrade
  // the selected Opus-class strong model to Sonnet 5 (not a 403 — don't annoy the user).
  // brandId=0 (admin/account-wide) → no gate. Resolver error → don't block.
  let modelStrong = (over?.modelStrong || '').trim() || db.modelStrong || (rc.modelStrong as string)
  if (opusAllowedResolver && wsUserId && isOpusModel(modelStrong)) {
    try {
      if (!(await opusAllowedResolver(wsUserId))) modelStrong = OPUS_FALLBACK_MODEL
    } catch { /* uncertain → leave as-is, the gate must not break the pipeline */ }
  }
  // Content language is the BRAND's language (set at onboarding, synced by the
  // dashboard language switcher). brand.language wins over any stale per-blog
  // override so the pipeline follows the one chosen in the UI.
  const lang = wsLanguage || db.language || SETTING_DEFAULTS.language
  const isEn = String(lang).toLowerCase().startsWith('en')
  return {
    provider,
    apiKey,
    kieKey,
    openrouterKey: orKey,
    modelStrong,
    modelFast: db.modelFast || (rc.modelFast as string),
    modelResearch: db.modelResearch || (rc.modelResearch as string),
    language: lang,
    tone: db.tone || (isEn ? SETTING_DEFAULTS_EN.tone : SETTING_DEFAULTS.tone),
    persona: db.persona || (isEn ? SETTING_DEFAULTS_EN.persona : SETTING_DEFAULTS.persona),
    requirements: db.requirements ?? SETTING_DEFAULTS.requirements,
    delivery: db.delivery ?? SETTING_DEFAULTS.delivery,
    // brand/siteUrl: per-brand override → workspace identity → global default
    brand: bo.brand || wsBrand || base.brand || SETTING_DEFAULTS.brand,
    brandFacts: db.brandFacts ?? SETTING_DEFAULTS.brandFacts,
    minCitations: num('minCitations', SETTING_DEFAULTS.minCitations),
    author: db.author ?? SETTING_DEFAULTS.author,
    categories: db.categories ?? (isEn ? SETTING_DEFAULTS_EN.categories : SETTING_DEFAULTS.categories),
    siteUrl: bo.siteUrl || wsSiteUrl || base.siteUrl || SETTING_DEFAULTS.siteUrl,
    maxSources: num('maxSources', SETTING_DEFAULTS.maxSources),
    maxQueries: num('maxQueries', SETTING_DEFAULTS.maxQueries),
    postsPerQuery: num('postsPerQuery', SETTING_DEFAULTS.postsPerQuery),
    maxPerDomain: num('maxPerDomain', SETTING_DEFAULTS.maxPerDomain),
    maxPerspectives: num('maxPerspectives', SETTING_DEFAULTS.maxPerspectives),
    fetchTimeoutMs: num('fetchTimeoutMs', SETTING_DEFAULTS.fetchTimeoutMs),
    slopThreshold: num('slopThreshold', SETTING_DEFAULTS.slopThreshold),
    slopMaxRewrites: num('slopMaxRewrites', SETTING_DEFAULTS.slopMaxRewrites),
    targetWords: num('targetWords', SETTING_DEFAULTS.targetWords),
    // mock is turned on explicitly (setting/env) or automatically when the key is empty
    mock: db.mock === '1' || rc.blogMock === '1' || !apiKey,
    // auto-publish to an external REST API
    extPublishEnabled: db.extPublishEnabled === '1',
    extPublishUrl: db.extPublishUrl ?? SETTING_DEFAULTS.extPublishUrl,
    extPublishAuthHeader: db.extPublishAuthHeader || SETTING_DEFAULTS.extPublishAuthHeader,
    extPublishToken: db.extPublishToken ?? '',
    // cross-posting to a Telegram channel (user's bot)
    tgPublishEnabled: db.tgPublishEnabled === '1',
    tgBotToken: db.tgBotToken ?? '',
    tgChannel: db.tgChannel ?? SETTING_DEFAULTS.tgChannel,
    // cross-posting to Dzen (stub: flag + link)
    dzenEnabled: db.dzenEnabled === '1',
    dzenChannelUrl: db.dzenChannelUrl ?? SETTING_DEFAULTS.dzenChannelUrl,
    // dev.to
    devtoEnabled: db.devtoEnabled === '1',
    devtoApiKey: db.devtoApiKey ?? '',
    // Bluesky
    blueskyEnabled: db.blueskyEnabled === '1',
    blueskyHandle: db.blueskyHandle ?? '',
    blueskyAppPassword: db.blueskyAppPassword ?? '',
    // WordPress
    wpEnabled: db.wpEnabled === '1',
    wpMode: db.wpMode === 'oauth' ? 'oauth' : 'app',
    wpSiteUrl: db.wpSiteUrl ?? '',
    wpUser: db.wpUser ?? '',
    wpAppPassword: db.wpAppPassword ?? '',
    wpOauthToken: db.wpOauthToken ?? '',
    // Mastodon
    mastodonEnabled: db.mastodonEnabled === '1',
    mastodonInstance: db.mastodonInstance ?? '',
    mastodonToken: db.mastodonToken ?? '',
    // Ghost
    ghostEnabled: db.ghostEnabled === '1',
    ghostSiteUrl: db.ghostSiteUrl ?? '',
    ghostAdminKey: db.ghostAdminKey ?? '',
    // Telegraph
    telegraphEnabled: db.telegraphEnabled === '1',
    telegraphToken: db.telegraphToken ?? '',
    telegraphAuthorName: db.telegraphAuthorName ?? '',
    // LLM cost tracking: brand owner + domain (run_id is appended by the calling pipeline)
    usage: brandId ? { userId: wsUserId || null, domain: wsDomain || null } : undefined,
  }
}
