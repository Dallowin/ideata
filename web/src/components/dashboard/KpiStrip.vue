<script setup lang="ts">
// KPI мониторинга — ТОЛЬКО agg.kpi с бэкенда (Profound-метрики: Visibility,
// Share of Voice, средняя позиция, Citation Share). Пересчитывать их из строк
// нельзя: получатся другие числа, чем в остальных панелях.
//
// Раскладка — канон Cloudflare/Navattic/Whop: у каждой метрики СВОЙ спарклайн
// в карточке. Ряд голых цифр над одним общим полотном не давал главного —
// куда метрика идёт; чтобы это понять, приходилось переключать большой график.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDown, ArrowUp } from 'lucide-vue-next'
import type { TrackerAggregates, TrackerMeta } from '@/composables/useTracker'
import { SELF_COLOR, pctFmt, posFmt } from '@/data/dashboard'
import Sparkline from './Sparkline.vue'

const props = defineProps<{
  agg: TrackerAggregates | null
  meta: TrackerMeta | null
  loading?: boolean
}>()

const emit = defineEmits<{ 'add-competitors': [] }>()

const { t } = useI18n()

// Две метрики из пяти — сравнительные: без конкурентов доля голоса всегда
// выходит 100%, а средняя позиция — 1. Это не победа, это «сравнили ни с кем»,
// причём выглядит как лучший возможный результат. Показываем причину и путь к
// исправлению вместо цифры (канон Midday: «No data available» + действие).
const needsRivals = computed(() => (props.meta?.competitors?.length ?? 0) === 0)

// История своей линии — она же ряд для спарклайна видимости.
const citeSeries = computed<number[]>(() => (props.agg?.citeShareTrend || []).map(Number))

/**
 * Сколько промптов реально уходит в прогон.
 *
 * Панель может держать 123 активных, а раннер берёт первые N: prompts_limit
 * трекера клампится в [5, тарифный потолок] и режет список (jobs.py
 * `prompts = prompts[:run_n]`). Разница не косметическая — ВСЕ метрики строки
 * посчитаны по ответам на эти N, поэтому показывать число из панели значило бы
 * приписывать замеру охват, которого у него нет.
 */
const running = computed(() => {
  const m = props.meta
  if (!m) return 0
  const cap = m.promptCap ?? m.activeCount
  const limit = m.promptsLimit == null
    ? cap
    : Math.max(5, Math.min(cap, m.promptsLimit))
  return Math.min(m.activeCount, limit)
})

interface Cell {
  key: string
  label: string
  hint: string
  value: string
  delta: number | null
  series: number[]
  locked: boolean
  /** заполненность тарифного лимита, 0..1 — только для «Промптов» */
  usage: number | null
}

const cells = computed<Cell[]>(() => {
  const k = props.agg?.kpi || {}
  const m = props.meta
  const locked = needsRivals.value
  const cap = m?.promptCap ?? null
  return [
    // «Видимость» ушла в заголовок первого экрана (OverviewHero) — здесь она
    // была бы вторым показом одного и того же числа на расстоянии экрана.
    {
      key: 'sov', label: t('monitoring.metric.sov'),
      hint: locked ? t('monitoring.kpi.needRivals') : t('monitoring.kpi.sovHint'),
      value: locked ? '—' : pctFmt(k.sov), delta: null,
      series: [], locked, usage: null,
    },
    {
      key: 'pos', label: t('monitoring.metric.pos'),
      hint: locked ? t('monitoring.kpi.needRivals') : t('monitoring.kpi.posHint'),
      value: locked ? '—' : posFmt(k.avgPos), delta: null,
      series: [], locked, usage: null,
    },
    {
      key: 'cite', label: t('monitoring.metric.cite'), hint: t('monitoring.kpi.citeHint'),
      value: pctFmt(k.citeShare), delta: null,
      series: citeSeries.value, locked: false, usage: null,
    },
    {
      key: 'prompts', label: t('monitoring.kpi.promptsLabel'),
      // Показываем СКОЛЬКО ГОНЯЕТСЯ, а не сколько лежит в панели: все прочие
      // KPI строки посчитаны по этим ответам. Раньше стояло число активных и
      // полоса «из 125 по тарифу» — почти полная, хотя опрашивалась половина.
      hint: m && running.value < m.activeCount
        ? t('monitoring.kpi.promptsHintLimit', { n: m.activeCount })
        : (cap ? t('monitoring.kpi.promptsHintCap', { n: cap }) : t('monitoring.kpi.promptsHintPanel')),
      value: m ? String(running.value) : '—', delta: null,
      series: [], locked: false,
      // Полоса вместо спарклайна: у счётчика нет истории, зато есть охват —
      // какая доля панели реально опрашивается.
      usage: m && m.activeCount ? Math.min(1, running.value / m.activeCount) : null,
    },
  ]
})
</script>

<template>
  <!--
    Разделители — линиями (divide-*), а не зазором поверх залитой секции.
    Токены поверхностей ПОЛУПРОЗРАЧНЫЕ: карточка на --surface (2% белого) не
    перекрывает фон секции, а складывается с ним. Залив секцию в --border (7%),
    я получал 9% белого против 2% у соседних панелей — строка KPI светилась
    вчетверо ярче всего остального и читалась как другой, тёплый фон.
  -->
  <section class="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface sm:grid-cols-2 lg:grid-cols-4 lg:divide-y-0">
    <div v-for="c in cells" :key="c.key" class="flex min-w-0 flex-col gap-2 px-4 py-3.5 sm:px-5">
      <div class="truncate text-[11.5px] text-muted-foreground">{{ c.label }}</div>

      <div class="flex items-baseline gap-2">
        <span
          class="text-[24px] font-semibold leading-none tracking-tight tabular-nums"
          :class="c.locked && !loading ? 'text-muted-foreground/40' : ''"
        >{{ loading ? '—' : c.value }}</span>
        <span
          v-if="!loading && c.delta != null && c.delta !== 0"
          class="inline-flex items-center gap-0.5 text-[11.5px] font-medium tabular-nums"
          :class="c.delta > 0 ? 'text-success' : 'text-danger'"
        >
          <component :is="c.delta > 0 ? ArrowUp : ArrowDown" :size="11" />{{ Math.abs(c.delta) }}
        </span>
      </div>

      <!-- Заблокированная метрика занимает ту же высоту, что и соседи со
           спарклайном: иначе строка KPI встаёт лесенкой. -->
      <div v-if="c.locked && !loading" class="flex h-7 items-end">
        <button
          type="button"
          class="text-[11px] text-muted-foreground/70 underline decoration-dotted underline-offset-2 transition hover:text-foreground"
          @click="emit('add-competitors')"
        >{{ $t('monitoring.kpi.setUp', { hint: c.hint }) }}</button>
      </div>
      <!-- Полоса почти заполнена (123 из 125), поэтому светлая заливка делала
           её самым ярким пятном строки — у наименее важной метрики. Дорожка
           уходит в цвет рамки, заполнение — тот же брендовый синий, что у
           спарклайнов: серый тут ничего не значил. -->
      <div v-else-if="c.usage != null" class="flex h-7 flex-col justify-end gap-1.5">
        <span class="h-1 w-full overflow-hidden rounded-full bg-border">
          <span class="block h-full rounded-full" :style="{ width: `${c.usage * 100}%`, background: SELF_COLOR, opacity: 0.7 }"></span>
        </span>
        <span class="truncate text-[11px] text-muted-foreground/60">{{ c.hint }}</span>
      </div>
      <template v-else>
        <Sparkline :values="c.series" :color="SELF_COLOR" />
        <span class="truncate text-[11px] text-muted-foreground/60">{{ c.hint }}</span>
      </template>
    </div>
  </section>
</template>
