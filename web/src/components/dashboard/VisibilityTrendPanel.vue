<script setup lang="ts">
// Динамика видимости по неделям: свой бренд + конкуренты одним графиком
// (канон Peec AI / Profound «Visibility» — линии + чипы-легенда, метрика
// переключается). Данные — agg.visTrend / agg.citeShareTrend, без пересчёта.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import InteractiveAreaChart, { type AreaSeries } from '@/components/charts/InteractiveAreaChart.vue'
import EmptyState from '@/components/EmptyState.vue'
import type { TrackerAggregates } from '@/composables/useTracker'
import { SELF_COLOR, brandLabel, brandPalette, trendLabel } from '@/data/dashboard'

const props = defineProps<{
  agg: TrackerAggregates | null
  loading?: boolean
}>()

const { t } = useI18n()

type Metric = 'vis' | 'cite'
const metric = ref<Metric>('vis')
const METRICS = computed<{ key: Metric; label: string }[]>(() => [
  { key: 'vis', label: t('monitoring.metric.visibility') },
  { key: 'cite', label: t('monitoring.metric.cite') },
])

const palette = computed(() => brandPalette(props.agg))
const weeks = computed(() => props.agg?.visTrend?.weekLabels || [])
// Заголовок и подсказка следуют за гранулярностью: при ежедневном мониторинге
// «по неделям» было прямой неправдой — точки теперь дневные.
const daily = computed(() => props.agg?.visTrend?.granularity === 'day')
const trendSeries = computed(() => props.agg?.visTrend?.series || [])

// свой бренд включён всегда, конкуренты — по клику на чип
const hidden = ref(new Set<string>())
const toggle = (brand: string) => {
  const next = new Set(hidden.value)
  next.has(brand) ? next.delete(brand) : next.add(brand)
  hidden.value = next
}

const chips = computed(() =>
  trendSeries.value.map((s) => ({
    brand: s.brand,
    label: brandLabel(s.brand),
    color: palette.value[s.brand] || SELF_COLOR,
    self: s.self,
    on: !hidden.value.has(s.brand),
  })),
)

const series = computed<AreaSeries[]>(() => {
  if (metric.value === 'cite') return [{ key: 'cite', label: t('monitoring.metric.cite'), color: SELF_COLOR }]
  return chips.value.filter((c) => c.on).map((c) => ({ key: c.brand, label: c.label, color: c.color }))
})

const data = computed(() => {
  const w = weeks.value
  if (metric.value === 'cite') {
    const t = props.agg?.citeShareTrend || []
    return w.map((wk, i) => ({ date: trendLabel(wk), cite: t[i] ?? 0 }))
  }
  return w.map((wk, i) => {
    const point: Record<string, any> = { date: trendLabel(wk) }
    for (const s of trendSeries.value) point[s.brand] = s.data[i] ?? 0
    return point
  })
})

const hasHistory = computed(() => weeks.value.length >= 2 && series.value.length > 0)
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
      <div class="mr-auto">
        <h2 class="text-[13px] font-medium">{{ daily ? $t('monitoring.trend.titleDaily') : $t('monitoring.trend.titleWeekly') }}</h2>
        <p class="mt-0.5 text-[11.5px] text-muted-foreground">
          {{ metric === 'vis' ? $t('monitoring.trend.hintVis') : $t('monitoring.trend.hintCite') }}
        </p>
      </div>
      <div class="inline-flex items-center rounded-lg border border-border bg-surface-2 p-0.5 text-[12px] font-medium">
        <button
          v-for="m in METRICS" :key="m.key" type="button"
          class="h-7 rounded-md px-2.5 transition"
          :class="metric === m.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'"
          @click="metric = m.key"
        >{{ m.label }}</button>
      </div>
    </div>

    <div v-if="loading" class="py-16 text-center text-[13px] text-muted-foreground">{{ $t('state.loading') }}</div>
    <EmptyState
      v-else-if="!hasHistory"
      :title="$t('monitoring.trend.emptyTitle')"
      :hint="$t('monitoring.trend.emptyHint')"
    />
    <template v-else>
      <div class="px-2 pt-3">
        <InteractiveAreaChart :data="data" :series="series" :height="230" variant="line" unit="%" hide-legend />
      </div>
      <!--
        Чипы-легенда: клик выключает конкурента из графика. При единственной
        серии легенда бессмысленна и вредна — это кнопка, которая умеет только
        стереть твой же график и оставить пустое поле. Легенда появляется
        вместе со вторым брендом.
      -->
      <div v-if="metric === 'vis' && chips.length > 1" class="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-2.5">
        <button
          v-for="c in chips" :key="c.brand" type="button"
          class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] transition"
          :class="c.on ? 'border-border bg-surface-2 text-foreground' : 'border-border/60 text-muted-foreground/60'"
          @click="toggle(c.brand)"
        >
          <span class="size-2 rounded-[3px]" :style="{ background: c.on ? c.color : 'transparent', boxShadow: c.on ? 'none' : `inset 0 0 0 1px ${c.color}` }"></span>
          {{ c.label }}
          <span v-if="c.self" class="text-[10px] text-muted-foreground">{{ $t('monitoring.you') }}</span>
        </button>
      </div>
    </template>
  </section>
</template>
