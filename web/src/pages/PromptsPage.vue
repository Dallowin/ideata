<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronRight, Download, Layers, Loader2, Plus, Search, Trash2, X,
} from 'lucide-vue-next'
import { api } from '@/lib/api'
import { PageHeader } from '@/components/ui/panel'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import PromptModal from '@/components/prompts/PromptModal.vue'
import SourcesTable from '@/components/prompts/SourcesTable.vue'
import PromptGraph from '@/components/prompts/PromptGraph.vue'
import TableFooter from '@/components/prompts/TableFooter.vue'
import EmptyState from '@/components/EmptyState.vue'
import BrandWarmup from '@/components/BrandWarmup.vue'
import { useBrandBootstrap } from '@/composables/useBrandBootstrap'
import { useBrands } from '@/composables/useBrands'
import { useTracker } from '@/composables/useTracker'
import {
  ENGINE_I18N, INTENTS, REGIONS, flagUrl, isKnownRegion,
  type IntentKey, type Platform, type PromptRow, type RegionCode,
} from '@/data/prompts'

// Свежий бренд: вместо пустой таблицы показываем ход разбора.
const { phase: bootstrapPhase } = useBrandBootstrap()
const warming = computed(() => bootstrapPhase.value === 'analysing' || bootstrapPhase.value === 'idle')

const { t } = useI18n()

// Подписи справочников — из словаря: сами данные хранят только ключи.
const intentLabel = (k: IntentKey) => t(`prompts.intent.${k}`)
const regionLabel = (code: string) => (isKnownRegion(code) ? t(`prompts.region.${code}`) : code)
const engineLabel = (p: Platform) => (ENGINE_I18N.has(p.key) ? t(`prompts.engine.${p.key}`) : p.label)

// ── данные: только реальный трекер активного бренда (без мока) ────────────
const { activeDomain } = useBrands()
const { state: tracker, load: loadTracker } = useTracker()
const mutating = ref(false)
const mutateError = ref('')

const rows = ref<PromptRow[]>([])
const platforms = computed(() => tracker.platforms)
const realSources = computed(() => tracker.sources)
const dataSource = computed(() => tracker.status)

watch(() => tracker.rows, (r) => { rows.value = [...r] }, { immediate: true })
onMounted(() => loadTracker())

// ── состояние UI ───────────────────────────────────────────────────────────
const q = ref('')
const intent = ref<IntentKey | 'all'>('all')
const engineFilter = ref<Set<string>>(new Set())
const sortKey = ref<'vis' | 'citations' | 'delta' | null>('vis')
const sortDir = ref<1 | -1>(-1)
const selected = ref<Set<number>>(new Set())
const modalRow = ref<PromptRow | null>(null)
const modalOpen = ref(false)

const groupBy = ref<'none' | 'intent' | 'region' | 'topic'>('none')
/** Раздел продукта — своя ось, независимая от интента: «Кейсы» и «Вывод
    скинов» могут быть оба «Сравнение». Пусто — промпт вне разделов. */
const topic = ref<string>('all')
/** Служебный ключ «вне разделов»: он же значение фильтра, поэтому не подпись —
    иначе смена языка сбрасывала бы выбранный фильтр. Подпись — topicLabel(). */
const NO_TOPIC = '__no_topic__'
const topicLabel = (name: string) => (name === NO_TOPIC ? t('prompts.filters.noTopic') : name)
const topics = computed(() => {
  const seen = new Map<string, number>()
  for (const r of rows.value) {
    const k = r.topic || NO_TOPIC
    seen.set(k, (seen.get(k) || 0) + 1)
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1])
})
const collapsed = ref<Set<string>>(new Set())

const page = ref(1)
const perPage = ref(10)

const addOpen = ref(false)
const addText = ref('')
const addIntent = ref<IntentKey>('commercial')
const addRegion = ref<RegionCode>('RU')

// ── производные ────────────────────────────────────────────────────────────
const filtered = computed(() => {
  let r = rows.value
  if (q.value.trim()) {
    const s = q.value.trim().toLowerCase()
    r = r.filter((x) => x.text.toLowerCase().includes(s))
  }
  if (intent.value !== 'all') r = r.filter((x) => x.intent === intent.value)
  if (topic.value !== 'all') r = r.filter((x) => (x.topic || NO_TOPIC) === topic.value)
  if (engineFilter.value.size) {
    r = r.filter((x) => [...engineFilter.value].every((k) => (x.engines[k] ?? 0) > 0))
  }
  if (sortKey.value) {
    const k = sortKey.value
    r = [...r].sort((a, b) => (a[k] - b[k]) * sortDir.value)
  }
  return r
})

watch([q, intent, topic, engineFilter, () => perPage.value], () => { page.value = 1 }, { deep: true })

const paged = computed(() => groupBy.value !== 'none'
  ? filtered.value
  : filtered.value.slice((page.value - 1) * perPage.value, page.value * perPage.value))

const groups = computed(() => {
  if (groupBy.value === 'none') return null
  const m = new Map<string, PromptRow[]>()
  for (const r of filtered.value) {
    const key = groupBy.value === 'intent' ? r.intent
      : groupBy.value === 'topic' ? (r.topic || NO_TOPIC)
      : r.region
    if (!m.has(key)) m.set(key, [])
    m.get(key)!.push(r)
  }
  return [...m.entries()].map(([key, items]) => ({
    key,
    label: groupBy.value === 'topic' ? topicLabel(key)
      : groupBy.value === 'intent'
      ? intentLabel(key as IntentKey)
      : regionLabel(key),
    flag: groupBy.value === 'region' ? key : null,
    items,
    avg: Math.round(items.reduce((s, r) => s + r.vis, 0) / items.length),
  }))
})

const avgVis = computed(() => Math.round(filtered.value.reduce((s, r) => s + r.vis, 0) / (filtered.value.length || 1)))
const top3 = computed(() => filtered.value.filter((r) => Object.values(r.engines).some((p) => p > 0 && p <= 3)).length)
const noMention = computed(() => filtered.value.filter((r) => Object.values(r.engines).every((p) => p === 0)).length)

const allChecked = computed(() => filtered.value.length > 0 && filtered.value.every((r) => selected.value.has(r.id)))

// ── действия ───────────────────────────────────────────────────────────────
function toggleSort(k: 'vis' | 'citations' | 'delta') {
  if (sortKey.value === k) sortDir.value = sortDir.value === -1 ? 1 : -1
  else { sortKey.value = k; sortDir.value = -1 }
  page.value = 1
}

function toggleEngine(key: string, on: boolean) {
  const s = new Set(engineFilter.value)
  if (on) s.add(key)
  else s.delete(key)
  engineFilter.value = s
}

function toggleAll() {
  if (allChecked.value) selected.value = new Set()
  else selected.value = new Set(filtered.value.map((r) => r.id))
}

function toggleRow(id: number) {
  const s = new Set(selected.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  selected.value = s
}

function toggleGroup(key: string) {
  const s = new Set(collapsed.value)
  if (s.has(key)) s.delete(key)
  else s.add(key)
  collapsed.value = s
}

function openModal(r: PromptRow) {
  modalRow.value = r
  modalOpen.value = true
}

// клик по промпту в раскрытии «Источников» → модалка этого промпта
function openPromptByText(text: string) {
  const r = rows.value.find((x) => x.text === text)
  if (r) openModal(r)
}

/**
 * Убрать промпты из панели. Раньше правился только локальный массив — после
 * F5 всё возвращалось, а фантомная строка портила среднюю видимость на экране.
 * Бэк снимает промпт в два шага: archive (active→inactive) и delete (убрать
 * inactive), поэтому дёргаем оба.
 */
async function removeSelected() {
  const id = tracker.meta?.id
  const texts = rows.value.filter((r) => selected.value.has(r.id)).map((r) => r.text)
  if (!id || !texts.length || mutating.value) return
  mutating.value = true
  mutateError.value = ''
  try {
    await api.aeoMutatePrompts(id, { action: 'archive', texts })
    await api.aeoMutatePrompts(id, { action: 'delete', texts })
    selected.value = new Set()
    await loadTracker(true)
  } catch (e: any) {
    mutateError.value = mutationMessage(e)
  } finally {
    mutating.value = false
  }
}

/** Человеческий текст ошибки мутации: квота тарифа и пейволл — не «что-то пошло не так». */
function mutationMessage(e: any): string {
  if (e?.status === 409 || e?.body?.error === 'quota') {
    const cap = e?.body?.cap
    return cap
      ? t('prompts.errors.quotaCap', { cap })
      : t('prompts.errors.quota')
  }
  if (e?.status === 402) return t('prompts.errors.paywall')
  if (e?.status === 403) return t('prompts.errors.forbidden')
  // текст сервера приходит уже готовым — переводить нечего
  return e?.serverMessage || t('prompts.errors.generic')
}

async function addPrompt() {
  const text = addText.value.trim()
  const id = tracker.meta?.id
  if (!text || !id || mutating.value) return
  mutating.value = true
  mutateError.value = ''
  try {
    await api.aeoMutatePrompts(id, { action: 'add', text })
    addText.value = ''
    addOpen.value = false
    await loadTracker(true)   // строка придёт из панели бэка, а не выдумывается тут
  } catch (e: any) {
    mutateError.value = mutationMessage(e)
  } finally {
    mutating.value = false
  }
}

function exportCsv(onlySelected = false) {
  const src = onlySelected ? filtered.value.filter((r) => selected.value.has(r.id)) : filtered.value
  const head = [
    t('prompts.csv.prompt'), t('prompts.csv.intent'), t('prompts.csv.region'),
    ...platforms.value.map((p) => engineLabel(p)),
    t('prompts.csv.visibility'), t('prompts.csv.citations'),
  ]
  const lines = src.map((r) => [
    `"${r.text.replaceAll('"', '""')}"`, intentLabel(r.intent), r.region,
    ...platforms.value.map((p) => r.engines[p.key] || ''), r.vis, r.citations,
  ].join(';'))
  const blob = new Blob(['﻿' + [head.join(';'), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'ideata-prompts.csv'
  a.click()
  URL.revokeObjectURL(a.href)
}

function sparkPoints(s: number[], w = 72, h = 22) {
  const min = Math.min(...s), max = Math.max(...s), span = max - min || 1
  return s.map((v, i) => `${((i / (s.length - 1)) * w).toFixed(1)},${(2 + (1 - (v - min) / span) * (h - 4)).toFixed(1)}`).join(' ')
}
</script>

<template>
  <div class="space-y-4 p-5 lg:p-6">
    <PageHeader :title="$t('routeTitle.prompts')">
      <template #description>
        <template v-if="dataSource === 'loading'">{{ $t('prompts.page.loading') }}</template>
        <template v-else-if="dataSource !== 'live'">{{ $t('prompts.page.noData') }}</template>
        <template v-else>{{ $t('prompts.page.tracked', rows.length) }}</template>
      </template>
      <template #actions>
        <Button variant="outline" size="sm" @click="exportCsv(false)">
          <Download :size="14" /> CSV
        </Button>
        <Button size="sm" @click="addOpen = true">
          <Plus :size="14" /> {{ $t('prompts.add.button') }}
        </Button>
      </template>
    </PageHeader>

    <!-- сводка -->
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div class="rounded-xl border border-border bg-surface px-4 py-3">
        <div class="text-[11.5px] text-muted-foreground">{{ $t('prompts.kpi.shown') }}</div>
        <div class="mt-0.5 text-xl font-semibold tabular-nums">{{ filtered.length }}</div>
      </div>
      <div class="rounded-xl border border-border bg-surface px-4 py-3">
        <div class="text-[11.5px] text-muted-foreground">{{ $t('prompts.kpi.avgVis') }}</div>
        <div class="mt-0.5 text-xl font-semibold tabular-nums">{{ avgVis }}%</div>
      </div>
      <div class="rounded-xl border border-border bg-surface px-4 py-3">
        <div class="text-[11.5px] text-muted-foreground">{{ $t('prompts.kpi.top3') }}</div>
        <div class="mt-0.5 text-xl font-semibold tabular-nums text-emerald-400">{{ top3 }}</div>
      </div>
      <div class="rounded-xl border border-border bg-surface px-4 py-3">
        <div class="text-[11.5px] text-muted-foreground">{{ $t('prompts.kpi.noMention') }}</div>
        <div class="mt-0.5 text-xl font-semibold tabular-nums text-rose-400">{{ noMention }}</div>
      </div>
    </div>

    <Tabs default-value="prompts">
      <TabsList class="border border-border bg-surface">
        <TabsTrigger value="prompts" class="text-[12.5px]">{{ $t('prompts.tabs.prompts') }}</TabsTrigger>
        <TabsTrigger value="sources" class="text-[12.5px]">{{ $t('prompts.tabs.sources') }}</TabsTrigger>
        <TabsTrigger value="graph" class="text-[12.5px]">{{ $t('prompts.tabs.graph') }}</TabsTrigger>
      </TabsList>

      <!-- ═══ ВКЛАДКА: ПРОМПТЫ ═══ -->
      <TabsContent value="prompts" class="mt-3 space-y-3">
        <!-- тулбар -->
        <div class="flex flex-wrap items-center gap-2">
          <div class="relative">
            <Search :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input v-model="q" :placeholder="$t('prompts.filters.search')" class="h-8 w-64 border-border bg-surface pl-8 text-[12.5px]" />
          </div>

          <!-- Интент и раздел — две независимые оси, обе в дропдаунах: строкой
               чипов они занимали половину тулбара, а разделов у продукта
               бывает и десяток. Выбранное значение пишем на самой кнопке,
               иначе фильтр включён, а по тулбару этого не видно. -->
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="outline" size="sm" class="h-8 border-border bg-surface text-[12px]" :class="intent !== 'all' && 'text-brand-soft'">
                {{ intent === 'all' ? $t('prompts.filters.intent') : intentLabel(intent as IntentKey) }}
                <ChevronDown :size="13" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-48">
              <DropdownMenuRadioGroup v-model="intent">
                <DropdownMenuRadioItem value="all">{{ $t('prompts.filters.allIntents') }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem v-for="(_cfg, k) in INTENTS" :key="k" :value="k">{{ intentLabel(k) }}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu v-if="topics.length > 1">
            <DropdownMenuTrigger as-child>
              <Button variant="outline" size="sm" class="h-8 border-border bg-surface text-[12px]" :class="topic !== 'all' && 'text-brand-soft'">
                {{ topic === 'all' ? $t('prompts.filters.topic') : topicLabel(topic) }}
                <ChevronDown :size="13" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="max-h-80 w-56 overflow-y-auto">
              <DropdownMenuRadioGroup v-model="topic">
                <DropdownMenuRadioItem value="all">{{ $t('prompts.filters.allTopics') }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem v-for="[name, n] in topics" :key="name" :value="name">
                  {{ topicLabel(name) }} <span class="ml-auto pl-2 text-[11px] text-muted-foreground">{{ n }}</span>
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="outline" size="sm" class="h-8 border-border bg-surface text-[12px]">
                {{ $t('prompts.filters.engines') }}
                <span v-if="engineFilter.size" class="rounded-full bg-brand/20 px-1.5 text-[10.5px] font-semibold text-brand-soft">{{ engineFilter.size }}</span>
                <ChevronDown :size="13" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-52">
              <DropdownMenuLabel class="text-xs text-muted-foreground">{{ $t('prompts.filters.mentionedIn') }}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                v-for="p in platforms" :key="p.key"
                :model-value="engineFilter.has(p.key)"
                @update:model-value="(v: boolean) => toggleEngine(p.key, v)"
                @select.prevent
              >
                <img :src="p.icon" alt="" class="mr-1 size-4 rounded-full bg-surface-2 p-0.5" />
                {{ engineLabel(p) }}
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="outline" size="sm" class="h-8 border-border bg-surface text-[12px]" :class="groupBy !== 'none' && 'text-brand-soft'">
                <Layers :size="13" /> {{ $t('prompts.filters.group') }}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" class="w-44">
              <DropdownMenuRadioGroup v-model="groupBy">
                <DropdownMenuRadioItem value="none">{{ $t('prompts.filters.groupNone') }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="intent">{{ $t('prompts.filters.groupIntent') }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="topic">{{ $t('prompts.filters.groupTopic') }}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="region">{{ $t('prompts.filters.groupRegion') }}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          <button
            v-if="q || intent !== 'all' || topic !== 'all' || engineFilter.size || groupBy !== 'none'"
            class="flex items-center gap-1 text-[12px] text-muted-foreground transition hover:text-foreground"
            @click="q = ''; intent = 'all'; topic = 'all'; groupBy = 'none'; engineFilter = new Set()"
          >
            <X :size="12" /> {{ $t('prompts.filters.reset') }}
          </button>
        </div>

        <!-- таблица -->
        <div class="overflow-x-auto rounded-xl border border-border bg-surface">
          <table class="w-full min-w-[860px] border-collapse text-left">
            <thead>
              <tr class="border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground/80">
                <th class="w-10 px-3 py-2.5">
                  <Checkbox :model-value="allChecked" :aria-label="$t('prompts.table.selectAll')" @update:model-value="toggleAll" />
                </th>
                <th class="px-2 py-2.5 font-medium">{{ $t('prompts.table.prompt') }}</th>
                <th class="px-2 py-2.5 font-medium">{{ $t('prompts.table.engines') }}</th>
                <th class="cursor-pointer select-none px-2 py-2.5 font-medium" @click="toggleSort('vis')">
                  <span class="inline-flex items-center gap-1">
                    {{ $t('prompts.table.visibility') }}
                    <component :is="sortKey === 'vis' ? (sortDir === -1 ? ArrowDown : ArrowUp) : ArrowUpDown" :size="12" :class="sortKey === 'vis' ? 'text-foreground' : 'opacity-40'" />
                  </span>
                </th>
                <th class="cursor-pointer select-none px-2 py-2.5 font-medium" @click="toggleSort('delta')">
                  <span class="inline-flex items-center gap-1">
                    {{ $t('prompts.table.trend') }}
                    <component :is="sortKey === 'delta' ? (sortDir === -1 ? ArrowDown : ArrowUp) : ArrowUpDown" :size="12" :class="sortKey === 'delta' ? 'text-foreground' : 'opacity-40'" />
                  </span>
                </th>
                <th class="cursor-pointer select-none px-2 py-2.5 font-medium" @click="toggleSort('citations')">
                  <span class="inline-flex items-center gap-1">
                    {{ $t('prompts.table.citations') }}
                    <component :is="sortKey === 'citations' ? (sortDir === -1 ? ArrowDown : ArrowUp) : ArrowUpDown" :size="12" :class="sortKey === 'citations' ? 'text-foreground' : 'opacity-40'" />
                  </span>
                </th>
              </tr>
            </thead>

            <!-- сгруппированный режим -->
            <tbody v-if="groups" class="divide-y divide-white/[0.04]">
              <template v-for="g in groups" :key="g.key">
                <tr class="cursor-pointer select-none bg-surface-2 transition-colors hover:bg-surface-hover" @click="toggleGroup(g.key)">
                  <td colspan="6" class="px-3 py-2">
                    <div class="flex items-center gap-2 text-[12px] font-medium">
                      <ChevronRight :size="14" class="transition-transform" :class="!collapsed.has(g.key) && 'rotate-90'" />
                      <img v-if="g.flag" :src="flagUrl(g.flag)" :alt="g.flag" class="h-[10px] w-[14px] rounded-[2px] object-cover" loading="lazy" />
                      {{ g.label }}
                      <span class="text-muted-foreground">· {{ g.items.length }}</span>
                      <span class="ml-auto text-[11.5px] text-muted-foreground">{{ $t('prompts.table.avgVis') }} <b class="text-foreground">{{ g.avg }}%</b></span>
                    </div>
                  </td>
                </tr>
                <template v-if="!collapsed.has(g.key)">
                  <tr
                    v-for="r in g.items" :key="r.id"
                    class="group cursor-pointer transition-colors hover:bg-surface-2"
                    :class="selected.has(r.id) && 'bg-brand/[0.06]'"
                    @click="openModal(r)"
                  >
                    <td class="px-3 py-2.5" @click.stop>
                      <Checkbox :model-value="selected.has(r.id)" :aria-label="$t('prompts.table.selectRow', { text: r.text })" @update:model-value="toggleRow(r.id)" />
                    </td>
                    <td class="max-w-[340px] px-2 py-2.5">
                      <div class="truncate text-[13px] text-foreground">{{ r.text }}</div>
                      <div class="mt-1 flex items-center gap-1.5">
                        <Badge variant="outline" class="h-[18px] rounded px-1.5 text-[10px] font-medium" :class="INTENTS[r.intent].class">{{ intentLabel(r.intent) }}</Badge>
                        <Badge v-if="r.topic" variant="outline" class="h-[18px] rounded border-border px-1.5 text-[10px] font-medium text-muted-foreground">{{ r.topic }}</Badge>
                        <img :src="flagUrl(r.region)" :alt="r.region" :title="r.region" class="h-[10px] w-[14px] rounded-[2px] object-cover opacity-80" loading="lazy" />
                      </div>
                    </td>
                    <td class="px-2 py-2.5">
                      <div class="flex items-center gap-1">
                        <span v-for="p in platforms" :key="p.key" class="relative" :title="`${engineLabel(p)}: ${r.engines[p.key] ? '#' + r.engines[p.key] : $t('prompts.table.notMentioned')}`">
                          <img :src="p.icon" :alt="engineLabel(p)" class="size-[18px] rounded-full bg-surface-2 p-0.5 transition-opacity" :class="r.engines[p.key] ? '' : 'opacity-20 grayscale'" />
                          <Check v-if="r.engines[p.key] === 1" :size="8" class="absolute -right-0.5 -top-0.5 rounded-full bg-emerald-500 p-px text-black" />
                        </span>
                      </div>
                    </td>
                    <td class="w-36 px-2 py-2.5">
                      <div class="flex items-center gap-2">
                        <span class="w-8 text-[12.5px] font-medium tabular-nums">{{ r.vis }}%</span>
                        <span class="h-1 w-16 overflow-hidden rounded-full bg-surface-hover">
                          <span class="block h-full rounded-full bg-gradient-to-r from-brand to-brand-soft" :style="{ width: r.vis + '%' }"></span>
                        </span>
                      </div>
                    </td>
                    <td class="w-28 px-2 py-2.5">
                      <!-- одна точка истории = линию рисовать не из чего: показываем
                           прочерк, а не ровную черту с «+0» -->
                      <div v-if="r.trend.length > 1" class="flex items-center gap-1.5">
                        <svg viewBox="0 0 72 22" class="h-[22px] w-[72px]" preserveAspectRatio="none" aria-hidden="true">
                          <polyline :points="sparkPoints(r.trend)" fill="none" :stroke="r.delta >= 0 ? '#34d399' : '#fb7185'" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.8" />
                        </svg>
                        <span class="text-[11px] font-medium tabular-nums" :class="r.delta >= 0 ? 'text-emerald-400' : 'text-rose-400'">{{ r.delta >= 0 ? '+' : '' }}{{ r.delta }}</span>
                      </div>
                      <span v-else class="text-[11px] text-muted-foreground/60" :title="$t('prompts.table.trendHint')">—</span>
                    </td>
                    <td class="w-20 px-2 py-2.5 text-[12.5px] tabular-nums text-text-2">{{ r.citations }}</td>
                  </tr>
                </template>
              </template>
            </tbody>

            <!-- плоский режим -->
            <tbody v-else class="divide-y divide-white/[0.04]">
              <tr
                v-for="r in paged" :key="r.id"
                class="group cursor-pointer transition-colors hover:bg-surface-2"
                :class="selected.has(r.id) && 'bg-brand/[0.06]'"
                @click="openModal(r)"
              >
                <td class="px-3 py-2.5" @click.stop>
                  <Checkbox :model-value="selected.has(r.id)" :aria-label="$t('prompts.table.selectRow', { text: r.text })" @update:model-value="toggleRow(r.id)" />
                </td>
                <td class="max-w-[340px] px-2 py-2.5">
                  <div class="truncate text-[13px] text-foreground">{{ r.text }}</div>
                  <div class="mt-1 flex items-center gap-1.5">
                    <Badge variant="outline" class="h-[18px] rounded px-1.5 text-[10px] font-medium" :class="INTENTS[r.intent].class">{{ intentLabel(r.intent) }}</Badge>
                        <Badge v-if="r.topic" variant="outline" class="h-[18px] rounded border-border px-1.5 text-[10px] font-medium text-muted-foreground">{{ r.topic }}</Badge>
                    <img :src="flagUrl(r.region)" :alt="r.region" :title="r.region" class="h-[10px] w-[14px] rounded-[2px] object-cover opacity-80" loading="lazy" />
                  </div>
                </td>
                <td class="px-2 py-2.5">
                  <div class="flex items-center gap-1">
                    <span v-for="p in platforms" :key="p.key" class="relative" :title="`${engineLabel(p)}: ${r.engines[p.key] ? '#' + r.engines[p.key] : $t('prompts.table.notMentioned')}`">
                      <img :src="p.icon" :alt="engineLabel(p)" class="size-[18px] rounded-full bg-surface-2 p-0.5 transition-opacity" :class="r.engines[p.key] ? '' : 'opacity-20 grayscale'" />
                      <Check v-if="r.engines[p.key] === 1" :size="8" class="absolute -right-0.5 -top-0.5 rounded-full bg-emerald-500 p-px text-black" />
                    </span>
                  </div>
                </td>
                <td class="w-36 px-2 py-2.5">
                  <div class="flex items-center gap-2">
                    <span class="w-8 text-[12.5px] font-medium tabular-nums">{{ r.vis }}%</span>
                    <span class="h-1 w-16 overflow-hidden rounded-full bg-surface-hover">
                      <span class="block h-full rounded-full bg-gradient-to-r from-brand to-brand-soft" :style="{ width: r.vis + '%' }"></span>
                    </span>
                  </div>
                </td>
                <td class="w-28 px-2 py-2.5">
                  <div v-if="r.trend.length > 1" class="flex items-center gap-1.5">
                    <svg viewBox="0 0 72 22" class="h-[22px] w-[72px]" preserveAspectRatio="none" aria-hidden="true">
                      <polyline :points="sparkPoints(r.trend)" fill="none" :stroke="r.delta >= 0 ? '#34d399' : '#fb7185'" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.8" />
                    </svg>
                    <span class="text-[11px] font-medium tabular-nums" :class="r.delta >= 0 ? 'text-emerald-400' : 'text-rose-400'">{{ r.delta >= 0 ? '+' : '' }}{{ r.delta }}</span>
                  </div>
                  <span v-else class="text-[11px] text-muted-foreground/60" :title="$t('prompts.table.trendHint')">—</span>
                </td>
                <td class="w-20 px-2 py-2.5 text-[12.5px] tabular-nums text-text-2">{{ r.citations }}</td>
              </tr>
              <tr v-if="!paged.length">
                <td colspan="6">
                  <p v-if="dataSource === 'loading'" class="px-4 py-12 text-center text-[13px] text-muted-foreground">{{ $t('state.loading') }}</p>
                  <BrandWarmup v-else-if="!rows.length && warming" :rows="0" class="my-4" />
                  <EmptyState
                    v-else-if="!rows.length"
                    :hint="$t('prompts.table.emptyHint')"
                  />
                  <p v-else class="px-4 py-12 text-center text-[13px] text-muted-foreground">{{ $t('prompts.table.noMatch') }}</p>
                </td>
              </tr>
            </tbody>
          </table>

          <div v-if="groupBy === 'none'" class="border-t border-border">
            <TableFooter v-model:page="page" v-model:per-page="perPage" :total="filtered.length" :selected="selected.size" />
          </div>
          <div v-else class="border-t border-border px-4 py-3 text-[12.5px] text-muted-foreground">
            {{ $t('prompts.table.groupFooter', {
              selected: selected.size,
              total: filtered.length,
              group: $t(`prompts.table.groupBy.${groupBy}`),
            }) }}
          </div>
        </div>
      </TabsContent>

      <!-- ═══ ВКЛАДКА: ИСТОЧНИКИ ═══ -->
      <TabsContent value="sources" class="mt-3">
        <SourcesTable :rows="realSources" :platforms="platforms" @open-prompt="openPromptByText" />
      </TabsContent>

      <!-- ═══ ВКЛАДКА: ГРАФ ═══ -->
      <!-- forceMount не ставим: силовая раскладка считает 600+ узлов, и
           держать её живой на фоне двух других вкладок незачем. -->
      <TabsContent value="graph" class="mt-3">
        <PromptGraph
          :rows="rows"
          :domain="tracker.meta?.domain"
          :competitors="tracker.meta?.competitors"
          @open-prompt="openPromptByText"
        />
      </TabsContent>
    </Tabs>

    <!-- бар выбранного -->
    <Transition
      enter-active-class="transition duration-200" enter-from-class="translate-y-3 opacity-0"
      leave-active-class="transition duration-150" leave-to-class="translate-y-3 opacity-0"
    >
      <div v-if="selected.size" class="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-xl border border-border bg-popover/95 px-2 py-1.5 shadow-2xl backdrop-blur">
        <span class="px-2 text-[12.5px] text-muted-foreground">{{ $t('prompts.bulk.selected') }} <b class="text-foreground">{{ selected.size }}</b></span>
        <Button variant="ghost" size="sm" class="h-7 text-[12px]" @click="exportCsv(true)">
          <Download :size="13" /> {{ $t('action.export') }}
        </Button>
        <Button
          variant="ghost" size="sm" :disabled="mutating"
          class="h-7 text-[12px] text-rose-400 hover:text-rose-300" @click="removeSelected"
        >
          <Trash2 :size="13" /> {{ $t('action.delete') }}
        </Button>
        <Button variant="ghost" size="sm" class="h-7 w-7 p-0" :aria-label="$t('prompts.bulk.clear')" @click="selected = new Set()">
          <X :size="13" />
        </Button>
      </div>
    </Transition>

    <!-- детализация -->
    <PromptModal v-model:open="modalOpen" :row="modalRow" :platforms="platforms" :own-brand="activeDomain.split('.')[0] || 'ideata'" />

    <!-- добавить промпт -->
    <Dialog v-model:open="addOpen">
      <DialogContent class="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('prompts.add.title') }}</DialogTitle>
          <DialogDescription class="text-[12.5px]">
            {{ $t('prompts.add.description') }}
          </DialogDescription>
        </DialogHeader>
        <textarea
          v-model="addText"
          rows="3" maxlength="200"
          :placeholder="$t('prompts.add.placeholder')"
          class="w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-[13px] outline-none transition focus:border-ring"
        ></textarea>
        <p v-if="mutateError" class="text-[12px] text-destructive">{{ mutateError }}</p>
        <div class="grid grid-cols-2 gap-3">
          <div class="space-y-1.5">
            <label class="text-[11.5px] font-medium text-muted-foreground">{{ $t('prompts.add.type') }}</label>
            <Select v-model="addIntent">
              <SelectTrigger class="w-full border-border bg-surface text-[12.5px]">
                <SelectValue>{{ intentLabel(addIntent) }}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="(_cfg, k) in INTENTS" :key="k" :value="k">{{ intentLabel(k) }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="space-y-1.5">
            <label class="text-[11.5px] font-medium text-muted-foreground">{{ $t('prompts.add.region') }}</label>
            <Select v-model="addRegion">
              <SelectTrigger class="w-full border-border bg-surface text-[12.5px]">
                <SelectValue>{{ regionLabel(addRegion) }}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="code in REGIONS" :key="code" :value="code">
                  <img :src="flagUrl(code)" :alt="code" class="mr-1 inline-block h-[10px] w-[14px] rounded-[2px] object-cover" loading="lazy" /> {{ regionLabel(code) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div class="flex items-center justify-end">
          <span class="text-[11px] tabular-nums text-muted-foreground">{{ addText.length }}/200</span>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="addOpen = false">{{ $t('action.cancel') }}</Button>
          <Button :disabled="!addText.trim() || mutating" @click="addPrompt">
            <Loader2 v-if="mutating" :size="14" class="animate-spin" /> {{ $t('action.add') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
