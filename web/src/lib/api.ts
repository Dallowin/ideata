// Дата-клиент: NestJS GraphQL (/graphql) + REST scrapper (/scrape/*).
// Сессия — кука _cw (credentials: 'include'); в dev запросы идут через
// vite-прокси на прод (см. vite.config), в проде — same origin за nginx.
import { demoBrands, demoTracker, demoTrackerList } from '@/data/demoTracker'
// не компонент — переводчик берём из инстанса
import { i18n } from '@/i18n'

/**
 * Демо-режим для показов и скриншотов: ?demo=1 один раз включает флаг на
 * вкладку. Держим в sessionStorage, чтобы переходы внутри SPA не сбрасывали
 * его и не приходилось таскать параметр по всем ссылкам.
 */
export function isDemoMode(): boolean {
  return isDemo()
}

/**
 * Выйти из демо. Флаг живёт в sessionStorage и переживает любые переходы, а на
 * экране раньше ничем себя не выдавал: одного визита по ?demo=1 хватало, чтобы
 * дальше вся вкладка показывала фикстуру вместо данных аккаунта — и это
 * читалось как «кабинет выдумывает цифры».
 */
export function exitDemoMode(): void {
  if (typeof window === 'undefined') return
  sessionStorage.removeItem('ideata_demo')
  window.location.assign(window.location.pathname)
}

function isDemo(): boolean {
  if (typeof window === 'undefined') return false
  const q = new URLSearchParams(window.location.search).get('demo')
  if (q === '1') sessionStorage.setItem('ideata_demo', '1')
  if (q === '0') sessionStorage.removeItem('ideata_demo')
  return sessionStorage.getItem('ideata_demo') === '1'
}

export interface Me {
  authed: boolean
  name: string
  userId: number | null
  isAdmin: boolean
}

export interface ApiBrand {
  id: number
  domain: string
  name?: string | null
  description?: string | null
  competitors: string[]
  geo: string
  language: string
  topics: string[]
  aliases: string[]
  isActive: boolean
  createdAt: string
  ownerUserId?: number | null
  ownerName?: string | null
  myRole?: 'owner' | 'editor' | 'viewer'
}

const BRAND_FIELDS = 'id domain name description competitors geo language topics aliases isActive createdAt ownerUserId ownerName myRole'

// --- тариф ------------------------------------------------------------------
// Контракт scrapper /api/me/plan. Поля защитно-опциональны: бэк может не
// прислать часть лимитов, гейты у нас fail-open (авторитетный гейт — бэкенд).
export interface PlanLimits {
  prompts?: number
  brands?: number
  postsPerDay?: number
  seats?: number | null
  export?: string[]
  reports?: { email?: boolean; telegram?: boolean }
  blog?: boolean
  opus?: boolean
}
export interface PlanUsage {
  prompts?: number
  brands?: number
  postsToday?: number
  freeRunUsed?: boolean
}
export interface PlanContract {
  plan?: string
  title?: string
  status?: string
  expiresAt?: string | null
  apiAccess?: boolean
  limits?: PlanLimits
  usage?: PlanUsage
  addons?: { code: string; title: string; price: number }[]
}

// --- команда ----------------------------------------------------------------
export type TeamRole = 'editor' | 'viewer'
export interface TeamMember {
  userId: number
  name?: string | null
  email?: string | null
  role: 'owner' | TeamRole
  createdAt?: string
}
export interface TeamInvite {
  id: number
  token: string
  role: TeamRole
  email?: string | null
  status: string
  createdAt?: string
}
export interface Team {
  seatsLimit: number | null
  members: TeamMember[]
  invites: TeamInvite[]
  myAccounts: { ownerUserId: number; ownerName?: string | null; role: string }[]
}

const TEAM_FIELDS = `
  seatsLimit
  members { userId name email role createdAt }
  invites { id token role email status createdAt }
  myAccounts { ownerUserId ownerName role }
`
const TEAM_INVITE_FIELDS = 'id token role email status createdAt'

/**
 * Head-разметка статьи (GET runs/:id/head-markup): варианты title/description,
 * Open Graph, Twitter и JSON-LD. Считается детерминированно из готового текста,
 * без модели и без списания кредитов.
 */
export interface HeadMarkup {
  titles: string[]
  descriptions: string[]
  og: Record<string, string>
  twitter: Record<string, string>
  jsonLd: Record<string, unknown>[]
  faqCount: number
  html: string
}

/** Канал публикации: готов ли принять статью и включён ли по умолчанию. */
export interface PublishChannel {
  key: string
  label: string
  ready: boolean
  enabled: boolean
  reason?: string
}

// --- отложенный автопостинг --------------------------------------------------
export type PublishScheduleStatus = 'planned' | 'done' | 'error'
/**
 * Одна отложенная отправка статьи в канал. `at` — момент в ISO-UTC: локальное
 * время пользователя живёт только в пикерах, по проводу ходит UTC (иначе
 * запланированное из другого часового пояса уезжает на несколько часов).
 */
export interface PublishScheduleEntry {
  id: string
  channel: string
  at: string
  status: PublishScheduleStatus
  error?: string
}
/**
 * Строка расписания в выдаче контент-плана: та же запись, но уже со статьёй, к
 * которой прицеплена — календарю нужно нарисовать чип с заголовком и увести
 * по клику в ран.
 */
export interface PlanScheduleEntry {
  runId: string
  runTitle: string
  entryId: string
  channel: string
  at: string
  status: PublishScheduleStatus
  error?: string
}

// --- кросспостинг в соцсети -------------------------------------------------
/** Профиль площадки: лимит символов и умеет ли она треды. */
export interface CrosspostPlatform {
  key: string
  label: string
  emoji: string
  charLimit: number
  thread: boolean
  maxPosts: number
  /** кто отправляет: мы / площадка сама по RSS / только копирование */
  delivery?: 'auto' | 'rss' | 'copy'
  /** канал настроен и готов принять пост */
  ready?: boolean
  /** чего не хватает (когда не готов) */
  reason?: string
}
/** Готовая адаптация статьи под одну площадку. */
export interface CrosspostAdapt {
  platform: string
  label: string
  emoji: string
  format: 'plain' | 'markdown'
  posts: string[]
  hashtags: string[]
  charCount: number
  charLimit: number
  thread: boolean
  warnings: string[]
  mock: boolean
}
export interface CrosspostAdaptResponse {
  runId: string
  mock: boolean
  results: { platform: string; ok: boolean; result?: CrosspostAdapt; error?: string }[]
}
/** Ответ публикации площадки. */
export interface CrosspostPublishResult {
  platform: string
  ok: boolean
  ids?: string[]
  url?: string
  posts?: string[]
  messageIds?: number[]
  error?: string
  /** пост ушёл, но файл площадка не приняла — это НЕ провал публикации */
  mediaError?: string
}
/** Файл, прикреплённый к посту соцсети (загружен через crosspost/media). */
export interface CrosspostMediaItem {
  url: string
  type: 'image' | 'video'
  name?: string
  /** к какому посту треда прикреплён (0 — первый); бэк раскладывает по нему */
  postIndex?: number
}
/**
 * Черновик композера, который бэк держит рядом с раном. Без него тред
 * приходилось собирать заново после каждой перезагрузки страницы.
 */
export interface CrosspostDrafts {
  adapts?: Record<string, CrosspostAdapt>
  media?: Record<string, CrosspostMediaItem[]>
}

// --- медиа в теле статьи ----------------------------------------------------
/** Загруженный в ран файл (библиотека статьи). */
export interface MediaAsset {
  id: number
  url: string
  kind: 'image' | 'video' | 'audio' | 'file'
  mime?: string
  name?: string
  size?: number
  width?: number
  height?: number
  createdAt?: string
}
/** Разбор произвольной ссылки: встраивание, прямой файл или карточка. */
export interface MediaEmbed {
  kind: 'embed' | 'image' | 'video' | 'audio' | 'link'
  provider?: string
  src?: string
  href?: string
  title?: string
  desc?: string
  thumb?: string
  site?: string
  ratio?: number
}

/**
 * RAW-загрузка файла на XMLHttpRequest, а не fetch: нужен upload.onprogress —
 * видео на сотню мегабайт без индикатора выглядит как зависший редактор.
 * Имя файла едет заголовком в encodeURIComponent: в HTTP-заголовке кириллица
 * недопустима, «отчёт.pdf» без кодирования роняет запрос ещё в браузере.
 */
function uploadRaw<T>(url: string, file: File, onProgress?: (pct: number) => void): Promise<T> & { abort: () => void } {
  const xhr = new XMLHttpRequest()
  const p = new Promise<T>((resolve, reject) => {
    xhr.open('POST', url)
    xhr.withCredentials = true
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
    if (file.name) xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name))
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      let body: any = null
      try { body = JSON.parse(xhr.responseText) } catch { /* не JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(body as T)
      const err: any = new Error(`HTTP ${xhr.status}`)
      err.status = xhr.status
      err.body = body
      const m = body?.message ?? body?.error
      err.serverMessage = Array.isArray(m) ? m.join('; ') : (typeof m === 'string' ? m : '')
      reject(err)
    }
    xhr.onerror = () => reject(Object.assign(new Error('network'), { status: 0 }))
    xhr.onabort = () => reject(Object.assign(new Error('aborted'), { status: -1, aborted: true }))
    xhr.send(file)
  })
  return Object.assign(p, { abort: () => xhr.abort() })
}

async function http<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init })
  if (!res.ok) {
    const err: any = new Error(`HTTP ${res.status}`)
    err.status = res.status
    // Текст ошибки от бэка (Nest кладёт его в message) — без него интерфейс
    // показывает «не получилось» вместо настоящей причины, и её приходится
    // выкапывать по логам.
    try {
      const body = await res.clone().json()
      err.body = body
      const m = body?.message ?? body?.error ?? body?.detail?.message ?? body?.detail
      err.serverMessage = Array.isArray(m) ? m.join('; ') : (typeof m === 'string' ? m : '')
      // scrapper кладёт машинный код в detail.code (напр. EMAIL_NOT_VERIFIED) —
      // без него 403 неотличим от «просто нельзя» и ветка UI теряется
      err.code = body?.detail?.code || body?.code || err.code
    } catch { /* не JSON — оставляем без текста */ }
    throw err
  }
  return res.json() as Promise<T>
}

async function gql(query: string, variables: Record<string, any> = {}) {
  const res = await http<any>('/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  })
  if (res?.errors?.length) {
    const e0 = res.errors[0]
    const err: any = new Error(e0.message)
    err.code = e0?.extensions?.code || null
    throw err
  }
  return res.data
}

export const api = {
  // --- auth ---------------------------------------------------------------
  me: async (): Promise<Me> => {
    // В демо сессии нет (скриншоты снимаются headless-браузером), а подпись
    // «Гость · не авторизован» в углу выдавала бы это на каждом кадре.
    if (isDemo()) return { authed: true, name: i18n.global.t('user.demo'), userId: 0, isAdmin: false }
    const d = await gql('query { me { authed name userId isAdmin } }')
    return {
      authed: !!d.me?.authed,
      name: d.me?.name || '',
      userId: d.me?.userId ?? null,
      isAdmin: !!d.me?.isAdmin,
    }
  },
  logout: () => http('/tg/logout'),

  // --- бренды (NestJS GraphQL) -------------------------------------------
  // В демо подменяем и список брендов: трекер ищется по активному домену, и с
  // реальным брендом фикстура просто не нашлась бы.
  myBrands: async (): Promise<ApiBrand[]> =>
    isDemo()
      ? (demoBrands() as any)
      : (await gql(`query{ myBrands{ ${BRAND_FIELDS} } }`)).myBrands || [],
  setActiveBrand: async (id: number) =>
    (await gql('mutation($id:Int!){ setActiveBrand(id:$id) }', { id })).setActiveBrand,

  /**
   * Завести бренд. Мутация в api существовала с самого начала — в новом
   * кабинете просто не было клиента, поэтому онбординг жил на моке и бренд
   * физически не создавался.
   */
  createBrand: async (input: {
    domain: string
    name?: string
    description?: string
    geo?: string
    language?: string
    topics?: string[]
    competitors?: string[]
  }): Promise<ApiBrand> =>
    (await gql(
      `mutation($domain:String!,$name:String,$description:String,$geo:String,
                $language:String,$topics:[String!],$competitors:[String!]){
         createBrand(domain:$domain,name:$name,description:$description,geo:$geo,
                     language:$language,topics:$topics,competitors:$competitors){ ${BRAND_FIELDS} } }`,
      input,
    )).createBrand,

  /**
   * Патч бренда. Мутация в api была с самого начала, но клиента к ней не было —
   * поэтому бренды, созданные из нового кабинета, навсегда оставались без
   * конкурентов: онбординг их не спрашивает, а изменить потом было нечем.
   */
  updateBrand: async (input: {
    id: number
    name?: string
    description?: string
    competitors?: string[]
    geo?: string
    language?: string
    topics?: string[]
    aliases?: string[]
  }): Promise<ApiBrand> =>
    (await gql(
      `mutation($id:Int!,$name:String,$description:String,$competitors:[String!],
                $geo:String,$language:String,$topics:[String!],$aliases:[String!]){
         updateBrand(id:$id,name:$name,description:$description,competitors:$competitors,
                     geo:$geo,language:$language,topics:$topics,aliases:$aliases){ ${BRAND_FIELDS} } }`,
      input,
    )).updateBrand,

  /** Мета главной страницы для экрана «Собираем информацию о сайте». Без LLM и без пейволла. */
  sitePeek: (domain: string) =>
    http<{ found: boolean; domain: string; title: string | null;
           description: string | null; site_name: string | null; lang?: string | null }>(
      '/scrape/tools/site_peek', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      }),

  // --- AEO-мониторинг (scrapper REST) --------------------------------------
  /**
   * Демо-режим (?demo=1) подменяет ответы трекера фикстурой — см.
   * data/demoTracker. Подмена именно здесь, а не в компонентах: экран рисуют
   * те же компоненты и тот же контракт, поэтому демо не может разъехаться с
   * продуктом. Снимать для сайта настоящий кабинет нельзя — там метрики живых
   * брендов, и один скриншот публикует их навсегда.
   */
  aeoList: () => (isDemo() ? Promise.resolve(demoTrackerList() as any) : http<any>('/scrape/aeo')),
  aeoGet: (id: number | string, weeks = 8) =>
    isDemo() ? Promise.resolve(demoTracker() as any) : http<any>(`/scrape/aeo/${id}?weeks=${weeks}`),
  /**
   * Точечные мутации панели промптов: add | archive | delete | accept | reject |
   * set_topic | rename_topic | clear_topic. Ручка была на бэке с самого начала —
   * кабинет её не звал, поэтому «добавить/удалить» жили до первой перезагрузки.
   * 409 {error:'quota', cap} — упёрлись в пул тарифа, 402 — пейволл.
   */
  aeoMutatePrompts: (trackerId: number, body: {
    action: 'add' | 'archive' | 'delete' | 'accept' | 'reject'
      | 'set_topic' | 'rename_topic' | 'clear_topic'
    text?: string
    texts?: string[]
    topic?: string
    new_topic?: string
  }) => http<{ ok?: boolean; panel?: any[]; error?: string; cap?: number }>(
    `/scrape/aeo/${trackerId}/prompts/mutate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  /**
   * С кем сравнивать бренд в мониторинге. Пишется В ТРЕКЕР: прогон берёт
   * конкурентов оттуда (jobs.py), а brands.competitors на уже созданный трекер
   * не влияет — правка только бренда выглядела бы как успех и не меняла ничего.
   */
  aeoSetCompetitors: (trackerId: number, competitors: string[]) =>
    http<{ id: number; competitors: string[] }>(`/scrape/aeo/${trackerId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ competitors }),
    }),

  // --- коннекторы (NestJS REST, per-brand) ---------------------------------
  metrikaStatus: (brandId: number) => http<any>(`/metrika/status?brandId=${brandId}`),
  gscStatus: (brandId: number) => http<any>(`/gsc/status?brandId=${brandId}`),
  cloudflareStatus: (brandId: number) => http<any>(`/cloudflare/status?brandId=${brandId}`),
  /**
   * Отключение коннекторов. Кнопки «Отключить» в настройках висели без
   * обработчиков, хотя ручки на бэке были с самого начала.
   */
  metrikaDisconnect: (brandId: number) =>
    http<any>('/metrika/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brandId }),
    }),
  gscDisconnect: (brandId: number) =>
    http<any>('/gsc/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brandId }),
    }),
  cloudflareDisconnect: (brandId: number) =>
    http<any>('/cloudflare/disconnect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brandId }),
    }),
  /** Cloudflare подключается токеном, а не OAuth: { brandId, apiToken }. */
  cloudflareConnect: (brandId: number, apiToken: string) =>
    http<any>('/cloudflare/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brandId, apiToken }),
    }),
  /** подключение Threads (Meta) — статус/отключение; подключение = редирект на /threads/connect */
  threadsStatus: (brandId: number) => http<any>(`/threads/status?brandId=${brandId}`),
  threadsDisconnect: (brandId: number) =>
    http<any>(`/threads/disconnect?brandId=${brandId}`, { method: 'POST' }),
  /** подключение LinkedIn — статус/отключение; подключение = редирект на /linkedin/connect */
  linkedinStatus: (brandId: number) => http<any>(`/linkedin/status?brandId=${brandId}`),
  linkedinDisconnect: (brandId: number) =>
    http<any>(`/linkedin/disconnect?brandId=${brandId}`, { method: 'POST' }),
  /** подключение X — статус/отключение; подключение = редирект на /x/connect */
  xStatus: (brandId: number) => http<any>(`/x/status?brandId=${brandId}`),
  xDisconnect: (brandId: number) =>
    http<any>(`/x/disconnect?brandId=${brandId}`, { method: 'POST' }),

  // --- AI-трафик -----------------------------------------------------------
  /** отчёт Метрики (контракт web/useMetrika.MetrikaReport) */
  metrikaReport: (brandId: number, period = '30d', scope: 'ai' | 'all' = 'ai') =>
    http<any>(`/metrika/report?brandId=${brandId}&period=${period}&scope=${scope}`),
  /** заходы AI-краулеров (scrapper bot_hits) */
  aeoBots: (domain: string, weeks = 8) =>
    http<any>(`/scrape/aeo/bots?domain=${encodeURIComponent(domain)}&weeks=${weeks}`),
  /** ingest-токен лог-форвардера: {token, ingestUrl} */
  aeoBotToken: () => http<any>('/scrape/aeo/bot-token'),
  /** AI-краулеры по данным Cloudflare: {bots:[{bot,vendor,hits,pct}], series, totalHits} */
  cloudflareReport: (brandId: number, period = '30d') =>
    http<any>(`/cloudflare/report?brandId=${brandId}&period=${period}`),
  // --- Blog Writer (NestJS /blogwriter, скоуп активного бренда) ------------
  /** список статей/ранов бренда */
  blogPosts: () => http<any[]>('/blogwriter/posts'),
  /** настройки агента (голос бренда, модели, токены-маски) */
  blogSettings: () => http<any>('/blogwriter/settings'),
  /** сохранить настройки агента (PATCH, per-brand + account-wide ключи) */
  blogPatchSettings: (body: Record<string, unknown>) =>
    http<any>('/blogwriter/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /**
   * Проверка приёмника сайта: шлём пример-статью на настроенный /blog/ingest
   * активного бренда → {attempted, ok, status?, id?, slug?, error?, native?,
   * cleaned?, leftoverDraft?}. Уходит ЧЕРНОВИК и сразу удаляется:
   * leftoverDraft:true — удалить не вышло, тестовая статья осталась на сайте.
   * native:true — base указывает на сам Ideata (публикация идёт нативно, HTTP
   * не нужен).
   */
  blogExtPublishTest: () =>
    http<any>('/blogwriter/blog/ext-publish/test', { method: 'POST' }),
  /** проверка ключа dev.to: {ok, url?} — спрашивает профиль, ничего не публикует */
  blogDevtoTest: () => http<any>('/blogwriter/blog/devto/test', { method: 'POST' }),
  /** проверка Telegram-канала: шлём сообщение в канал бренда и сразу удаляем */
  blogTgPublishTest: () => http<any>('/blogwriter/blog/tg-publish/test', { method: 'POST' }),
  /** проверка доступа Bluesky: заводит сессию по app-паролю, ничего не постит */
  blogBlueskyTest: () => http<any>('/blogwriter/blog/bluesky/test', { method: 'POST' }),
  /** проверка доступа к WordPress: спрашивает сайт о себе, ничего не публикует */
  blogWordpressTest: () => http<any>('/blogwriter/blog/wordpress/test', { method: 'POST' }),
  /** каталог моделей: {models:[{id,label,inUsd,outUsd,desc,context}], default} —
   *  default = сильная модель бренда, на ней действие поедет без явного выбора */
  blogModels: () => http<any>('/blogwriter/models/kie'),
  /**
   * AI-правка выделенного фрагмента: {html, instruction, model?, history?, title?}
   * → {html, usage:{model,tokensIn,tokensOut,costRub}|null}. model — id из
   * каталога blogModels(); history — прошлые указания того же диалога.
   *
   * format:'markdown' — просим вернуть markdown, а не HTML: профиль агента
   * хранится markdown-ом, и HTML в нём отображается как текст с тегами.
   */
  blogAiEdit: (
    html: string,
    instruction: string,
    opts: { model?: string; history?: string[]; title?: string; format?: 'html' | 'markdown' } = {},
  ) =>
    http<any>('/blogwriter/ai-edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html, instruction, ...opts }),
    }),
  /**
   * Собрать «голос бренда» с САЙТА активного бренда (краул + LLM):
   * → {brand, tone, persona, requirements, categories, language, domain, pagesCrawled}.
   * save:false — ничего не сохраняем на бэке, результат идёт в форму на ревью.
   */
  blogVoiceAnalyze: (save = false) =>
    http<any>('/blogwriter/voice/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ save }),
    }),
  // --- конструктор обложек (/blogwriter/preview + covers) ------------------
  /** кредиты и свой ключ: {pool, granted, spent, balance, plan, degraded, hasOwnKey} */
  previewBgStatus: () => http<any>('/blogwriter/preview/status'),
  /** каталог text→image моделей: {models:[{id,label,usdPerImage,credits}], defaultModel} */
  previewImageModels: () => http<any>('/blogwriter/preview/image-models'),
  /**
   * кредиты блог-райтера: {balance, pool, spent, perPost, model, degraded}.
   * model — слаг из каталога blogModels(): цена статьи считается на нём (пусто —
   * на модели из настроек бренда). В ответе model — на чём ран реально поедет.
   */
  blogCredits: (model?: string) =>
    http<any>(`/blogwriter/credits${model ? `?model=${encodeURIComponent(model)}` : ''}`),
  /** сохранённые шаблоны студии обложек (в БД, не в localStorage) */
  previewScenes: () => http<any>('/blogwriter/preview/scenes'),
  previewSaveScene: (name: string, scene: unknown) =>
    http<any>('/blogwriter/preview/scenes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, scene }),
    }),
  previewDeleteScene: (id: number) =>
    http<any>(`/blogwriter/preview/scenes/${id}`, { method: 'DELETE' }),
  /** история генераций: {images:[{id,url,model,prompt,credits,createdAt}]};
   *  kind='bg' — фоны студии, 'cover' — готовые обложки статей */
  previewImages: (kind?: 'bg' | 'cover') =>
    http<any>(`/blogwriter/preview/images${kind ? `?kind=${kind}` : ''}`),
  /** свой ключ kie.ai (снимает почасовой лимит) → {hasOwnKey} */
  previewBgKey: (key: string) =>
    http<any>('/blogwriter/preview/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    }),
  /** AI-фон под формат холста → {url, model, credits, balance, usingOwnKey} */
  previewBackground: (prompt: string, aspectRatio: string, model?: string) =>
    http<any>('/blogwriter/preview/background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, aspectRatio, model }),
    }),
  /** сохранить готовую композицию обложкой статьи (RAW image/jpeg) → {coverUrl} */
  blogSaveCover: (runId: string, jpeg: Blob) =>
    http<{ coverUrl: string }>(`/blogwriter/runs/${runId}/cover-save`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: jpeg,
    }),
  /**
   * старт генерации статьи → {runId}; targetQueries — целевые AEO-запросы (до 20),
   * model — модель ЭТОЙ статьи из каталога blogModels() (пусто — из настроек бренда)
   */
  blogStartRun: (topic: string, mode: 'auto' | 'interactive' = 'auto', targetQueries: string[] = [], model = '') =>
    http<{ runId: string }>('/blogwriter/runs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic, mode, targetQueries, model }),
    }),
  /** подобрать AEO-запросы под тему: {topic} → {keywords:[{query,intent,score}]} */
  blogGenKeywords: (topic: string) =>
    http<any>('/blogwriter/aeo/keywords', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic }),
    }),
  /** один ран/статья по id (topic, status, bodyHtml, title, stages…) */
  blogRun: (id: string) => http<any>(`/blogwriter/runs/${id}`),
  /** сохранить пост: {title, bodyHtml, status, category, author} */
  blogPatchRun: (id: string, body: Record<string, unknown>) =>
    http<any>(`/blogwriter/runs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /** удалить статью целиком (ран + его публикации остаются снятыми вручную) */
  blogDeleteRun: (id: string) =>
    http<{ ok: boolean }>(`/blogwriter/runs/${id}`, { method: 'DELETE' }),
  /**
   * Варианты title/description + OG/Twitter/JSON-LD по готовому тексту.
   * Без LLM: считается на бэке детерминированно, кредиты не тратятся.
   */
  blogHeadMarkup: (id: string) => http<HeadMarkup>(`/blogwriter/runs/${id}/head-markup`),
  /**
   * Шаг 1 обложки: AI-фон под 16:9 → {bgUrl}. Готовую композицию с заголовком
   * собирает клиент и шлёт в blogSaveCover — бэк сам обложку не проставляет.
   */
  blogGenCover: (id: string, prompt?: string) =>
    http<{ bgUrl: string; prompt: string }>(`/blogwriter/runs/${id}/cover`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prompt ? { prompt } : {}),
    }),
  /** убрать обложку статьи (чистит cover_url) */
  blogClearCover: (id: string) =>
    http<{ ok: boolean }>(`/blogwriter/runs/${id}/cover-clear`, { method: 'POST' }),
  /** перезапустить упавший ран */
  blogRetryRun: (id: string) =>
    http<any>(`/blogwriter/runs/${id}/retry`, { method: 'POST' }),
  /** продолжить интерактивный шаг: источники {selectedUrls,extraUrls} или структура {outline} */
  blogContinueRun: (id: string, body: Record<string, unknown>) =>
    http<any>(`/blogwriter/runs/${id}/continue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /** убрать выдуманные данные по замечаниям факт-чека: {html} → {html, fixed} */
  blogFactfix: (id: string, html: string) =>
    http<any>(`/blogwriter/runs/${id}/factfix`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html }),
    }),
  /** перегенерировать отрывок (секцию): {index, heading, directive?} → {index, heading, html} */
  blogRegenSection: (id: string, body: { index: number; heading: string; directive?: string }) =>
    http<any>(`/blogwriter/runs/${id}/section`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /** группа переводов статьи: {groupId, sourceLocale, items:[{id,locale,title,blogStatus,…}]} */
  blogGroup: (id: string) => http<any>(`/blogwriter/runs/${id}/group`),
  /** сгенерировать переводы в локали: {locales} → {created, failed} */
  blogTranslate: (id: string, locales: string[]) =>
    http<any>(`/blogwriter/runs/${id}/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ locales }),
    }),
  /** опубликовать/обновить пост в блоге: {status, locale?} → {postId, slug, status, coverUrl, syncedAt} */
  /** каналы, куда может уехать статья: готовность считает бэк, не фронт */
  blogChannels: () => http<{ channels: PublishChannel[] }>('/blogwriter/blog/channels'),
  blogPublish: (id: string, body: { status: 'draft' | 'published'; locale?: string; channels?: string[] }) =>
    http<any>(`/blogwriter/blog/publish/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /** снять пост из блога */
  blogUnpublish: (id: string) =>
    http<any>(`/blogwriter/blog/publish/${id}`, { method: 'DELETE' }),

  // --- отложенный автопостинг статьи (runs/:id/publish-schedule) -----------
  /** расписание отправок статьи: {entries:[{id,channel,at,status,error?}]} */
  blogSchedule: (runId: string) =>
    http<{ entries: PublishScheduleEntry[] }>(`/blogwriter/runs/${runId}/publish-schedule`),
  /** переписать расписание целиком (диалог публикации сохраняет весь список) */
  blogSaveSchedule: (runId: string, entries: { id?: string; channel: string; at: string }[]) =>
    http<{ entries: PublishScheduleEntry[] }>(`/blogwriter/runs/${runId}/publish-schedule`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    }),
  /**
   * Подвинуть ОДНУ запись — перетаскивание чипа в календаре. Сохранять весь
   * список тут нельзя: план знает только строки своего месяца и затёр бы
   * отправки, запланированные на соседние.
   */
  blogMoveScheduleEntry: (runId: string, entryId: string, at: string) =>
    http<{ entry: PublishScheduleEntry }>(`/blogwriter/runs/${runId}/publish-schedule/${entryId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ at }),
    }),
  // --- кросспостинг в соцсети (blogwriter/crosspost.controller) -----------
  /** профили площадок: лимит символов, тред/одиночный пост */
  crosspostPlatforms: () =>
    http<{ platforms: CrosspostPlatform[] }>('/blogwriter/crosspost/platforms'),
  /** сгенерировать адаптации статьи под площадки (стоит вызовов LLM) */
  crosspostAdapt: (id: string, platforms: string[]) =>
    http<CrosspostAdaptResponse>(`/blogwriter/runs/${id}/crosspost`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platforms }),
    }),
  /** что уже опубликовано по площадкам + сохранённый черновик композера */
  crosspostState: (id: string) =>
    http<{ runId: string; platforms: Record<string, { ids?: string[]; url?: string }>; drafts?: CrosspostDrafts }>(`/blogwriter/runs/${id}/crosspost/state`),
  /** тихо сохранить черновик треда и вложений (автосейв композера) */
  crosspostSaveDrafts: (id: string, drafts: CrosspostDrafts) =>
    http<{ ok: boolean }>(`/blogwriter/runs/${id}/crosspost/drafts`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(drafts),
    }),
  /** опубликовать пост/тред (посты — из превью, возможно правленные) */
  crosspostPublish: (id: string, platform: string, posts: string[], media?: CrosspostMediaItem[]) =>
    http<CrosspostPublishResult>(`/blogwriter/runs/${id}/crosspost/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // media шлём, только когда есть: пустой массив бэк трактует так же, но в
      // логе запроса лишнее поле мешает отличить «не прикрепляли» от «не влезло»
      // postIndex обязателен: медиа теперь висит на конкретном посте треда, а не
      // на первом — без номера бэк свалит весь альбом в начало
      body: JSON.stringify(media?.length
        ? { platform, posts, media: media.map((m) => ({ url: m.url, type: m.type, postIndex: m.postIndex || 0 })) }
        : { platform, posts }),
    }),
  /**
   * Загрузить фото/видео к посту соцсети: RAW-байты, Content-Type = MIME файла
   * (как blogMediaUpload). Лимиты держит бэк — 20/40(gif)/100(видео) МБ.
   */
  blogCrosspostMediaUpload: (runId: string, file: File) =>
    uploadRaw<CrosspostMediaItem>(`/blogwriter/runs/${runId}/crosspost/media`, file),
  /** снять пост/тред из соцсети */
  crosspostUnpublish: (id: string, platform: string) =>
    http<{ platform: string; ok: boolean; removed: number; leftover: number; error?: string }>(
      `/blogwriter/runs/${id}/crosspost/publish/${platform}`, { method: 'DELETE' },
    ),
  /** проверка доступа к инстансу Mastodon */
  blogMastodonTest: () => http<any>('/blogwriter/blog/mastodon/test', { method: 'POST' }),
  /** проверка Admin API key Ghost */
  blogGhostTest: () => http<any>('/blogwriter/blog/ghost/test', { method: 'POST' }),
  /** проверка токена Telegraph */
  blogTelegraphTest: () => http<any>('/blogwriter/blog/telegraph/test', { method: 'POST' }),
  /** создать аккаунт Telegraph и сохранить токен бренду (иначе его негде взять) */
  blogTelegraphCreateAccount: () =>
    http<{ ok: boolean; authUrl?: string; tokenMasked?: string; error?: string }>(
      '/blogwriter/blog/telegraph/create-account', { method: 'POST' },
    ),

  /** URL экспорта статьи в .md (открыть в новой вкладке) */
  blogExportUrl: (id: string) => `/blogwriter/runs/${id}/export`,

  // --- медиа в теле статьи (blogwriter/media.controller) -------------------
  /** загрузить файл в ран RAW-телом → MediaAsset; onProgress — проценты 0..100 */
  blogMediaUpload: (runId: string, file: File, onProgress?: (pct: number) => void) =>
    uploadRaw<MediaAsset>(`/blogwriter/runs/${runId}/media`, file, onProgress),
  /** библиотека рана (свежие сверху, лимит 200) */
  blogMediaList: (runId: string) => http<{ items: MediaAsset[] }>(`/blogwriter/runs/${runId}/media`),
  /** удалить файл из библиотеки (в теле статьи ссылка при этом протухнет) */
  blogMediaDelete: (mediaId: number) => http<{ ok: boolean }>(`/blogwriter/media/${mediaId}`, { method: 'DELETE' }),
  /** распознать произвольную ссылку: встраивание / прямой файл / карточка */
  blogMediaEmbed: (url: string) =>
    http<MediaEmbed>('/blogwriter/media/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    }),

  // --- Идеи тем (content.controller /topics/*) -----------------------------
  /** кэш идей тем бренда: {topics:[{title,angle,intent,keyword,queries,score,source}]} */
  blogTopicIdeas: () => http<any>('/blogwriter/topics/ideas'),
  /** сгенерировать идеи: {seed?, append?} → {topics} */
  blogGenTopicIdeas: (seed?: string, append = false) =>
    http<any>('/blogwriter/topics/ideas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seed, append }),
    }),
  /** скрыть идею по заголовку */
  blogHideTopicIdea: (title: string) =>
    http<any>('/blogwriter/topics/ideas', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  /** идеи-перехваты из тем конкурентов: {topics} */
  blogCompetitorIdeas: () => http<any>('/blogwriter/topics/competitors'),
  blogGenCompetitorIdeas: () =>
    http<any>('/blogwriter/topics/competitors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),

  // --- Контент-план / календарь (plan.controller /plan/*) -------------------
  /**
   * Пункты плана за период: {items:[{id,date,title,queries,status,runId,run}],
   * schedule:[{runId,runTitle,entryId,channel,at,status,error}], brand, mock}.
   * schedule — уже запланированный автопостинг статей: он рисуется в тех же
   * клетках календаря, что и слоты тем.
   */
  blogPlan: (from: string, to: string) => http<any>(`/blogwriter/plan?from=${from}&to=${to}`),
  /** сгенерировать план на период: {from,to,perWeek,append?} */
  blogPlanGenerate: (body: { from: string; to: string; perWeek?: number; append?: boolean }) =>
    http<any>('/blogwriter/plan/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /** добавить пункт плана: {date, title, queries?} */
  blogPlanCreate: (body: { date: string; title: string; queries?: string[] }) =>
    http<any>('/blogwriter/plan/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /** обновить пункт (перенос даты/правка): {date?, title?} */
  blogPlanUpdate: (id: string, body: Record<string, unknown>) =>
    http<any>(`/blogwriter/plan/items/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  /** удалить пункт плана */
  blogPlanRemove: (id: string) =>
    http<any>(`/blogwriter/plan/items/${id}`, { method: 'DELETE' }),
  /** запустить пункт в статью: {mode} → {runId} */
  blogPlanWrite: (id: string, mode: 'auto' | 'interactive' = 'interactive') =>
    http<{ runId: string }>(`/blogwriter/plan/items/${id}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    }),

  /** счётчики Метрики аккаунта: {ok, current, counters: [{id,name,site}]} */
  metrikaCounters: (brandId: number) => http<any>(`/metrika/counters?brandId=${brandId}`),
  /** выбрать счётчик (домен) для бренда */
  metrikaSetCounter: (brandId: number, counterId: string) =>
    http<any>('/metrika/counter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ brandId, counterId }),
    }),

  // --- AI-разбор сайта (scrapper /api/public/site_analytic) ---------------
  /** мои разборы: {items:[{id,domain,status,created_at,finished_at,...}]} */
  siteAnalyticList: () => http<any>('/scrape/site_analytic'),
  /** Запуск разбора: {id, job_id, cached}. На free — разовый lite-прогон, потом 402. */
  siteAnalyticStart: (domain: string, geo?: string) =>
    http<{ id: number; job_id?: number; cached?: boolean }>('/scrape/site_analytic', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, ...(geo ? { geo } : {}) }),
    }),
  /** Подтверждение почты кодом из письма (TTL 15 мин) + повторная отправка кода. */
  sendVerify: () => http<any>('/scrape/auth/send-verify', { method: 'POST' }),
  verifyEmail: (code: string) =>
    http<any>('/scrape/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }),
  /** отчёт разбора по id: {status, facts, ...} — чтение из БД, без прогона */
  siteAnalytic: (id: number) => http<any>(`/scrape/site_analytic/${id}`),

  // --- тариф аккаунта (scrapper /api/me/plan ← /scrape rewrite) ------------
  /** расширенный контракт: {plan,title,status,expiresAt,limits,usage,addons,apiAccess} */
  myPlan: () => http<PlanContract>('/scrape/me/plan'),

  // --- ассистент (NestJS /assistant) ---------------------------------------
  /** каталог моделей для селектора: {models:[{id,label,format,inUsd,outUsd}], default} */
  assistantModels: () => http<any>('/assistant/models'),
  /** свободный вопрос по данным бренда → {answer, model}; снимок собирает клиент */
  assistantChat: (
    question: string,
    snapshot: string,
    history: { role: 'user' | 'bot'; text: string }[],
    model?: string,
  ) =>
    // spent — сколько кредитов списал бэк за этот вопрос (0 — ответ без модели
    // либо цена модели неизвестна). Показываем под ответом, чтобы расход не был
    // невидимым.
    http<{ answer: string; model: string | null; spent?: number }>('/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, snapshot, history, model }),
    }),

  // --- команда аккаунта (NestJS GraphQL) -----------------------------------
  /** состав команды + исходящие приглашения + чужие аккаунты, куда пригласили меня */
  myTeam: async (): Promise<Team> =>
    (await gql(`query{ myTeam{ ${TEAM_FIELDS} } }`)).myTeam,
  /** приглашение по роли (email — опционально, для памятки) → ссылка /invite/{token} */
  /** Принять приглашение по токену. Идемпотентна: повторный вызов не ломается. */
  acceptInvite: async (token: string): Promise<{ ownerUserId: number; ownerName?: string | null; role: string }> =>
    (await gql(
      'mutation($token:String!){ acceptInvite(token:$token){ ownerUserId ownerName role } }',
      { token },
    )).acceptInvite,

  createInvite: async (role: TeamRole, email?: string): Promise<TeamInvite> =>
    (await gql(
      `mutation($role:String!,$email:String){ createInvite(role:$role,email:$email){ ${TEAM_INVITE_FIELDS} } }`,
      { role, email: email || null },
    )).createInvite,
  revokeInvite: async (id: number) =>
    (await gql('mutation($id:Int!){ revokeInvite(id:$id) }', { id })).revokeInvite,
  setMemberRole: async (userId: number, role: TeamRole) =>
    (await gql(
      'mutation($userId:Int!,$role:String!){ setMemberRole(userId:$userId,role:$role){ userId name email role createdAt } }',
      { userId, role },
    )).setMemberRole,
  removeMember: async (userId: number) =>
    (await gql('mutation($userId:Int!){ removeMember(userId:$userId) }', { userId })).removeMember,
}
