<script setup lang="ts">
// Контент-план: календарь публикаций бренда. Агент генерит план на месяц
// (темы — LLM, даты — по частоте в неделю), слот можно добавить/удалить и
// запустить в статью одним кликом (слот привязывается к рану и показывает статус).
// Данные: plan.controller /plan/*.
//
// В тех же клетках живёт ВТОРОЙ слой — расписание автопостинга (soc-сети и
// каналы статьи идут комплектом к статье). Раньше запланированные отправки не
// было видно нигде, кроме диалога публикации конкретной статьи: календарь
// показывал «когда напишем», но не «когда и куда это уедет». Слоты тем и чипы
// автопостинга специально выглядят по-разному — чип компактнее и с логотипом
// канала.
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  CalendarDays, ChevronLeft, ChevronRight, Eye, ExternalLink, Hash, Loader2, PenLine, Plus,
  RefreshCw, SquarePen, Trash2, TriangleAlert, X,
} from 'lucide-vue-next'
import { CHANNEL_ICONS, channelLabel } from '@/data/channelIcons'
import type { PlanScheduleEntry } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import BlogPageHeader from '@/components/blog/BlogPageHeader.vue'
import IdeataLoader from '@/components/IdeataLoader.vue'
import { api } from '@/lib/api'
import { useBlogPlan } from '@/composables/useBlogPlan'
import { intlLocale } from '@/i18n'

const router = useRouter()
const { t } = useI18n()

const now = new Date()
const viewY = ref(now.getFullYear())
const viewM = ref(now.getMonth())
// значение шага — строкой: reka-ui Select работает со строками
const perWeek = ref('3')
const generating = ref<'' | 'append' | 'rebuild'>('')
const error = ref('')
const addingDate = ref('')
const addTitle = ref('')
const busyItem = ref('')

/** 402 = не входит в тариф; сообщение бэка приходит готовым и не переводится */
const planError = (e: any, fallback: string) =>
  (e?.status === 402 ? t('blog.pages.plan.errors.tariff') : (e?.serverMessage || fallback))

const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`
// Месяцы и дни недели — из Intl по языку интерфейса: свой список пришлось бы
// вести на каждый язык, а Intl уже знает и падежи, и сокращения.
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const MONTHS = computed(() => {
  const f = new Intl.DateTimeFormat(intlLocale(), { month: 'long' })
  return Array.from({ length: 12 }, (_, m) => cap(f.format(new Date(2021, m, 1))))
})
// неделя начинается с понедельника (1 марта 2021 — понедельник)
const WEEK = computed(() => {
  const f = new Intl.DateTimeFormat(intlLocale(), { weekday: 'short' })
  return Array.from({ length: 7 }, (_, i) => cap(f.format(new Date(2021, 2, 1 + i))))
})
const monthLabel = computed(() => `${MONTHS.value[viewM.value]} ${viewY.value}`)
const todayStr = ymd(now.getFullYear(), now.getMonth(), now.getDate())
const monthFrom = computed(() => ymd(viewY.value, viewM.value, 1))
const monthTo = computed(() => ymd(viewY.value, viewM.value, new Date(viewY.value, viewM.value + 1, 0).getDate()))

// кэш-синглтон по месяцам: возврат/переключение назад — мгновенно, без лоадера
const plan = useBlogPlan()
const monthKey = computed(() => `${viewY.value}-${pad(viewM.value + 1)}`)
const items = computed<any[]>({
  get: () => plan.itemsOf(monthKey.value),
  set: (v) => plan.setItems(monthKey.value, v),
})
const schedule = computed<PlanScheduleEntry[]>({
  get: () => plan.scheduleOf(monthKey.value),
  set: (v) => plan.setSchedule(monthKey.value, v),
})
const loading = computed(() => plan.state.loading)
// лоадер только когда для месяца ещё нет данных в кэше
const showLoader = computed(() => loading.value && !plan.hasCache(monthKey.value))
// запрос месяца упал и показывать нечего — плашка «Повторить», а не «План пуст»
const loadFailed = computed(() => !loading.value && plan.hasFailed(monthKey.value) && !plan.hasCache(monthKey.value))

const cells = computed(() => {
  const startDow = (new Date(viewY.value, viewM.value, 1).getDay() + 6) % 7 // Пн=0
  const days = new Date(viewY.value, viewM.value + 1, 0).getDate()
  const arr: (string | null)[] = []
  for (let i = 0; i < startDow; i++) arr.push(null)
  for (let d = 1; d <= days; d++) arr.push(ymd(viewY.value, viewM.value, d))
  while (arr.length % 7 !== 0) arr.push(null)
  return arr
})
const byDate = computed(() => {
  const m = new Map<string, any[]>()
  for (const it of items.value) {
    const arr = m.get(it.date)
    if (arr) arr.push(it)
    else m.set(it.date, [it])
  }
  return m
})

// --- слой автопостинга -------------------------------------------------------
/**
 * `at` приходит в UTC, а календарь у пользователя локальный: раскладываем чипы
 * по ЛОКАЛЬНОЙ дате, иначе вечерняя отправка в Москве падала бы на предыдущий
 * день у любого, кто западнее.
 */
const localDate = (at: string) => {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : ymd(d.getFullYear(), d.getMonth(), d.getDate())
}
const localTime = (at: string) => {
  const d = new Date(at)
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** та же локальная time, но другая дата — перенос чипа мышью */
function atOnDate(at: string, date: string) {
  const src = new Date(at)
  const [y, m, d] = date.split('-').map(Number)
  return new Date(y, m - 1, d, src.getHours(), src.getMinutes(), 0, 0).toISOString()
}
const schedByDate = computed(() => {
  const m = new Map<string, PlanScheduleEntry[]>()
  for (const e of schedule.value) {
    const k = localDate(e.at)
    if (!k) continue
    const arr = m.get(k)
    if (arr) arr.push(e)
    else m.set(k, [e])
  }
  // внутри дня — по времени: иначе порядок чипов задаёт бэк, и он произвольный
  for (const arr of m.values()) arr.sort((a, b) => a.at.localeCompare(b.at))
  return m
})
const entryTitle = (e: PlanScheduleEntry) =>
  `${localTime(e.at)} · ${channelLabel(e.channel)} · ${e.runTitle || ''}`

// Narrow screens can't fit a 7-column month, so mobile shows ONE week at a time —
// all 7 days, one per row (each addable) — with its own week nav that rolls over
// to the previous/next month at the edges. Reuses the month's cells/data (no
// extra fetch); padding days from adjacent months are simply not rendered.
const weekCount = computed(() => Math.max(1, Math.round(cells.value.length / 7)))
const weekIdx = ref(0)
// index of the week that holds "today" in the current month (0 if today is elsewhere)
function weekOfToday(): number {
  const i = cells.value.indexOf(todayStr)
  return i >= 0 ? Math.floor(i / 7) : 0
}
const weekDays = computed(() => {
  const idx = Math.min(Math.max(weekIdx.value, 0), weekCount.value - 1)
  return cells.value.slice(idx * 7, idx * 7 + 7).filter((d): d is string => !!d)
})
function fmtDayShort(iso: string): string {
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short' })
  } catch { return iso }
}
const weekLabel = computed(() => {
  const days = weekDays.value
  if (!days.length) return ''
  const first = days[0]!, last = days[days.length - 1]!
  return first === last ? fmtDayShort(first) : `${fmtDayShort(first)} – ${fmtDayShort(last)}`
})
function fmtAgenda(iso: string): string {
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString(intlLocale(), { weekday: 'short', day: 'numeric', month: 'short' })
  } catch { return iso }
}
function prevWeek() {
  if (weekIdx.value > 0) { weekIdx.value--; return }
  shiftMonth(-1)                        // shiftMonth resets weekIdx; override to land on the LAST week
  weekIdx.value = weekCount.value - 1
}
function nextWeek() {
  if (weekIdx.value < weekCount.value - 1) { weekIdx.value++; return }
  shiftMonth(1)
  weekIdx.value = 0
}

function shiftMonth(delta: number) {
  const d = new Date(viewY.value, viewM.value + delta, 1)
  viewY.value = d.getFullYear(); viewM.value = d.getMonth()
  weekIdx.value = weekOfToday() // land on today's week if it's in this month, else the first
}
/**
 * Перенос слота мышью.
 *
 * В старом кабинете это работало, в новый страницу переписали и жест
 * потеряли — ручка PATCH /blogwriter/plan/items/:id при этом никуда не
 * девалась.
 *
 * Перенос оптимистичный: дата меняется сразу, при ошибке откатывается. Ждать
 * ответ сервера, держа карточку под курсором, — это заметная пауза на каждом
 * перетаскивании ради случая, который почти не наступает.
 *
 * Слот с УЖЕ СГЕНЕРИРОВАННЫМ постом не таскаем: у публикации своя дата, и
 * молча разъехаться с ней хуже, чем запретить жест (так же было в старом
 * кабинете).
 *
 * Тем же жестом двигаются чипы автопостинга — но только те, что ещё не ушли:
 * отправленное (done) сдвигать некуда, а упавшее (error) сначала надо перевести
 * в «запланировано» в диалоге статьи, иначе перенос выглядел бы как повтор,
 * которого не произойдёт.
 */
const dragId = ref('')
/** что именно тащим: слот темы или чип расписания (id у них из разных таблиц) */
const dragKind = ref<'' | 'slot' | 'entry'>('')
const dragOver = ref('')

const canDrag = (it: any) => !it.run
const canDragEntry = (e: PlanScheduleEntry) => e.status === 'planned'

function onDragStart(it: any, e: DragEvent) {
  if (!canDrag(it)) { e.preventDefault(); return }
  dragId.value = it.id
  dragKind.value = 'slot'
  // без setData Firefox не начинает перетаскивание вовсе
  e.dataTransfer?.setData('text/plain', it.id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onEntryDragStart(entry: PlanScheduleEntry, e: DragEvent) {
  if (!canDragEntry(entry)) { e.preventDefault(); return }
  dragId.value = entry.entryId
  dragKind.value = 'entry'
  e.dataTransfer?.setData('text/plain', entry.entryId)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragEnd() { dragId.value = ''; dragKind.value = ''; dragOver.value = '' }

async function onDrop(date: string) {
  const id = dragId.value
  const kind = dragKind.value
  dragId.value = ''
  dragKind.value = ''
  dragOver.value = ''
  if (!id || !date) return
  if (kind === 'entry') return moveEntry(id, date)

  const it = items.value.find((x: any) => x.id === id)
  if (!it || it.date === date) return

  const prev = it.date
  const next = items.value.map((x: any) => (x.id === id ? { ...x, date } : x))
  items.value = next
  try {
    const r: any = await api.blogPlanUpdate(id, { date })
    if (r?.item) {
      const idx = items.value.findIndex((x: any) => x.id === id)
      if (idx >= 0) items.value[idx] = r.item
    }
  } catch (e: any) {
    items.value = items.value.map((x: any) => (x.id === id ? { ...x, date: prev } : x))
    error.value = e?.serverMessage || t('blog.pages.plan.errors.move')
  }
}

/** перенос отправки: точечный PATCH записи, весь список плана не трогаем */
async function moveEntry(entryId: string, date: string) {
  const entry = schedule.value.find((x) => x.entryId === entryId)
  if (!entry || localDate(entry.at) === date) return
  const prev = entry.at
  const at = atOnDate(entry.at, date)
  schedule.value = schedule.value.map((x) => (x.entryId === entryId ? { ...x, at } : x))
  try {
    const r = await api.blogMoveScheduleEntry(entry.runId, entryId, at)
    if (r?.entry?.at) {
      schedule.value = schedule.value.map((x) => (x.entryId === entryId ? { ...x, ...r.entry, at: r.entry.at } : x))
    }
  } catch (e: any) {
    schedule.value = schedule.value.map((x) => (x.entryId === entryId ? { ...x, at: prev } : x))
    error.value = e?.serverMessage || t('blog.pages.plan.errors.moveSchedule')
  }
}

function goToday() { viewY.value = now.getFullYear(); viewM.value = now.getMonth(); weekIdx.value = weekOfToday() }

function load() { return plan.load(monthKey.value, monthFrom.value, monthTo.value) }
onMounted(() => { weekIdx.value = weekOfToday(); load() })
watch([viewY, viewM], load)

/**
 * Генерация плана в двух режимах.
 *
 * append:true («Дополнить») — бэк добавляет темы к тому, что уже есть: это
 * дефолт, потому что раньше единственная кнопка шла с append:false и молча
 * стирала все руками заведённые слоты месяца.
 * append:false («Пересобрать») — за подтверждением с числом слотов, которые
 * при этом пропадут (все, что ещё не превратились в статью).
 */
const wipeCount = computed(() => items.value.filter((x: any) => !x.runId).length)
const rebuildOpen = ref(false)

async function generate(append: boolean) {
  if (generating.value) return
  generating.value = append ? 'append' : 'rebuild'
  error.value = ''
  try {
    await api.blogPlanGenerate({ from: monthFrom.value, to: monthTo.value, perWeek: Number(perWeek.value), append })
    rebuildOpen.value = false
    await load()
  } catch (e: any) {
    error.value = planError(e, t('blog.pages.plan.errors.failed'))
  } finally {
    generating.value = ''
  }
}

function startAdd(date: string) { addingDate.value = date; addTitle.value = ''; error.value = '' }
async function confirmAdd() {
  const title = addTitle.value.trim()
  const date = addingDate.value
  addingDate.value = ''
  if (!title || !date) return
  try {
    const it = await api.blogPlanCreate({ date, title })
    if (it?.id) items.value = [...items.value, it]
    else await load()
  } catch (e: any) {
    // тема не создалась — возвращаем её в инпут, чтобы не набирать заново
    addingDate.value = date
    addTitle.value = title
    error.value = planError(e, t('blog.pages.plan.errors.add'))
  }
}

// удаление слота: оптимистично, при ошибке возвращаем список как был
async function removeItem(it: any) {
  const prev = items.value
  error.value = ''
  items.value = items.value.filter((x) => x.id !== it.id)
  try {
    await api.blogPlanRemove(it.id)
  } catch (e: any) {
    items.value = prev
    error.value = planError(e, t('blog.pages.plan.errors.remove'))
  }
}

/** слот, для которого спрашиваем подтверждение удаления (null = закрыто) */
const toDelete = ref<any>(null)
// цель держим и вне ref: AlertDialogAction закрывает диалог своим обработчиком
// раньше нашего, и toDelete к этому моменту уже пуст
let pendingRemove: any = null
function askRemove(it: any) { pendingRemove = it; toDelete.value = it }
async function confirmRemove() {
  const it = pendingRemove
  pendingRemove = null
  toDelete.value = null
  if (it) await removeItem(it)
}

// запустить слот в статью и уйти в редактор
async function writeItem(it: any) {
  if (busyItem.value) return
  busyItem.value = it.id
  error.value = ''
  try {
    const { runId } = await api.blogPlanWrite(it.id, 'auto')
    if (runId) router.push(`/blog/run/${runId}`)
    else error.value = t('blog.pages.plan.errors.write')
  } catch (e: any) {
    error.value = planError(e, t('blog.pages.plan.errors.write'))
  } finally {
    busyItem.value = ''
  }
}

// --- боковая панель-детали слота ---------------------------------------------
const sel = ref<any>(null) // выбранный слот (null = закрыто)
const editTitle = ref('')
const editDate = ref('')
const editTime = ref('')
const INTENT_LABELS = computed<Record<string, string>>(() => ({
  informational: t('blog.pages.ideas.intent.informational'),
  commercial: t('blog.pages.ideas.intent.commercial'),
  transactional: t('blog.pages.ideas.intent.transactional'),
  navigational: t('blog.pages.ideas.intent.navigational'),
}))
function openSlot(it: any) {
  sel.value = it
  editTitle.value = it.title || ''
  editDate.value = it.date || ''
  editTime.value = it.time || ''
}
function slotStatus(it: any) {
  if (it?.run?.blogStatus === 'published') return { label: t('blog.pages.plan.slot.status.published'), cls: 'bg-violet-500/15 text-violet-700 dark:text-violet-300' }
  if (it?.runId) return { label: t('blog.pages.plan.slot.status.draft'), cls: 'bg-surface-hover text-muted-foreground' }
  if (it?.status === 'skipped') return { label: t('blog.pages.plan.slot.status.skipped'), cls: 'bg-surface-hover text-muted-foreground' }
  return { label: t('blog.pages.plan.slot.status.planned'), cls: 'bg-warning-soft text-warning' }
}

/** дата слота в шапке панели — форматом языка интерфейса (в input остаётся ISO) */
function slotDate(iso: string) {
  try {
    return new Date(`${iso}T00:00:00`).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'long', year: 'numeric' })
  } catch { return iso }
}
// сохранить изменённые поля слота (тема / дата / время)
async function saveSlot() {
  const it = sel.value
  if (!it) return
  const body: Record<string, unknown> = {}
  const title = editTitle.value.trim()
  if (title && title !== it.title) body.title = title
  if (editDate.value && editDate.value !== it.date) body.date = editDate.value
  if (editTime.value !== (it.time || '')) body.time = editTime.value
  if (!Object.keys(body).length) return
  error.value = ''
  try {
    const r = await api.blogPlanUpdate(it.id, body)
    if (r?.item) {
      const idx = items.value.findIndex((x) => x.id === it.id)
      if (idx >= 0) items.value[idx] = r.item
      sel.value = r.item
    }
  } catch (e: any) {
    // правка не сохранилась — откатываем поля панели к тому, что реально в слоте
    editTitle.value = it.title || ''
    editDate.value = it.date || ''
    editTime.value = it.time || ''
    error.value = planError(e, t('blog.pages.plan.errors.save'))
  }
}
function removeSlot() {
  const it = sel.value
  if (!it) return
  sel.value = null
  askRemove(it)
}

// цвет точки статуса слота
function dotCls(it: any) {
  const st = it.run?.status || it.status
  if (it.run?.blogStatus === 'published') return 'bg-violet-400'
  if (/run|queu|progress|generat|pending/i.test(st)) return 'bg-info'
  if (/error|fail/i.test(st)) return 'bg-danger'
  if (/done|ready|complete/i.test(st)) return 'bg-success'
  return 'bg-muted-foreground/40'
}
</script>

<template>
  <div class="space-y-4 p-5 lg:p-6">
    <BlogPageHeader :title="$t('blog.pages.plan.title')" :subtitle="$t('blog.pages.plan.subtitle')">
      <template #actions>
        <Select v-model="perWeek">
          <SelectTrigger class="h-9 w-[120px] border-border bg-surface text-[12.5px]">
            <!-- явный контент SelectValue: у reka-ui плейсхолдер иначе не подставляется -->
            <SelectValue>{{ $t('blog.pages.plan.perWeek', { n: perWeek }) }}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem v-for="n in 7" :key="n" :value="String(n)">{{ $t('blog.pages.plan.perWeek', { n }) }}</SelectItem>
          </SelectContent>
        </Select>
        <Button :disabled="!!generating" @click="generate(true)">
          <Loader2 v-if="generating === 'append'" :size="14" class="animate-spin" />
          {{ $t('blog.pages.plan.append') }}
        </Button>
        <Button
          variant="outline" class="border-border bg-surface" :disabled="!!generating"
          :title="$t('blog.pages.plan.rebuildHint')" @click="rebuildOpen = true"
        >
          <Loader2 v-if="generating === 'rebuild'" :size="14" class="animate-spin" /><RefreshCw v-else :size="14" />
          {{ $t('blog.pages.plan.rebuild') }}
        </Button>
      </template>
    </BlogPageHeader>

    <!-- навигация по месяцам -->
    <div class="hidden flex-wrap items-center gap-1 md:flex">
      <button type="button" class="grid size-8 place-items-center rounded-lg border border-border text-muted-foreground transition hover:text-foreground" :aria-label="$t('blog.pages.plan.prevMonth')" @click="shiftMonth(-1)"><ChevronLeft :size="16" /></button>
      <span class="w-[130px] text-center text-[13.5px] font-medium">{{ monthLabel }}</span>
      <button type="button" class="grid size-8 place-items-center rounded-lg border border-border text-muted-foreground transition hover:text-foreground" :aria-label="$t('blog.pages.plan.nextMonth')" @click="shiftMonth(1)"><ChevronRight :size="16" /></button>
      <button type="button" class="ml-1 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground transition hover:text-foreground" @click="goToday">{{ $t('blog.pages.plan.today') }}</button>

      <!-- легенда: в клетке теперь два разных объекта, и без подписи чип
           автопостинга читался как второй, почему-то бледный слот темы -->
      <div class="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground/70">
        <span class="inline-flex items-center gap-1.5">
          <span class="inline-block h-3 w-4 shrink-0 rounded-md border border-border bg-surface-2"></span>
          {{ $t('blog.pages.plan.legend.slot') }}
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="inline-block h-3 w-4 shrink-0 rounded-md bg-surface-hover"></span>
          {{ $t('blog.pages.plan.legend.autopost') }}
        </span>
        <span class="inline-flex items-center gap-1.5">
          <span class="size-1.5 shrink-0 rounded-full bg-success"></span>
          {{ $t('blog.pages.plan.legend.done') }}
        </span>
        <span class="inline-flex items-center gap-1.5">
          <TriangleAlert :size="10" class="shrink-0 text-warning" />
          {{ $t('blog.pages.plan.legend.error') }}
        </span>
      </div>
    </div>

    <p v-if="error" class="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{{ error }}</p>

    <!-- первая загрузка плана -->
    <div v-if="showLoader" class="relative min-h-[60vh]"><IdeataLoader variant="solid" /></div>

    <!-- запрос месяца упал: показывать «План пуст» тут нельзя -->
    <div v-else-if="loadFailed" class="flex flex-col items-center gap-3 py-16 text-center">
      <TriangleAlert :size="26" class="text-danger/70" />
      <p class="text-[13px] text-muted-foreground">{{ $t('blog.pages.plan.loadFailed') }}</p>
      <Button variant="outline" size="sm" class="border-border bg-surface" @click="load()">{{ $t('action.retry') }}</Button>
    </div>

    <!-- сетка календаря — резиновая, как в маковском «Календаре»: грид на всю
         ширину занимает остаток высоты экрана, ряды делят её поровну
         (repeat(rows, 1fr)), содержимое клетки клиппится/скроллится внутри.
         Никаких квадратов и формул ширины — месяц всегда влезает целиком. -->
    <template v-else>
    <!-- wide screens: rubber month grid -->
    <div class="hidden w-full flex-col overflow-hidden rounded-xl border border-border md:flex" style="height: calc(100dvh - 15.5rem)">
      <div class="grid shrink-0 grid-cols-7 border-b border-border bg-surface">
        <div v-for="w in WEEK" :key="w" class="px-2 py-2 text-center text-[11px] font-medium text-muted-foreground">{{ w }}</div>
      </div>
      <div class="grid min-h-0 flex-1 grid-cols-7" :style="{ gridTemplateRows: `repeat(${cells.length / 7}, minmax(0, 1fr))` }">
        <div
          v-for="(date, i) in cells" :key="i"
          class="group relative flex min-h-0 flex-col overflow-hidden border-b border-r border-border/60 p-1.5 transition-colors"
          :class="[!date && 'bg-surface', i % 7 === 6 && 'border-r-0', dragOver === date && date && 'bg-surface-hover ring-1 ring-inset ring-ring']"
          @dragover.prevent="date && (dragOver = date)"
          @dragleave="dragOver === date && (dragOver = '')"
          @drop.prevent="date && onDrop(date)"
        >
          <template v-if="date">
            <div class="mb-1 flex shrink-0 items-center justify-between px-0.5">
              <span class="text-[11.5px] tabular-nums" :class="date === todayStr ? 'grid size-5 place-items-center rounded-full bg-foreground font-semibold text-background' : 'text-muted-foreground/70'">{{ Number(date.slice(-2)) }}</span>
              <!-- «+» виден всегда (на тач-экране и с клавиатуры hover не наступает) -->
              <button type="button" class="grid size-5 place-items-center rounded text-muted-foreground/50 opacity-40 transition hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100" :title="$t('blog.pages.plan.addTopic')" @click="startAdd(date)"><Plus :size="13" /></button>
            </div>

            <!-- инлайн-добавление -->
            <div v-if="addingDate === date" class="mb-1 shrink-0">
              <input v-model="addTitle" autofocus :placeholder="$t('blog.pages.plan.topicPlaceholder')" class="w-full rounded border border-border bg-background px-1.5 py-1 text-[11.5px] outline-none focus:border-ring" @keydown.enter="confirmAdd" @keydown.esc="addingDate = ''" @blur="confirmAdd">
            </div>

            <div class="min-h-0 flex-1 space-y-1 overflow-y-auto">
              <!-- слоты тем -->
              <div
                v-for="it in (byDate.get(date) || [])" :key="it.id"
                class="group/it relative rounded-md border border-border bg-surface-2 px-1.5 py-1 transition hover:bg-surface-hover"
                :class="[canDrag(it) ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer', dragId === it.id && 'opacity-40']"
                :draggable="canDrag(it)"
                :title="canDrag(it) ? it.title : $t('blog.pages.plan.lockedHint', { title: it.title })"
                @dragstart="onDragStart(it, $event)"
                @dragend="onDragEnd"
                @click="openSlot(it)"
              >
                <div class="flex items-center gap-1.5">
                  <span class="size-1.5 shrink-0 rounded-full" :class="dotCls(it)"></span>
                  <span class="min-w-0 flex-1 truncate text-[11.5px] leading-tight">{{ it.run?.title || it.title }}</span>
                  <Loader2 v-if="busyItem === it.id" :size="11" class="shrink-0 animate-spin text-muted-foreground" />
                  <Eye v-else :size="11" class="shrink-0 text-muted-foreground/50 opacity-0 group-hover/it:opacity-100" />
                </div>
                <button type="button" class="absolute -right-1 -top-1 grid size-4 place-items-center rounded-full border border-border bg-background text-muted-foreground opacity-0 transition hover:text-danger focus-visible:opacity-100 group-hover/it:opacity-100" :title="$t('action.delete')" @click.stop="askRemove(it)"><X :size="10" /></button>
              </div>

              <!-- чипы автопостинга: без рамки и в одну строку — чтобы «когда
                   уедет» не путалось со слотом «когда пишем» -->
              <div
                v-for="e in (schedByDate.get(date) || [])" :key="e.entryId"
                class="flex items-center gap-1 rounded bg-surface-hover/60 px-1 py-0.5 transition hover:bg-surface-hover"
                :class="[canDragEntry(e) ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer', dragId === e.entryId && 'opacity-40']"
                :draggable="canDragEntry(e)"
                :title="e.status === 'error' ? `${entryTitle(e)} — ${e.error || ''}` : entryTitle(e)"
                @dragstart="onEntryDragStart(e, $event)"
                @dragend="onDragEnd"
                @click="router.push(`/blog/run/${e.runId}`)"
              >
                <img v-if="CHANNEL_ICONS[e.channel]" :src="CHANNEL_ICONS[e.channel]" :alt="channelLabel(e.channel)" class="size-3 shrink-0 rounded-md object-contain">
                <span v-else class="size-3 shrink-0 rounded-md bg-muted-foreground/20"></span>
                <span class="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">{{ localTime(e.at) }}</span>
                <span class="min-w-0 flex-1 truncate text-[10.5px] leading-tight text-muted-foreground">{{ e.runTitle }}</span>
                <span v-if="e.status === 'done'" class="size-1.5 shrink-0 rounded-full bg-success" :title="$t('blog.pages.plan.schedule.done')"></span>
                <TriangleAlert v-else-if="e.status === 'error'" :size="10" class="shrink-0 text-danger" :title="e.error || $t('blog.pages.plan.schedule.error')" />
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- narrow screens: one week at a time, one day per row (every day addable) -->
    <div class="flex flex-col gap-2 md:hidden">
      <!-- week navigation (rolls into the prev/next month at the edges) -->
      <div class="flex items-center gap-1 rounded-xl border border-border bg-surface px-2 py-1.5">
        <button type="button" class="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:text-foreground" :aria-label="$t('blog.pages.plan.prevMonth')" @click="prevWeek"><ChevronLeft :size="16" /></button>
        <span class="flex-1 text-center text-[13px] font-medium capitalize">{{ weekLabel }}</span>
        <button type="button" class="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:text-foreground" :aria-label="$t('blog.pages.plan.nextMonth')" @click="nextWeek"><ChevronRight :size="16" /></button>
        <button type="button" class="rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-muted-foreground transition hover:text-foreground" @click="goToday">{{ $t('blog.pages.plan.today') }}</button>
      </div>

      <!-- day rows -->
      <div v-for="date in weekDays" :key="date" class="rounded-xl border border-border bg-surface p-3">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[13px] font-medium capitalize" :class="date === todayStr ? 'text-brand-accent' : 'text-foreground'">{{ fmtAgenda(date) }}</span>
          <button type="button" class="grid size-6 place-items-center rounded-md text-muted-foreground transition hover:text-foreground" :title="$t('blog.pages.plan.addTopic')" @click="startAdd(date)"><Plus :size="14" /></button>
        </div>

        <div v-if="addingDate === date" class="mt-2">
          <input v-model="addTitle" autofocus :placeholder="$t('blog.pages.plan.topicPlaceholder')" class="w-full rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12.5px] outline-none focus:border-ring" @keydown.enter="confirmAdd" @keydown.esc="addingDate = ''" @blur="confirmAdd">
        </div>

        <div v-if="(byDate.get(date) || []).length || (schedByDate.get(date) || []).length" class="mt-2 space-y-1.5">
          <!-- topic slots -->
          <div
            v-for="it in (byDate.get(date) || [])" :key="it.id"
            class="group/it flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-2.5 py-2 transition hover:bg-surface-hover"
            @click="openSlot(it)"
          >
            <span class="size-1.5 shrink-0 rounded-full" :class="dotCls(it)"></span>
            <span class="min-w-0 flex-1 truncate text-[13px] leading-tight">{{ it.run?.title || it.title }}</span>
            <Loader2 v-if="busyItem === it.id" :size="13" class="shrink-0 animate-spin text-muted-foreground" />
            <button type="button" class="grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition hover:text-danger" :title="$t('action.delete')" @click.stop="askRemove(it)"><X :size="13" /></button>
          </div>

          <!-- autopost entries -->
          <div
            v-for="e in (schedByDate.get(date) || [])" :key="e.entryId"
            class="flex items-center gap-2 rounded-lg bg-surface-hover/60 px-2.5 py-1.5 transition hover:bg-surface-hover"
            :title="e.status === 'error' ? `${entryTitle(e)} — ${e.error || ''}` : entryTitle(e)"
            @click="router.push(`/blog/run/${e.runId}`)"
          >
            <img v-if="CHANNEL_ICONS[e.channel]" :src="CHANNEL_ICONS[e.channel]" :alt="channelLabel(e.channel)" class="size-4 shrink-0 rounded-md object-contain">
            <span v-else class="size-4 shrink-0 rounded-md bg-muted-foreground/20"></span>
            <span class="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground/70">{{ localTime(e.at) }}</span>
            <span class="min-w-0 flex-1 truncate text-[12px] leading-tight text-muted-foreground">{{ e.runTitle }}</span>
            <span v-if="e.status === 'done'" class="size-1.5 shrink-0 rounded-full bg-success" :title="$t('blog.pages.plan.schedule.done')"></span>
            <TriangleAlert v-else-if="e.status === 'error'" :size="12" class="shrink-0 text-danger" :title="e.error || $t('blog.pages.plan.schedule.error')" />
          </div>
        </div>
      </div>
    </div>
    </template>

    <div v-if="loading && !showLoader" class="flex items-center gap-2 text-[12.5px] text-muted-foreground"><Loader2 :size="14" class="animate-spin" /> {{ $t('blog.pages.plan.refreshing') }}</div>
    <div v-else-if="!loading && !loadFailed && !items.length" class="flex flex-wrap items-center gap-3">
      <p class="flex items-center gap-2 text-[12.5px] text-muted-foreground"><CalendarDays :size="14" /> {{ $t('blog.pages.plan.empty') }}</p>
      <Button variant="outline" size="sm" class="border-border bg-surface" @click="router.push('/blog/new')"><SquarePen :size="13" /> {{ $t('blog.pages.nav.newTopic') }}</Button>
    </div>

    <!-- боковая панель-детали слота -->
    <Teleport to="body">
      <div v-if="sel" class="fixed inset-0 z-50" @click.self="sel = null">
        <div class="absolute inset-0 bg-black/40" @click="sel = null"></div>
        <aside class="absolute right-0 top-0 flex h-full w-full max-w-[420px] flex-col overflow-y-auto border-l border-border bg-background shadow-2xl">
          <!-- шапка -->
          <div class="flex items-center justify-between gap-2 px-5 pb-2 pt-4">
            <span class="text-[12.5px] text-muted-foreground">{{ sel.time
              ? $t('blog.pages.plan.slot.titleWithTime', { date: slotDate(sel.date), time: sel.time })
              : $t('blog.pages.plan.slot.title', { date: slotDate(sel.date) }) }}</span>
            <button type="button" class="grid size-8 place-items-center rounded-lg text-muted-foreground transition hover:bg-surface-hover hover:text-foreground" @click="sel = null"><X :size="18" /></button>
          </div>

          <div class="space-y-4 px-5 pb-6">
            <!-- бейджи -->
            <div class="flex flex-wrap items-center gap-1.5">
              <span v-if="sel.intent" class="rounded-md bg-surface-hover px-2 py-0.5 text-[11.5px] font-medium text-muted-foreground">{{ INTENT_LABELS[sel.intent] || sel.intent }}</span>
              <span v-if="sel.category" class="rounded-md bg-surface-hover px-2 py-0.5 text-[11.5px] text-muted-foreground">{{ sel.category }}</span>
              <span v-if="sel.score != null" class="font-mono text-[11.5px] font-medium text-success" :title="$t('blog.pages.plan.slot.aeoTitle')">{{ $t('blog.pages.ideas.aeo', { n: Number(sel.score).toFixed(1) }) }}</span>
              <span class="ml-auto rounded-md px-2 py-0.5 text-[11.5px] font-medium" :class="slotStatus(sel).cls">{{ slotStatus(sel).label }}</span>
            </div>

            <!-- тема (правится) -->
            <div>
              <label class="mb-1 block text-[12px] text-muted-foreground">{{ $t('blog.pages.plan.slot.topic') }}</label>
              <textarea
                v-model="editTitle" rows="2"
                class="w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-[14px] leading-snug outline-none focus:border-ring"
                @blur="saveSlot" @keydown.meta.enter="saveSlot"
              ></textarea>
            </div>

            <!-- угол -->
            <p v-if="sel.angle" class="text-[13px] leading-relaxed text-muted-foreground">{{ sel.angle }}</p>

            <!-- запросы -->
            <div v-if="sel.queries?.length" class="flex flex-wrap gap-1.5">
              <span v-for="(q, i) in sel.queries" :key="i" class="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px] text-muted-foreground">
                <Hash :size="11" class="opacity-50" /> {{ q }}
              </span>
            </div>

            <!-- дата и время (правятся) -->
            <div>
              <label class="mb-1 block text-[12px] text-muted-foreground">{{ $t('blog.pages.plan.slot.datetime') }}</label>
              <div class="flex gap-2">
                <input type="date" v-model="editDate" class="h-9 flex-1 rounded-lg border border-border bg-surface px-2.5 text-[13px] outline-none focus:border-ring" @change="saveSlot">
                <input type="time" v-model="editTime" class="h-9 w-[110px] rounded-lg border border-border bg-surface px-2.5 text-[13px] outline-none focus:border-ring" @change="saveSlot">
              </div>
            </div>

            <div class="border-t border-border/60 pt-4">
              <Button v-if="sel.runId" class="w-full" @click="router.push(`/blog/run/${sel.runId}`)"><ExternalLink :size="14" /> {{ $t('blog.pages.plan.slot.open') }}</Button>
              <Button v-else class="w-full" :disabled="busyItem === sel.id" @click="writeItem(sel)"><Loader2 v-if="busyItem === sel.id" :size="14" class="animate-spin" /><PenLine v-else :size="14" /> {{ $t('blog.pages.plan.slot.write') }}</Button>
              <button type="button" class="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-[12.5px] text-danger transition hover:bg-danger-soft" @click="removeSlot"><Trash2 :size="13" /> {{ $t('blog.pages.plan.slot.remove') }}</button>
            </div>
          </div>
        </aside>
      </div>
    </Teleport>

    <!-- пересборка месяца: сначала честно говорим, что при этом пропадёт -->
    <AlertDialog v-model:open="rebuildOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ $t('blog.pages.plan.rebuildDialog.title', { month: monthLabel }) }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{ $t('blog.pages.plan.rebuildDialog.body', { n: wipeCount }) }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ $t('action.cancel') }}</AlertDialogCancel>
          <AlertDialogAction :disabled="!!generating" @click.prevent="generate(false)">
            <Loader2 v-if="generating === 'rebuild'" :size="14" class="animate-spin" /> {{ $t('blog.pages.plan.rebuild') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- удаление слота -->
    <AlertDialog :open="!!toDelete" @update:open="(v: boolean) => { if (!v) toDelete = null }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ $t('blog.pages.plan.removeDialog.title') }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{ $t('blog.pages.plan.removeDialog.body', { title: toDelete?.run?.title || toDelete?.title }) }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ $t('action.cancel') }}</AlertDialogCancel>
          <AlertDialogAction class="bg-destructive text-destructive-foreground hover:bg-destructive/90" @click="confirmRemove">{{ $t('action.delete') }}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
