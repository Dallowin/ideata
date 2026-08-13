<script setup lang="ts">
// Полный разбор ссылок: на что ссылаются нейросети, отвечая по промптам бренда.
// KPI → динамика доли своих цитат → типы источников → таблица доменов с
// раскрытием (URL + промпты) → страницы вашего сайта в ответах.
// Данные реальные: агрегаты трекера (citeShareTrend/citeCats/watchedPages) и
// разобранные цитаты ответов (SourceRow), без пересчёта «на глазок».
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import InteractiveAreaChart from '@/components/charts/InteractiveAreaChart.vue'
import EmptyState from '@/components/EmptyState.vue'
import SourcesTable from '@/components/prompts/SourcesTable.vue'
import CitationTypesPanel from '@/components/dashboard/CitationTypesPanel.vue'
import OwnPagesPanel from '@/components/dashboard/OwnPagesPanel.vue'
import type { TrackerAggregates } from '@/composables/useTracker'
import type { Platform, SourceRow } from '@/data/prompts'
import { SELF_COLOR, nf, pctFmt, trendLabel } from '@/data/dashboard'

const props = defineProps<{
  sources: SourceRow[]
  platforms: Platform[]
  agg: TrackerAggregates | null
  loading?: boolean
}>()
const emit = defineEmits<{ (e: 'open-prompt', text: string): void }>()

const { t } = useI18n()

const totalCitations = computed(() => props.sources.reduce((s, r) => s + r.citations, 0))
const ownRow = computed(() => props.sources.find((s) => s.own) || null)

const cells = computed(() => [
  { key: 'cites', l: t('links.kpi.cites'), hint: t('links.kpi.citesHint'), v: nf(totalCitations.value) },
  { key: 'hosts', l: t('links.kpi.hosts'), hint: t('links.kpi.hostsHint'), v: nf(props.sources.length) },
  { key: 'share', l: t('links.kpi.share'), hint: t('links.kpi.shareHint'), v: pctFmt(props.agg?.kpi?.citeShare) },
  {
    key: 'pages',
    l: t('links.kpi.pages'),
    hint: ownRow.value ? t('links.kpi.pagesHint', ownRow.value.citations) : t('links.kpi.pagesHintEmpty'),
    v: nf(props.agg?.watchedPages?.length ?? 0),
  },
])

// динамика доли своих цитат — недельные точки того же окна, что и «Мониторинг»
const weeks = computed(() => props.agg?.visTrend?.weekLabels || [])
const trend = computed(() => props.agg?.citeShareTrend || [])
const chartData = computed(() =>
  weeks.value.map((w, i) => ({ date: trendLabel(w), cite: trend.value[i] ?? 0 })),
)
const chartSeries = computed(() => [{ key: 'cite', label: t('links.trend.series'), color: SELF_COLOR }])
const hasTrend = computed(() => trend.value.length >= 2 && weeks.value.length >= 2)
</script>

<template>
  <div class="space-y-4">
    <!-- KPI -->
    <section class="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface lg:grid-cols-4 lg:divide-y-0">
      <div v-for="c in cells" :key="c.key" class="min-w-0 px-4 py-3.5 sm:px-5">
        <div class="truncate text-[11.5px] text-muted-foreground">{{ c.l }}</div>
        <div class="mt-1.5 text-[24px] font-semibold leading-none tracking-tight tabular-nums">
          {{ loading ? '—' : c.v }}
        </div>
        <div class="mt-1 truncate text-[11px] text-muted-foreground/60">{{ c.hint }}</div>
      </div>
    </section>

    <div class="grid gap-4 lg:grid-cols-5">
      <!-- динамика доли своих цитат -->
      <section class="overflow-hidden rounded-xl border border-border bg-surface lg:col-span-3">
        <div class="border-b border-border px-4 py-3">
          <h2 class="text-[13px] font-medium">{{ $t('links.trend.title') }}</h2>
          <p class="mt-0.5 text-[11.5px] text-muted-foreground">{{ $t('links.trend.subtitle') }}</p>
        </div>
        <div v-if="loading" class="py-14 text-center text-[13px] text-muted-foreground">{{ $t('state.loading') }}</div>
        <EmptyState
          v-else-if="!hasTrend"
          :title="$t('links.trend.emptyTitle')"
          :hint="$t('links.trend.emptyHint')"
        />
        <div v-else class="px-2 pt-3 pb-1">
          <InteractiveAreaChart :data="chartData" :series="chartSeries" :height="180" unit="%" hide-legend />
        </div>
      </section>

      <CitationTypesPanel class="lg:col-span-2" :agg="agg" />
    </div>

    <!-- таблица доменов с раскрытием URL и промптов -->
    <section class="overflow-hidden rounded-xl border border-border bg-surface">
      <div class="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <h2 class="text-[13px] font-medium">{{ $t('links.sources.title') }}</h2>
          <p class="mt-0.5 text-[11.5px] text-muted-foreground">{{ $t('links.sources.subtitle') }}</p>
        </div>
      </div>
      <SourcesTable :rows="sources" :platforms="platforms" @open-prompt="(t: string) => emit('open-prompt', t)" />
    </section>

    <OwnPagesPanel :agg="agg" />
  </div>
</template>
