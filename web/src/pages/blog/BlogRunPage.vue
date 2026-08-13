<script setup lang="ts">
// Рабочая область статьи: слежение за генерацией (поллинг стадий из /runs/:id),
// редактор тела + правый инспектор (Мета, Разметка, Публикация, перегенерация
// отрывка, Подача, Качество/AEO) и превью. Обложка собирается автоматически на
// старте темы; здесь — превью в теле документа и студия модалкой.
//
// Публикация устроена как в Ghost/Hashnode: одна главная кнопка в шапке
// открывает диалог, где видно язык версии и куда именно уедет статья. Раньше
// «Опубликовать» в шапке просто меняла статус рана и никуда не публиковала, а
// настоящая кнопка пряталась в свёрнутой секции инспектора.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { createReusableTemplate, useMediaQuery } from '@vueuse/core'
import {
  ArrowLeft, CalendarClock, Check, ChevronDown, Code2, Copy as CopyIcon, Download, ExternalLink, Eye,
  Gauge, Hand, ImageIcon, Languages, Loader2, MoreHorizontal, PanelRight, PanelRightOpen,
  Plus, ChevronRight, ImagePlus, RotateCcw, Save, Send, Share2, ShieldCheck, SlidersHorizontal, Trash2,
  TriangleAlert, X,
} from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import ArticleEditor from '@/components/blog/ArticleEditor.vue'
import SourcePicker from '@/components/blog/SourcePicker.vue'
import OutlineEditor from '@/components/blog/OutlineEditor.vue'
import SocialComposer from '@/components/blog/SocialComposer.vue'
import { publishTargets, type PublishTarget } from '@/data/publishTargets'
import { api } from '@/lib/api'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet'
import CoverStudio from '@/components/preview/CoverStudio.vue'
import type {
  CrosspostPlatform, HeadMarkup, PublishChannel, PublishScheduleEntry, PublishScheduleStatus,
} from '@/lib/api'
import { CHANNEL_ICONS, channelLabel, NO_AUTO_PUBLISH } from '@/data/channelIcons'
import { makeDefaultCover } from '@/lib/preview/autoCover'
import { useBlogRuns } from '@/composables/useBlogRuns'
import { intlLocale } from '@/i18n'
// те же правила .bw-*, что рисует редактор: превью обязано врать по минимуму
import '@/components/blog/media/media.css'

const route = useRoute()
const router = useRouter()
const { t, te } = useI18n()
// список тем держит и сайдбар, и страница «Темы»: после публикации/удаления его
// надо перечитать, иначе бейджи фаз врут до перезагрузки страницы
const { load: reloadRuns } = useBlogRuns()
// let, а не const: при смене локали роут меняет :id на том же компоненте —
// переприсваиваем и перезагружаем (Vue Router не пересоздаёт инстанс)
let id = String(route.params.id)
// реактивное зеркало id — для пропсов в шаблоне (let выше не реактивен)
const routeRunId = computed(() => String(route.params.id || ''))

/** инспектор колонкой помещается только на широком экране */
const isWide = useMediaQuery('(min-width: 1280px)')
/** одна разметка инспектора на два места: колонка справа и Sheet на узком */
const [DefineInspector, ReuseInspector] = createReusableTemplate()

const topic = ref('')
const title = ref('')
const html = ref('')
const status = ref('')
const mode = ref('')
const category = ref('')
const author = ref('')
const coverUrl = ref<string | null>(null)
// студия обложек открывается модалкой прямо в статье
const studioOpen = ref(false)
const coverError = ref('')
const coverBusy = ref<'' | 'gen' | 'clear'>('')
const wordCount = ref(0)
const views = ref(0)
const stages = ref<{ key: string; label: string; status: string }[] | null>(null)
const outline = ref<any>(null)
const sources = ref<any[]>([])
const searchQueries = ref<any[]>([])
const perspectives = ref<any[]>([])
const targetQueries = ref<string[]>([])
const submitting = ref(false)
const eeat = ref<any>(null)
const notes = ref<string[]>([])
const slop = ref<any>(null)
const runError = ref('')
const loadError = ref('')
const saving = ref(false)
const savedFlash = ref(false)
/** почему не сохранилось — раньше ошибка PATCH молча уходила в пустой catch */
const saveError = ref('')
/** ошибка любого шагового действия (продолжить, утвердить, факт-чек, перегенерация) */
const actionError = ref('')
const retrying = ref(false)
const factfixing = ref(false)
const settings = ref<any>(null)
// состояние публикации в блог (из рана)
const blog = ref<{ postId: number; slug: string; status: string; locale: string; coverUrl: string; syncedAt: string }>(
  { postId: 0, slug: '', status: '', locale: '', coverUrl: '', syncedAt: '' },
)

let timer: number | null = null
let autoT: number | null = null
let flashT: number | null = null

const TERMINAL = new Set(['done', 'published', 'error'])
const isAwaiting = computed(() => status.value.startsWith('awaiting'))
const isRunning = computed(() => !TERMINAL.has(status.value) && !isAwaiting.value)
const hasBody = computed(() => !!html.value.trim())
// скелет «агент пишет» показываем только когда ран реально жив: при провале
// загрузки он врал, будто статья вот-вот появится
const generating = computed(() => !hasBody.value && isRunning.value && !loadError.value)

// --- несохранённые правки ----------------------------------------------------
/** снимок полей, которые правит автор: по нему считаем «есть изменения» */
const snap = computed(() => JSON.stringify([title.value, html.value, category.value, author.value]))
/**
 * Снимок последней успешной записи (пусто = ещё ничего не грузили). Он же —
 * снимок серверного состояния: пока он совпадает с текущим, тело можно смело
 * перетирать ответом поллинга.
 */
const savedSnap = ref('')
const dirty = computed(() => !!savedSnap.value && snap.value !== savedSnap.value)
function markSaved() { savedSnap.value = snap.value }

const statusPill = computed(() => {
  if (isRunning.value) return { label: t('blog.pages.run.status.generating'), cls: 'bg-info-soft text-info', dot: 'bg-info' }
  if (status.value === 'awaiting_sources') return { label: t('blog.pages.run.status.awaitingSources'), cls: 'bg-warning-soft text-warning', dot: 'bg-warning' }
  if (status.value === 'awaiting_outline') return { label: t('blog.pages.run.status.awaitingOutline'), cls: 'bg-warning-soft text-warning', dot: 'bg-warning' }
  if (status.value === 'published') return { label: t('blog.pages.run.status.published'), cls: 'bg-success-soft text-success', dot: 'bg-success' }
  if (status.value === 'error') return { label: t('blog.pages.run.status.error'), cls: 'bg-danger-soft text-danger', dot: 'bg-danger' }
  return { label: t('blog.pages.run.status.draft'), cls: 'bg-surface-hover text-muted-foreground', dot: 'bg-warning' }
})

/** Индикатор записи в шапке: «Есть изменения» → «Сохраняем…» → «Сохранено». */
const saveState = computed<'' | 'dirty' | 'saving' | 'saved'>(() => {
  if (saving.value) return 'saving'
  if (dirty.value) return 'dirty'
  if (savedFlash.value) return 'saved'
  return ''
})

/**
 * Причина отказа человеческим языком. 413 — тело статьи не пролезло в лимит
 * запроса (nginx режет на 1 МБ), 402 — упёрлись в тариф, отсутствие статуса —
 * до бэка вообще не дошли.
 */
function apiError(e: any, fallback: string): string {
  const st = Number(e?.status || 0)
  if (st === 413) return t('blog.pages.run.errors.tooLarge')
  if (st === 402) return t('blog.pages.run.errors.tariff')
  if (!st) return t('blog.pages.run.errors.network')
  return e?.serverMessage || fallback
}

/**
 * Подпись шага пайплайна. Бэк присылает и ключ, и уже готовую подпись —
 * известные ключи переводим сами, незнакомый шаг показываем как прислали
 * (иначе новый шаг на бэке молча пропал бы с экрана).
 */
function stageLabel(st: { key: string; label: string }): string {
  const key = `blog.pages.run.stages.${String(st.key || '').toLowerCase().replace(/[^a-z0-9]/g, '')}`
  return te(key) ? t(key) : st.label
}

/** количество слов с разделителями разрядов по языку интерфейса */
const words = (n: number) => t('blog.pages.units.words', { n: n.toLocaleString(intlLocale()) }, n)

async function load(withBody = true) {
  const run = await api.blogRun(id)
  topic.value = run.topic || ''
  status.value = run.status || ''
  mode.value = run.mode || ''
  coverUrl.value = run.coverUrl || null
  wordCount.value = run.wordCount || 0
  views.value = run.views || 0
  stages.value = Array.isArray(run.stages) ? run.stages : null
  outline.value = run.outline || null
  sources.value = run.sources || []
  searchQueries.value = run.searchQueries || []
  perspectives.value = run.perspectives || []
  targetQueries.value = run.targetQueries || []
  eeat.value = run.eeat || null
  notes.value = run.notes || []
  slop.value = run.slop || null
  runError.value = run.error || ''
  if (run.blog) blog.value = run.blog
  // Поля автора подтягиваем ТОЛЬКО когда несохранённых правок нет: поллинг и
  // фоновые перезагрузки иначе затирают набранный текст прямо под руками.
  if (!dirty.value) {
    if (run.title) title.value = run.title
    category.value = run.category || ''
    author.value = run.author || ''
    if (withBody && run.bodyHtml) html.value = run.bodyHtml
    markSaved()
  }
  return run
}

function tick() {
  if (timer) { clearInterval(timer); timer = null }
  if (!isRunning.value) return
  timer = window.setInterval(async () => {
    try {
      // Тело в поллинге тянем, только пока править нечего; готовый текст
      // подтягиваем один раз — на переходе в терминальный статус.
      await load(!hasBody.value)
      if (!isRunning.value) {
        if (timer) { clearInterval(timer); timer = null }
        await load(true)
      }
    } catch { /* временная сеть */ }
  }, 2500)
}

// сброс всего, что относится к конкретной статье (перед загрузкой другой локали)
function resetState() {
  if (timer) { clearInterval(timer); timer = null }
  if (autoT) { clearTimeout(autoT); autoT = null }
  title.value = ''; html.value = ''; status.value = ''; topic.value = ''
  category.value = ''; author.value = ''; coverUrl.value = null
  wordCount.value = 0; views.value = 0; stages.value = null; outline.value = null
  sources.value = []; searchQueries.value = []; perspectives.value = []
  targetQueries.value = []; eeat.value = null; notes.value = []
  slop.value = null; runError.value = ''; loadError.value = ''; savedFlash.value = false
  saveError.value = ''; actionError.value = ''; coverError.value = ''
  savedSnap.value = ''
  headMarkup.value = null; markupError.value = ''
  publishOpen.value = false; publishDone.value = false; publishErr.value = ''; targets.value = []
  publishTab.value = 'now'; scheduleDraft.value = {}; scheduleExtra.value = []; scheduleErr.value = ''
  blog.value = { postId: 0, slug: '', status: '', locale: '', coverUrl: '', syncedAt: '' }
  localeItems.value = []; picked.value = new Set(); localeNote.value = ''; publishLocale.value = ''
}

async function init() {
  loadError.value = ''
  try {
    await load()
    tick()
    loadGroup()
    loadSchedule()
  } catch (e: any) {
    loadError.value = e?.status === 404 ? t('blog.pages.run.notFound') : t('blog.pages.run.loadFailed')
  }
}

onMounted(() => {
  api.blogSettings().then((s) => { settings.value = s }).catch(() => {})
  api.blogChannels().then((r) => { blogTargets.value = r.channels || [] }).catch(() => {})
  // профили соцсетей нужны и здесь: планировщик показывает их рядом с каналами
  // статьи, а раньше список жил только внутри композера
  api.crosspostPlatforms().then((r) => { crossPlatforms.value = r.platforms || [] }).catch(() => {})
  init()
})
// смена :id (переключение локали) → перезагружаем ту же вьюху
watch(() => route.params.id, (nv) => {
  const next = String(nv || '')
  if (!next || next === id) return
  id = next
  resetState()
  init()
})
watch(status, tick)
onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
  if (autoT) clearTimeout(autoT)
  window.removeEventListener('beforeunload', onUnload)
})

// --- автосохранение и гард ---------------------------------------------------
/**
 * Автосейв через 4 секунды после остановки ввода. Не во время генерации и не на
 * паузах пошагового режима: там тело статьи принадлежит агенту, и запись из
 * браузера затёрла бы его результат.
 */
watch(snap, () => {
  if (!dirty.value || isRunning.value || isAwaiting.value) return
  if (autoT) clearTimeout(autoT)
  autoT = window.setTimeout(() => { autoT = null; if (dirty.value) save() }, 4000)
})

function onUnload(e: BeforeUnloadEvent) {
  if (!dirty.value) return
  e.preventDefault()
  e.returnValue = ''
}
onMounted(() => window.addEventListener('beforeunload', onUnload))
onBeforeRouteLeave(() => (dirty.value ? window.confirm(t('blog.pages.run.leaveConfirm')) : true))

async function save(): Promise<boolean> {
  if (saving.value) return false
  if (autoT) { clearTimeout(autoT); autoT = null }
  saving.value = true
  saveError.value = ''
  // снимок на момент отправки: правки, набранные пока идёт запрос, обязаны
  // остаться «несохранёнными»
  const sent = snap.value
  try {
    await api.blogPatchRun(id, {
      title: title.value,
      bodyHtml: html.value,
      category: category.value,
      author: author.value,
    })
    savedSnap.value = sent
    savedFlash.value = true
    if (flashT) clearTimeout(flashT)
    flashT = window.setTimeout(() => { savedFlash.value = false }, 1500)
    // PATCH отвечает {ok}: слоп и число слов пересчитывает бэк — забираем их
    load(false).catch(() => {})
    reloadRuns(true).catch(() => {})
    return true
  } catch (e: any) {
    saveError.value = apiError(e, t('blog.pages.run.errors.saveFailed'))
    return false
  } finally {
    saving.value = false
  }
}

async function retry() {
  if (retrying.value) return
  retrying.value = true
  actionError.value = ''
  try {
    await api.blogRetryRun(id)
    status.value = 'running'
    runError.value = ''
    await load()
    tick()
  } catch (e: any) {
    actionError.value = apiError(e, t('blog.pages.run.errors.actionFailed'))
  } finally {
    retrying.value = false
  }
}

async function exportMd() {
  // Вкладку открываем СИНХРОННО по клику: после await браузер считает попап
  // непрошеным и молча его режет — «Экспорт» выглядел как мёртвая кнопка.
  const w = window.open('', '_blank')
  const ok = await save()
  if (!ok) { w?.close(); return }
  if (w) w.location.href = api.blogExportUrl(id)
}

// --- интерактивные шаги (Пошагово) -------------------------------------------
async function continueWithSources(payload: { selectedUrls: string[]; extraUrls: string[] }) {
  if (submitting.value) return
  submitting.value = true
  actionError.value = ''
  try {
    await api.blogContinueRun(id, payload)
    status.value = 'running'
    await load(); tick()
  } catch (e: any) {
    actionError.value = apiError(e, t('blog.pages.run.errors.actionFailed'))
  } finally { submitting.value = false }
}
async function approveOutline(edited: any) {
  if (submitting.value) return
  submitting.value = true
  actionError.value = ''
  try {
    await api.blogContinueRun(id, { outline: edited })
    status.value = 'running'
    await load(); tick()
  } catch (e: any) {
    actionError.value = apiError(e, t('blog.pages.run.errors.actionFailed'))
  } finally { submitting.value = false }
}

const copied = ref(false)
async function copyContent() {
  try {
    await navigator.clipboard.writeText(stripHtml(html.value))
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch { /* clipboard недоступен */ }
}

// --- факт-чек: убрать выдуманные данные -------------------------------------
async function fixFacts() {
  if (!hasBody.value || factfixing.value) return
  factfixing.value = true
  actionError.value = ''
  try {
    const res = await api.blogFactfix(id, html.value)
    if (res?.html) {
      html.value = res.html
      notes.value = []
      await save()
    }
  } catch (e: any) {
    actionError.value = apiError(e, t('blog.pages.run.errors.actionFailed'))
  } finally {
    factfixing.value = false
  }
}

/** Студия сохранила обложку — подхватываем URL сразу, без перезагрузки рана. */
function onCoverSaved(url: string) {
  coverUrl.value = `${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`
  coverError.value = ''
}

/**
 * Обложка одним действием: бэк умеет только сгенерировать ФОН (runs/:id/cover),
 * композицию с заголовком собирает браузер и он же кладёт её обложкой рана.
 */
async function genCoverBg() {
  if (coverBusy.value) return
  coverBusy.value = 'gen'
  coverError.value = ''
  try {
    const { bgUrl } = await api.blogGenCover(id)
    const url = await makeDefaultCover(id, title.value || topic.value, bgUrl)
    if (url) onCoverSaved(url)
    else coverError.value = t('blog.pages.run.cover.failed')
  } catch (e: any) {
    coverError.value = apiError(e, t('blog.pages.run.cover.failed'))
  } finally {
    coverBusy.value = ''
  }
}
async function clearCover() {
  if (coverBusy.value) return
  coverBusy.value = 'clear'
  coverError.value = ''
  try {
    await api.blogClearCover(id)
    coverUrl.value = null
  } catch (e: any) {
    coverError.value = apiError(e, t('blog.pages.run.cover.failed'))
  } finally {
    coverBusy.value = ''
  }
}

// --- перегенерация отрывка ---------------------------------------------------
const regenIdx = ref(0)
const regenNeg = ref('')
const regenBusy = ref<number | null>(null)
// Пилюли-исключения уходят в директиву для модели, поэтому текст берём на языке
// интерфейса: агент понимает и русскую, и английскую формулировку.
const REGEN_PRESETS = computed(() => [
  t('blog.pages.run.regen.presets.noSources'),
  t('blog.pages.run.regen.presets.noOtherArticles'),
  t('blog.pages.run.regen.presets.noExternalLinks'),
])
function negActive(p: string) { return regenNeg.value.toLowerCase().includes(p.toLowerCase()) }
function toggleNeg(p: string) {
  const items = regenNeg.value.split(/[;\n]+/).map((x) => x.trim()).filter(Boolean)
  regenNeg.value = negActive(p)
    ? items.filter((x) => x.toLowerCase() !== p.toLowerCase()).join('; ')
    : [...items, p].join('; ')
}
// вставить перегенерированный отрывок на место секции (блоки по <h2>)
function spliceSection(body: string, index: number, heading: string, sectionHtml: string): string {
  const parts = body.split(/(?=<h2[\s>])/i)
  let lead = ''
  if (parts.length && !/^<h2[\s>]/i.test(parts[0])) lead = parts.shift() as string
  if (!parts.length) return (body.trim() ? body.trim() + '\n' : '') + sectionHtml.trim()
  const norm = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()
  const h2text = (b: string) => norm(b.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || '')
  let target = parts.findIndex((p) => h2text(p) === norm(heading))
  if (target < 0) target = (index >= 0 && index < parts.length) ? index : -1
  if (target < 0) return body
  parts[target] = sectionHtml.trim() + '\n'
  return lead + parts.join('')
}
async function regenSection() {
  const sec = outline.value?.sections?.[regenIdx.value]
  if (!sec || regenBusy.value !== null || !hasBody.value) return
  regenBusy.value = regenIdx.value
  actionError.value = ''
  try {
    const res = await api.blogRegenSection(id, { index: regenIdx.value, heading: sec.heading, directive: regenNeg.value.trim() || undefined })
    if (res?.html) {
      html.value = spliceSection(html.value, regenIdx.value, sec.heading, res.html)
      await save()
    }
  } catch (e: any) {
    actionError.value = apiError(e, t('blog.pages.run.errors.actionFailed'))
  } finally {
    regenBusy.value = null
  }
}

// --- Подача и уникальность (per-brand delivery) ------------------------------
// Пресеты подачи сохраняются в настройки бренда как есть — берём их на языке
// интерфейса (набранная раньше на другом языке подача остаётся в поле текстом).
const DELIVERY_PRESETS = computed(() => [
  t('blog.pages.run.delivery.presets.expert'),
  t('blog.pages.run.delivery.presets.simple'),
  t('blog.pages.run.delivery.presets.opinion'),
  t('blog.pages.run.delivery.presets.differentiate'),
  t('blog.pages.run.delivery.presets.facts'),
])
const delivery = ref('')
const deliverySaving = ref(false)
const deliverySaved = ref(false)
watch(settings, (s) => { if (s) delivery.value = String(s.delivery ?? '') })
function deliveryHas(p: string) { return delivery.value.toLowerCase().includes(p.toLowerCase()) }
function deliveryToggle(p: string) {
  const items = delivery.value.split(/[;\n]+/).map((x) => x.trim()).filter(Boolean)
  delivery.value = deliveryHas(p)
    ? items.filter((x) => x.toLowerCase() !== p.toLowerCase()).join('; ')
    : [...items, p].join('; ')
}
async function saveDelivery() {
  deliverySaving.value = true
  try {
    await api.blogPatchSettings({ delivery: delivery.value })
    if (settings.value) settings.value.delivery = delivery.value
    deliverySaved.value = true
    setTimeout(() => { deliverySaved.value = false }, 1800)
  } catch (e: any) {
    actionError.value = apiError(e, t('blog.pages.run.errors.actionFailed'))
  } finally {
    deliverySaving.value = false
  }
}

// --- Разметка (AEO/SEO) ------------------------------------------------------
// Считается на бэке детерминированно из готового текста: ни модели, ни кредитов.
const headMarkup = ref<HeadMarkup | null>(null)
const markupBusy = ref(false)
const markupError = ref('')
const copiedKey = ref('')
async function copyText(text: string, key: string) {
  try {
    await navigator.clipboard.writeText(text)
    copiedKey.value = key
    setTimeout(() => { if (copiedKey.value === key) copiedKey.value = '' }, 1500)
  } catch { /* clipboard недоступен */ }
}
async function loadMarkup() {
  if (markupBusy.value || headMarkup.value) return
  markupBusy.value = true
  markupError.value = ''
  try {
    headMarkup.value = await api.blogHeadMarkup(id)
  } catch (e: any) {
    markupError.value = apiError(e, t('blog.pages.run.markup.failed'))
  } finally {
    markupBusy.value = false
  }
}
function toggleMarkup() {
  panel.value.markup = !panel.value.markup
  if (panel.value.markup) loadMarkup()
}

// --- Публикация в блог -------------------------------------------------------
const LANGUAGES = [
  { code: 'ru', flag: '🇷🇺', name: 'Русский' },
  { code: 'en', flag: '🇬🇧', name: 'English' },
  { code: 'pt', flag: '🇵🇹', name: 'Português' },
  { code: 'es', flag: '🇪🇸', name: 'Español' },
  { code: 'tr', flag: '🇹🇷', name: 'Türkçe' },
  { code: 'de', flag: '🇩🇪', name: 'Deutsch' },
  { code: 'pl', flag: '🇵🇱', name: 'Polski' },
]
const localeFlag = (c: string) => LANGUAGES.find((l) => l.code === c)?.flag || '🌐'
const localeName = (c: string) => LANGUAGES.find((l) => l.code === c)?.name || c.toUpperCase()
const defaultLocale = computed(() => {
  const lang = String(settings.value?.language || '').toLowerCase()
  return LANGUAGES.find((l) => lang.includes(l.name.toLowerCase()) || lang === l.code)?.code || 'ru'
})
const publishLocale = ref('')
watch([defaultLocale, blog], () => { if (!publishLocale.value) publishLocale.value = blog.value.locale || defaultLocale.value }, { immediate: true })
const publishBusy = ref<'' | 'publish' | 'draft' | 'remove'>('')
const publishErr = ref('')
/** диалог публикации — главное действие шапки */
const publishOpen = ref(false)
/** публикация прошла: в диалоге вместо кнопок показываем отчёт по каналам */
const publishDone = ref(false)
const unpublishOpen = ref(false)
/** куда ушла статья при последней публикации — иначе веер каналов молчит */
const targets = ref<PublishTarget[]>([])

/**
 * Куда уедет статья по текущим настройкам — строкой. Выбор перенесён в композер,
 * но у кнопки «Опубликовать» должно быть написано, что произойдёт: раньше тут
 * стояли галочки, а после их переноса не осталось вообще ничего.
 */
const blogTargets = ref<PublishChannel[]>([])
const targetsHint = computed(() => {
  const on = blogTargets.value.filter((c) => c.ready && c.enabled)
  if (!on.length) return ''
  const names = on.map((c) => (c.key === 'external' ? t('blog.pages.run.blog.targets.site') : c.label))
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ')
})

const blogShareUrl = computed(() => {
  const base = String(settings.value?.siteUrl || '').replace(/\/$/, '')
  return base && blog.value.slug ? `${base}/blog/${blog.value.slug}` : ''
})
const canPublishBlog = computed(() => hasBody.value && !!title.value.trim())
/** статья реально где-то лежит — значит её есть что снимать */
const isLive = computed(() => blog.value.status === 'published' || !!blog.value.postId)

function openPublish(tab: 'now' | 'schedule' = 'now') {
  publishErr.value = ''
  publishDone.value = false
  publishTab.value = tab
  publishOpen.value = true
}

// --- отложенный автопостинг --------------------------------------------------
/**
 * Соцсети и каналы статьи идут комплектом к самой статье, но отправлялись
 * только «сейчас»: чтобы пост ушёл в четверг вечером, надо было в четверг
 * вечером сидеть в кабинете. Здесь — вторая вкладка диалога публикации: список
 * каналов, у каждого дата и время. Пикеры локальные, по проводу ходит UTC.
 *
 * Каналы-копипаст (VK, Дзен, Threads, RSS) в список не попадают: мы туда не
 * отправляем, там только текст на копирование, и «запланировать» было бы
 * обещанием, которого никто не выполнит.
 */
type ScheduleRow = { id?: string; channel: string; date: string; time: string; status: PublishScheduleStatus; error?: string }

const publishTab = ref<'now' | 'schedule'>('now')
const crossPlatforms = ref<CrosspostPlatform[]>([])
/** черновик расписания КАНАЛ → строка: строка правится прямо в пикерах, а по
 *  ключу её достаёт и шаблон, и сохранение */
const scheduleDraft = ref<Record<string, ScheduleRow>>({})
const scheduleRows = computed<ScheduleRow[]>(() => Object.values(scheduleDraft.value))
/**
 * Записи, которые не легли в строки каналов (второй и далее записи одного
 * канала). На экране их нет, но при сохранении отдаём обратно как есть —
 * молча стирать чужие отправки нельзя.
 */
const scheduleExtra = ref<PublishScheduleEntry[]>([])
const scheduleBusy = ref(false)
const scheduleErr = ref('')

const pad2 = (n: number) => String(n).padStart(2, '0')
const splitAt = (at: string) => {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return { date: '', time: '' }
  return {
    date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`,
    time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}`,
  }
}
const joinAt = (date: string, time: string) => {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  return new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0).toISOString()
}
/** дефолт новой записи — завтра в 10 утра: сегодняшнее время часто уже прошло */
function defaultSlot() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return { date: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`, time: '10:00' }
}

function applySchedule(entries: PublishScheduleEntry[]) {
  const draft: Record<string, ScheduleRow> = {}
  const extra: PublishScheduleEntry[] = []
  for (const e of entries || []) {
    if (draft[e.channel]) { extra.push(e); continue }
    draft[e.channel] = { id: e.id, channel: e.channel, ...splitAt(e.at), status: e.status || 'planned', error: e.error }
  }
  scheduleDraft.value = draft
  scheduleExtra.value = extra
}

function loadSchedule() {
  api.blogSchedule(id)
    .then((r) => applySchedule(r?.entries || []))
    // расписания может ещё не быть на бэке — вкладка тогда просто пустая
    .catch(() => { scheduleDraft.value = {}; scheduleExtra.value = [] })
}

/**
 * Каналы, куда можно запланировать. К доступным добавляем те, на которые
 * запись уже есть: интеграцию могли выключить после планирования, и запись
 * иначе висела бы невидимой — но всё ещё сохранялась бы.
 */
const scheduleChannels = computed<{ key: string; label: string }[]>(() => {
  const out: { key: string; label: string }[] = []
  const seen = new Set<string>()
  const add = (key: string, label: string) => {
    if (!key || seen.has(key) || NO_AUTO_PUBLISH.has(key)) return
    seen.add(key); out.push({ key, label })
  }
  for (const c of blogTargets.value) {
    if (c.ready && c.enabled) add(c.key, c.key === 'external' ? t('blog.pages.run.blog.targets.site') : c.label)
  }
  for (const p of crossPlatforms.value) {
    if (p.ready && p.delivery !== 'copy' && p.delivery !== 'rss') add(p.key, p.label)
  }
  for (const r of scheduleRows.value) add(r.channel, channelLabel(r.channel))
  return out
})
function addScheduleRow(key: string) {
  if (scheduleDraft.value[key]) return
  scheduleErr.value = ''
  scheduleDraft.value[key] = { channel: key, ...defaultSlot(), status: 'planned' }
}
function removeScheduleRow(key: string) {
  scheduleErr.value = ''
  delete scheduleDraft.value[key]
}
/** «Повторить» после ошибки: запись возвращается в planned с новой датой */
function retryScheduleRow(key: string) {
  const row = scheduleDraft.value[key]
  if (!row) return
  scheduleErr.value = ''
  scheduleDraft.value[key] = { ...row, ...defaultSlot(), status: 'planned', error: '' }
}

/** сколько отправок ещё впереди и когда ближайшая — строка для инспектора */
const schedulePlanned = computed(() => scheduleRows.value.filter((r) => r.status === 'planned' && r.date && r.time))
const scheduleNext = computed(() => {
  const ats = schedulePlanned.value.map((r) => joinAt(r.date, r.time)).sort()
  if (!ats.length) return ''
  return new Date(ats[0]).toLocaleString(intlLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
})

async function saveSchedule() {
  if (scheduleBusy.value) return
  scheduleBusy.value = true
  scheduleErr.value = ''
  try {
    const entries = [
      ...scheduleRows.value
        .filter((r) => r.date && r.time)
        .map((r) => ({ id: r.id, channel: r.channel, at: joinAt(r.date, r.time) })),
      ...scheduleExtra.value.map((e) => ({ id: e.id, channel: e.channel, at: e.at })),
    ]
    const res = await api.blogSaveSchedule(id, entries)
    applySchedule(res?.entries || [])
    publishOpen.value = false
  } catch (e: any) {
    scheduleErr.value = apiError(e, t('blog.pages.run.schedule.errors.save'))
  } finally {
    scheduleBusy.value = false
  }
}

async function publishBlog(next: 'draft' | 'published') {
  if (publishBusy.value || !canPublishBlog.value) return
  publishBusy.value = next === 'published' ? 'publish' : 'draft'
  publishErr.value = ''
  try {
    // публикуем актуальную версию; не сохранилось — не публикуем
    if (!(await save())) { publishErr.value = saveError.value; return }
    // Без channels бэк работает по тумблерам из интеграций. Разовый выбор
    // каналов живёт в композере соцсетей — там видно все площадки сразу.
    const res = await api.blogPublish(id, { status: next, locale: publishLocale.value })
    blog.value = { postId: res.postId, slug: res.slug, status: res.status, locale: res.locale || publishLocale.value, coverUrl: res.coverUrl || '', syncedAt: res.syncedAt || '' }
    targets.value = publishTargets(res)
    // Статус рана и статус поста жили порознь: в списке тем опубликованная
    // статья продолжала висеть черновиком.
    if (next === 'published') {
      await api.blogPatchRun(id, { status: 'published' }).catch(() => {})
      status.value = 'published'
    }
    publishDone.value = true
    reloadRuns(true).catch(() => {})
  } catch (e: any) {
    publishErr.value = apiError(e, t('blog.pages.run.blog.errors.failed'))
  } finally {
    publishBusy.value = ''
  }
}
async function unpublishBlog() {
  if (publishBusy.value) return
  publishBusy.value = 'remove'
  publishErr.value = ''
  actionError.value = ''
  try {
    const res = await api.blogUnpublish(id)
    targets.value = publishTargets(res)
    // deleted:false = внешнюю копию снять не удалось — бэк намеренно НЕ обнулил
    // blog_* (иначе снять её потом было бы нечем). Не врём «снято»: состояние
    // оставляем и показываем причину.
    if (res && res.deleted === false) {
      unpublishOpen.value = false
      actionError.value = t('blog.pages.run.blog.errors.unpublishPartial', {
        reason: String(res?.external?.error || ''),
      })
      load(false).catch(() => {})
      return
    }
    blog.value = { postId: 0, slug: '', status: '', locale: '', coverUrl: '', syncedAt: '' }
    if (status.value === 'published') {
      await api.blogPatchRun(id, { status: 'done' }).catch(() => {})
      status.value = 'done'
    }
    unpublishOpen.value = false
    reloadRuns(true).catch(() => {})
  } catch (e: any) {
    // подтверждение закрывается кликом по действию — ошибку показываем плашкой
    // в шапке, иначе она пряталась бы в свёрнутой секции инспектора
    actionError.value = apiError(e, t('blog.pages.run.blog.errors.unpublishFailed'))
  } finally {
    publishBusy.value = ''
  }
}

/** Каналы, которых коснётся снятие: их же и перечисляем в подтверждении. */
const liveChannels = computed(() => {
  const names = targets.value.filter((x) => x.state === 'ok' || x.state === 'skipped')
    .map((x) => (x.labelKey ? t('blog.pages.run.blog.targets.' + x.labelKey) : x.label))
  return names.length ? names.join(', ') : targetsHint.value
})

// --- удаление статьи ---------------------------------------------------------
const deleteOpen = ref(false)
const deleting = ref(false)
async function removeRun() {
  if (deleting.value) return
  deleting.value = true
  actionError.value = ''
  try {
    await api.blogDeleteRun(id)
    markSaved() // статьи больше нет — гард ухода спрашивать не о чем
    deleteOpen.value = false
    reloadRuns(true).catch(() => {})
    router.push('/blog')
  } catch (e: any) {
    actionError.value = apiError(e, t('blog.pages.run.delete.failed'))
  } finally {
    deleting.value = false
  }
}

// --- Локали / переводы -------------------------------------------------------
const localeItems = ref<any[]>([])
const localeBusy = ref(false)
const localeNote = ref('')
const picked = ref<Set<string>>(new Set())
const missingLocales = computed(() => LANGUAGES.map((l) => l.code).filter((c) => !localeItems.value.some((i) => i.locale === c)))
const pickedMissing = computed(() => missingLocales.value.filter((c) => picked.value.has(c)))
function togglePick(c: string) {
  const next = new Set(picked.value)
  next.has(c) ? next.delete(c) : next.add(c)
  picked.value = next
}
async function loadGroup() {
  try {
    const g = await api.blogGroup(id)
    localeItems.value = g.items || []
  } catch { /* группа недоступна */ }
}
async function translate() {
  if (localeBusy.value || !pickedMissing.value.length) return
  localeBusy.value = true
  localeNote.value = ''
  try {
    const r = await api.blogTranslate(id, pickedMissing.value)
    await loadGroup()
    picked.value = new Set()
    const parts: string[] = []
    if (r?.created?.length) parts.push(t('blog.pages.run.locales.note.created', { list: r.created.map((c: any) => c.locale).join(', ') }))
    if (r?.failed?.length) parts.push(t('blog.pages.run.locales.note.failed', { list: r.failed.map((f: any) => f.locale).join(', ') }))
    localeNote.value = parts.join(' · ') || t('blog.pages.run.locales.note.nothing')
  } catch { localeNote.value = t('blog.pages.run.locales.note.error') } finally {
    localeBusy.value = false
  }
}
const localeDot = (i: any) => i.blogStatus === 'published' ? 'bg-success' : i.blogStatus === 'draft' ? 'bg-warning' : 'bg-muted-foreground/30'

// --- производные для инспектора ----------------------------------------------
function stripHtml(h: string) { return (h || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }
const plainText = computed(() => stripHtml(html.value).toLowerCase())
const categoryOptions = computed(() => String(settings.value?.categories || '').split(',').map((s) => s.trim()).filter(Boolean))
const authorPlaceholder = computed(() => settings.value?.author
  || t('blog.pages.run.meta.authorFallback', { brand: settings.value?.brand || t('blog.pages.run.meta.authorFallbackBrand') }))

const slopScore = computed(() => Number(slop.value?.score ?? 0))
const slopFindings = computed<any[]>(() => slop.value?.findings || slop.value?.hits || [])
const slopTier = computed(() => slopScore.value === 0
  ? { t: t('blog.pages.run.quality.tier.clean'), c: 'text-success' }
  : slopScore.value <= 6
    ? { t: t('blog.pages.run.quality.tier.some'), c: 'text-warning' }
    : { t: t('blog.pages.run.quality.tier.many'), c: 'text-danger' })

const aeoCoverage = computed(() => {
  const qs = targetQueries.value
  if (!qs.length) return null
  const txt = plainText.value
  let hit = 0
  for (const q of qs) {
    const parts = String(q).toLowerCase().split(/\s+/).filter((w) => w.length > 3)
    if (parts.length && parts.every((w) => txt.includes(w))) hit++
  }
  return { hit, total: qs.length }
})
const qualityIssues = computed(() => (eeat.value?.issues?.length || 0) + (notes.value?.length || 0))

// --- панели инспектора / превью ----------------------------------------------
const panelCollapsed = ref(false)
/** инспектор ящиком — на экранах уже xl колонка в 350px не помещается */
const inspectorOpen = ref(false)
/** композер соцсетей — полноэкранная модалка */
const socialOpen = ref(false)
const panel = ref({ meta: true, markup: false, blog: false, locales: false, delivery: false, quality: true, regen: false })
const previewOpen = ref(false)
onMounted(() => { panelCollapsed.value = localStorage.getItem('bw_panel_collapsed') === '1' })
watch(panelCollapsed, (v) => localStorage.setItem('bw_panel_collapsed', v ? '1' : '0'))
/** инспектору нечего показывать, пока статьи нет */
const showInspector = computed(() => !generating.value && !isAwaiting.value && !loadError.value)
function toggleInspector() {
  if (isWide.value) panelCollapsed.value = !panelCollapsed.value
  else inspectorOpen.value = true
}
// экран стал широким — ящик больше не нужен, инспектор снова колонка (и заодно
// не остаётся второй копии разметки в DOM)
watch(isWide, (v) => { if (v) inspectorOpen.value = false })

// авто-рост заголовка
const titleEl = ref<HTMLTextAreaElement>()
function growTitle() { const el = titleEl.value; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }
watch(title, () => requestAnimationFrame(growTitle))
onMounted(() => requestAnimationFrame(growTitle))

const stepIcon: Record<string, any> = { done: Check, running: Loader2, waiting: Hand, error: X }
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- Инспектор описан один раз: на широком экране он колонка справа, на
         узком — тот же блок в Sheet по кнопке из шапки. -->
    <DefineInspector>
      <!-- Мета -->
      <section class="border-b border-border">
        <button type="button" class="flex w-full items-center gap-2.5 px-4 py-3.5 text-left transition hover:bg-surface" @click="panel.meta = !panel.meta">
          <ImageIcon :size="16" class="shrink-0 text-muted-foreground" />
          <span class="flex-1 text-[13.5px] font-semibold">{{ $t('blog.pages.run.meta.title') }}</span>
          <span v-if="views" class="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground"><Eye :size="11" /> {{ views }}</span>
          <ChevronDown :size="16" class="shrink-0 text-muted-foreground/50 transition" :class="panel.meta ? 'rotate-180' : ''" />
        </button>
        <div v-show="panel.meta" class="space-y-3 px-4 pb-4">
          <div>
            <label class="mb-1 block text-[12px] text-muted-foreground">{{ $t('blog.pages.run.meta.category') }}</label>
            <input v-model="category" list="cat-opts" :placeholder="$t('blog.pages.run.meta.categoryPlaceholder')" class="h-8 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus:border-ring">
            <datalist id="cat-opts"><option v-for="c in categoryOptions" :key="c" :value="c" /></datalist>
          </div>
          <div>
            <label class="mb-1 block text-[12px] text-muted-foreground">{{ $t('blog.pages.run.meta.author') }}</label>
            <input v-model="author" :placeholder="authorPlaceholder" class="h-8 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none focus:border-ring">
          </div>
          <!-- Обложка тут только миниатюрой-ссылкой: правится она в теле
               документа, где её и видно рядом с текстом. -->
          <button
            type="button"
            class="flex w-full items-center gap-2.5 border-t border-border pt-3 text-left transition hover:opacity-90"
            @click="studioOpen = true"
          >
            <img v-if="coverUrl" :src="coverUrl" :alt="$t('blog.pages.run.cover.articleAlt')" class="h-9 w-16 shrink-0 rounded border border-border object-cover">
            <span v-else class="grid h-9 w-16 shrink-0 place-items-center rounded border border-dashed border-border text-[10px] text-muted-foreground/60">{{ $t('blog.pages.run.cover.none') }}</span>
            <span class="min-w-0 flex-1 text-[12.5px] text-muted-foreground">{{ $t('blog.pages.run.cover.label') }}</span>
            <ChevronRight :size="14" class="shrink-0 text-muted-foreground/50" />
          </button>
        </div>
      </section>

      <!-- Разметка (AEO/SEO): что уедет в <head> и в JSON-LD -->
      <section class="border-b border-border">
        <button type="button" class="flex w-full items-center gap-2.5 px-4 py-3.5 text-left transition hover:bg-surface" @click="toggleMarkup">
          <Code2 :size="16" class="shrink-0 text-muted-foreground" />
          <span class="flex-1 text-[13.5px] font-semibold">{{ $t('blog.pages.run.markup.title') }}</span>
          <span v-if="headMarkup?.faqCount" class="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{{ $t('blog.pages.run.markup.faq', { n: headMarkup.faqCount }) }}</span>
          <ChevronDown :size="16" class="shrink-0 text-muted-foreground/50 transition" :class="panel.markup ? 'rotate-180' : ''" />
        </button>
        <div v-show="panel.markup" class="space-y-3 px-4 pb-4">
          <p class="text-[12px] leading-relaxed text-muted-foreground/70">{{ $t('blog.pages.run.markup.hint') }}</p>
          <p v-if="markupBusy" class="flex items-center gap-1.5 text-[12px] text-muted-foreground"><Loader2 :size="13" class="animate-spin" /> {{ $t('state.loading') }}</p>
          <p v-else-if="markupError" class="text-[12px] text-danger">{{ markupError }}</p>
          <template v-else-if="headMarkup">
            <div v-if="headMarkup.titles.length">
              <div class="mb-1 text-[12px] text-muted-foreground">{{ $t('blog.pages.run.markup.titles') }}</div>
              <button
                v-for="(v, i) in headMarkup.titles" :key="'t' + i" type="button"
                class="mb-1 flex w-full items-start gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-left text-[12px] transition hover:bg-surface-2"
                :title="$t('action.copy')" @click="copyText(v, 't' + i)"
              >
                <span class="min-w-0 flex-1 leading-[1.45]">{{ v }}</span>
                <Check v-if="copiedKey === 't' + i" :size="12" class="mt-0.5 shrink-0 text-success" />
                <CopyIcon v-else :size="12" class="mt-0.5 shrink-0 text-muted-foreground/50" />
              </button>
            </div>
            <div v-if="headMarkup.descriptions.length">
              <div class="mb-1 text-[12px] text-muted-foreground">{{ $t('blog.pages.run.markup.descriptions') }}</div>
              <button
                v-for="(v, i) in headMarkup.descriptions" :key="'d' + i" type="button"
                class="mb-1 flex w-full items-start gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 text-left text-[12px] transition hover:bg-surface-2"
                :title="$t('action.copy')" @click="copyText(v, 'd' + i)"
              >
                <span class="min-w-0 flex-1 leading-[1.45]">{{ v }}</span>
                <Check v-if="copiedKey === 'd' + i" :size="12" class="mt-0.5 shrink-0 text-success" />
                <CopyIcon v-else :size="12" class="mt-0.5 shrink-0 text-muted-foreground/50" />
              </button>
            </div>
            <button
              type="button"
              class="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border py-2 text-[12.5px] transition hover:bg-surface-2"
              @click="copyText(headMarkup.html, 'head')"
            >
              <Check v-if="copiedKey === 'head'" :size="13" class="text-success" /><CopyIcon v-else :size="13" />
              {{ $t('blog.pages.run.markup.copyHead') }}
            </button>
          </template>
        </div>
      </section>

      <!-- Публикация: статус, слаг и снятие. Выбор языка и адресатов живёт в
           диалоге «Опубликовать» — дублировать их здесь незачем. -->
      <section class="border-b border-border">
        <button type="button" class="flex w-full items-center gap-2.5 px-4 py-3.5 text-left transition hover:bg-surface" @click="panel.blog = !panel.blog">
          <Send :size="16" class="shrink-0 text-muted-foreground" />
          <span class="flex-1 text-[13.5px] font-semibold">{{ $t('blog.pages.run.blog.title') }}</span>
          <span v-if="blog.status === 'published'" class="rounded bg-success-soft px-1.5 py-0.5 text-[11px] text-success">{{ $t('blog.pages.run.blog.publishedBadge') }}</span>
          <span v-else-if="blog.status === 'draft'" class="rounded bg-warning-soft px-1.5 py-0.5 text-[11px] text-warning">{{ $t('blog.pages.run.blog.draftBadge') }}</span>
          <ChevronDown :size="16" class="shrink-0 text-muted-foreground/50 transition" :class="panel.blog ? 'rotate-180' : ''" />
        </button>
        <div v-show="panel.blog" class="space-y-2.5 px-4 pb-4">
          <div v-if="blog.slug" class="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <span class="shrink-0 opacity-60">{{ $t('blog.pages.run.blog.slug') }}</span>
            <code class="truncate font-mono">{{ blog.slug }}</code>
            <a v-if="blogShareUrl" :href="blogShareUrl" target="_blank" rel="noopener" class="ml-auto shrink-0 text-brand-accent hover:text-foreground" :title="$t('blog.pages.run.blog.openInBlog')"><ExternalLink :size="13" /></a>
          </div>
          <p v-else class="text-[12px] text-muted-foreground/70">{{ $t('blog.pages.run.blog.notPublished') }}</p>

          <!-- Отложенные отправки одной строкой: иначе о них знал только диалог,
               и «когда это уедет» приходилось вспоминать. -->
          <button
            v-if="schedulePlanned.length" type="button"
            class="flex w-full items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-left text-[12px] text-muted-foreground transition hover:bg-surface-2 hover:text-foreground"
            @click="openPublish('schedule')"
          >
            <CalendarClock :size="13" class="shrink-0" />
            <span class="min-w-0 flex-1 truncate">{{ $t('blog.pages.run.schedule.summary', { n: schedulePlanned.length, at: scheduleNext }) }}</span>
            <ChevronRight :size="13" class="shrink-0 opacity-50" />
          </button>

          <!-- Кнопка видна по статусу поста, а не по postId: у не-Ideata брендов
               postId нет вовсе, и «Снять» пряталась ровно у тех, кому нужна. -->
          <button
            v-if="isLive" type="button"
            class="inline-flex w-full items-center justify-center gap-1.5 rounded-lg py-1.5 text-[12px] text-danger transition hover:bg-danger-soft disabled:opacity-50"
            :disabled="!!publishBusy" @click="unpublishOpen = true"
          >
            <Loader2 v-if="publishBusy === 'remove'" :size="13" class="animate-spin" /><Trash2 v-else :size="13" /> {{ $t('blog.pages.run.blog.unpublish') }}
          </button>
          <p v-if="publishErr" class="text-[11.5px] text-danger">{{ publishErr }}</p>

          <!-- Куда ушла статья: ответ сервера по каналам раньше летел в корзину -->
          <div v-if="targets.length" class="space-y-1 rounded-lg border border-border bg-surface px-2.5 py-2">
            <div class="mb-1 text-[11.5px] text-muted-foreground/70">{{ $t('blog.pages.run.blog.targets.title') }}</div>
            <div v-for="tg in targets" :key="tg.key" class="flex items-start gap-1.5 text-[12px]">
              <component
                :is="tg.state === 'error' || tg.state === 'unconfigured' ? TriangleAlert : tg.state === 'manual' ? Hand : Check"
                :size="12"
                class="mt-[3px] shrink-0"
                :class="tg.state === 'error' || tg.state === 'unconfigured' ? 'text-danger' : tg.state === 'manual' ? 'text-warning' : 'text-success'"
              />
              <div class="min-w-0 flex-1">
                <span>{{ tg.labelKey ? $t('blog.pages.run.blog.targets.' + tg.labelKey) : tg.label }}</span>
                <span v-if="tg.updated" class="ml-1 text-[11px] text-muted-foreground/60">{{ $t('blog.pages.run.blog.targets.updated') }}</span>
                <span v-else-if="tg.state === 'skipped'" class="ml-1 text-[11px] text-muted-foreground/60">{{ $t('blog.pages.run.blog.targets.skipped') }}</span>
                <span v-else-if="tg.state === 'manual'" class="ml-1 text-[11px] text-muted-foreground/60">{{ $t('blog.pages.run.blog.targets.manual') }}</span>
                <p v-if="tg.error" class="text-[11px] leading-[1.45] text-danger">{{ tg.error }}</p>
              </div>
              <a
                v-if="tg.url" :href="tg.url" target="_blank" rel="noopener"
                class="mt-px shrink-0 text-brand-accent hover:text-foreground" :title="$t('blog.pages.run.blog.targets.open')"
              ><ExternalLink :size="12" /></a>
            </div>
          </div>
        </div>
      </section>

      <!-- Перегенерация отрывка: инструмент правки, а не часть документа —
           между заголовком и обложкой она разрывала статью пополам -->
      <section v-if="outline?.sections?.length" class="border-b border-border">
        <button type="button" class="flex w-full items-center gap-2.5 px-4 py-3.5 text-left transition hover:bg-surface" @click="panel.regen = !panel.regen">
          <RotateCcw :size="16" class="shrink-0 text-muted-foreground" />
          <span class="flex-1 text-[13.5px] font-semibold">{{ $t('blog.pages.run.regen.title') }}</span>
          <ChevronDown :size="16" class="shrink-0 text-muted-foreground/50 transition" :class="panel.regen ? 'rotate-180' : ''" />
        </button>
        <div v-show="panel.regen" class="space-y-2.5 px-4 pb-4">
          <select v-model.number="regenIdx" class="h-8 w-full rounded-md border border-border bg-background px-2 text-[12.5px] outline-none" :disabled="regenBusy !== null">
            <option v-for="(sec, i) in outline.sections" :key="i" :value="i">{{ Number(i) + 1 }}. {{ sec.heading }}</option>
          </select>
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="shrink-0 text-[11px] text-muted-foreground/70">{{ $t('blog.pages.run.regen.exclude') }}</span>
            <button v-for="p in REGEN_PRESETS" :key="p" type="button" class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition" :class="negActive(p) ? 'border-transparent bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'" :disabled="regenBusy !== null" @click="toggleNeg(p)"><Check v-if="negActive(p)" :size="10" /> {{ p }}</button>
          </div>
          <Button size="sm" class="w-full" :disabled="regenBusy !== null || isRunning" @click="regenSection">
            <Loader2 v-if="regenBusy !== null" :size="12" class="animate-spin" /><RotateCcw v-else :size="12" />
            {{ regenBusy !== null ? $t('blog.pages.run.regen.running') : $t('blog.pages.run.regen.run') }}
          </Button>
        </div>
      </section>

      <!-- Локали -->
      <section class="border-b border-border">
        <button type="button" class="flex w-full items-center gap-2.5 px-4 py-3.5 text-left transition hover:bg-surface" @click="panel.locales = !panel.locales">
          <Languages :size="16" class="shrink-0 text-muted-foreground" />
          <span class="flex-1 text-[13.5px] font-semibold">{{ $t('blog.pages.run.locales.title') }}</span>
          <span v-if="localeItems.length > 1" class="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{{ localeItems.length }}</span>
          <ChevronDown :size="16" class="shrink-0 text-muted-foreground/50 transition" :class="panel.locales ? 'rotate-180' : ''" />
        </button>
        <div v-show="panel.locales" class="space-y-3 px-4 pb-4">
          <!-- версии-свитчер -->
          <div v-if="localeItems.length > 1">
            <div class="mb-1.5 text-[12px] text-muted-foreground">{{ $t('blog.pages.run.locales.versions') }}</div>
            <div class="flex flex-wrap gap-1">
              <RouterLink
                v-for="i in localeItems" :key="i.id" :to="`/blog/run/${i.id}`"
                class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11.5px] transition"
                :class="i.isCurrent ? 'border-transparent bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'"
                :title="`${i.title || i.locale}${i.blogStatus ? ' · ' + $t('blog.pages.run.locales.blogStatus', { status: i.blogStatus }) : ''}`"
              >
                <span class="size-1.5 rounded-full" :class="localeDot(i)"></span>
                {{ localeFlag(i.locale) }} <span class="font-mono uppercase">{{ i.locale }}</span>
              </RouterLink>
            </div>
          </div>
          <!-- перевести на -->
          <div v-if="missingLocales.length">
            <div class="mb-1.5 text-[12px] text-muted-foreground">{{ $t('blog.pages.run.locales.translateTo') }}</div>
            <div class="mb-2 flex flex-wrap gap-1">
              <button
                v-for="c in missingLocales" :key="c" type="button"
                class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11.5px] transition"
                :class="picked.has(c) ? 'border-transparent bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'"
                :disabled="localeBusy" @click="togglePick(c)"
              >
                <Check v-if="picked.has(c)" :size="11" /> {{ localeFlag(c) }} {{ localeName(c) }}
              </button>
            </div>
            <button type="button" class="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-border py-2 text-[12.5px] transition hover:bg-surface-2 disabled:opacity-50" :disabled="localeBusy || !pickedMissing.length" @click="translate">
              <Loader2 v-if="localeBusy" :size="14" class="animate-spin" /><Plus v-else :size="14" /> {{ localeBusy ? $t('blog.pages.run.locales.translating') : (pickedMissing.length ? $t('blog.pages.run.locales.translate', { n: pickedMissing.length }) : $t('blog.pages.run.locales.choose')) }}
            </button>
          </div>
          <p v-if="localeNote" class="text-[11.5px] text-muted-foreground">{{ localeNote }}</p>
        </div>
      </section>

      <!-- Подача -->
      <section class="border-b border-border">
        <button type="button" class="flex w-full items-center gap-2.5 px-4 py-3.5 text-left transition hover:bg-surface" @click="panel.delivery = !panel.delivery">
          <SlidersHorizontal :size="16" class="shrink-0 text-muted-foreground" />
          <span class="flex-1 text-[13.5px] font-semibold">{{ $t('blog.pages.run.delivery.title') }}</span>
          <span v-if="delivery.trim()" class="size-1.5 rounded-full bg-brand-accent" :title="$t('blog.pages.run.delivery.set')"></span>
          <ChevronDown :size="16" class="shrink-0 text-muted-foreground/50 transition" :class="panel.delivery ? 'rotate-180' : ''" />
        </button>
        <div v-show="panel.delivery" class="space-y-2.5 px-4 pb-4">
          <i18n-t keypath="blog.pages.run.delivery.hint" scope="global" tag="p" class="text-[12px] leading-relaxed text-muted-foreground/70">
            <template #all><b class="text-foreground/80">{{ $t('blog.pages.run.delivery.hintAll') }}</b></template>
          </i18n-t>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="p in DELIVERY_PRESETS" :key="p" type="button" class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition" :class="deliveryHas(p) ? 'border-transparent bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'" @click="deliveryToggle(p)"><Check v-if="deliveryHas(p)" :size="10" /> {{ p }}</button>
          </div>
          <textarea v-model="delivery" rows="4" class="w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-[13px] outline-none focus:border-ring" :placeholder="$t('blog.pages.run.delivery.placeholder')"></textarea>
          <Button size="sm" class="w-full" :disabled="deliverySaving || delivery === String(settings?.delivery ?? '')" @click="saveDelivery">
            <Loader2 v-if="deliverySaving" :size="14" class="animate-spin" /><Check v-else-if="deliverySaved" :size="14" /><Save v-else :size="14" /> {{ deliverySaved ? $t('blog.pages.run.delivery.saved') : $t('blog.pages.run.delivery.save') }}
          </Button>
        </div>
      </section>

      <!-- Качество и AEO -->
      <section class="border-b border-border">
        <button type="button" class="flex w-full items-center gap-2.5 px-4 py-3.5 text-left transition hover:bg-surface" @click="panel.quality = !panel.quality">
          <Gauge :size="16" class="shrink-0 text-muted-foreground" />
          <span class="flex-1 text-[13.5px] font-semibold">{{ $t('blog.pages.run.quality.title') }}</span>
          <span v-if="qualityIssues" class="rounded bg-warning-soft px-1.5 py-0.5 font-mono text-[11px] text-warning">{{ qualityIssues }}</span>
          <span v-else class="rounded bg-success-soft px-1.5 py-0.5 text-[11px] text-success">{{ $t('blog.pages.run.quality.ok') }}</span>
          <ChevronDown :size="16" class="shrink-0 text-muted-foreground/50 transition" :class="panel.quality ? 'rotate-180' : ''" />
        </button>
        <div v-show="panel.quality" class="space-y-3 px-4 pb-4">
          <!-- слоп -->
          <div class="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
            <span class="text-[12px] text-muted-foreground">{{ $t('blog.pages.run.quality.antislop') }}</span>
            <span class="ml-auto text-[12.5px] font-medium" :class="slopTier.c">{{ slopScore === 0 ? $t('blog.pages.run.quality.clean') : $t('blog.pages.run.quality.score', { n: slopScore.toFixed(1) }) }}</span>
          </div>
          <div v-if="slopFindings.length" class="flex flex-wrap gap-1">
            <span v-for="(f, i) in slopFindings.slice(0, 8)" :key="i" class="rounded border border-warning/20 bg-warning-soft px-1.5 py-0.5 text-[11px] text-warning">{{ f.hint || f.phrase || f.id }}</span>
          </div>
          <!-- AEO -->
          <div v-if="aeoCoverage" class="rounded-lg border border-border bg-surface px-3 py-2 text-[12.5px]">
            {{ $t('blog.pages.run.quality.aeoCoverage') }} <b>{{ aeoCoverage.hit }}/{{ aeoCoverage.total }}</b> {{ $t('blog.pages.run.quality.aeoCoverageTail') }}
          </div>
          <!-- E-E-A-T -->
          <div v-if="eeat" class="space-y-1.5">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-[12px]">
              <div class="rounded-md bg-surface-2 px-2.5 py-1.5">{{ $t('blog.pages.run.quality.citations') }} <b>{{ eeat.citations ?? 0 }}</b></div>
              <div class="rounded-md bg-surface-2 px-2.5 py-1.5">{{ $t('blog.pages.run.quality.leadFaq') }} <b>{{ eeat.hasLead ? '✓' : '—' }} / {{ eeat.hasFaq ? '✓' : '—' }}</b></div>
            </div>
            <div v-if="eeat.removedLinks?.length" class="rounded-md border border-danger/20 bg-danger-soft px-2.5 py-1.5 text-[12px] text-danger">{{ $t('blog.pages.run.quality.removedLinks', { n: eeat.removedLinks.length }) }}</div>
            <div v-for="(iss, i) in (eeat.issues || [])" :key="i" class="rounded-md border border-warning/20 bg-warning-soft px-2.5 py-1.5 text-[12px] text-warning">{{ iss }}</div>
          </div>
          <!-- факт-чек -->
          <div v-if="notes.length" class="space-y-1.5">
            <button type="button" class="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border py-2 text-[12.5px] transition hover:bg-surface-2 disabled:opacity-50" :disabled="factfixing" @click="fixFacts">
              <Loader2 v-if="factfixing" :size="14" class="animate-spin" /><ShieldCheck v-else :size="14" class="text-success" /> {{ factfixing ? $t('blog.pages.run.quality.factfixing') : $t('blog.pages.run.quality.factfix', { n: notes.length }) }}
            </button>
            <div v-for="(n, i) in notes" :key="i" class="rounded-md border border-warning/20 bg-warning-soft px-2.5 py-1.5 text-[12px] text-warning">{{ n }}</div>
          </div>
          <!-- источники -->
          <div v-if="sources.length">
            <div class="mb-1 text-[12px] font-medium text-muted-foreground">{{ $t('blog.pages.run.quality.sources', { n: sources.length }) }}</div>
            <ul class="space-y-1">
              <li v-for="(s, i) in sources.slice(0, 12)" :key="i" class="truncate text-[12px]">
                <a :href="s.url" target="_blank" rel="noopener" class="text-brand-accent hover:underline">{{ s.title || s.url }}</a>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </DefineInspector>

    <!-- шапка -->
    <header class="sticky top-0 z-10 flex flex-wrap shrink-0 items-center gap-x-2.5 gap-y-1.5 border-b border-border bg-background/80 px-4 py-2.5 backdrop-blur">
      <button type="button" class="flex shrink-0 items-center gap-1.5 text-[13px] text-muted-foreground transition hover:text-foreground" @click="router.push('/blog')">
        <ArrowLeft :size="16" /> {{ $t('action.back') }}
      </button>
      <div class="h-4 w-px shrink-0 bg-border"></div>
      <!-- заголовок редактируется в теле документа; здесь он только подпись -->
      <span class="min-w-0 max-w-[42ch] flex-1 truncate text-[14px] font-medium" :title="title || topic">
        {{ title || topic || $t('blog.pages.run.titlePlaceholder') }}
      </span>
      <span class="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium" :class="statusPill.cls">
        <span class="size-1.5 rounded-full" :class="statusPill.dot"></span>{{ statusPill.label }}
      </span>
      <!-- состояние записи: молчит, пока сохранять нечего -->
      <span v-if="saveState" class="shrink-0 text-[12px]" :class="saveState === 'dirty' ? 'text-warning' : 'text-muted-foreground'">
        {{ saveState === 'saving' ? $t('state.saving') : saveState === 'dirty' ? $t('blog.pages.run.saveState.dirty') : $t('blog.pages.run.saved') }}
      </span>
      <div class="flex-1"></div>

      <button v-if="showInspector" type="button" class="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-surface-hover hover:text-foreground" :title="panelCollapsed ? $t('blog.pages.run.showPanel') : $t('blog.pages.run.hidePanel')" @click="toggleInspector">
        <PanelRightOpen v-if="panelCollapsed" :size="17" /><PanelRight v-else :size="17" />
      </button>
      <button
        v-if="hasBody" type="button"
        class="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium transition hover:bg-surface-hover"
        :class="socialOpen ? 'bg-surface-2 text-foreground' : 'text-muted-foreground hover:text-foreground'"
        @click="socialOpen = !socialOpen"
      ><Share2 :size="15" /> {{ $t('blog.pages.run.social.title') }}</button>

      <template v-if="hasBody">
        <button type="button" class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium transition hover:bg-surface-hover disabled:opacity-50" :disabled="saving || isRunning" @click="save()">
          <Loader2 v-if="saving" :size="14" class="animate-spin" /><Save v-else :size="14" /> {{ $t('action.save') }}
        </button>

        <!-- Вторичные действия — под «•••»: в шапке они конкурировали с главной
             кнопкой и вчетвером занимали больше места, чем она. -->
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button type="button" class="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-surface-hover hover:text-foreground data-[state=open]:bg-surface-2" :aria-label="$t('blog.pages.run.menu.more')">
              <MoreHorizontal :size="17" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" :side-offset="6" class="w-56">
            <DropdownMenuItem @click="previewOpen = true"><Eye :size="14" /> {{ $t('blog.pages.run.preview') }}</DropdownMenuItem>
            <DropdownMenuItem @click="copyContent">
              <Check v-if="copied" :size="14" /><CopyIcon v-else :size="14" /> {{ copied ? $t('action.copied') : $t('blog.pages.run.menu.copyText') }}
            </DropdownMenuItem>
            <DropdownMenuItem @click="exportMd"><Download :size="14" /> {{ $t('blog.pages.run.export') }}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem class="text-danger focus:text-danger" @click="deleteOpen = true">
              <Trash2 :size="14" /> {{ $t('blog.pages.run.delete.action') }}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button size="sm" class="border border-border bg-white text-[#111418] hover:bg-white/90 dark:border-0" :disabled="isRunning || !canPublishBlog" @click="openPublish()">
          <Send :size="14" /> {{ blog.status === 'published' ? $t('blog.pages.run.blog.update') : $t('blog.pages.run.publish') }}
        </Button>
      </template>
    </header>

    <!-- ошибки -->
    <div v-if="saveError" class="flex shrink-0 items-center gap-2 border-b border-danger/20 bg-danger-soft px-4 py-2 text-[13px] text-danger">
      <TriangleAlert :size="15" class="shrink-0" />
      <span class="flex-1">{{ saveError }}</span>
      <button type="button" class="shrink-0 rounded-md border border-danger/40 px-2 py-1 text-[12px] transition hover:bg-danger-soft" @click="save()">{{ $t('action.retry') }}</button>
    </div>
    <div v-if="actionError" class="flex shrink-0 items-center gap-2 border-b border-danger/20 bg-danger-soft px-4 py-2 text-[13px] text-danger">
      <TriangleAlert :size="15" class="shrink-0" />
      <span class="flex-1">{{ actionError }}</span>
      <button type="button" class="grid size-6 shrink-0 place-items-center rounded-md transition hover:bg-danger-soft" :aria-label="$t('action.close')" @click="actionError = ''"><X :size="14" /></button>
    </div>
    <div v-if="!loadError && (status === 'error' || runError)" class="flex shrink-0 items-center gap-2 border-b border-danger/20 bg-danger-soft px-4 py-2 text-[13px] text-danger">
      <TriangleAlert :size="15" class="shrink-0" />
      <span class="flex-1 truncate">{{ $t('blog.pages.run.pipelineFailed') }}{{ runError ? `: ${runError}` : '' }}</span>
      <button type="button" class="inline-flex items-center gap-1.5 rounded-md border border-danger/40 px-2 py-1 text-[12px] transition hover:bg-danger-soft disabled:opacity-50" :disabled="retrying" @click="retry">
        <RotateCcw :size="12" :class="retrying ? 'animate-spin' : ''" /> {{ retrying ? $t('blog.pages.run.restarting') : $t('blog.pages.run.restart') }}
      </button>
    </div>

    <!-- степпер -->
    <div v-if="stages?.length && !loadError" class="shrink-0 overflow-x-auto border-b border-border px-4 py-2.5">
      <div class="flex items-center gap-1">
        <template v-for="(st, i) in stages" :key="st.key">
          <span class="inline-flex shrink-0 items-center gap-1.5 rounded-full py-1 pl-1 pr-2.5 text-[12px] font-medium" :class="(st.status === 'running' || st.status === 'waiting') ? 'bg-foreground text-background' : st.status === 'done' ? 'text-muted-foreground' : 'text-muted-foreground/40'">
            <span class="grid size-5 shrink-0 place-items-center rounded-full" :class="{ 'bg-success-soft text-success': st.status === 'done', 'bg-warning-soft text-warning': st.status === 'waiting', 'bg-danger-soft text-danger': st.status === 'error', 'bg-background/25 text-current': st.status === 'running', 'border border-border text-muted-foreground/40': st.status === 'pending' }">
              <component :is="stepIcon[st.status]" v-if="stepIcon[st.status]" :size="12" :class="st.status === 'running' ? 'animate-spin' : ''" :stroke-width="st.status === 'done' ? 3 : 2" />
              <span v-else class="font-mono text-[10px]">{{ i + 1 }}</span>
            </span>
            {{ stageLabel(st) }}
          </span>
          <span v-if="i < stages.length - 1" class="h-px w-3 shrink-0 bg-border"></span>
        </template>
      </div>
    </div>

    <!-- тело: документ + инспектор -->
    <div class="flex min-h-0 flex-1">
      <section class="flex min-w-0 flex-1 flex-col overflow-auto">
        <!-- статью не удалось загрузить: отдельный экран, а не скелет «агент
             пишет» — тот обещал текст, которого не будет -->
        <div v-if="loadError" class="mx-auto flex w-full max-w-[520px] flex-col items-center gap-3 px-6 py-24 text-center">
          <TriangleAlert :size="28" class="text-danger" />
          <p class="text-[14px] font-semibold">{{ loadError }}</p>
          <div class="mt-1 flex items-center gap-2">
            <button type="button" class="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] transition hover:bg-surface-2" @click="router.push('/blog')">
              <ArrowLeft :size="14" /> {{ $t('blog.pages.run.backToTopics') }}
            </button>
            <Button size="sm" @click="init"><RotateCcw :size="14" /> {{ $t('action.retry') }}</Button>
          </div>
        </div>

        <!-- интерактивный шаг: источники / структура -->
        <SourcePicker
          v-else-if="status === 'awaiting_sources'"
          :sources="sources" :search-queries="searchQueries" :submitting="submitting" :error="actionError"
          @continue="continueWithSources"
        />
        <OutlineEditor
          v-else-if="status === 'awaiting_outline'"
          :outline="outline" :perspectives="perspectives" :submitting="submitting" :error="actionError"
          @approve="approveOutline"
        />

        <!-- генерация -->
        <div v-else-if="generating" class="mx-auto w-full max-w-[720px] px-6 pb-16 pt-10">
          <div class="mb-7 flex items-center gap-2 text-[13px] text-muted-foreground"><Loader2 :size="15" class="animate-spin" /> {{ $t('blog.pages.run.generatingHint') }}</div>
          <div class="space-y-8">
            <div class="space-y-2.5"><div class="h-3.5 animate-pulse rounded-md bg-surface-hover" style="width:97%"></div><div class="h-3.5 animate-pulse rounded-md bg-surface-hover" style="width:90%"></div><div class="h-3.5 animate-pulse rounded-md bg-surface-hover" style="width:73%"></div></div>
            <div class="h-5 animate-pulse rounded-md bg-surface-hover" style="width:36%"></div>
            <div class="space-y-2.5"><div class="h-3.5 animate-pulse rounded-md bg-surface-hover" style="width:94%"></div><div class="h-3.5 animate-pulse rounded-md bg-surface-hover" style="width:99%"></div><div class="h-3.5 animate-pulse rounded-md bg-surface-hover" style="width:62%"></div></div>
          </div>
        </div>

        <!-- документ -->
        <div v-else class="mx-auto w-full max-w-[720px] px-6 pb-24 pt-8">
          <textarea ref="titleEl" v-model="title" rows="1" :placeholder="topic || $t('blog.pages.run.titlePlaceholder')" class="w-full resize-none overflow-hidden bg-transparent text-[28px] font-bold leading-[1.18] tracking-[-0.5px] outline-none placeholder:text-muted-foreground/30" @input="growTitle"></textarea>

          <!-- обложка живёт здесь, рядом с текстом; действия тихие -->
          <div class="mt-4">
            <div v-if="coverUrl" class="overflow-hidden rounded-xl border border-border"><img :src="coverUrl" :alt="$t('blog.pages.run.cover.alt')" class="aspect-[16/9] w-full object-cover"></div>
            <div v-else class="grid aspect-[16/9] w-full place-items-center rounded-xl border border-dashed border-border text-[12px] text-muted-foreground/50">{{ $t('blog.pages.run.cover.none') }}</div>
            <div class="mt-2 flex flex-wrap items-center gap-3">
              <button type="button" class="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground transition hover:text-foreground" @click="studioOpen = true">
                <ImageIcon :size="13" /> {{ $t('blog.pages.run.cover.studio') }}
              </button>
              <button type="button" class="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground transition hover:text-foreground disabled:opacity-50" :disabled="!!coverBusy" @click="genCoverBg">
                <Loader2 v-if="coverBusy === 'gen'" :size="13" class="animate-spin" /><ImagePlus v-else :size="13" /> {{ $t('blog.pages.run.cover.generateBg') }}
              </button>
              <button v-if="coverUrl" type="button" class="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground transition hover:text-danger disabled:opacity-50" :disabled="!!coverBusy" @click="clearCover">
                <Loader2 v-if="coverBusy === 'clear'" :size="13" class="animate-spin" /><X v-else :size="13" /> {{ $t('blog.pages.run.cover.remove') }}
              </button>
            </div>
            <p v-if="coverError" class="mt-1.5 text-[11.5px] text-warning">{{ coverError }}</p>
          </div>

          <!-- run-id нужен редактору для загрузки медиа: файлы кладутся в ран.
               Берём из роута, а не из let id, — тот не реактивен, и при смене
               локали редактор продолжил бы грузить в прошлую версию статьи -->
          <div class="mt-5"><ArticleEditor v-model="html" :title="title" :run-id="routeRunId" :placeholder="$t('blog.pages.run.editorPlaceholder')" /></div>
          <p class="mt-8 border-t border-border/60 pt-3 text-[12px] text-muted-foreground/60">{{ words(wordCount || 0) }}</p>
        </div>
      </section>

      <!-- инспектор колонкой: только на широком экране -->
      <aside v-if="!panelCollapsed && showInspector" class="hidden w-full shrink-0 flex-col overflow-y-auto border-l border-border sm:w-[380px] xl:flex">
        <ReuseInspector />
      </aside>
    </div>

    <!-- тот же инспектор ящиком: уже xl колонка съедала половину документа -->
    <Sheet v-model:open="inspectorOpen">
      <SheetContent side="right" class="w-[90vw] gap-0 overflow-y-auto p-0 sm:max-w-[380px] xl:hidden">
        <SheetTitle class="sr-only">{{ $t('blog.pages.run.inspector.title') }}</SheetTitle>
        <SheetDescription class="sr-only">{{ $t('blog.pages.run.inspector.hint') }}</SheetDescription>
        <ReuseInspector />
      </SheetContent>
    </Sheet>

    <SocialComposer
      v-model:open="socialOpen"
      :run-id="routeRunId" :can-publish="!!title.trim() && hasBody"
    />

    <!-- Диалог публикации: язык версии, куда уедет, и отчёт по каналам после
         отправки. До него «Опубликовать» в шапке меняла только статус рана. -->
    <Dialog v-model:open="publishOpen">
      <!-- ширину дублируем в sm:: в базовом классе DialogContent стоит
           sm:max-w-lg, и одиночный max-w-[…] tailwind-merge не перебивает -->
      <DialogContent class="max-h-[90dvh] max-w-[560px] overflow-y-auto sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle>{{ publishDone ? $t('blog.pages.run.publishDialog.doneTitle') : $t('blog.pages.run.publishDialog.title') }}</DialogTitle>
          <DialogDescription>{{ publishDone ? $t('blog.pages.run.publishDialog.doneHint') : $t('blog.pages.run.publishDialog.hint') }}</DialogDescription>
        </DialogHeader>

        <!-- «сейчас» и «по расписанию» — одно и то же действие с разным when,
             поэтому вкладки внутри диалога, а не вторая кнопка в шапке -->
        <div v-if="!publishDone" class="flex items-center gap-1 rounded-lg border border-border p-0.5">
          <button
            v-for="tb in (['now', 'schedule'] as const)" :key="tb" type="button"
            class="flex-1 rounded-md px-3 py-1.5 text-[12.5px] outline-none transition focus-visible:ring-1 focus-visible:ring-ring"
            :class="publishTab === tb ? 'bg-surface-hover font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'"
            @click="publishTab = tb"
          >
            {{ tb === 'now' ? $t('blog.pages.run.publishDialog.tabNow') : $t('blog.pages.run.schedule.tab') }}
            <span v-if="tb === 'schedule' && schedulePlanned.length" class="ml-1 font-mono text-[11px] text-muted-foreground">{{ schedulePlanned.length }}</span>
          </button>
        </div>

        <template v-if="!publishDone && publishTab === 'schedule'">
          <p v-if="!scheduleChannels.length" class="text-[12.5px] text-muted-foreground">{{ $t('blog.pages.run.schedule.noChannels') }}</p>

          <div v-else class="space-y-1.5">
            <div
              v-for="c in scheduleChannels" :key="c.key"
              class="flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2"
              :class="scheduleDraft[c.key] ? 'border-border bg-surface' : 'border-border/60'"
            >
              <img v-if="CHANNEL_ICONS[c.key]" :src="CHANNEL_ICONS[c.key]" :alt="c.label" class="size-4 shrink-0 rounded-sm object-contain">
              <span class="min-w-0 flex-1 truncate text-[12.5px]">{{ c.label }}</span>

              <template v-if="scheduleDraft[c.key]">
                <!-- уже ушло: дату не правим, но и не прячем — это история -->
                <template v-if="scheduleDraft[c.key].status === 'done'">
                  <span class="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-success"><Check :size="12" /> {{ $t('blog.pages.run.schedule.sent') }}</span>
                  <span class="shrink-0 font-mono text-[11.5px] tabular-nums text-muted-foreground">{{ scheduleDraft[c.key].date }} {{ scheduleDraft[c.key].time }}</span>
                </template>

                <!-- упало: показываем причину и даём переназначить время -->
                <template v-else-if="scheduleDraft[c.key].status === 'error'">
                  <span class="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-warning"><TriangleAlert :size="12" /> {{ $t('blog.pages.run.schedule.failed') }}</span>
                  <button type="button" class="shrink-0 rounded-md border border-border px-2 py-1 text-[11.5px] transition hover:bg-surface-2" @click="retryScheduleRow(c.key)">{{ $t('blog.pages.run.schedule.retry') }}</button>
                  <p class="w-full text-[11.5px] leading-[1.45] text-danger">{{ scheduleDraft[c.key].error }}</p>
                </template>

                <template v-else>
                  <input type="date" v-model="scheduleDraft[c.key].date" class="h-8 shrink-0 rounded-md border border-border bg-background px-2 text-[12.5px] outline-none focus:border-ring">
                  <input type="time" v-model="scheduleDraft[c.key].time" class="h-8 w-[92px] shrink-0 rounded-md border border-border bg-background px-2 text-[12.5px] outline-none focus:border-ring">
                  <button type="button" class="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-surface-2 hover:text-danger" :title="$t('blog.pages.run.schedule.remove')" @click="removeScheduleRow(c.key)"><X :size="14" /></button>
                </template>
              </template>

              <button v-else type="button" class="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] text-muted-foreground transition hover:bg-surface-2 hover:text-foreground" @click="addScheduleRow(c.key)">
                <Plus :size="12" /> {{ $t('blog.pages.run.schedule.add') }}
              </button>
            </div>
          </div>

          <p class="text-[11.5px] leading-[1.45] text-muted-foreground/70">{{ $t('blog.pages.run.schedule.hint') }}</p>
          <p v-if="scheduleErr" class="text-[12px] text-danger">{{ scheduleErr }}</p>

          <div class="flex flex-wrap items-center justify-end gap-2">
            <button type="button" class="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] transition hover:bg-surface-2" @click="publishOpen = false">{{ $t('action.cancel') }}</button>
            <Button size="sm" :disabled="scheduleBusy || !scheduleChannels.length" @click="saveSchedule">
              <Loader2 v-if="scheduleBusy" :size="14" class="animate-spin" /><CalendarClock v-else :size="14" />
              {{ $t('blog.pages.run.schedule.save') }}
            </Button>
          </div>
        </template>

        <template v-else-if="!publishDone">
          <div>
            <label class="mb-1 block text-[12px] text-muted-foreground">{{ $t('blog.pages.run.blog.localeLabel') }}</label>
            <select v-model="publishLocale" class="h-8 w-full rounded-md border border-border bg-background px-2 text-[13px] outline-none focus:border-ring">
              <option v-for="l in LANGUAGES" :key="l.code" :value="l.code">{{ l.flag }} {{ l.name }}</option>
            </select>
          </div>

          <!-- «Уедет в» — не выбор, а сводка; выбор адресатов живёт в композере -->
          <button
            type="button"
            class="flex w-full items-start gap-2 rounded-lg border border-border px-2.5 py-2 text-left text-[12.5px] transition hover:bg-surface"
            @click="publishOpen = false; socialOpen = true"
          >
            <Share2 :size="14" class="mt-0.5 shrink-0 text-muted-foreground" />
            <span class="min-w-0 flex-1">
              <span class="text-muted-foreground">{{ $t('blog.pages.run.blog.goesTo') }}</span>
              {{ targetsHint || $t('blog.pages.run.publishDialog.noChannels') }}
            </span>
            <ChevronRight :size="14" class="mt-0.5 shrink-0 text-muted-foreground/50" />
          </button>

          <p v-if="publishErr" class="text-[12px] text-danger">{{ publishErr }}</p>

          <div class="flex flex-wrap items-center justify-end gap-2">
            <button type="button" class="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] transition hover:bg-surface-2 disabled:opacity-50" :disabled="!!publishBusy" @click="publishBlog('draft')">
              <Loader2 v-if="publishBusy === 'draft'" :size="14" class="animate-spin" /><Save v-else :size="14" /> {{ $t('blog.pages.run.blog.toDraft') }}
            </button>
            <Button size="sm" class="border border-border bg-white text-[#111418] hover:bg-white/90 dark:border-0" :disabled="!!publishBusy || !canPublishBlog" @click="publishBlog('published')">
              <Loader2 v-if="publishBusy === 'publish'" :size="14" class="animate-spin" /><Send v-else :size="14" />
              {{ blog.status === 'published' ? $t('blog.pages.run.blog.update') : $t('blog.pages.run.blog.publish') }}
            </Button>
          </div>
        </template>

        <!-- отчёт: куда именно уехало и что не доехало -->
        <template v-else>
          <div v-if="targets.length" class="space-y-1.5">
            <div v-for="tg in targets" :key="tg.key" class="flex items-start gap-2 text-[12.5px]">
              <component
                :is="tg.state === 'error' || tg.state === 'unconfigured' ? TriangleAlert : tg.state === 'manual' ? Hand : Check"
                :size="13"
                class="mt-[3px] shrink-0"
                :class="tg.state === 'error' || tg.state === 'unconfigured' ? 'text-danger' : tg.state === 'manual' ? 'text-warning' : 'text-success'"
              />
              <div class="min-w-0 flex-1">
                <span>{{ tg.labelKey ? $t('blog.pages.run.blog.targets.' + tg.labelKey) : tg.label }}</span>
                <span v-if="tg.updated" class="ml-1 text-[11.5px] text-muted-foreground/60">{{ $t('blog.pages.run.blog.targets.updated') }}</span>
                <span v-else-if="tg.state === 'skipped'" class="ml-1 text-[11.5px] text-muted-foreground/60">{{ $t('blog.pages.run.blog.targets.skipped') }}</span>
                <span v-else-if="tg.state === 'manual'" class="ml-1 text-[11.5px] text-muted-foreground/60">{{ $t('blog.pages.run.blog.targets.manual') }}</span>
                <p v-if="tg.error" class="text-[11.5px] leading-[1.45] text-danger">{{ tg.error }}</p>
              </div>
              <a v-if="tg.url" :href="tg.url" target="_blank" rel="noopener" class="mt-px shrink-0 text-brand-accent hover:text-foreground" :title="$t('blog.pages.run.blog.targets.open')"><ExternalLink :size="13" /></a>
            </div>
          </div>
          <p v-else class="text-[12.5px] text-muted-foreground">{{ $t('blog.pages.run.publishDialog.noReport') }}</p>

          <div class="flex flex-wrap items-center justify-end gap-2">
            <a v-if="blogShareUrl" :href="blogShareUrl" target="_blank" rel="noopener" class="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12.5px] transition hover:bg-surface-2">
              <ExternalLink :size="14" /> {{ $t('blog.pages.run.publishDialog.openArticle') }}
            </a>
            <Button size="sm" @click="publishOpen = false">{{ $t('action.done') }}</Button>
          </div>
        </template>
      </DialogContent>
    </Dialog>

    <!-- снятие с публикации: перечисляем, чего это коснётся -->
    <AlertDialog v-model:open="unpublishOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ $t('blog.pages.run.unpublishDialog.title') }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{ liveChannels ? $t('blog.pages.run.unpublishDialog.body', { list: liveChannels }) : $t('blog.pages.run.unpublishDialog.bodyPlain') }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ $t('action.cancel') }}</AlertDialogCancel>
          <AlertDialogAction
            class="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            :disabled="!!publishBusy" @click="unpublishBlog"
          >
            <Loader2 v-if="publishBusy === 'remove'" :size="14" class="animate-spin" />
            {{ $t('blog.pages.run.blog.unpublish') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- удаление статьи -->
    <AlertDialog v-model:open="deleteOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ $t('blog.pages.run.delete.title') }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{ $t('blog.pages.run.delete.body', { n: Math.max(localeItems.length, 1) }) }}
            <template v-if="isLive"> {{ $t('blog.pages.run.delete.published') }}</template>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ $t('action.cancel') }}</AlertDialogCancel>
          <AlertDialogAction class="bg-destructive text-destructive-foreground hover:bg-destructive/90" :disabled="deleting" @click="removeRun">
            <Loader2 v-if="deleting" :size="14" class="animate-spin" /> {{ $t('action.delete') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- превью -->
    <Teleport to="body">
      <div v-if="previewOpen" class="fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-sm" @click.self="previewOpen = false">
        <div class="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
          <span class="text-[13px] text-white/70">{{ $t('blog.pages.run.previewTitle') }}</span>
          <button type="button" class="grid size-8 place-items-center rounded-lg text-white/70 transition hover:bg-surface-hover" @click="previewOpen = false"><X :size="18" /></button>
        </div>
        <div class="flex-1 overflow-auto">
          <article class="mx-auto my-8 max-w-[720px] rounded-2xl bg-white px-8 py-10 text-zinc-900 shadow-2xl sm:px-12">
            <h1 class="text-[32px] font-bold leading-[1.15] tracking-[-0.02em]">{{ title || topic }}</h1>
            <div class="mt-3 flex items-center gap-3 text-[13px] text-zinc-500">
              <span>{{ author || authorPlaceholder }}</span>
              <span v-if="category" class="rounded-full bg-zinc-100 px-2 py-0.5">{{ category }}</span>
            </div>
            <img v-if="coverUrl" :src="coverUrl" :alt="$t('blog.pages.run.cover.alt')" class="mt-6 aspect-[16/9] w-full rounded-xl object-cover">
            <div class="preview-body mt-6" v-html="html"></div>
          </article>
        </div>
      </div>
    </Teleport>

    <!-- студия обложек прямо в статье -->
    <Dialog v-model:open="studioOpen">
      <DialogContent class="max-h-[92dvh] w-[96vw] max-w-[96vw] overflow-y-auto sm:max-w-[1180px]">
        <DialogHeader><DialogTitle>{{ $t('blog.pages.run.cover.dialogTitle') }}</DialogTitle></DialogHeader>
        <CoverStudio embedded :run-id="routeRunId" :title="title || topic" @saved="onCoverSaved" />
      </DialogContent>
    </Dialog>
  </div>
</template>

<style scoped>
.preview-body :deep(*) + * { margin-top: 1em; }
.preview-body :deep(h2) { font-size: 22px; font-weight: 700; margin-top: 1.6em; line-height: 1.3; }
.preview-body :deep(h3) { font-size: 18px; font-weight: 600; margin-top: 1.3em; }
.preview-body :deep(p) { font-size: 16.5px; line-height: 1.75; }
.preview-body :deep(ul) { list-style: disc; padding-left: 1.4em; }
.preview-body :deep(ol) { list-style: decimal; padding-left: 1.4em; }
.preview-body :deep(li) { margin-top: .4em; }
.preview-body :deep(a) { color: #2563eb; text-decoration: underline; }
.preview-body :deep(blockquote) { border-left: 3px solid #e4e4e7; padding-left: 1em; color: #52525b; font-style: italic; }

/* Медиа: геометрия и вид приходят из media.css (общий файл с редактором),
   тут только правки под белую «бумагу» превью — правило `* + *` выше иначе
   съедает отбивку блока, а ссылки внутри карточек красит в синий. */
.preview-body :deep(.bw-media) { margin-top: 1.7em; margin-bottom: 1.7em; }
.preview-body :deep(.bw-media a) { color: inherit; text-decoration: none; }
.preview-body :deep(.bw-media > figcaption) { font-size: 13.5px; color: #71717a; opacity: 1; }
/* «на всю ширину» внутри модалки ограничиваем шириной листа: 100vw вылезал бы
   за карточку превью и давал горизонтальный скролл */
.preview-body :deep(.bw-media[data-align="full"]),
.preview-body :deep(.bw-media[data-align="wide"]) {
  --bw-w: min(100vw - 64px, 100% + 96px);
}
</style>
