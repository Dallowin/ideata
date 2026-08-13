<script setup lang="ts">
// «Интеграция» Blog Writer — каталог каналов публикации.
// Паттерн собран по референсам Mobbin (Langdock / Obvious / Midday / LangChain):
// хедер с сабтайтлом + поиск справа, фильтр-табы со счётчиками, плотная сетка
// карточек во всю ширину контейнера (1180px — как остальные страницы кабинета),
// у каждой карточки явное действие внизу, статус — пилюлей у названия.
// Каталог разбит на секции (блог / соцсети / скоро) — тринадцать одинаковых
// плиток подряд не читались: непонятно, что вообще выбираешь.
// Telegram и автопубликация на сайт — реальные (настройки blogwriter);
// VK — цель контент-фабрики, пока «скоро».
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { AlertTriangle, ArrowLeft, Check, ChevronRight, Copy, ExternalLink, Globe, KeyRound, Loader2, PlugZap, Search, Send, X } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import SiteIngestDocs from '@/components/blog/SiteIngestDocs.vue'
import { faviconSrc } from '@/data/prompts'
import { useBrands } from '@/composables/useBrands'
import { api } from '@/lib/api'
import { intlLocale } from '@/i18n'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const settings = ref<any | null>(null)
const loading = ref(true)
/** статус OAuth-подключения Threads (отдельный от blogwriter-настроек) */
const threads = ref<any | null>(null)
/** то же для LinkedIn: подключение живёт своей таблицей, а не настройками блога */
const linkedin = ref<any | null>(null)
/** X: подключение по OAuth перебивает режим из настроек */
const xConn = ref<any | null>(null)
const { load: loadBrands, active } = useBrands()
const channel = ref<string | null>(null)
const saving = ref(false)
const saved = ref(false)
/** текст ошибки сохранения: раньше catch молчал, и «не сохранилось» выглядело
 *  ровно как «сохранилось» — менялась только (не)обновившаяся маска */
const saveError = ref('')
const form = ref<Record<string, string>>({})
/** значение переключателя канала (автопубликация вкл/выкл) */
const enabled = ref(false)
/** выбранный режим подключения (у каналов с modes) */
const mode = ref('')
/** настройки автопубликации живут per-brand: без активного бренда бэк их молча
 *  игнорирует (settings.controller → extIgnored) — показываем это, а не «Сохранено» */
const extIgnored = ref(false)
const copied = ref('')
let copyT: ReturnType<typeof setTimeout> | undefined
async function copyValue(v: string) {
  try {
    await navigator.clipboard.writeText(v)
    copied.value = v
    clearTimeout(copyT)
    copyT = setTimeout(() => { if (copied.value === v) copied.value = '' }, 2000)
  } catch { /* clipboard недоступен — значение видно и выделяется руками */ }
}

/** своё действие канала (Telegraph: создать аккаунт и получить токен) */
const acting = ref(false)
const actionErr = ref('')
/** одноразовая ссылка Telegraph: по ней аккаунт забирается в браузер */
const actionAuthUrl = ref('')

async function runAction() {
  if (acting.value || current.value?.action?.key !== 'telegraphAccount') return
  acting.value = true
  actionErr.value = ''
  actionAuthUrl.value = ''
  try {
    const r = await api.blogTelegraphCreateAccount()
    if (!r?.ok) { actionErr.value = r?.error || t('blog.pages.integration.channels.telegraph.createFailed'); return }
    actionAuthUrl.value = r.authUrl || ''
    await loadSettings()
    enabled.value = true
  } catch {
    actionErr.value = t('blog.pages.integration.channels.telegraph.createFailed')
  } finally {
    acting.value = false
  }
}

/**
 * Что произойдёт после подключения. Без этой строки карточка отвечала на вопрос
 * «куда вставить токен», но не на «а как теперь запостить»: каналы уезжают
 * веером по кнопке «Опубликовать» в статье, отдельного действия нет.
 */
const flowHint = computed(() => {
  const key = current.value?.key
  if (!key) return ''
  if (key === 'x') return t('blog.pages.integration.flow.x')
  if (key === 'threads') return t('blog.pages.integration.flow.threads')
  if (current.value?.howto) return '' // у этих каналов шаги и так расписаны
  return t('blog.pages.integration.flow.auto')
})

const q = ref('')
const tab = ref<'all' | 'connected' | 'soon'>('all')

async function loadSettings() {
  loading.value = true
  try { settings.value = await api.blogSettings() } catch { settings.value = null }
  finally { loading.value = false }
}

// статус Threads тянем отдельно: он в своей таблице, а не в blogwriter-настройках
async function loadThreads() {
  try {
    await loadBrands()
    const id = active.value?.id
    threads.value = id ? await api.threadsStatus(id) : null
  } catch { threads.value = null }
  try {
    const id = active.value?.id
    linkedin.value = id ? await api.linkedinStatus(id) : null
  } catch { linkedin.value = null }
  try {
    const id = active.value?.id
    xConn.value = id ? await api.xStatus(id) : null
  } catch { xConn.value = null }
}

// ── возврат с OAuth ────────────────────────────────────────────────────────
// Бэк редиректит на ?<канал>_connected=1 либо ?<канал>_error=<код>. Без разбора
// этих параметров возврат выглядел как «ничего не произошло»: страница просто
// открывалась заново, а ошибка авторизации терялась в адресной строке.
const OAUTH_RETURNS = [
  { key: 'threads', ok: 'threads_connected', err: 'threads_error' },
  { key: 'x', ok: 'x_connected', err: 'x_error' },
  { key: 'linkedin', ok: 'linkedin_connected', err: 'linkedin_error' },
] as const
const OAUTH_QUERY_KEYS = OAUTH_RETURNS.flatMap((r) => [r.ok, r.err])
const notice = ref<{ ok: boolean; text: string } | null>(null)

/** коды из *_controller.ts (fail('…')) — человеческим языком */
const oauthErrorText = (code: string) => ({
  disabled: t('blog.pages.integration.notice.errors.disabled'),
  no_brand: t('blog.pages.integration.notice.errors.no_brand'),
  auth: t('blog.pages.integration.notice.errors.auth'),
  denied: t('blog.pages.integration.notice.errors.denied'),
  state: t('blog.pages.integration.notice.errors.state'),
  exchange: t('blog.pages.integration.notice.errors.exchange'),
}[code] || t('blog.pages.integration.notice.errors.unknown'))

/**
 * Адрес держит открытую карточку (?channel=…) и не держит следы OAuth: по такой
 * ссылке страница открывается там же, где её оставили, а возврат с авторизации
 * приземляется в нужный канал, а не в общий каталог.
 */
function syncQuery() {
  const next: Record<string, any> = { ...route.query }
  let changed = false
  for (const k of OAUTH_QUERY_KEYS) if (k in next) { delete next[k]; changed = true }
  const want = channel.value || undefined
  if ((next.channel || undefined) !== want) {
    changed = true
    if (want) next.channel = want
    else delete next.channel
  }
  if (changed) void router.replace({ query: next })
}
watch(channel, syncQuery)

function applyQuery() {
  const ret = OAUTH_RETURNS.find((r) => route.query[r.ok] || route.query[r.err])
  if (ret) {
    const c = CHANNELS.value.find((x) => x.key === ret.key)
    const name = c?.title || ret.key
    if (route.query[ret.ok]) {
      notice.value = { ok: true, text: t('blog.pages.integration.notice.connected', { channel: name }) }
      // подключённый канал открываем сразу: человек шёл настраивать именно его.
      // Но только если статус это подтвердил — иначе карточка соврала бы
      // «аккаунт подключён» поверх пустого подключения.
      if (c && isConnected(c)) channel.value = ret.key
    } else {
      notice.value = {
        ok: false,
        text: t('blog.pages.integration.notice.failed', {
          channel: name,
          reason: oauthErrorText(String(route.query[ret.err] || '')),
        }),
      }
    }
  }
  // ?channel=… — прямая ссылка на карточку (в т.ч. после перезагрузки страницы).
  // Неподключённый OAuth-канал не открываем: у него карточка = экран статуса,
  // а подключение начинается редиректом по клику, не по ссылке.
  if (!channel.value) {
    const c = CHANNELS.value.find((x) => x.key === String(route.query.channel || ''))
    if (c && !c.soon && !(c.oauth && !isConnected(c))) { channel.value = c.key; fillForm(c) }
  }
  syncQuery()
}

onMounted(async () => {
  await loadSettings()
  await loadThreads()
  applyQuery()
})

/** OAuth стартуем полным редиректом — площадка возвращает на зарегистрированный callback */
function connectThreads() {
  const id = active.value?.id
  if (!id) return
  const next = encodeURIComponent('/blog/integration')
  window.location.assign(`/threads/connect?brandId=${id}&next=${next}`)
}

/** OAuth X: тот же полный редирект, что и у остальных каналов. */
function connectX() {
  const id = active.value?.id
  if (!id) return
  const next = encodeURIComponent('/blog/integration')
  window.location.assign(`/x/connect?brandId=${id}&next=${next}`)
}

async function disconnectX() {
  const id = active.value?.id
  if (!id) return
  try { await api.xDisconnect(id) } catch { /* остаёмся как есть */ }
  await loadThreads()
  channel.value = null
}

/** OAuth LinkedIn: тот же полный редирект, что и у Threads. */
function connectLinkedin() {
  const id = active.value?.id
  if (!id) return
  const next = encodeURIComponent('/blog/integration')
  window.location.assign(`/linkedin/connect?brandId=${id}&next=${next}`)
}

async function disconnectLinkedin() {
  const id = active.value?.id
  if (!id) return
  try { await api.linkedinDisconnect(id) } catch { /* остаёмся как есть */ }
  await loadThreads()
  channel.value = null
}

async function disconnectThreads() {
  const id = active.value?.id
  if (!id) return
  try { await api.threadsDisconnect(id) } catch { /* остаёмся как есть */ }
  await loadThreads()
  channel.value = null
}

interface Channel {
  key: string
  title: string
  /** png/svg из public — либо null, тогда рисуем встроенный глиф */
  icon: string | null
  desc: string
  soon?: boolean
  /** подключается редиректом на OAuth, а не вводом токена в форму */
  oauth?: boolean
  connected?: (s: any) => boolean
  detail?: (s: any) => string
  fields?: {
    key: string
    label: string
    hint?: string
    placeholder: string
    secret?: boolean
    /** текущее значение из настроек: несекретные поля показываем заполненными */
    prefill?: (s: any) => string
    /** поле нужно только в этом режиме канала (см. modes) */
    onlyMode?: string
  }[]
  /**
   * Режимы подключения. Нужны там, где у площадки принципиально разные пути —
   * например, у WordPress: пароль приложения или OAuth.
   */
  modes?: {
    key: string
    label: string
    options: { value: string; title: string; desc: string }[]
  }
  /**
   * Канал, который подключается НЕ у нас: площадка сама забирает статью (RSS)
   * или втягивает её по адресу. Кода публикации не требует, но и «скоро» тут
   * врало бы — работает уже сегодня, поэтому вместо формы показываем шаги.
   */
  howto?: {
    steps: string[]
    copy?: { label: string; value: string }
    copy2?: { label: string; value: string }
    link?: { label: string; url: string }
    note?: string
  }
  /** выключатель канала (пишется тем же PATCH настроек) */
  toggle?: { key: string; label: string; hint: string }
  /** есть кнопка «Проверить связь»; значение — какую проверку звать */
  testable?: boolean | 'tg' | 'devto' | 'bluesky' | 'wordpress' | 'mastodon' | 'ghost' | 'telegraph'
  /** кнопка своего действия: канал подключается не вводом токена (Telegraph) */
  action?: { key: string; label: string; hint: string }
}

const CHANNELS = computed<Channel[]>(() => [
  {
    key: 'telegram', title: t('blog.pages.integration.channels.telegram.title'), icon: null,
    desc: t('blog.pages.integration.channels.telegram.desc'),
    // Одного токена бота мало: без канала и включённого выключателя постить
    // некуда (tgPublish.tgConfig → ready = enabled && token && channel).
    connected: (s) => !!(s?.tgPublishEnabled && s?.hasTgBotToken && s?.tgChannel),
    detail: (s) => s?.tgChannel || s?.tgBotTokenMasked || '',
    fields: [
      {
        key: 'tgBotToken', label: t('blog.pages.integration.fields.tgBotToken.label'), secret: true, placeholder: '1234567890:AA…',
        hint: t('blog.pages.integration.fields.tgBotToken.hint'),
      },
      {
        key: 'tgChannel', label: t('blog.pages.integration.fields.tgChannel.label'),
        placeholder: '@mychannel',
        hint: t('blog.pages.integration.fields.tgChannel.hint'),
        prefill: (s) => s?.tgChannel || '',
      },
    ],
    toggle: {
      key: 'tgPublishEnabled',
      label: t('blog.pages.integration.fields.tgPublishEnabled.label'),
      hint: t('blog.pages.integration.fields.tgPublishEnabled.hint'),
    },
    testable: 'tg',
  },
  {
    key: 'site', title: t('blog.pages.integration.channels.site.title'), icon: null,
    desc: t('blog.pages.integration.channels.site.desc'),
    // Токена мало: без base URL и включённой автопубликации статьи никуда не
    // поедут (api/blogwriter/publish.ts гейтит по extPublishEnabled + extConfig),
    // поэтому «подключено» = ровно то, при чём канал реально работает.
    connected: (s) => !!(s?.extPublishEnabled && s?.extPublishUrl && s?.hasExtPublishToken),
    detail: (s) => s?.extPublishTokenMasked || '',
    fields: [
      {
        key: 'extPublishUrl', label: t('blog.pages.integration.fields.extPublishUrl.label'),
        placeholder: 'https://api.example.com',
        hint: t('blog.pages.integration.fields.extPublishUrl.hint'),
        prefill: (s) => s?.extPublishUrl || '',
      },
      {
        key: 'extPublishAuthHeader', label: t('blog.pages.integration.fields.extPublishAuthHeader.label'),
        placeholder: 'Authorization',
        hint: t('blog.pages.integration.fields.extPublishAuthHeader.hint'),
        prefill: (s) => s?.extPublishAuthHeader || 'Authorization',
      },
      {
        key: 'extPublishToken', label: t('blog.pages.integration.fields.extPublishToken.label'), secret: true, placeholder: 'blg_…',
        hint: t('blog.pages.integration.fields.extPublishToken.hint'),
      },
    ],
    toggle: {
      key: 'extPublishEnabled',
      label: t('blog.pages.integration.fields.extPublishEnabled.label'),
      hint: t('blog.pages.integration.fields.extPublishEnabled.hint'),
    },
    testable: true,
  },
  {
    key: 'x', title: t('blog.pages.integration.channels.x.title'), icon: faviconSrc('x.com'),
    oauth: true,
    desc: t('blog.pages.integration.channels.x.desc'),
    connected: () => !!xConn.value?.connected,
    detail: () => (xConn.value?.username ? `@${xConn.value.username}` : t('blog.pages.integration.linkedin.connectedShort')),
  },
  {
    key: 'threads', title: t('blog.pages.integration.channels.threads.title'), icon: faviconSrc('threads.com'), oauth: true,
    desc: t('blog.pages.integration.channels.threads.desc'),
    connected: () => !!threads.value?.connected,
    detail: () => (threads.value?.username ? `@${threads.value.username}` : t('blog.pages.integration.threads.connectedShort')),
  },
  // ── каналы без нашего кода: площадка забирает статью сама ────────────────
  // Их нельзя прятать за «скоро»: они работают уже сегодня, просто подключение
  // делается один раз руками на стороне площадки, а не токеном у нас.
  {
    key: 'dzen', title: t('blog.pages.integration.channels.dzen.title'), icon: '/icons/sites/dzen.ru.png',
    desc: t('blog.pages.integration.channels.dzen.desc'),
    howto: {
      steps: [
        t('blog.pages.integration.channels.dzen.s1'),
        t('blog.pages.integration.channels.dzen.s2'),
        t('blog.pages.integration.channels.dzen.s3'),
      ],
      copy: { label: t('blog.pages.integration.howto.feedRu'), value: 'https://ideata.io/ru/rss.xml' },
      copy2: { label: t('blog.pages.integration.howto.feedEn'), value: 'https://ideata.io/rss.xml' },
      link: { label: t('blog.pages.integration.channels.dzen.link'), url: 'https://dzen.ru/profile/editor' },
      note: t('blog.pages.integration.channels.dzen.note'),
    },
  },
  {
    key: 'medium', title: 'Medium', icon: faviconSrc('medium.com'),
    desc: t('blog.pages.integration.channels.medium.desc'),
    howto: {
      steps: [
        t('blog.pages.integration.channels.medium.s1'),
        t('blog.pages.integration.channels.medium.s2'),
        t('blog.pages.integration.channels.medium.s3'),
      ],
      link: { label: t('blog.pages.integration.channels.medium.link'), url: 'https://medium.com/p/import' },
      note: t('blog.pages.integration.channels.medium.note'),
    },
  },
  // ── в очереди: подключение известно, кода публикации ещё нет ─────────────
  {
    key: 'devto', title: 'dev.to', icon: faviconSrc('dev.to'),
    desc: t('blog.pages.integration.channels.devto.desc'),
    connected: (s) => !!(s?.devtoEnabled && s?.hasDevtoApiKey),
    detail: (s) => s?.devtoApiKeyMasked || '',
    fields: [{
      key: 'devtoApiKey', label: t('blog.pages.integration.fields.devtoApiKey.label'),
      secret: true, placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxx',
      hint: t('blog.pages.integration.fields.devtoApiKey.hint'),
    }],
    toggle: {
      key: 'devtoEnabled',
      label: t('blog.pages.integration.fields.devtoEnabled.label'),
      hint: t('blog.pages.integration.fields.devtoEnabled.hint'),
    },
    testable: 'devto',
  },
  {
    key: 'bluesky', title: 'Bluesky', icon: faviconSrc('bsky.app'),
    desc: t('blog.pages.integration.channels.bluesky.desc'),
    connected: (s) => !!(s?.blueskyEnabled && s?.hasBlueskyAppPassword && s?.blueskyHandle),
    detail: (s) => s?.blueskyHandle || '',
    fields: [
      {
        key: 'blueskyHandle', label: t('blog.pages.integration.fields.blueskyHandle.label'),
        placeholder: 'name.bsky.social',
        hint: t('blog.pages.integration.fields.blueskyHandle.hint'),
        prefill: (s) => s?.blueskyHandle || '',
      },
      {
        key: 'blueskyAppPassword', label: t('blog.pages.integration.fields.blueskyAppPassword.label'),
        secret: true, placeholder: 'xxxx-xxxx-xxxx-xxxx',
        hint: t('blog.pages.integration.fields.blueskyAppPassword.hint'),
      },
    ],
    toggle: {
      key: 'blueskyEnabled',
      label: t('blog.pages.integration.fields.blueskyEnabled.label'),
      hint: t('blog.pages.integration.fields.blueskyEnabled.hint'),
    },
    testable: 'bluesky',
  },
  {
    key: 'mastodon', title: 'Mastodon', icon: faviconSrc('mastodon.social'),
    desc: t('blog.pages.integration.channels.mastodon.desc'),
    connected: (s) => !!(s?.mastodonEnabled && s?.mastodonInstance && s?.hasMastodonToken),
    detail: (s) => s?.mastodonInstance || '',
    fields: [
      {
        key: 'mastodonInstance', label: t('blog.pages.integration.fields.mastodonInstance.label'),
        placeholder: 'https://mastodon.social',
        hint: t('blog.pages.integration.fields.mastodonInstance.hint'),
        prefill: (s) => s?.mastodonInstance || '',
      },
      {
        key: 'mastodonToken', label: t('blog.pages.integration.fields.mastodonToken.label'),
        secret: true, placeholder: 'xxxxxxxx…',
        hint: t('blog.pages.integration.fields.mastodonToken.hint'),
      },
    ],
    toggle: {
      key: 'mastodonEnabled',
      label: t('blog.pages.integration.fields.mastodonEnabled.label'),
      hint: t('blog.pages.integration.fields.mastodonEnabled.hint'),
    },
    testable: 'mastodon',
  },
  { key: 'vk', title: t('blog.pages.integration.channels.vk.title'), icon: '/icons/sites/vk.com.png', desc: t('blog.pages.integration.channels.vk.desc'), soon: true },
  {
    key: 'linkedin', title: 'LinkedIn', icon: faviconSrc('linkedin.com'), oauth: true,
    desc: t('blog.pages.integration.channels.linkedin.desc'),
    connected: () => !!linkedin.value?.connected,
    detail: () => linkedin.value?.name || t('blog.pages.integration.linkedin.connectedShort'),
  },
  {
    key: 'wordpress', title: 'WordPress', icon: faviconSrc('wordpress.org'),
    desc: t('blog.pages.integration.channels.wordpress.desc'),
    connected: (s) => !!(s?.wpEnabled && s?.wpSiteUrl && (s?.hasWpAppPassword || s?.hasWpOauthToken)),
    detail: (s) => s?.wpSiteUrl || '',
    modes: {
      key: 'wpMode',
      label: t('blog.pages.integration.channels.wordpress.modeLabel'),
      options: [
        {
          value: 'app',
          title: t('blog.pages.integration.channels.wordpress.modes.app.title'),
          desc: t('blog.pages.integration.channels.wordpress.modes.app.desc'),
        },
        {
          value: 'oauth',
          title: t('blog.pages.integration.channels.wordpress.modes.oauth.title'),
          desc: t('blog.pages.integration.channels.wordpress.modes.oauth.desc'),
        },
      ],
    },
    fields: [
      {
        key: 'wpSiteUrl', label: t('blog.pages.integration.fields.wpSiteUrl.label'),
        placeholder: 'https://example.com',
        hint: t('blog.pages.integration.fields.wpSiteUrl.hint'),
        prefill: (s) => s?.wpSiteUrl || '',
      },
      {
        key: 'wpUser', label: t('blog.pages.integration.fields.wpUser.label'),
        placeholder: 'admin', onlyMode: 'app',
        hint: t('blog.pages.integration.fields.wpUser.hint'),
        prefill: (s) => s?.wpUser || '',
      },
      {
        key: 'wpAppPassword', label: t('blog.pages.integration.fields.wpAppPassword.label'),
        secret: true, placeholder: 'xxxx xxxx xxxx xxxx', onlyMode: 'app',
        hint: t('blog.pages.integration.fields.wpAppPassword.hint'),
      },
    ],
    toggle: {
      key: 'wpEnabled',
      label: t('blog.pages.integration.fields.wpEnabled.label'),
      hint: t('blog.pages.integration.fields.wpEnabled.hint'),
    },
    testable: 'wordpress',
  },
  {
    key: 'ghost', title: 'Ghost', icon: faviconSrc('ghost.org'),
    desc: t('blog.pages.integration.channels.ghost.desc'),
    connected: (s) => !!(s?.ghostEnabled && s?.ghostSiteUrl && s?.hasGhostAdminKey),
    detail: (s) => s?.ghostAdminKeyMasked || s?.ghostSiteUrl || '',
    fields: [
      {
        key: 'ghostSiteUrl', label: t('blog.pages.integration.fields.ghostSiteUrl.label'),
        placeholder: 'https://blog.example.com',
        hint: t('blog.pages.integration.fields.ghostSiteUrl.hint'),
        prefill: (s) => s?.ghostSiteUrl || '',
      },
      {
        key: 'ghostAdminKey', label: t('blog.pages.integration.fields.ghostAdminKey.label'),
        secret: true, placeholder: '640b…:0123abcd…',
        hint: t('blog.pages.integration.fields.ghostAdminKey.hint'),
      },
    ],
    toggle: {
      key: 'ghostEnabled',
      label: t('blog.pages.integration.fields.ghostEnabled.label'),
      hint: t('blog.pages.integration.fields.ghostEnabled.hint'),
    },
    testable: 'ghost',
  },
  {
    key: 'telegraph', title: 'Telegraph', icon: faviconSrc('telegra.ph'),
    desc: t('blog.pages.integration.channels.telegraph.desc'),
    connected: (s) => !!(s?.telegraphEnabled && s?.hasTelegraphToken),
    detail: (s) => s?.telegraphTokenMasked || '',
    // Токена у Telegraph нет в интерфейсе вовсе — его выдаёт только createAccount,
    // поэтому вместо поля «вставьте токен» кнопка «Создать аккаунт».
    action: {
      key: 'telegraphAccount',
      label: t('blog.pages.integration.channels.telegraph.createAccount'),
      hint: t('blog.pages.integration.channels.telegraph.createAccountHint'),
    },
    fields: [{
      key: 'telegraphAuthorName', label: t('blog.pages.integration.fields.telegraphAuthorName.label'),
      placeholder: 'Ideata',
      hint: t('blog.pages.integration.fields.telegraphAuthorName.hint'),
      prefill: (s) => s?.telegraphAuthorName || '',
    }],
    toggle: {
      key: 'telegraphEnabled',
      label: t('blog.pages.integration.fields.telegraphEnabled.label'),
      hint: t('blog.pages.integration.fields.telegraphEnabled.hint'),
    },
    testable: 'telegraph',
  },
])

const isConnected = (c: Channel) => !!(settings.value && c.connected?.(settings.value))

const counts = computed(() => ({
  all: CHANNELS.value.length,
  connected: CHANNELS.value.filter(isConnected).length,
  soon: CHANNELS.value.filter((c) => c.soon).length,
}))

const TABS = computed(() => [
  { key: 'all', label: t('blog.pages.integration.tabs.all') },
  { key: 'connected', label: t('blog.pages.integration.tabs.connected') },
  { key: 'soon', label: t('blog.pages.integration.tabs.soon') },
] as const)

const visible = computed(() => {
  const needle = q.value.trim().toLowerCase()
  return CHANNELS.value.filter((c) => {
    if (tab.value === 'connected' && !isConnected(c)) return false
    if (tab.value === 'soon' && !c.soon) return false
    if (needle && !`${c.title} ${c.desc}`.toLowerCase().includes(needle)) return false
    return true
  })
})

// Секции каталога. Тринадцать плиток одним списком читались как свалка: «Сайт»
// и «Bluesky» стоят рядом, хотя решают разные задачи. Порядок внутри секции
// задаётся руками — сверху то, что подключают чаще.
const SOCIAL_KEYS = ['telegram', 'x', 'threads', 'linkedin', 'bluesky', 'mastodon']
const GROUPS = computed(() => [
  { key: 'blog', title: t('blog.pages.integration.groups.blog'), keys: ['site', 'wordpress', 'ghost', 'devto', 'telegraph', 'medium', 'dzen'] },
  { key: 'social', title: t('blog.pages.integration.groups.social'), keys: SOCIAL_KEYS },
  { key: 'soon', title: t('blog.pages.integration.groups.soon'), keys: ['vk'] },
])

/** секции с учётом поиска и фильтра — пустые не рисуем */
const sections = computed(() =>
  GROUPS.value
    .map((g) => ({
      key: g.key,
      title: g.title,
      items: g.keys.flatMap((k) => {
        const c = visible.value.find((x) => x.key === k)
        return c ? [c] : []
      }),
    }))
    .filter((g) => g.items.length),
)

/** микроподпись на карточке: чем этот канал отличается от «уедет статья целиком» */
const cardNote = (c: Channel) => {
  if (c.howto) return t('blog.pages.integration.cardNote.howto')
  if (!c.soon && SOCIAL_KEYS.includes(c.key)) return t('blog.pages.integration.cardNote.announce')
  return ''
}

const current = computed(() => CHANNELS.value.find((c) => c.key === channel.value) ?? null)

/** Статус активного OAuth-канала: у каждого своя таблица подключений. */
const oauthStatus = computed(() => {
  const k = current.value?.key
  return k === 'linkedin' ? linkedin.value : k === 'x' ? xConn.value : threads.value
})
const connectOauth = () => {
  const k = current.value?.key
  return k === 'linkedin' ? connectLinkedin() : k === 'x' ? connectX() : connectThreads()
}
const disconnectOauth = () => {
  const k = current.value?.key
  return k === 'linkedin' ? disconnectLinkedin() : k === 'x' ? disconnectX() : disconnectThreads()
}

/**
 * Тексты OAuth-карточки — свои у каждого канала. Раньше на всех трёх стояли
 * строки Threads: LinkedIn сообщал «Аккаунт Threads подключён» и предлагал
 * отозвать доступ «в настройках приложения Meta».
 */
const oauthText = computed(() => {
  const k = current.value?.key
  if (k === 'linkedin') {
    return {
      title: t('blog.pages.integration.linkedin.connectedTitle'),
      note: t('blog.pages.integration.linkedin.note'),
      revoke: t('blog.pages.integration.linkedin.revokeNote'),
    }
  }
  if (k === 'x') {
    return {
      title: t('blog.pages.integration.x.connectedTitle'),
      note: t('blog.pages.integration.x.oauthNote'),
      revoke: t('blog.pages.integration.x.revokeNote'),
    }
  }
  return {
    title: t('blog.pages.integration.threads.connectedTitle'),
    note: t('blog.pages.integration.threads.note'),
    revoke: t('blog.pages.integration.threads.revokeNote'),
  }
})

/** есть ли сохранённый секрет под этим полем (has-флаг из publicSettings) */
const hasSecret = (key: string) => !!(settings.value as any)?.[`has${key[0]!.toUpperCase()}${key.slice(1)}`]
/**
 * Маска именно этого секрета. Раньше рядом с полем печатался channel.detail —
 * а он у bluesky/mastodon/wordpress это хэндл или адрес сайта, то есть под
 * «Пароль приложения» показывался вовсе не пароль.
 */
const secretMask = (key: string) => String((settings.value as any)?.[`${key}Masked`] || '')

/** заполнить форму карточки из сохранённых настроек (без навигации) */
function fillForm(c: Channel) {
  // несекретные поля показываем заполненными: пустой инпут поверх сохранённого
  // base URL читается как «не задан», и человек вводит его заново
  form.value = {}
  for (const f of c.fields || []) {
    if (f.prefill) form.value[f.key] = f.prefill(settings.value)
  }
  enabled.value = c.toggle ? !!(settings.value as any)?.[c.toggle.key] : false
  mode.value = c.modes
    ? String((settings.value as any)?.[c.modes.key] || c.modes.options[0]!.value)
    : ''
  saved.value = false
  saveError.value = ''
  extIgnored.value = false
  testResult.value = null
}

function openChannel(c: Channel) {
  if (c.soon) return
  // OAuth-канал: не подключён — сразу гоним на авторизацию, подключён — карточка статуса
  if (c.oauth && !isConnected(c)) {
    return c.key === 'linkedin' ? connectLinkedin() : c.key === 'x' ? connectX() : connectThreads()
  }
  channel.value = c.key
  fillForm(c)
}

/** true — настройки реально записаны (иначе тест бил бы по старым значениям) */
async function save(): Promise<boolean> {
  const c = current.value
  if (!c?.fields || saving.value) return true
  const patch: Record<string, unknown> = {}
  for (const f of c.fields) {
    // поле чужого режима не отправляем: у каждого режима свои поля
    if (f.onlyMode && f.onlyMode !== mode.value) continue
    const v = (form.value[f.key] ?? '').trim()
    // секрет пустым не шлём: на бэке пустое значение = «не менять», а тут это
    // ещё и единственный способ не затереть уже сохранённый токен
    if (f.secret ? v : f.prefill) patch[f.key] = v
  }
  if (c.modes) patch[c.modes.key] = mode.value
  if (c.toggle) patch[c.toggle.key] = enabled.value
  if (!Object.keys(patch).length) return true
  saving.value = true
  saveError.value = ''
  try {
    const r = await api.blogPatchSettings(patch)
    extIgnored.value = !!r?.extIgnored
    await loadSettings()
    saved.value = !extIgnored.value
    if (saved.value) setTimeout(() => (saved.value = false), 2000)
    return saved.value
  } catch (e: any) {
    // молчаливый catch тут врал дважды: «Сохранить» гасло как успешное, а тест
    // потом бил по старым настройкам и показывал непонятную ошибку канала
    saveError.value = e?.message || t('blog.pages.integration.saveFailed')
    return false
  } finally { saving.value = false }
}

/**
 * Проверка канала: сначала сохраняем форму (тест бьёт по СОХРАНЁННЫМ настройкам
 * бренда, а не по тому, что в инпутах), и только если сохранение прошло.
 */
const testing = ref(false)
const testResult = ref<{
  ok: boolean; status?: number; slug?: string; native?: boolean
  cleaned?: boolean; leftoverDraft?: boolean; error?: string
} | null>(null)
async function testConnection() {
  if (testing.value) return
  testing.value = true
  testResult.value = null
  try {
    if (!(await save())) return
    const kind = current.value?.testable
    const r = kind === 'tg' ? await api.blogTgPublishTest()
      : kind === 'devto' ? await api.blogDevtoTest()
      : kind === 'bluesky' ? await api.blogBlueskyTest()
      : kind === 'wordpress' ? await api.blogWordpressTest()
      : kind === 'mastodon' ? await api.blogMastodonTest()
      : kind === 'ghost' ? await api.blogGhostTest()
      : kind === 'telegraph' ? await api.blogTelegraphTest()
      : await api.blogExtPublishTest()
    testResult.value = {
      ok: !!r?.ok, status: r?.status, slug: r?.slug, native: !!r?.native,
      cleaned: !!r?.cleaned, leftoverDraft: !!r?.leftoverDraft,
      error: r?.error || (r?.attempted === false ? t('blog.pages.integration.test.notConfigured') : ''),
    }
  } catch (e: any) {
    testResult.value = { ok: false, error: e?.message || t('state.error') }
  } finally {
    testing.value = false
  }
}
</script>

<template>
  <div class="space-y-6 p-5 lg:p-8">
    <!-- хлебные крошки -->
    <div class="flex flex-wrap items-center gap-1.5 text-[13px]">
      <span class="text-muted-foreground">Blog Writer</span>
      <span class="text-muted-foreground/50">›</span>
      <button v-if="current" type="button" class="text-muted-foreground transition hover:text-foreground" @click="channel = null">{{ $t('blog.pages.integration.breadcrumb') }}</button>
      <span v-else class="font-medium">{{ $t('blog.pages.integration.breadcrumb') }}</span>
      <template v-if="current">
        <span class="text-muted-foreground/50">›</span>
        <span class="font-medium">{{ current.title }}</span>
      </template>
    </div>

    <!-- итог возврата с OAuth: без него страница просто открывалась заново -->
    <div
      v-if="notice"
      class="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[12.5px] leading-[1.5]"
      :class="notice.ok ? 'border-success/25 bg-success-soft text-success' : 'border-danger/25 bg-danger-soft text-danger'"
    >
      <component :is="notice.ok ? Check : AlertTriangle" :size="14" class="mt-px shrink-0" />
      <span class="min-w-0 flex-1">{{ notice.text }}</span>
      <button type="button" class="shrink-0 opacity-60 transition hover:opacity-100" :aria-label="$t('action.close')" @click="notice = null">
        <X :size="14" />
      </button>
    </div>

    <!-- каталог каналов -->
    <template v-if="!current">
      <!-- хедер: заголовок + сабтайтл слева, поиск справа -->
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 class="text-[22px] font-bold tracking-[-0.025em]">{{ $t('blog.pages.integration.heading') }}</h1>
          <p class="mt-1 text-[13px] text-muted-foreground">
            {{ $t('blog.pages.integration.subtitle') }}
          </p>
        </div>
        <div class="relative w-full sm:w-72">
          <Search :size="14" class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="q" :placeholder="$t('blog.pages.integration.searchPlaceholder')" class="h-9 border-border bg-surface-2 pl-9 text-[13px]" />
        </div>
      </div>

      <!-- фильтр-табы со счётчиками: работают поверх секций -->
      <div class="flex items-center gap-1 border-b border-border">
        <button
          v-for="t in TABS" :key="t.key" type="button"
          class="relative -mb-px border-b-2 px-3 pb-2.5 pt-1 text-[13px] font-medium transition"
          :class="tab === t.key
            ? 'border-foreground text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground/80'"
          @click="tab = t.key"
        >
          {{ t.label }}
          <span class="ml-1 text-[11.5px] text-muted-foreground/60">{{ counts[t.key] }}</span>
        </button>
      </div>

      <p v-if="loading" class="py-16 text-center text-[13px] text-muted-foreground">{{ $t('state.loading') }}</p>
      <p v-else-if="!visible.length" class="py-16 text-center text-[13px] text-muted-foreground">
        {{ $t('blog.pages.integration.notFound') }}
      </p>

      <!--
        Сетка карточек. Синих кнопок «Подключить» на каждой карточке больше нет:
        их было восемь на экран, все одинаковые, и цветом они кричали громче, чем
        значил их смысл. В каталогах интеграций (LangChain, Midday, Typeform)
        действие либо тихое контурное, либо его нет вовсе — кликается карточка.

        Взято последнее: карточка целиком и есть кнопка, а справа внизу остаётся
        подпись-указатель. Цвет теперь несёт информацию, а не украшает: зелёная
        точка = подключено, приглушённая карточка = «скоро».
      -->
      <section v-for="g in sections" :key="g.key" class="space-y-3">
        <h2 class="text-[12px] font-medium uppercase tracking-[0.06em] text-muted-foreground/70">{{ g.title }}</h2>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
          <component
            :is="c.soon ? 'div' : 'button'"
            v-for="c in g.items" :key="c.key"
            :type="c.soon ? undefined : 'button'"
            class="group flex flex-col rounded-xl border border-border bg-surface p-4 text-left transition"
            :class="c.soon
              ? 'opacity-55'
              : 'cursor-pointer hover:border-hairline hover:bg-surface-2'"
            @click="c.soon ? null : openChannel(c)"
          >
            <div class="flex items-start gap-3">
              <!-- глиф канала -->
              <span class="flex size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-2">
                <svg v-if="c.key === 'telegram'" viewBox="0 0 24 24" class="size-5 text-sky-400" fill="currentColor" aria-hidden="true">
                  <path d="M21.9 4.3 18.6 20c-.25 1.1-.9 1.37-1.83.85l-5.05-3.72-2.44 2.35c-.27.27-.5.5-1.02.5l.36-5.14L17.98 6.4c.4-.36-.09-.56-.63-.2L5.79 13.44.9 11.9c-1.06-.33-1.08-1.06.22-1.57L20.53 2.8c.88-.33 1.65.2 1.37 1.5Z" />
                </svg>
                <Globe v-else-if="c.key === 'site'" :size="19" class="text-success" />
                <img v-else :src="c.icon!" :alt="c.title" class="size-5 object-contain" />
              </span>

              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <span class="truncate text-[14px] font-semibold">{{ c.title }}</span>
                  <span
                    v-if="c.soon"
                    class="shrink-0 rounded-full border border-border px-1.5 py-px text-[10px] font-medium text-muted-foreground"
                  >{{ $t('blog.pages.integration.soonBadge') }}</span>
                  <span
                    v-else-if="isConnected(c)"
                    class="inline-flex shrink-0 items-center gap-1 rounded-full bg-success-soft px-1.5 py-px text-[10px] font-medium text-success"
                  ><span class="size-1 rounded-full bg-success"></span> {{ $t('blog.pages.integration.connectedBadge') }}</span>
                </div>
                <p class="mt-1.5 text-[12.5px] leading-[1.5] text-muted-foreground">{{ c.desc }}</p>
              </div>
            </div>

            <!-- Подвал: маска токена (или чем канал отличается) слева, указатель
                 справа. mt-auto держит его у низа, иначе карточки в ряду
                 разъезжаются по высоте. -->
            <div class="mt-auto flex items-center justify-between gap-2 pt-4">
              <span
                v-if="!c.soon && isConnected(c) && c.detail?.(settings)"
                class="truncate rounded bg-surface-hover px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground"
              >{{ c.detail?.(settings) }}</span>
              <span v-else-if="cardNote(c)" class="truncate text-[11px] text-muted-foreground/60">{{ cardNote(c) }}</span>
              <span v-else></span>
              <span
                v-if="!c.soon"
                class="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-muted-foreground transition group-hover:text-foreground"
              >
                {{ isConnected(c) ? $t('blog.pages.integration.configure') : $t('blog.pages.integration.connect') }}
                <ChevronRight :size="14" class="transition group-hover:translate-x-0.5" />
              </span>
            </div>
          </component>
        </div>
      </section>
    </template>

    <!-- конфигурация канала: форма во всю ширину. Правой колонки «Статус» больше
         нет — она занимала треть экрана ради бейджа, который и так виден. -->
    <template v-else>
      <div class="flex items-center gap-3">
        <span class="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-2">
          <svg v-if="current.key === 'telegram'" viewBox="0 0 24 24" class="size-5 text-sky-400" fill="currentColor" aria-hidden="true">
            <path d="M21.9 4.3 18.6 20c-.25 1.1-.9 1.37-1.83.85l-5.05-3.72-2.44 2.35c-.27.27-.5.5-1.02.5l.36-5.14L17.98 6.4c.4-.36-.09-.56-.63-.2L5.79 13.44.9 11.9c-1.06-.33-1.08-1.06.22-1.57L20.53 2.8c.88-.33 1.65.2 1.37 1.5Z" />
          </svg>
          <Globe v-else-if="current.key === 'site'" :size="20" class="text-success" />
          <img v-else :src="current.icon!" :alt="current.title" class="size-5 object-contain" />
        </span>
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <h1 class="text-[20px] font-bold tracking-[-0.025em]">{{ current.title }}</h1>
            <span
              v-if="isConnected(current)"
              class="inline-flex items-center gap-1.5 rounded-full bg-success-soft px-2 py-0.5 text-[11px] font-medium text-success"
            ><span class="size-1.5 rounded-full bg-success"></span> {{ $t('blog.pages.integration.status.connected') }}</span>
            <span
              v-else
              class="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
            ><span class="size-1.5 rounded-full bg-muted-foreground/50"></span> {{ $t('blog.pages.integration.status.disconnected') }}</span>
          </div>
          <p class="text-[12.5px] text-muted-foreground">{{ current.desc }}</p>
        </div>
      </div>

      <div class="rounded-xl border border-border bg-surface">
        <!-- OAuth-канал: токен добыт авторизацией, вводить нечего -->
        <div v-if="current.oauth" class="space-y-4 p-5">
          <div class="flex items-center gap-2 text-[13px]">
            <Check :size="15" class="text-success" />
            {{ oauthText.title }}<!--
            --><template v-if="oauthStatus?.username">: <b>@{{ oauthStatus.username }}</b></template><!--
            --><template v-else-if="oauthStatus?.name">: <b>{{ oauthStatus.name }}</b></template>
          </div>
          <p class="text-[12.5px] leading-[1.6] text-muted-foreground">
            {{ oauthText.note }}
            <template v-if="oauthStatus?.expiresAt">
              {{ $t('blog.pages.integration.threads.expires', { date: new Date(oauthStatus.expiresAt).toLocaleDateString(intlLocale()) }) }}
            </template>
            <template v-if="current.key === 'threads'"> {{ $t('blog.pages.integration.channels.threadsNote') }}</template>
          </p>
          <div class="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="outline" size="sm" @click="connectOauth">{{ $t('blog.pages.integration.threads.reconnect') }}</Button>
            <Button variant="ghost" size="sm" class="text-danger hover:text-danger/80" @click="disconnectOauth">{{ $t('blog.pages.integration.threads.disconnect') }}</Button>
          </div>
          <p class="text-[11px] leading-[1.5] text-muted-foreground/60">{{ oauthText.revoke }}</p>
        </div>

        <!-- канал без нашего кода: площадка забирает статью сама, показываем шаги -->
        <div v-else-if="current.howto" class="space-y-5 p-5">
          <ol class="space-y-3">
            <li v-for="(step, i) in current.howto.steps" :key="i" class="flex gap-2.5">
              <span class="mt-px grid size-[18px] shrink-0 place-items-center rounded-full bg-surface-2 text-[10.5px] font-medium text-muted-foreground">{{ i + 1 }}</span>
              <span class="text-[12.5px] leading-[1.6] text-text-2">{{ step }}</span>
            </li>
          </ol>

          <div v-for="c in [current.howto.copy, current.howto.copy2].filter(Boolean)" :key="c!.value" class="space-y-1.5">
            <label class="text-[11.5px] text-muted-foreground">{{ c!.label }}</label>
            <div class="flex items-center gap-2">
              <code class="min-w-0 flex-1 truncate rounded-lg border border-border bg-surface-2 px-3 py-2 text-[11.5px] text-text-2">{{ c!.value }}</code>
              <button
                type="button"
                class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-2 text-[11.5px] font-medium text-muted-foreground transition hover:text-foreground"
                @click="copyValue(c!.value)"
              >
                <component :is="copied === c!.value ? Check : Copy" :size="12" />
                {{ copied === c!.value ? $t('action.copied') : $t('action.copy') }}
              </button>
            </div>
          </div>

          <p v-if="current.howto.note" class="rounded-lg border border-border bg-surface-2 px-3 py-2.5 text-[11.5px] leading-[1.6] text-muted-foreground">
            {{ current.howto.note }}
          </p>

          <a
            v-if="current.howto.link" :href="current.howto.link.url" target="_blank" rel="noopener"
            class="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[12.5px] font-medium transition hover:bg-surface-hover"
          >
            <ExternalLink :size="13" /> {{ current.howto.link.label }}
          </a>
        </div>

        <div v-else class="space-y-5 p-5">
          <!-- выбор способа подключения: два принципиально разных пути, поэтому
               карточками, а не выпадашкой — разницу надо прочитать до выбора -->
          <div v-if="current.modes" class="space-y-2">
            <label class="text-[13px] font-medium">{{ current.modes.label }}</label>
            <div class="grid gap-2 sm:grid-cols-2">
              <button
                v-for="o in current.modes.options" :key="o.value" type="button"
                class="rounded-lg border p-3 text-left transition"
                :class="mode === o.value
                  ? 'border-brand-accent/45 bg-brand-accent-soft'
                  : 'border-border bg-surface-2 hover:bg-surface-hover'"
                @click="mode = o.value"
              >
                <span class="flex items-center gap-2">
                  <span
                    class="grid size-3.5 shrink-0 place-items-center rounded-full border"
                    :class="mode === o.value ? 'border-brand-accent' : 'border-border'"
                  >
                    <span v-if="mode === o.value" class="size-1.5 rounded-full bg-brand-accent"></span>
                  </span>
                  <span class="text-[13px] font-medium">{{ o.title }}</span>
                </span>
                <span class="mt-1.5 block text-[11.5px] leading-[1.5] text-muted-foreground">{{ o.desc }}</span>
              </button>
            </div>
          </div>

          <div
            v-for="f in (current.fields || []).filter((x) => !x.onlyMode || x.onlyMode === mode)" :key="f.key"
            class="space-y-2"
          >
            <label class="flex flex-wrap items-center gap-2 text-[13px] font-medium">
              <KeyRound v-if="f.secret" :size="14" class="text-muted-foreground" /> {{ f.label }}
              <!-- рядом с секретом — маска именно этого секрета, а не «деталь» канала -->
              <span
                v-if="f.secret && hasSecret(f.key)"
                class="rounded bg-surface-hover px-1.5 py-0.5 text-[10.5px] text-muted-foreground"
                :class="secretMask(f.key) && 'font-mono'"
              >{{ secretMask(f.key) || $t('blog.pages.integration.secretSaved') }}</span>
            </label>
            <Input
              v-model="form[f.key]"
              :type="f.secret ? 'password' : 'text'"
              :placeholder="f.placeholder"
              :class="['h-9 border-border bg-surface text-[13px]', !f.secret && 'font-mono']"
            />
            <p v-if="f.hint" class="text-[11.5px] text-muted-foreground/70">{{ f.hint }}</p>
            <p v-if="f.secret" class="text-[11px] leading-[1.5] text-muted-foreground/60">{{ $t('blog.pages.integration.status.tokenNote') }}</p>
          </div>

          <!-- выключатель канала: без него автопубликация настроена, но не работает -->
          <label v-if="current.toggle" class="flex cursor-pointer items-start gap-3 rounded-lg border border-border bg-surface-2 p-3">
            <input v-model="enabled" type="checkbox" class="mt-0.5 size-4 accent-[color:var(--primary)]" />
            <span class="min-w-0">
              <span class="block text-[13px] font-medium">{{ current.toggle.label }}</span>
              <span class="mt-0.5 block text-[11.5px] leading-[1.5] text-muted-foreground">{{ current.toggle.hint }}</span>
            </span>
          </label>

          <!-- как эта площадка получает статью — до полей: сначала ответ на
               «что дальше», потом «куда вставить ключ» -->
          <div v-if="flowHint" class="flex items-start gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-[12px] leading-[1.5] text-muted-foreground">
            <Send :size="14" class="mt-px shrink-0 opacity-70" />
            <span>{{ flowHint }}</span>
          </div>

          <!-- своё действие канала: у Telegraph токен нельзя «взять в настройках»,
               его выдаёт только createAccount — поэтому кнопка, а не поле -->
          <div v-if="current.action" class="rounded-lg border border-border bg-surface px-3 py-3">
            <div class="flex flex-wrap items-center gap-2">
              <Button
                variant="outline" size="sm" class="h-8 text-[12.5px]"
                :disabled="acting || saving" @click="runAction"
              >
                <Loader2 v-if="acting" :size="13" class="animate-spin" /><KeyRound v-else :size="13" />
                {{ current.action.label }}
              </Button>
              <span v-if="settings?.hasTelegraphToken" class="font-mono text-[11.5px] text-muted-foreground">
                {{ settings.telegraphTokenMasked }}
              </span>
            </div>
            <p class="mt-1.5 text-[11.5px] leading-[1.5] text-muted-foreground">{{ current.action.hint }}</p>
            <!-- auth_url показываем один раз: второй раз его взять неоткуда -->
            <div v-if="actionAuthUrl" class="mt-2 flex items-start gap-2 rounded-md border border-warning/25 bg-warning-soft px-2.5 py-2 text-[11.5px] leading-[1.5] text-warning">
              <AlertTriangle :size="13" class="mt-px shrink-0" />
              <span class="min-w-0">
                {{ $t('blog.pages.integration.channels.telegraph.authUrlNote') }}
                <a :href="actionAuthUrl" target="_blank" rel="noopener" class="block truncate underline">{{ actionAuthUrl }}</a>
              </span>
            </div>
            <p v-if="actionErr" class="mt-1.5 text-[11.5px] text-danger">{{ actionErr }}</p>
          </div>

          <!-- результат проверки: у «Сайта» тест публикует ЧЕРНОВИК и убирает его
               за собой, поэтому «черновик остался» — отдельный (жёлтый) исход -->
          <div
            v-if="testResult"
            class="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[12px] leading-[1.5]"
            :class="!testResult.ok ? 'border-danger/25 bg-danger-soft text-danger'
              : testResult.leftoverDraft ? 'border-warning/25 bg-warning-soft text-warning'
              : 'border-success/25 bg-success-soft text-success'"
          >
            <component :is="testResult.ok && !testResult.leftoverDraft ? Check : testResult.ok ? AlertTriangle : X" :size="14" class="mt-px shrink-0" />
            <span v-if="testResult.ok">
              {{ testResult.native ? $t('blog.pages.integration.test.native')
                : testResult.leftoverDraft ? $t('blog.pages.integration.test.leftover')
                : testResult.cleaned ? $t('blog.pages.integration.test.okCleaned')
                : $t('blog.pages.integration.test.ok') }}
              <template v-if="testResult.slug">
                <span class="font-mono text-[11.5px]">/{{ testResult.slug }}</span>
              </template>
            </span>
            <span v-else>{{ testResult.error }}</span>
          </div>

          <!-- настройки автопубликации привязаны к бренду: без активного бренда PATCH их не сохранит -->
          <div v-if="extIgnored" class="flex items-start gap-2 rounded-lg border border-warning/25 bg-warning-soft px-3 py-2.5 text-[12px] leading-[1.5] text-warning">
            <AlertTriangle :size="14" class="mt-px shrink-0" />
            <span>{{ $t('blog.pages.integration.noBrand') }}</span>
          </div>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3.5">
          <Button variant="ghost" size="sm" class="text-muted-foreground" @click="channel = null">
            <ArrowLeft :size="13" /> {{ $t('action.back') }}
          </Button>
          <div class="flex flex-wrap items-center gap-2">
            <span v-if="saveError" class="text-[11.5px] text-danger">{{ saveError }}</span>
            <Button
              v-if="current.testable" variant="outline" size="sm" class="h-8 text-[12.5px]"
              :disabled="testing || saving" @click="testConnection"
            >
              <PlugZap :size="13" />
              {{ testing ? $t('blog.pages.integration.test.running')
                : current.key === 'site' ? $t('blog.pages.integration.test.actionSite')
                : $t('blog.pages.integration.test.action') }}
            </Button>
            <!-- у howto-каналов сохранять нечего: кнопка была мёртвой -->
            <Button v-if="!current.oauth && current.fields?.length" size="sm" :disabled="saving" @click="save">
              <Check v-if="saved" :size="13" />
              {{ saved ? $t('blog.pages.integration.saved') : saving ? $t('blog.pages.integration.saving') : $t('blog.pages.integration.save') }}
            </Button>
          </div>
        </div>
      </div>

      <!-- контракт приёмника: без него токен и base URL — просто два поля.
           Свёрнут: это справочник на два экрана, а не часть формы. -->
      <SiteIngestDocs
        v-if="current.key === 'site'"
        :base="form.extPublishUrl || ''"
        :header="form.extPublishAuthHeader || ''"
      />
    </template>
  </div>
</template>
