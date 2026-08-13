<script setup lang="ts">
/**
 * Композер соцсетей: полноэкранная модалка с тредом и отдельной модалкой
 * публикации. Схема снята с Typefully, потому что она решает ровно наши задачи.
 *
 * Что именно взято и почему:
 *
 *  · Тред — это лента, а не форма. Аватар, имя, текст, нить между постами, и
 *    печатаешь прямо в ней. Отдельного превью нет: оно показывало бы тот же
 *    текст второй раз.
 *  · Панель действий под сфокусированным постом (#N, добавить ниже, копировать,
 *    удалить). Действие принадлежит ПОСТУ, а не всей вкладке.
 *  · Публикация — отдельная модалка со списком площадок и тумблерами. Одна
 *    кнопка «Опубликовать» в шапке, выбор адресатов внутри. Это же снимает
 *    вопрос «куда именно»: список видно перед отправкой.
 *  · Счётчик — остаток символов, а не «118/270»: цифра важна у края.
 *
 * Площадки стоят КОЛОНКАМИ в ряд (Mailchimp «Customize What You Share», то же у
 * Later и Sprout), а не одной лентой активной вкладки. Причина простая: пост
 * правят, сравнивая с соседним — вкладки заставляли держать второй текст в
 * голове и прятали площадку, у которой сборка упала. Полоса чипов сверху
 * осталась, но теперь это навигация: клик скроллит к колонке.
 */
import { computed, nextTick, ref, watch } from 'vue'
import { createReusableTemplate } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import {
  BarChart3, Check, Copy, CornerDownRight, Eye, ExternalLink, Film, Globe, GripVertical,
  Heart, ImagePlus, Loader2, MessageCircle, Plus, RefreshCw, Repeat2, Share, Smile,
  Trash2, TriangleAlert, X,
} from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { useRouter } from 'vue-router'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { api, type CrosspostAdapt, type CrosspostMediaItem, type CrosspostPlatform, type PublishChannel } from '@/lib/api'
import { faviconSrc } from '@/data/prompts'
import { AUTO_PUBLISH_CHANNELS, CHANNEL_ICONS } from '@/data/channelIcons'
import { publishTargets } from '@/data/publishTargets'
import { useBrands } from '@/composables/useBrands'

const props = defineProps<{
  open: boolean
  runId: string
  canPublish: boolean
}>()
const emit = defineEmits<{ 'update:open': [boolean] }>()
const { t } = useI18n()
const { active } = useBrands()
const router = useRouter()

/** Логотипы площадок вместо эмодзи — таблица общая с планом и диалогом публикации */
const ICONS = CHANNEL_ICONS
/** Куда кабинет публикует сам. Остальным — копирование. */
const PUBLISHABLE = AUTO_PUBLISH_CHANNELS
/**
 * Сколько файлов площадка примет В ОДНОМ посте. Общей четвёркой было бы врать:
 * у Telegram альбом до 10, у LinkedIn пост один и девятка там суммарная, у X и
 * ATProto-лент — четыре на каждый пост треда. У кого нуля нет в списке (загрузки
 * на бэке не заведено) кнопку показываем выключенной, а не прячем — иначе
 * непонятно, «почему у телеги скрепка есть, а тут нет».
 */
const PLATFORM_MEDIA_MAX: Record<string, number> = { tg: 10, x: 4, bluesky: 4, mastodon: 4, linkedin: 9 }
const mediaMax = (k: string) => PLATFORM_MEDIA_MAX[k] || 0
/** Больше четырёх файлов — это уже альбом: квадрат 2×2 их просто не покажет. */
const album = (k: string) => mediaMax(k) > 4
/** Что принимает бэк (crosspost.controller MEDIA_EXT). */
const MEDIA_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,video/mp4,video/quicktime,video/webm'
/**
 * Ходовые эмодзи для пикера. Своей зависимости ради одного поповера не берём:
 * полный каталог тут не нужен, в постах живут реакции, руки, стрелки и цифры.
 */
const EMOJI = [
  '👍', '👎', '❤️', '🔥', '🎉', '😍', '😂', '🙂',
  '😉', '😎', '🤔', '😅', '😢', '😱', '🙏', '👏',
  '🤝', '💪', '👋', '✌️', '👌', '🫡', '💡', '⚡',
  '⭐', '✅', '❌', '⚠️', '📈', '📉', '📊', '🚀',
  '🎯', '🏆', '💰', '🧠', '📌', '🔗', '📷', '🎬',
  '➡️', '⬅️', '⬆️', '⬇️', '1️⃣', '2️⃣', '3️⃣', '❓',
]

/**
 * Каналы, куда едет СТАТЬЯ целиком (сайт, dev.to, WordPress, Ghost, Telegraph) и
 * анонсы (Telegram, Bluesky, Mastodon, Threads). Раньше их выбор жил
 * раскрывашкой в инспекторе статьи — в колонке 350px это был список галочек, по
 * которому нельзя было понять, куда вообще можно отправить. Теперь обе группы
 * рядом: «статья целиком» и «короткие посты».
 */
const blogChannels = ref<PublishChannel[]>([])
const blogPicked = ref<Set<string>>(new Set())

const platforms = ref<CrosspostPlatform[]>([])
const picked = ref<Set<string>>(new Set(['tg', 'x']))
const adapts = ref<Record<string, CrosspostAdapt>>({})
const adaptErr = ref<Record<string, string>>({})
/** что уже опубликовано: платформа → ссылка */
const state = ref<Record<string, { ids?: string[]; url?: string }>>({})
/** какая колонка сейчас в вьюпорте — подсветка чипа в полосе навигации */
const tab = ref('')
/** сфокусированный пост: «площадка#индекс», потому что лент теперь несколько */
const focused = ref('')
/** прикреплённые файлы по площадкам; постом владеет postIndex внутри элемента */
const mediaByPlatform = ref<Record<string, CrosspostMediaItem[]>>({})
const mediaBusy = ref<Record<string, boolean>>({})
const mediaErr = ref<Record<string, string>>({})
/** в какой ПОСТ положить файл из общего скрытого input (fkey) */
const mediaTarget = ref('')
/** у какого поста (fkey) раскрыт пикер эмодзи и где его рисовать */
const emojiFor = ref('')
const emojiPos = ref({ top: 0, left: 0 })
const emojiEl = ref<HTMLElement | null>(null)
/** автосейв упал — говорим один раз и мелко, мигать на каждой букве незачем */
const saveErr = ref('')
const fileEl = ref<HTMLInputElement | null>(null)
/** контейнер колонок — по нему скроллим к площадке и ловим активный чип */
const colsEl = ref<HTMLElement | null>(null)
const generating = ref(false)
const err = ref('')
const copied = ref('')
/** модалка публикации поверх композера */
const publishOpen = ref(false)
/** тумблеры адресатов в модалке публикации */
const targets = ref<Set<string>>(new Set())
const publishing = ref(false)
/** результат по площадкам после отправки */
const results = ref<Record<string, { ok: boolean; url?: string; error?: string; mediaError?: string }>>({})
/** показывать выбор площадок (пере-сборка под другой набор) */
const chooserOpen = ref(false)
let copyT: ReturnType<typeof setTimeout> | undefined

/**
 * Собранные адаптации по статьям: возврат к прошлой статье не должен стоить
 * ещё одного прогона LLM, а вот показывать её тред у другой статьи нельзя.
 */
const adaptCache = new Map<string, Record<string, CrosspostAdapt>>()
/** то же для прикреплённых файлов: они привязаны к ран-id, а не к сессии */
const mediaCache = new Map<string, Record<string, CrosspostMediaItem[]>>()
/** для какой статьи сейчас загружено содержимое композера */
let loadedRunId = ''

/**
 * Данные тянем при первом открытии: держать их всё время смысла нет.
 * Слушаем и runId: компонент живёт в странице статьи и НЕ пересоздаётся при
 * переключении локали/темы — без этого композер показывал тред прошлой статьи
 * и публиковал его под её же ссылкой.
 */
watch([() => props.open, () => props.runId], async ([open, runId]) => {
  if (!open || !runId) return
  if (loadedRunId === runId) return
  if (loadedRunId) {
    adaptCache.set(loadedRunId, adapts.value)
    mediaCache.set(loadedRunId, mediaByPlatform.value)
    // недосохранённые правки уходящей статьи дописываем сейчас: через две
    // секунды в adapts будет уже чужой тред
    flushSave()
  }
  loadedRunId = runId as string

  adapts.value = { ...(adaptCache.get(runId as string) || {}) }
  // файлы прошлой статьи в новом посте — гарантированно чужая картинка
  mediaByPlatform.value = { ...(mediaCache.get(runId as string) || {}) }
  mediaBusy.value = {}
  mediaErr.value = {}
  adaptErr.value = {}
  results.value = {}
  targets.value = new Set()
  state.value = {}
  tab.value = ''
  focused.value = ''
  err.value = ''
  saveErr.value = ''
  emojiFor.value = ''
  publishOpen.value = false
  chooserOpen.value = false

  // профили площадок общие для всех статей — тянем один раз
  if (!platforms.value.length) {
    try { platforms.value = (await api.crosspostPlatforms()).platforms || [] } catch { /* пустой список — только пустое состояние */ }
  }
  try {
    const st = await api.crosspostState(runId as string)
    state.value = st.platforms || {}
    // Черновик с сервера — то, ради чего это всё: тред больше не собирается
    // заново после перезагрузки. Кэш сессии остаётся быстрым путём, поэтому
    // гидрируем только когда в памяти пусто.
    if (st.drafts?.adapts && !Object.keys(adapts.value).length && Object.keys(st.drafts.adapts).length) {
      adapts.value = { ...st.drafts.adapts }
      adaptCache.set(runId as string, adapts.value)
    }
    if (st.drafts?.media && !Object.keys(mediaByPlatform.value).length) {
      mediaByPlatform.value = { ...st.drafts.media }
      mediaCache.set(runId as string, mediaByPlatform.value)
    }
    // «Пересобрать» должна брать те же площадки, что уже в треде, а не
    // дефолтную пару tg+x — иначе кнопка молча меняет состав колонок
    if (Object.keys(adapts.value).length) picked.value = new Set(Object.keys(adapts.value))
  } catch { /* необязательно */ }
  try {
    const res = await api.blogChannels()
    blogChannels.value = res.channels || []
    // по умолчанию — то, что настроено и включено тумблером в интеграциях
    blogPicked.value = new Set(blogChannels.value.filter((c) => c.ready && c.enabled).map((c) => c.key))
  } catch { blogChannels.value = [] }
// immediate: модалку могут отрисовать сразу открытой, и тогда «изменения» prop
// не будет — список площадок останется пустым, а вкладки покажут сырые ключи
}, { immediate: true })

watch([adapts, adaptErr], () => {
  if (!tab.value || (!adapts.value[tab.value] && !adaptErr.value[tab.value])) tab.value = tabs.value[0] || ''
}, { deep: true })

// --- автосейв черновика ----------------------------------------------------
/**
 * Главная претензия к композеру была не про кнопки: собранный тред жил только в
 * памяти вкладки, и после перезагрузки его готовили заново. Пишем молча, с
 * дебаунсом — индикатор «сохранено» тут лишний шум, а вот молчащая ошибка
 * означала бы потерянный вечер, поэтому её показываем один раз и мелко.
 */
let saveT: ReturnType<typeof setTimeout> | undefined
let saveErrShown = false

function saveDrafts(id: string, a: Record<string, CrosspostAdapt>, m: Record<string, CrosspostMediaItem[]>) {
  return api.crosspostSaveDrafts(id, { adapts: a, media: m }).catch((e: any) => {
    if (saveErrShown) return
    saveErrShown = true
    saveErr.value = errText(e, t('blog.pages.run.social.draftFailed'))
  })
}
function scheduleSave() {
  const id = loadedRunId
  if (!id) return
  clearTimeout(saveT)
  saveT = setTimeout(() => {
    saveT = undefined
    void saveDrafts(id, adapts.value, mediaByPlatform.value)
  }, 2000)
}
/** Отправить отложенный сейв немедленно (уходим с этой статьи). */
function flushSave() {
  if (!saveT || !loadedRunId) return
  clearTimeout(saveT)
  saveT = undefined
  void saveDrafts(loadedRunId, adapts.value, mediaByPlatform.value)
}

function togglePick(key: string) {
  // ненастроенную площадку выбирать нельзя: адаптацию соберём, а отправить
  // будет некуда — сначала «Настроить»
  if (platforms.value.find((p) => p.key === key)?.ready === false) return
  const next = new Set(picked.value)
  next.has(key) ? next.delete(key) : next.add(key)
  picked.value = next
}
function toggleBlog(key: string) {
  if (blogChannels.value.find((c) => c.key === key)?.ready === false) return
  const next = new Set(blogPicked.value)
  next.has(key) ? next.delete(key) : next.add(key)
  blogPicked.value = next
}
function toggleTarget(key: string) {
  // площадка откажет сама: пост длиннее её лимита. Включённый тумблер обещал бы
  // отправку, которая гарантированно вернётся ошибкой
  if (overflowOf(key)) return
  const next = new Set(targets.value)
  next.has(key) ? next.delete(key) : next.add(key)
  targets.value = next
}

async function copy(text: string, mark: string) {
  if (!text.trim()) return
  try {
    await navigator.clipboard.writeText(text)
    copied.value = mark
    clearTimeout(copyT)
    copyT = setTimeout(() => { if (copied.value === mark) copied.value = '' }, 2000)
  } catch { /* clipboard закрыт — текст выделяется руками */ }
}

/**
 * Сгенерировать адаптации: вызов LLM на каждую площадку, поэтому по кнопке.
 * keys — пересборка конкретных площадок (ретрай с упавшей вкладки), без них
 * собираем всё выбранное в пикере.
 */
async function generate(keys?: string[]) {
  const list = keys?.length ? keys : [...picked.value]
  if (generating.value || !list.length) return
  generating.value = true
  err.value = ''
  if (keys?.length) {
    const next = { ...adaptErr.value }
    for (const k of keys) delete next[k]
    adaptErr.value = next
  } else {
    adaptErr.value = {}
  }
  try {
    const res = await api.crosspostAdapt(props.runId, list)
    for (const r of res.results || []) {
      if (r.ok && r.result) adapts.value = { ...adapts.value, [r.platform]: r.result }
      else adaptErr.value = { ...adaptErr.value, [r.platform]: r.error || t('blog.pages.run.social.errors.adapt') }
    }
    adaptCache.set(props.runId, adapts.value)
    scheduleSave()
    chooserOpen.value = false
  } catch (e: any) {
    err.value = e?.status === 402 ? t('blog.pages.run.social.errors.tariff') : t('blog.pages.run.social.errors.adapt')
  } finally {
    generating.value = false
  }
}

/** Открыть модалку публикации: адресаты по умолчанию — всё, куда мы умеем. */
function openPublish() {
  results.value = {}
  targets.value = new Set(Object.keys(adapts.value).filter((k) => canAutoPublish(k) && !overflowOf(k)))
  publishOpen.value = true
}

/**
 * Публикуем последовательно, а не Promise.all: каждая площадка отвечает своей
 * ошибкой, и при параллельной отправке пользователь видит их разом и не
 * понимает, что из этого прошло.
 */
async function publishAll() {
  if (publishing.value || !targets.value.size && !blogPicked.value.size) return
  publishing.value = true

  // Сначала статья: короткие посты обычно ведут на неё ссылкой, и публиковать
  // их раньше значит на минуту раздать ссылки в никуда.
  if (blogPicked.value.size) {
    try {
      const res = await api.blogPublish(props.runId, {
        status: 'published',
        channels: [...blogPicked.value],
      })
      for (const t of publishTargets(res)) {
        results.value = { ...results.value, ['blog:' + t.key]: { ok: t.state === 'ok' || t.state === 'skipped', url: t.url, error: t.error } }
      }
    } catch (e: any) {
      const msg = errText(e, t('blog.pages.run.social.errors.publish'))
      for (const k of blogPicked.value) results.value = { ...results.value, ['blog:' + k]: { ok: false, error: msg } }
    }
  }
  for (const key of targets.value) {
    const a = adapts.value[key]
    if (!a) continue
    try {
      // медиа шлём только туда, где его умеют принять: у остальных лишнее поле
      // в теле запроса выглядело бы как обещание, которого никто не сдержит
      const media = mediaMax(key) ? mediaByPlatform.value[key] : undefined
      const res = await api.crosspostPublish(props.runId, key, a.posts, media)
      results.value = { ...results.value, [key]: { ok: !!res.ok, url: res.url, error: res.error, mediaError: res.mediaError } }
      if (res.ok) state.value = { ...state.value, [key]: { ids: res.ids || (res.messageIds || []).map(String), url: res.url } }
    } catch (e: any) {
      results.value = { ...results.value, [key]: { ok: false, error: errText(e, t('blog.pages.run.social.errors.publish')) } }
    }
  }
  publishing.value = false
}

/** Текст ошибки от бэка: e.data у нашего http-клиента не бывает — только body. */
function errText(e: any, fallback: string): string {
  if (e?.status === 402) return t('blog.pages.run.social.errors.tariff')
  return e?.serverMessage || e?.body?.message || fallback
}

async function unpublish(key: string) {
  if (publishing.value) return
  publishing.value = true
  try {
    const res = await api.crosspostUnpublish(props.runId, key)
    if (res.ok) {
      const next = { ...state.value }
      delete next[key]
      state.value = next
      const r = { ...results.value }
      delete r[key]
      results.value = r
    } else {
      results.value = { ...results.value, [key]: { ok: false, error: res.error || t('blog.pages.run.social.errors.unpublish') } }
    }
  } catch (e: any) {
    // сеть/403 роняли промис в пустоту: кнопка «снять» просто ничего не делала
    results.value = { ...results.value, [key]: { ok: false, error: errText(e, t('blog.pages.run.social.errors.unpublish')) } }
  } finally {
    publishing.value = false
  }
}

/**
 * Поле растёт под текст.
 *
 * Три вещи, каждая из которых по отдельности ломала высоту:
 *
 *  1. Директива, а не ref-колбэк: колбэк срабатывает до того, как Vue положит в
 *     поле значение, и высота считается по пустому тексту.
 *  2. Сброс в 0px с принудительным чтением offsetHeight, а не в 'auto': внутри
 *     диалога 'auto' разрешался в уже проставленную высоту, scrollHeight
 *     возвращал её же, и поле разрасталось само от себя.
 *  3. ResizeObserver на ширину. Модалка раскрывается анимацией, и первый замер
 *     попадает на момент, когда ширина поля ещё около нуля: каждая буква
 *     переносится на свою строку, и 120 символов дают под сотню строк — те самые
 *     2200px на пост. Пересчитываем, когда ширина изменилась; на изменение
 *     высоты не реагируем, иначе получим бесконечный цикл.
 */
function fit(el: HTMLTextAreaElement) {
  if (!el.clientWidth) return // ещё не раскрылись — мерить нечего
  el.style.height = '0px'
  void el.offsetHeight
  el.style.height = `${Math.max(el.scrollHeight, 24)}px`
}

const observers = new WeakMap<HTMLTextAreaElement, ResizeObserver>()
const vGrow = {
  mounted(el: HTMLTextAreaElement) {
    let lastWidth = 0
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width || 0
      if (!w || w === lastWidth) return
      lastWidth = w
      fit(el)
    })
    ro.observe(el)
    observers.set(el, ro)
    nextTick(() => fit(el))
  },
  updated: (el: HTMLTextAreaElement) => nextTick(() => fit(el)),
  unmounted(el: HTMLTextAreaElement) {
    observers.get(el)?.disconnect()
    observers.delete(el)
  },
}


/* Правки постов адресуются ПЛОЩАДКОЙ, а не активной вкладкой: колонок теперь
   несколько, и «текущая» вкладка к тому посту, в котором печатают, отношения
   не имеет. */
function editPost(k: string, i: number, value: string) {
  const a = adapts.value[k]
  if (!a) return
  const posts = [...a.posts]
  posts[i] = value
  adapts.value = { ...adapts.value, [k]: { ...a, posts } }
  adaptCache.set(props.runId, adapts.value)
  scheduleSave()
}
function onPostInput(k: string, i: number, e: Event) {
  const el = e.target as HTMLTextAreaElement
  fit(el)
  editPost(k, i, el.value)
}

/** Добавить пост СРАЗУ ПОД этим: тред пишется сверху вниз, а не только в конец. */
function addBelow(k: string, i: number) {
  const a = adapts.value[k]
  if (!a || !a.thread || a.posts.length >= 10) return
  const posts = [...a.posts]
  posts.splice(i + 1, 0, '')
  adapts.value = { ...adapts.value, [k]: { ...a, posts } }
  reindexMedia(k, i, 'insert')
  adaptCache.set(props.runId, adapts.value)
  scheduleSave()
  focused.value = fkey(k, i + 1)
}
function removePost(k: string, i: number) {
  const a = adapts.value[k]
  if (!a || a.posts.length <= 1) return
  adapts.value = { ...adapts.value, [k]: { ...a, posts: a.posts.filter((_, idx) => idx !== i) } }
  reindexMedia(k, i, 'remove')
  adaptCache.set(props.runId, adapts.value)
  scheduleSave()
  if (emojiFor.value.startsWith(k + '#')) emojiFor.value = ''
}
/** Ключ сфокусированного поста: площадка + индекс. */
const fkey = (k: string, i: number) => `${k}#${i}`

// --- колонки ---------------------------------------------------------------
/** Колонки ищем по data-атрибуту, а не по ref-колбэку в v-for: там пришлось бы
 *  вручную чистить мапу на каждой пересборке набора площадок. */
const colEl = (k: string) => colsEl.value?.querySelector<HTMLElement>(`[data-col="${k}"]`) || null
/** Клик по чипу — прокрутка к колонке: чип теперь навигация, а не переключатель. */
function scrollToCol(k: string) {
  tab.value = k
  colEl(k)?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
}
/** Активный чип — первая колонка, которая ещё видна слева. */
function onColsScroll() {
  const wrap = colsEl.value
  if (!wrap) return
  const left = wrap.scrollLeft
  for (const k of tabs.value) {
    const el = colEl(k)
    if (el && el.offsetLeft + el.offsetWidth > left + 48) { tab.value = k; break }
  }
}

// --- медиа в постах --------------------------------------------------------
/**
 * Файлы висят на КОНКРЕТНОМ посте треда, а не на площадке целиком: тред из пяти
 * постов с одной картинкой в начале — это не тред, а пост с хвостом. Каждый
 * элемент носит свой postIndex, а список остаётся плоским, чтобы не чинить
 * дырки в нумерации при удалении постов.
 */
const mediaAt = (k: string, i: number) => (mediaByPlatform.value[k] || [])
  .map((m, idx) => ({ m, idx }))
  .filter((e) => (e.m.postIndex || 0) === i)
const mediaCountAt = (k: string, i: number) => mediaAt(k, i).length
/** Всего по площадке — для бейджа в модалке публикации. */
const mediaCount = (k: string) => (mediaByPlatform.value[k] || []).length

/**
 * Номер поста — часть адреса файла, поэтому вставка и удаление поста двигают
 * его так же, как двигают сами посты. Без этого картинка первого поста после
 * удаления соседа уезжала в чужой.
 */
function reindexMedia(k: string, at: number, mode: 'insert' | 'remove') {
  const list = mediaByPlatform.value[k]
  if (!list?.length) return
  const next = list
    .filter((m) => !(mode === 'remove' && (m.postIndex || 0) === at))
    .map((m) => {
      const p = m.postIndex || 0
      if (p <= at) return m
      return { ...m, postIndex: mode === 'insert' ? p + 1 : p - 1 }
    })
  mediaByPlatform.value = { ...mediaByPlatform.value, [k]: next }
  mediaCache.set(props.runId, mediaByPlatform.value)
}

/** Один скрытый input на все колонки: помним, чей ПОСТ его открыл. */
function pickMedia(k: string, i: number) {
  if (!mediaMax(k)) return
  mediaTarget.value = fkey(k, i)
  if (fileEl.value) fileEl.value.value = ''
  fileEl.value?.click()
}
async function onFilePicked(e: Event) {
  const input = e.target as HTMLInputElement
  const at = mediaTarget.value.lastIndexOf('#')
  const k = at > 0 ? mediaTarget.value.slice(0, at) : ''
  const i = at > 0 ? Number(mediaTarget.value.slice(at + 1)) : 0
  const files = [...(input.files || [])]
  if (!k || !files.length) return
  const max = mediaMax(k)
  const already = mediaCountAt(k, i)
  mediaErr.value = { ...mediaErr.value, [k]: '' }
  if (already >= max) {
    mediaErr.value = { ...mediaErr.value, [k]: t('blog.pages.run.social.media.limit', { n: max }) }
    return
  }
  mediaBusy.value = { ...mediaBusy.value, [k]: true }
  try {
    // последовательно: ошибка на втором файле не должна прятаться за первым
    for (const file of files.slice(0, max - already)) {
      const m = await api.blogCrosspostMediaUpload(props.runId, file)
      mediaByPlatform.value = { ...mediaByPlatform.value, [k]: [...(mediaByPlatform.value[k] || []), { ...m, postIndex: i }] }
    }
    mediaCache.set(props.runId, mediaByPlatform.value)
    scheduleSave()
  } catch (err2: any) {
    mediaErr.value = { ...mediaErr.value, [k]: errText(err2, t('blog.pages.run.social.media.failed')) }
  } finally {
    mediaBusy.value = { ...mediaBusy.value, [k]: false }
  }
}
function removeMedia(k: string, i: number) {
  mediaByPlatform.value = { ...mediaByPlatform.value, [k]: (mediaByPlatform.value[k] || []).filter((_, idx) => idx !== i) }
  mediaCache.set(props.runId, mediaByPlatform.value)
  scheduleSave()
}

// --- эмодзи ----------------------------------------------------------------
/**
 * Поповер живёт на уровне всей модалки, а не в колонке: колонка ленты со своим
 * overflow-y обрезала бы его по краю. Координаты считаем ОТ КОРОБКИ модалки —
 * у DialogContent есть translate(-50%,-50%), и он становится точкой отсчёта
 * даже для position:fixed, так что viewport-координаты здесь не годятся.
 */
const EMOJI_W = 268
const EMOJI_H = 226
function toggleEmoji(k: string, i: number, e: MouseEvent) {
  const key = fkey(k, i)
  if (emojiFor.value === key) { emojiFor.value = ''; return }
  const btn = e.currentTarget as HTMLElement
  const r = btn.getBoundingClientRect()
  const box = btn.closest('[data-slot="dialog-content"]')?.getBoundingClientRect()
  if (!box) return
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 8), Math.max(8, max - 8))
  emojiPos.value = {
    top: clamp(r.bottom - box.top + 6, box.height - EMOJI_H),
    left: clamp(r.left - box.left, box.width - EMOJI_W),
  }
  emojiFor.value = key
  // фокус на поповере, чтобы Esc закрывал ЕГО, а не весь композер
  nextTick(() => emojiEl.value?.focus())
}
/** Textarea поста ищем по data-атрибуту: ref-колбэков на v-for тут не напасёшься. */
const postTextarea = (key: string) =>
  colsEl.value?.querySelector<HTMLTextAreaElement>(`[data-post="${key}"] textarea`) || null

/** Вставка в позицию курсора, а не в конец: эмодзи ставят по месту в фразе. */
function pickEmoji(ch: string) {
  const key = emojiFor.value
  const at = key.lastIndexOf('#')
  if (at < 1) return
  const k = key.slice(0, at)
  const i = Number(key.slice(at + 1))
  const cur = adapts.value[k]?.posts[i] ?? ''
  const el = postTextarea(key)
  const start = el?.selectionStart ?? cur.length
  const end = el?.selectionEnd ?? cur.length
  editPost(k, i, cur.slice(0, start) + ch + cur.slice(end))
  emojiFor.value = ''
  // курсор ЗА вставленным символом: иначе следующий эмодзи встанет перед первым
  nextTick(() => {
    const next = postTextarea(key)
    if (!next) return
    next.focus()
    const pos = start + ch.length
    next.setSelectionRange(pos, pos)
    fit(next)
  })
}

/**
 * Скрепку и смайлик показываем только там, где пост уходит от нас. У RSS и
 * «скопируйте текст» кнопка обещала бы вложение, которое никуда не поедет.
 */
const canAttach = (k: string) => (platforms.value.find((p) => p.key === k)?.delivery || 'auto') === 'auto'

/**
 * Вложения рисуем ВНУТРИ ленты, а не полоской миниатюр над ней: полоска
 * показывала «файлы приложены», но не показывала, как пост будет выглядеть —
 * а именно за этим в композер и заходят. Рисуем ровно в том посте, к которому
 * файл прикреплён: превью до публикации обязано совпадать с тем, что уедет.
 */
const showMedia = (k: string, i: number) => mediaMax(k) > 0 && mediaCountAt(k, i) > 0
/** Раскладка вложений: 1 — во всю ширину, 2 — пополам, 3 — большая слева и две
 *  справа стопкой, 4 — квадрат 2×2. У Telegram и LinkedIn файлов бывает больше
 *  четырёх: там первая во всю ширину, остальные парами — так лента и покажет. */
const mediaGridCls = (k: string, n: number) => n <= 1
  ? 'grid grid-cols-1'
  : n === 2
    ? 'grid h-[220px] grid-cols-2 gap-px'
    : n <= 4 || !album(k)
      ? 'grid h-[280px] grid-cols-2 grid-rows-2 gap-px'
      : 'grid grid-cols-2 gap-px'
/** У тройки первая занимает обе строки — так её кадрируют и X, и ВК; в альбоме
 *  она же растянута на обе колонки. */
const mediaCellCls = (k: string, n: number, i: number) => album(k) && n >= 5
  ? (i === 0 ? 'col-span-2 h-[220px]' : 'h-[130px]')
  : (n === 3 && i === 0 ? 'row-span-2' : '')
/** Одиночная картинка живёт своей высотой с потолком, в сетке — тянется в ячейку. */
const mediaImgCls = (n: number) => (n <= 1 ? 'max-h-[340px] w-full object-cover' : 'size-full object-cover')
/** Видео не проигрываем: плашке нужна собственная высота, иначе она схлопнется. */
const mediaVideoCls = (n: number) => (n <= 1 ? 'h-[240px] w-full' : 'size-full')
/** Разметка вложений одна на три каркаса ленты — различается только обёрткой. */
const [DefineMedia, ReuseMedia] = createReusableTemplate<{ k: string; i: number; cls?: string }>()
/** Карточка выбора площадок живёт в двух местах: экраном до сборки и модалкой
 *  после. Второй копии этого списка не хочет никто. */
const [DefineChooser, ReuseChooser] = createReusableTemplate()
/**
 * Вкладки — ВСЕ площадки, под которые собирали, включая упавшие: молча
 * пропавшая из полосы сеть читалась как «не выбралась» (Mailchimp/Sprout
 * недоступную сеть показывают с предупреждением, а не прячут). Порядок —
 * как в каталоге площадок, а не как ответил сервер.
 */
const tabs = computed(() => {
  const keys = new Set([...Object.keys(adapts.value), ...Object.keys(adaptErr.value)])
  const ordered = platforms.value.map((p) => p.key).filter((k) => keys.has(k))
  return ordered.concat([...keys].filter((k) => !ordered.includes(k)))
})
/**
 * От трёх колонок модалка занимает весь экран. Две ленты рядом ещё читаются в
 * окне 1040px, а на третьей начинался горизонтальный скролл при пустых полях по
 * бокам — сравнивать посты, докручивая колонку, невозможно.
 */
const fullscreen = computed(() => tabs.value.length >= 3)
const limitOf = (k: string) => adapts.value[k]?.charLimit || 0
const overflow = (k: string, text: string) => !!limitOf(k) && text.length > limitOf(k)
const label = (key: string) => platforms.value.find((p) => p.key === key)?.label || key

const handle = computed(() => active.value?.name || 'Ideata')
const avatar = computed(() => (active.value?.domain ? faviconSrc(active.value.domain) : ''))

/** Можем ли отправить сами (иначе — ссылка или копирование). */
const canAutoPublish = (key: string) => PUBLISHABLE.has(key)
/** Сколько постов площадки не влезет в лимит — публиковать такое она откажется. */
function overflowOf(key: string): number {
  const a = adapts.value[key]
  if (!a?.charLimit) return 0
  return a.posts.filter((p) => p.length > a.charLimit).length
}

/** Имя канала статьи: у «Сайта» оно языкозависимое, у остальных это бренд. */
const blogLabel = (c: PublishChannel) =>
  c.key === 'external' ? t('blog.pages.run.blog.targets.site') : c.label
/** Имя адресата в подзаголовке: ключи каналов статьи помечены префиксом blog:. */
const sendLabel = (key: string) => key.startsWith('blog:')
  ? blogLabel(blogChannels.value.find((c) => c.key === key.slice(5)) || { key: '', label: key.slice(5), ready: true, enabled: true })
  : label(key)

/** Каналы статьи с готовностью, чтобы не рисовать заведомо мёртвые строки. */
const blogVisible = computed(() => blogChannels.value.filter((c) => c.ready || c.enabled))

/**
 * Каркас ленты под площадку:
 *  · 'thread' — X и Threads: аватар слева, хэндл, строка реакций;
 *  · 'bubble' — Telegram: текст в пузыре сообщения со временем;
 *  · 'card'   — ВК и Дзен: пост карточкой с шапкой.
 */
const THREAD_FEEDS = new Set(['x', 'threads', 'bluesky', 'mastodon'])
const feedOf = (k: string): 'thread' | 'bubble' | 'card' =>
  THREAD_FEEDS.has(k) ? 'thread' : k === 'tg' ? 'bubble' : 'card'

// --- перестановка постов треда ---------------------------------------------
/**
 * Порядок постов правят перетаскиванием, а не «удалить и написать заново»:
 * поменять местами второй и третий пост иначе стоит двух правок текста, и
 * прикреплённые к ним картинки при этом теряются.
 *
 * Ручка ⠿ слева (композер X), но draggable висит на самом посте: с draggable на
 * кнопке браузер потащил бы кнопку, а не карточку. Ключ в dragArm ставим по
 * pointerdown на ручке и снимаем на dragend — иначе лента начинала бы
 * перетаскиваться от обычной протяжки выделения в textarea.
 *
 * Таскаем только ВНУТРИ своей колонки: у соседней сети свой текст под свой
 * лимит символов, и перенос туда молча подсунул бы чужой пост.
 */
const dragArm = ref('')
const dragFrom = ref('')
const dragOver = ref('')

/** Ленты карточками (ВК, Дзен, LinkedIn) — это один пост, переставлять нечего. */
const canReorder = (k: string) => feedOf(k) !== 'card' && (adapts.value[k]?.posts.length || 0) > 1
/** Индекс поста из fkey своей колонки; -1 — тащат не отсюда. */
const dragIndexIn = (k: string) => (dragFrom.value.startsWith(k + '#') ? Number(dragFrom.value.slice(k.length + 1)) : -1)

function onPostDragStart(k: string, i: number, e: DragEvent) {
  // не за ручку — не тащим: иначе жест перехватывал бы выделение текста
  if (dragArm.value !== fkey(k, i)) { e.preventDefault(); return }
  dragFrom.value = fkey(k, i)
  // без setData Firefox не начинает перетаскивание вовсе
  e.dataTransfer?.setData('text/plain', fkey(k, i))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}
function onPostDragOver(k: string, i: number, e: DragEvent) {
  // preventDefault только в своей колонке: он и есть «сюда можно уронить», и без
  // проверки чужая лента показывала бы курсор переноса, который ничего не делает
  if (dragIndexIn(k) < 0) return
  e.preventDefault()
  dragOver.value = fkey(k, i)
}
function onPostDragEnd() { dragArm.value = ''; dragFrom.value = ''; dragOver.value = '' }
function onPostDrop(k: string, to: number) {
  const from = dragIndexIn(k)
  onPostDragEnd()
  if (from >= 0) movePost(k, from, to)
}

/** Пост встаёт НА место цели, поэтому линия вставки идёт под целью при движении
 *  вниз и над ней при движении вверх — ровно туда, куда он приземлится. */
function dropLineCls(k: string, i: number): string {
  if (dragOver.value !== fkey(k, i)) return ''
  const from = dragIndexIn(k)
  if (from < 0 || from === i) return ''
  const base = "before:pointer-events-none before:absolute before:inset-x-0 before:z-10 before:h-0.5 before:rounded-full before:bg-foreground/70 before:content-['']"
  return from < i ? base + ' before:-bottom-1' : base + ' before:-top-1'
}

/** Переставить пост: текст, его файлы и фокус едут вместе. */
function movePost(k: string, from: number, to: number) {
  const a = adapts.value[k]
  if (!a || from === to) return
  if (from < 0 || to < 0 || from >= a.posts.length || to >= a.posts.length) return
  const posts = [...a.posts]
  posts.splice(to, 0, ...posts.splice(from, 1))
  adapts.value = { ...adapts.value, [k]: { ...a, posts } }
  remapMedia(k, from, to)
  adaptCache.set(props.runId, adapts.value)
  scheduleSave()
  // панель действий должна остаться под тем же текстом — вместе с новым номером
  focused.value = fkey(k, to)
  // поповер эмодзи стоит по координатам старой строки: держать его нельзя
  if (emojiFor.value.startsWith(k + '#')) emojiFor.value = ''
}

/**
 * Файлы адресуются номером поста, поэтому перестановка постов — это ещё и
 * перенумерация вложений. Двигаем ровно тот отрезок, через который проехал пост:
 * иначе картинка остаётся на месте и оказывается под чужим текстом.
 */
function remapMedia(k: string, from: number, to: number) {
  const list = mediaByPlatform.value[k]
  if (!list?.length) return
  const next = list.map((m) => {
    const p = m.postIndex || 0
    if (p === from) return { ...m, postIndex: to }
    if (from < to && p > from && p <= to) return { ...m, postIndex: p - 1 }
    if (from > to && p >= to && p < from) return { ...m, postIndex: p + 1 }
    return m
  })
  mediaByPlatform.value = { ...mediaByPlatform.value, [k]: next }
  mediaCache.set(props.runId, mediaByPlatform.value)
}

/** @-хэндл для ленты: домен бренда без зоны, иначе имя без пробелов. */
const handleAt = computed(() => {
  const domain = (active.value?.domain || '').split('.')[0]
  const name = (active.value?.name || 'ideata').toLowerCase().replace(/[^a-z0-9_]/g, '')
  return '@' + (domain || name || 'ideata')
})
</script>

<template>
  <!-- Вложения в ленте. Разметка одна, а обёртку задаёт каркас сети: у Telegram
       это верх пузыря, у X — блок под текстом в рамке, у ВК с Дзеном — блид до
       краёв карточки. Скругление везде наследуется от обёртки с overflow-hidden,
       поэтому сама сетка углы не знает и не дублируется тремя копиями. -->
  <DefineMedia v-slot="{ k, i, cls }">
    <div :class="[mediaGridCls(k, mediaCountAt(k, i)), cls]">
      <div
        v-for="(e, mi) in mediaAt(k, i)" :key="e.m.url"
        class="group relative overflow-hidden bg-surface-2"
        :class="mediaCellCls(k, mediaCountAt(k, i), mi)"
      >
        <img v-if="e.m.type === 'image'" :src="e.m.url" :alt="e.m.name || ''" :class="mediaImgCls(mediaCountAt(k, i))">
        <!-- видео не проигрываем: в ленте важна только его доля кадра -->
        <div
          v-else class="flex flex-col items-center justify-center gap-1.5 bg-[#0e1116] px-3 text-center text-white/60"
          :class="mediaVideoCls(mediaCountAt(k, i))"
        >
          <Film :size="18" />
          <span class="line-clamp-2 text-[11px] leading-[1.3]">{{ e.m.name || $t('blog.pages.run.social.media.video') }}</span>
        </div>
        <!-- удаление по наведению: постоянный крестик поверх кадра врал бы про
             то, как пост увидят в ленте. Индекс — абсолютный в списке площадки:
             в посте показан только его срез -->
        <button
          type="button"
          class="absolute top-1.5 right-1.5 grid size-8 place-items-center rounded-full bg-background/85 text-muted-foreground opacity-0 transition max-sm:opacity-100 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none"
          :title="$t('blog.pages.run.social.media.remove')" @click="removeMedia(k, e.idx)"
        ><X :size="12" /></button>
      </div>
    </div>
  </DefineMedia>

  <!-- Карточка выбора площадок. Один список на два места: экраном до первой
       сборки и модалкой по «+» после неё. -->
  <DefineChooser>
    <div v-if="!tabs.length" class="mb-5 shrink-0 text-center">
      <h2 class="text-[17px] font-semibold">{{ $t('blog.pages.run.social.emptyTitle') }}</h2>
      <p class="mx-auto mt-1.5 max-w-[400px] text-[13px] leading-[1.5] text-muted-foreground">
        {{ $t('blog.pages.run.social.hint') }}
      </p>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <!-- Группа 1: куда едет САМА статья. Раньше её выбор жил раскрывашкой
           в инспекторе — там не было видно, куда вообще можно отправить. -->
      <template v-if="blogVisible.length">
        <div class="mb-2 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground/60">
          {{ $t('blog.pages.run.social.groupArticle') }}
        </div>
        <div class="-mx-1 mb-5 border-y border-border">
          <label
            v-for="c in blogVisible" :key="c.key"
            class="flex items-center gap-3.5 border-b border-border px-1 py-3.5 transition last:border-b-0"
            :class="c.ready === false ? 'cursor-pointer' : 'cursor-pointer'"
            @click="c.ready === false ? router.push('/blog/integration') : null"
          >
            <button
              type="button" role="switch" :aria-checked="blogPicked.has(c.key)"
              class="relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-40"
              :class="blogPicked.has(c.key) ? 'bg-brand-accent' : 'bg-surface-2'"
              :disabled="c.ready === false"
              @click.stop="toggleBlog(c.key)"
            >
              <span class="absolute top-0.5 size-4 rounded-full bg-white transition-all" :class="blogPicked.has(c.key) ? 'left-[18px]' : 'left-0.5'"></span>
            </button>
            <img
              v-if="ICONS[c.key]" :src="ICONS[c.key]" :alt="blogLabel(c)"
              class="size-6 shrink-0 rounded-full object-contain"
              :class="c.ready === false ? 'opacity-45 grayscale' : ''"
            >
            <Globe v-else :size="20" class="shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <div class="truncate text-[13.5px] font-medium" :class="c.ready === false ? 'text-muted-foreground' : ''">{{ blogLabel(c) }}</div>
              <p v-if="c.ready !== false && !c.enabled" class="truncate text-[11.5px] leading-[1.4] text-muted-foreground/70">
                {{ $t('blog.pages.run.blog.channels.offByDefault') }}
              </p>
            </div>
          </label>
        </div>
        <div class="mb-2 text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground/60">
          {{ $t('blog.pages.run.social.groupPosts') }}
        </div>
      </template>

      <div class="-mx-1 border-y border-border">
        <label
          v-for="p in platforms" :key="p.key"
          class="flex items-center gap-3.5 border-b border-border px-1 py-3.5 transition last:border-b-0"
          :class="p.ready === false ? 'cursor-pointer' : p.delivery === 'rss' ? '' : 'cursor-pointer'"
          @click="p.ready === false ? router.push('/blog/integration') : null"
        >
          <!-- У Дзена тумблера нет: он подписан на наш RSS и забирает статьи
               сам. Тумблер там обещал бы отправку, которой не происходит. -->
          <button
            v-if="p.delivery !== 'rss'"
            type="button" role="switch" :aria-checked="picked.has(p.key)"
            class="relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-40"
            :class="picked.has(p.key) ? 'bg-brand-accent' : 'bg-surface-2'"
            :disabled="generating || p.ready === false"
            @click.stop="togglePick(p.key)"
          >
            <span class="absolute top-0.5 size-4 rounded-full bg-white transition-all" :class="picked.has(p.key) ? 'left-[18px]' : 'left-0.5'"></span>
          </button>
          <span v-else class="h-5 w-9 shrink-0"></span>

          <img
            v-if="ICONS[p.key]" :src="ICONS[p.key]" :alt="p.label"
            class="size-6 shrink-0 rounded-full object-contain"
            :class="p.ready === false ? 'opacity-45 grayscale' : ''"
          >

          <!-- Неподключённый аккаунт — одна строка с именем и ничего больше.
               Причина и кнопка «Настроить» превращали спокойный список в
               стену текста; вся строка и так ведёт в интеграции. -->
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="truncate text-[13.5px] font-medium" :class="p.ready === false ? 'text-muted-foreground' : ''">{{ p.label }}</span>
              <span
                v-if="p.delivery === 'rss'"
                class="shrink-0 rounded-md border border-border px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground"
              >RSS</span>
            </div>
            <p v-if="p.ready !== false" class="truncate text-[11.5px] leading-[1.4] text-muted-foreground/70">
              {{ $t('blog.pages.run.social.delivery.' + (p.delivery || 'auto')) }}
            </p>
          </div>
        </label>
      </div>
    </div>

    <Button
      class="mt-5 h-12 w-full shrink-0 rounded-full border border-border bg-white text-[14.5px] font-semibold text-[#111418] hover:bg-white/90 dark:border-0"
      :disabled="generating || !picked.size || !canPublish" @click="generate()"
    >
      <Loader2 v-if="generating" :size="16" class="animate-spin" />
      {{ tabs.length ? $t('blog.pages.run.social.regenerate') : $t('blog.pages.run.social.generate') }}
    </Button>
    <p v-if="!canPublish" class="mt-2 text-center text-[12px] text-muted-foreground/70">{{ $t('blog.pages.run.social.needBody') }}</p>
    <p v-if="err" class="mt-2 text-center text-[12px] text-danger">{{ err }}</p>
    <p v-for="(msg, key) in adaptErr" :key="key" class="mt-1 text-center text-[12px] text-danger">{{ label(String(key)) }}: {{ msg }}</p>
  </DefineChooser>

  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <!-- Размер по содержимому: до сборки в модалке одна карточка выбора, и
         разворачивать её на весь экран незачем — получался чёрный прямоугольник
         с блоком посередине. Полный размер нужен только ленте, а от трёх колонок
         — весь экран целиком (см. fullscreen).
         sm:max-w-* дублирует max-w-* намеренно: у DialogContent в базовом классе
         есть sm:max-w-lg, и без одноимённого брейкпоинта tailwind-merge его не
         вытеснит — модалка схлопнется в 512px на любом экране шире sm. -->
    <DialogContent
      class="flex flex-col gap-0 overflow-hidden p-0"
      :class="tabs.length
        ? (fullscreen
          ? 'h-[100dvh] max-h-[100dvh] w-[100vw] max-w-[100vw] rounded-none border-0 sm:max-w-[100vw]'
          : 'h-[92dvh] w-[96vw] max-w-[96vw] sm:max-w-[1040px]')
        : 'max-h-[86dvh] w-[92vw] max-w-[92vw] rounded-2xl shadow-2xl sm:max-w-[560px] dark:border-0'"
    >
      <DialogTitle class="sr-only">{{ $t('blog.pages.run.social.title') }}</DialogTitle>
      <DialogHeader v-if="tabs.length" class="shrink-0 border-b border-border px-4 py-2.5">
        <div class="flex items-center gap-2 pr-8">
          <!-- полоса площадок: теперь навигация по колонкам, а не переключатель -->
          <div class="flex min-w-0 flex-1 gap-1 overflow-x-auto">
            <button
              v-for="k in tabs" :key="k" type="button"
              class="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] transition"
              :class="tab === k ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:text-foreground'"
              @click="scrollToCol(k)"
            >
              <img v-if="ICONS[k]" :src="ICONS[k]" :alt="label(k)" class="size-3.5 rounded-[3px] object-contain">
              {{ label(k) }}
              <span v-if="state[k]" class="size-1.5 rounded-full bg-success"></span>
              <!-- сборка под площадку упала: вкладка остаётся, точка предупреждает -->
              <TriangleAlert v-else-if="adaptErr[k] && !adapts[k]" :size="12" class="text-warning" />
            </button>
            <!-- добавить площадки — «+» в самой полосе (Later/Assembly). Кнопка
                 именно ТУМБЛЕР: раньше повторный клик ничего не делал, а список
                 разворачивался в композере и закрыть его было нечем. -->
            <button
              type="button"
              class="grid size-7 shrink-0 place-items-center self-center rounded-lg border border-dashed border-border text-muted-foreground transition hover:border-solid hover:text-foreground"
              :class="chooserOpen ? 'border-solid text-foreground' : ''"
              :title="$t('blog.pages.run.social.pickTitle')" @click="chooserOpen = !chooserOpen"
            ><Plus :size="14" /></button>
          </div>

          <button
            v-if="tabs.length" type="button"
            class="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:opacity-50"
            :title="$t('blog.pages.run.social.regenerate')" :disabled="generating" @click="generate()"
          ><Loader2 v-if="generating" :size="15" class="animate-spin" /><RefreshCw v-else :size="15" /></button>
          <Button v-if="tabs.length" size="sm" class="shrink-0 rounded-full border border-border bg-white px-4 font-semibold text-[#111418] hover:bg-white/90 dark:border-0" @click="openPublish">
            {{ $t('blog.pages.run.social.publish') }}
          </Button>
        </div>
      </DialogHeader>

      <!-- Выбор площадок. До первой сборки это ЭКРАН, а не полоска сверху:
           пустой композер с прижатым к верху блоком выглядел сломанным. Карточка
           по центру, крупные тумблеры площадок, у неготовых — прямой путь в
           настройки, а не тупик «канал не настроен».
           Когда колонки уже собраны, тот же список живёт отдельной модалкой (см.
           низ файла): раньше «+» разворачивал его прямо в композере во всю
           ширину, и закрыть эту простыню было нечем. -->
      <div v-if="!tabs.length" class="flex min-h-0 flex-1 flex-col overflow-hidden px-6 py-7">
        <div class="mx-auto flex min-h-0 w-full max-w-[520px] flex-1 flex-col">
          <ReuseChooser />
        </div>
      </div>

      <!-- Автосейв молчит, пока всё хорошо: строка появляется только когда
           черновик не доехал — это единственный случай, когда о нём надо знать. -->
      <p v-if="saveErr" class="shrink-0 border-b border-border px-4 py-1.5 text-[11.5px] leading-[1.4] text-danger">{{ saveErr }}</p>


      <!-- Колонки площадок. Одной ленты активной вкладки не хватало: пост правят,
           сравнивая с соседним, а упавшая площадка пряталась за чипом. Ряд колонок
           со snap-скроллом (Mailchimp «Customize What You Share», то же у Later и
           Sprout) — все ленты рядом, каждая в одежде своей сети.
           Каркас поста у каждой сети свой: у X хэндл и строка реакций съедают
           вертикаль, у Telegram текст живёт в пузыре, у ВК и Дзена — карточкой с
           шапкой. Общий «серый абзац» врал бы про то, как пост сядет в ленту. -->
      <div
        v-if="tabs.length" ref="colsEl"
        class="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto"
        @scroll.passive="onColsScroll"
      >
        <!-- один input на все колонки: помним, чей ПОСТ его открыл -->
        <input ref="fileEl" type="file" class="hidden" :accept="MEDIA_ACCEPT" multiple @change="onFilePicked">

        <!-- В полный экран колонки не фиксируем по ширине, а раздаём остаток:
             три ленты на 1920 берут по 640px и заполняют окно, четыре — по 480,
             а с пятой min-w упирается и снова включается горизонтальный скролл.
             Фиксированные 440px оставляли бы на широком мониторе пустое поле. -->
        <section
          v-for="k in tabs" :key="k" :data-col="k"
          class="flex snap-start flex-col border-r border-border last:border-r-0"
          :class="fullscreen ? 'min-w-[440px] flex-1' : 'w-[440px] shrink-0'"
        >
          <!-- Шапка колонки: чья лента, что с ней и что можно сделать. Точка
               «опубликовано» и предупреждение живут здесь, а не только в чипе:
               при скролле полоса чипов далеко. -->
          <header class="flex shrink-0 items-center gap-2 border-b border-border px-3.5 py-2">
            <img v-if="ICONS[k]" :src="ICONS[k]" :alt="label(k)" class="size-4 shrink-0 rounded-[3px] object-contain">
            <span class="truncate text-[13px] font-medium">{{ label(k) }}</span>
            <span
              v-if="state[k]" class="size-1.5 shrink-0 rounded-full bg-success"
              :title="$t('blog.pages.run.social.publishedBadge')"
            ></span>
            <TriangleAlert v-else-if="adaptErr[k] && !adapts[k]" :size="13" class="shrink-0 text-warning" />

            <!-- Скрепка уехала в панель действий поста: медиа теперь принадлежит
                 конкретному посту треда, а кнопка в шапке колонки могла означать
                 только «в первый» — ровно то ограничение, которое мы и снимали. -->
            <div class="ml-auto flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                class="grid size-7 place-items-center rounded-lg text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:opacity-40"
                :title="$t('blog.pages.run.social.regenerateOne', { name: label(k) })"
                :disabled="generating" @click="generate([k])"
              ><Loader2 v-if="generating" :size="14" class="animate-spin" /><RefreshCw v-else :size="14" /></button>
            </div>
          </header>

          <p v-if="mediaErr[k]" class="shrink-0 border-b border-border px-3.5 py-1.5 text-[11.5px] leading-[1.4] text-danger">{{ mediaErr[k] }}</p>

          <div class="min-h-0 flex-1 overflow-y-auto px-3.5 py-4">
            <!-- сборка под эту площадку упала: причина и ретрай вместо пустоты -->
            <div v-if="!adapts[k]" class="grid h-full place-items-center">
              <div class="flex flex-col items-center gap-3 text-center">
                <TriangleAlert :size="22" class="text-warning/80" />
                <p class="text-[12.5px] leading-relaxed text-muted-foreground">{{ adaptErr[k] }}</p>
                <Button variant="outline" size="sm" class="border-border bg-surface" :disabled="generating" @click="generate([k])">
                  <Loader2 v-if="generating" :size="13" class="animate-spin" /> {{ $t('action.retry') }}
                </Button>
              </div>
            </div>

            <template v-else>
              <!-- Перетаскивание за ручку слева: draggable ставим на сам пост, а
                   не на кнопку — иначе браузер потащил бы кнопку. Оба обработчика
                   dragover/drop висят на посте, так что уронить можно в любое его
                   место, а линия показывает, куда он приземлится. -->
              <div
                v-for="(post, i) in adapts[k].posts" :key="i"
                class="relative" :data-post="fkey(k, i)"
                :class="[
                  feedOf(k) === 'card' ? 'mb-3 rounded-xl border border-border bg-card p-3.5' : 'flex gap-2.5',
                  dragFrom === fkey(k, i) ? 'opacity-40' : '',
                  dropLineCls(k, i),
                ]"
                :draggable="dragArm === fkey(k, i)"
                @focusin="focused = fkey(k, i)" @mouseenter="focused = fkey(k, i)"
                @dragstart="onPostDragStart(k, i, $event)" @dragend="onPostDragEnd"
                @dragover="onPostDragOver(k, i, $event)" @drop.prevent.stop="onPostDrop(k, i)"
              >
                <!-- Жёлоб под ручку резервируем всегда, когда постов больше одного:
                     появляйся он по ховеру — лента дёргалась бы вбок под курсором. -->
                <div v-if="canReorder(k)" class="flex w-4 shrink-0 justify-center pt-1.5">
                  <button
                    type="button" class="cursor-grab rounded-md text-muted-foreground/70 transition hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none active:cursor-grabbing"
                    :class="focused === fkey(k, i) || dragFrom === fkey(k, i) ? 'opacity-100' : 'opacity-0'"
                    :title="$t('blog.pages.run.social.reorder')"
                    @pointerdown="dragArm = fkey(k, i)" @pointerup="dragArm = ''"
                  ><GripVertical :size="14" /></button>
                </div>

                <!-- аватар с нитью треда: только у лент, где посты идут ответами -->
                <div v-if="feedOf(k) === 'thread'" class="flex shrink-0 flex-col items-center">
                  <div class="grid size-9 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-2 text-[13px] font-semibold uppercase">
                    <img v-if="avatar" :src="avatar" :alt="handle" class="size-full object-cover">
                    <template v-else>{{ handle.slice(0, 1) }}</template>
                  </div>
                  <div v-if="i < adapts[k].posts.length - 1" class="mt-1 w-px flex-1 bg-muted-foreground/25"></div>
                </div>

                <div class="min-w-0 flex-1" :class="feedOf(k) === 'thread' ? 'pb-4' : ''">
                  <!-- шапка поста -->
                  <div class="flex items-center gap-1.5">
                    <div v-if="feedOf(k) !== 'thread'" class="grid size-7 shrink-0 place-items-center overflow-hidden rounded-full bg-surface-2 text-[11px] font-semibold uppercase">
                      <img v-if="avatar" :src="avatar" :alt="handle" class="size-full object-cover">
                      <template v-else>{{ handle.slice(0, 1) }}</template>
                    </div>
                    <span class="truncate text-[13.5px] font-bold">{{ handle }}</span>
                    <span v-if="feedOf(k) === 'thread'" class="truncate text-[13px] text-muted-foreground">{{ handleAt }}</span>
                    <span class="shrink-0 text-[13px] text-muted-foreground">· {{ $t('blog.pages.run.social.now') }}</span>
                    <!-- остаток символов, а не «118/270»: цифра важна у края -->
                    <span
                      v-if="limitOf(k)" class="ml-auto shrink-0 text-[11.5px] tabular-nums"
                      :class="overflow(k, post) ? 'font-semibold text-danger' : post.length > limitOf(k) * 0.9 ? 'text-warning' : 'text-muted-foreground/40'"
                    >{{ limitOf(k) - post.length }}</span>
                  </div>

                  <!-- текст. У Telegram он в пузыре: там пост так и выглядит.
                       Паддинги ушли внутрь: картинка в канале идёт НАД текстом и
                       во всю ширину пузыря, а не в рамке с отступами. -->
                  <div :class="feedOf(k) === 'bubble' ? 'mt-1.5 overflow-hidden rounded-2xl rounded-tl-md bg-surface-2' : ''">
                    <ReuseMedia v-if="feedOf(k) === 'bubble' && showMedia(k, i)" :k="k" :i="i" />
                    <div :class="feedOf(k) === 'bubble' ? 'px-3.5 py-2.5' : ''">
                      <textarea
                        v-grow
                        :value="post" rows="1"
                        :placeholder="$t('blog.pages.run.social.postPlaceholder')"
                        class="w-full resize-none overflow-hidden bg-transparent text-[14.5px] leading-[1.45] text-foreground outline-none placeholder:text-muted-foreground/40"
                        :class="feedOf(k) === 'thread' ? 'mt-0.5' : ''"
                        @input="onPostInput(k, i, $event)" @focus="focused = fkey(k, i)"
                      ></textarea>
                      <div v-if="feedOf(k) === 'bubble'" class="mt-1 flex items-center justify-end gap-1 text-[11px] text-muted-foreground/60">
                        <Eye :size="11" /> {{ $t('blog.pages.run.social.now') }}
                      </div>
                    </div>
                  </div>

                  <!-- В X вложение — блок под текстом в скруглённой рамке -->
                  <ReuseMedia
                    v-if="feedOf(k) === 'thread' && showMedia(k, i)"
                    :k="k" :i="i" cls="mt-2.5 overflow-hidden rounded-2xl border border-border"
                  />

                  <!-- Строка реакций. Ничего не считает и считать не может: пост ещё
                       не опубликован. Она здесь ради каркаса — без неё пост в ленте
                       занимает меньше места, чем займёт на самом деле. -->
                  <div v-if="feedOf(k) === 'thread'" class="mt-2.5 flex max-w-[300px] items-center justify-between text-muted-foreground/45">
                    <MessageCircle :size="15" />
                    <Repeat2 :size="16" />
                    <Heart :size="15" />
                    <BarChart3 :size="15" />
                    <Share :size="15" />
                  </div>

                  <!-- Панель действий ПОСТА: номер, скрепка, эмодзи, добавить ниже,
                       копировать, удалить. Скрепка и смайлик живут именно здесь —
                       файл и эмодзи принадлежат посту, а не всей колонке. -->
                  <div
                    class="mt-1.5 flex items-center gap-1 transition"
                    :class="focused === fkey(k, i) || emojiFor === fkey(k, i) ? 'opacity-100' : 'opacity-0'"
                  >
                    <span v-if="adapts[k].thread" class="mr-1 font-mono text-[11px] text-muted-foreground/50">#{{ i + 1 }}</span>
                    <!-- Где загрузки файла нет, кнопку показываем выключенной с
                         причиной в title, а не прячем: иначе непонятно, почему у
                         Telegram скрепка есть, а тут её нет. А у RSS и
                         «скопируйте текст» её нет вовсе: пост туда уходит не от
                         нас, прикладывать нечего. -->
                    <button
                      v-if="canAttach(k)" type="button"
                      class="grid size-6 place-items-center rounded-md text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                      :title="!mediaMax(k)
                        ? $t('blog.pages.run.social.media.unsupported')
                        : mediaCountAt(k, i) >= mediaMax(k)
                          ? $t('blog.pages.run.social.media.max', { n: mediaMax(k) })
                          : $t('blog.pages.run.social.media.add')"
                      :disabled="!mediaMax(k) || !!mediaBusy[k] || mediaCountAt(k, i) >= mediaMax(k)"
                      @click="pickMedia(k, i)"
                    ><Loader2 v-if="mediaBusy[k]" :size="12" class="animate-spin" /><ImagePlus v-else :size="12" /></button>
                    <button
                      v-if="canAttach(k)" type="button"
                      class="grid size-6 place-items-center rounded-md transition hover:bg-surface hover:text-foreground"
                      :class="emojiFor === fkey(k, i) ? 'bg-surface text-foreground' : 'text-muted-foreground'"
                      :title="$t('blog.pages.run.social.emoji')"
                      @click="toggleEmoji(k, i, $event)"
                    ><Smile :size="12" /></button>
                    <button
                      v-if="adapts[k].thread && adapts[k].posts.length < 10" type="button"
                      class="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-muted-foreground transition hover:bg-surface hover:text-foreground"
                      @click="addBelow(k, i)"
                    ><CornerDownRight :size="12" /> {{ $t('blog.pages.run.social.addBelow') }}</button>
                    <button
                      type="button"
                      class="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-muted-foreground transition hover:bg-surface hover:text-foreground"
                      @click="copy(post, k + i)"
                    ><Check v-if="copied === k + i" :size="12" /><Copy v-else :size="12" /> {{ copied === k + i ? $t('blog.pages.run.social.copied') : $t('blog.pages.run.social.copy') }}</button>
                    <button
                      v-if="adapts[k].posts.length > 1" type="button"
                      class="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-[11.5px] text-muted-foreground transition hover:bg-danger-soft hover:text-danger"
                      @click="removePost(k, i)"
                    ><Trash2 :size="12" /></button>
                  </div>

                  <!-- ВК и Дзен растягивают вложение до краёв карточки — гасим
                       её паддинги отрицательными маржинами, чтобы блок сел в
                       нижние углы, а не оказался в рамке из фона. -->
                  <ReuseMedia
                    v-if="feedOf(k) === 'card' && showMedia(k, i)"
                    :k="k" :i="i" cls="-mx-3.5 -mb-3.5 mt-2 overflow-hidden rounded-b-xl"
                  />
                </div>
              </div>

              <p v-if="overflowOf(k)" class="mt-4 flex items-center gap-1.5 text-[12px] text-danger">
                <TriangleAlert :size="13" /> {{ $t('blog.pages.run.social.overLimit', { n: overflowOf(k) }) }}
              </p>
              <p v-for="(w, wi) in adapts[k].warnings" :key="'w' + wi" class="mt-2 text-[12px] text-warning/80">{{ w }}</p>
            </template>
          </div>
        </section>
      </div>

      <!-- Пикер эмодзи. Своей библиотеки ради сетки из символов не берём: в
           постах живут реакции, руки, стрелки и цифры, полный каталог тут
           лишний. Подложка ловит клик мимо и Esc — иначе поповер пришлось бы
           закрывать той же кнопкой, которой его открыли. -->
      <template v-if="emojiFor">
        <div class="absolute inset-0 z-50" @click="emojiFor = ''"></div>
        <div
          ref="emojiEl" tabindex="-1"
          class="absolute z-50 w-[268px] max-w-[calc(100vw-2rem)] rounded-xl border border-border bg-background p-2 shadow-2xl outline-none"
          :style="{ top: emojiPos.top + 'px', left: emojiPos.left + 'px' }"
          @keydown.esc.stop="emojiFor = ''"
        >
          <div class="grid grid-cols-8 gap-0.5">
            <button
              v-for="ch in EMOJI" :key="ch" type="button"
              class="grid size-7 place-items-center rounded-md text-[16px] leading-none transition hover:bg-surface"
              @click="pickEmoji(ch)"
            >{{ ch }}</button>
          </div>
        </div>
      </template>
    </DialogContent>
  </Dialog>

  <!-- Выбор площадок после первой сборки — ОТДЕЛЬНАЯ модалка. Раньше «+»
       разворачивал этот же список прямо в композере: блок занимал полэкрана, и
       закрыть его было нечем (крестика нет, Esc закрывал весь композер). Диалог
       даёт и крестик, и Esc, и клик по подложке, и ширину по содержимому.
       sm:max-w-* дублирует max-w-* намеренно — см. комментарий у композера. -->
  <Dialog :open="chooserOpen" @update:open="chooserOpen = $event">
    <DialogContent class="flex max-h-[82dvh] max-w-[560px] flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl sm:max-w-[560px] dark:border-0">
      <DialogHeader class="shrink-0 px-6 pt-6 pb-4">
        <DialogTitle class="text-[16px] font-semibold">{{ $t('blog.pages.run.social.pickTitle') }}</DialogTitle>
      </DialogHeader>
      <div class="flex min-h-0 flex-1 flex-col px-6 pb-6">
        <ReuseChooser />
      </div>
    </DialogContent>
  </Dialog>

  <!-- Модалка публикации. Раскладка снята с диалога Publish у Typefully:
       заголовок и подзаголовок по центру, одна широкая кнопка отправки, ниже
       список адресатов строками — тумблер, аватар с бейджем площадки, имя,
       действие справа. Смысл раскладки в том, что список видно ДО отправки: он
       и отвечает на вопрос «куда именно уедет пост». -->
  <Dialog :open="publishOpen" @update:open="publishOpen = $event">
    <DialogContent class="max-w-[540px] gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl dark:border-0">
      <DialogHeader class="px-6 pt-7 pb-5">
        <DialogTitle class="text-center text-[16px] font-semibold">{{ $t('blog.pages.run.social.publishTitle') }}</DialogTitle>
        <p class="text-center text-[13px] text-muted-foreground">
          <template v-if="targets.size || blogPicked.size">
            {{ $t('blog.pages.run.social.publishToPrefix') }}
            <template v-for="(k, i) in [...blogPicked.values()].map((b) => 'blog:' + b).concat([...targets])" :key="k">
              <span class="font-semibold text-foreground">{{ sendLabel(k) }}</span><!--
              --><template v-if="i < targets.size + blogPicked.size - 2">, </template><!--
              --><template v-else-if="i === targets.size + blogPicked.size - 2"> {{ $t('blog.pages.run.social.and') }} </template>
            </template>.
          </template>
          <template v-else>{{ $t('blog.pages.run.social.publishNowhere') }}</template>
        </p>

        <!-- Кнопка белая и круглая: главное действие диалога, других здесь нет.
             В светлой теме держится на рамке, иначе сливается с фоном. -->
        <Button
          class="mt-5 h-12 w-full rounded-full border border-border bg-white text-[14.5px] font-semibold text-[#111418] hover:bg-white/90 dark:border-0"
          :disabled="publishing || (!targets.size && !blogPicked.size)" @click="publishAll"
        >
          <Loader2 v-if="publishing" :size="15" class="animate-spin" />
          {{ $t('blog.pages.run.social.publishNow') }}
        </Button>
      </DialogHeader>

      <div class="max-h-[46dvh] overflow-y-auto border-t border-border">
        <!-- статья целиком: её адресаты первыми, короткие посты ведут на неё -->
        <div
          v-for="c in blogVisible.filter((x) => blogPicked.has(x.key))" :key="'b' + c.key"
          class="flex items-center gap-3.5 border-b border-border px-6 py-4"
        >
          <button
            type="button" role="switch" :aria-checked="blogPicked.has(c.key)"
            class="relative h-5 w-9 shrink-0 rounded-full bg-foreground transition"
            @click="toggleBlog(c.key)"
          ><span class="absolute top-0.5 left-[18px] size-4 rounded-full bg-background transition-all"></span></button>
          <img v-if="ICONS[c.key]" :src="ICONS[c.key]" :alt="blogLabel(c)" class="size-8 shrink-0 rounded-full object-contain">
          <Globe v-else :size="22" class="shrink-0 text-muted-foreground" />
          <div class="min-w-0 flex-1">
            <div class="truncate text-[13.5px] font-medium">{{ blogLabel(c) }}</div>
            <p v-if="results['blog:' + c.key]?.error" class="text-[11.5px] leading-[1.4] text-danger">{{ results['blog:' + c.key]!.error }}</p>
            <p v-else-if="results['blog:' + c.key]?.ok" class="text-[11.5px] text-success">{{ $t('blog.pages.run.social.publishedBadge') }}</p>
            <p v-else class="truncate text-[11.5px] leading-[1.4] text-muted-foreground/70">{{ $t('blog.pages.run.social.groupArticle') }}</p>
          </div>
          <a
            v-if="results['blog:' + c.key]?.url" :href="results['blog:' + c.key]!.url" target="_blank" rel="noopener"
            class="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:text-foreground"
            :title="$t('blog.pages.run.social.open')"
          ><ExternalLink :size="13" /></a>
        </div>

        <div v-for="k in tabs" :key="k" class="flex items-center gap-3.5 border-b border-border px-6 py-4 last:border-b-0">
          <!-- тумблер только там, где отправляем мы; иначе действие справа -->
          <button
            v-if="canAutoPublish(k)" type="button" role="switch" :aria-checked="targets.has(k)"
            class="relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-40"
            :class="targets.has(k) ? 'bg-brand-accent' : 'bg-surface-2'"
            :disabled="!!overflowOf(k)" @click="toggleTarget(k)"
          >
            <span class="absolute top-0.5 size-4 rounded-full bg-white transition-all" :class="targets.has(k) ? 'left-[18px]' : 'left-0.5'"></span>
          </button>
          <span v-else class="h-5 w-9 shrink-0"></span>

          <!-- аватар бренда с бейджем площадки: пост уйдёт от лица бренда, и
               логотип площадки здесь уточнение, а не главное -->
          <div class="relative shrink-0">
            <div class="grid size-8 place-items-center overflow-hidden rounded-full bg-surface-2 text-[12px] font-semibold uppercase">
              <img v-if="avatar" :src="avatar" :alt="handle" class="size-full object-cover">
              <template v-else>{{ handle.slice(0, 1) }}</template>
            </div>
            <img
              v-if="ICONS[k]" :src="ICONS[k]" :alt="label(k)"
              class="absolute -right-0.5 -bottom-0.5 size-4 rounded-full bg-background object-contain p-px"
            >
          </div>

          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-1.5">
              <span class="truncate text-[13.5px] font-medium">{{ label(k) }}</span>
              <!-- сколько файлов уедет вместе с постом: до отправки это видно
                   только в колонке, а решение принимают здесь -->
              <span
                v-if="mediaMax(k) && mediaCount(k)"
                class="shrink-0 rounded-md border border-border px-1 py-px text-[9.5px] font-semibold uppercase tracking-wide text-muted-foreground"
              >{{ $t('blog.pages.run.social.media.count', { n: mediaCount(k) }) }}</span>
            </div>
            <p v-if="results[k]?.error" class="text-[11.5px] leading-[1.4] text-danger">{{ results[k]!.error }}</p>
            <!-- Пост ушёл, а медиа — нет. Показываем причину от площадки, если
                 она есть: у старых подключений X это «переподключите аккаунт», и
                 общая фраза оставляла бы человека без единственного действия. -->
            <p v-else-if="results[k]?.ok && results[k]?.mediaError" class="flex items-start gap-1 text-[11.5px] leading-[1.4] text-warning">
              <TriangleAlert :size="11" class="mt-0.5 shrink-0" />
              <span class="min-w-0 flex-1">{{ results[k]!.mediaError || $t('blog.pages.run.social.media.warn') }}</span>
            </p>
            <p v-else-if="results[k]?.ok" class="text-[11.5px] text-success">{{ $t('blog.pages.run.social.publishedBadge') }}</p>
            <!-- лимит символов: площадка откажет сама, поэтому тумблер выключен -->
            <p v-else-if="overflowOf(k)" class="text-[11.5px] leading-[1.4] text-danger">{{ $t('blog.pages.run.social.overLimit', { n: overflowOf(k) }) }}</p>
            <p v-else class="truncate text-[11.5px] leading-[1.4] text-muted-foreground/70">
              {{ $t('blog.pages.run.social.delivery.' + (platforms.find((p) => p.key === k)?.delivery || 'auto')) }}
            </p>
          </div>

          <!-- «Превью» прокручивает к колонке площадки в композере: смотреть
               текст отдельным окном незачем, он уже открыт за этим диалогом -->
          <button type="button" class="inline-flex shrink-0 items-center gap-1.5 text-[12.5px] text-muted-foreground transition hover:text-foreground" @click="publishOpen = false; scrollToCol(k)">
            <Eye :size="13" /> {{ $t('blog.pages.run.social.preview') }}
          </button>

          <button
            v-if="!canAutoPublish(k)" type="button"
            class="inline-flex shrink-0 items-center gap-1.5 text-[12.5px] text-muted-foreground transition hover:text-foreground"
            @click="copy((adapts[k]?.posts || []).join('\n\n'), 'm' + k)"
          ><Check v-if="copied === 'm' + k" :size="13" /><Copy v-else :size="13" /> {{ $t('blog.pages.run.social.copy') }}</button>
          <template v-else>
            <a
              v-if="state[k]?.url" :href="state[k]!.url" target="_blank" rel="noopener"
              class="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:text-foreground"
              :title="$t('blog.pages.run.social.open')"
            ><ExternalLink :size="13" /></a>
            <button
              v-if="state[k]" type="button"
              class="grid size-7 shrink-0 place-items-center rounded-lg text-danger transition hover:bg-danger-soft disabled:opacity-50"
              :title="$t('blog.pages.run.social.unpublish')" :disabled="publishing" @click="unpublish(k)"
            ><Trash2 :size="13" /></button>
          </template>
        </div>
      </div>
    </DialogContent>
  </Dialog>
</template>
