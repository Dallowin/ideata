<script setup lang="ts">
/**
 * Первый экран мониторинга: три панели — видимость, позиция в нише, тональность.
 *
 * Раскладка перенесена из маркетинговой панели лендинга
 * (www/app/components/landing/MetricsSection.vue). Там она жила как
 * скролл-анимация с захардкоженными числами и в продукт никогда не попадала, а
 * кабинет тем временем показывал строку из пяти мелких цифр. Здесь то же самое
 * на живых агрегатах.
 *
 * Что даёт раскладка, чего не давала строка KPI:
 *  · одна главная цифра на панель вместо пяти равнозначных — видно, на что
 *    смотреть;
 *  · разбивка по движкам сразу под графиком, а не таблицей далеко внизу: «где
 *    именно меня не называют» — первый вопрос после «сколько»;
 *  · рейтинг просторным списком с подсвеченной своей строкой.
 *
 * Тональность НЕ повторяет лендинг: там нарисован трёхцветный сплит
 * «64 / 28 / 8», а такого распределения бэкенд не считает — есть балл 0–100 и
 * темы с тоном. Рисовать сплит из головы значило бы показывать выдуманные
 * доли в продукте.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import InteractiveAreaChart, { type AreaSeries } from '@/components/charts/InteractiveAreaChart.vue'
import type { TrackerAggregates, TrackerMeta } from '@/composables/useTracker'
import { SELF_COLOR, brandLabel, brandPalette, pctFmt, trendLabel } from '@/data/dashboard'
import { platformsFor } from '@/data/prompts'
import BrandMark from './BrandMark.vue'

const props = defineProps<{
  agg: TrackerAggregates | null
  meta: TrackerMeta | null
  loading?: boolean
}>()

const emit = defineEmits<{ 'add-competitors': [] }>()

const { t } = useI18n()

const kpi = computed(() => props.agg?.kpi || {})

/** Своя линия видимости — она же площадь графика панели. */
const visSeries = computed<number[]>(() => {
  const s = (props.agg?.visTrend?.series || []).find((x) => x.self)
  return (s?.data || []).map(Number).filter((n) => Number.isFinite(n))
})

/** Видимость по каждому движку — строка своего бренда из матрицы. */
const engines = computed(() => {
  const self = (props.agg?.platMatrix || []).find((r) => r.self)
  if (!self) return []
  const plats = platformsFor(props.agg?.platforms || [])
  return plats
    .map((p, i) => ({ key: p.key, label: p.label, icon: p.icon, vis: Number(self.vals?.[i] ?? 0) }))
    .sort((a, b) => b.vis - a.vis)
    .slice(0, 6)
})

const palette = computed(() => brandPalette(props.agg))
const ladder = computed(() =>
  (props.agg?.leaderboard || []).slice(0, 5).map((r, i) => ({ ...r, rank: i + 1 })),
)
const selfRank = computed(() => {
  const i = (props.agg?.leaderboard || []).findIndex((r) => r.self)
  return i >= 0 ? i + 1 : null
})
const rivals = computed(() => (props.meta?.competitors?.length ?? 0) > 0)

const selfSent = computed<number | null>(() => {
  const s = (props.agg?.rivalSent || []).find((x) => x.self)
  return s ? Number(s.score) : null
})
const themes = computed(() =>
  (props.agg?.sentThemes || [])
    .map((t: any) => (typeof t === 'string' ? { t, tone: 'neutral' } : t))
    .filter((t: any) => t?.t)
    .slice(0, 4),
)
const TONE_LABEL = computed<Record<string, string>>(() => ({
  good: t('monitoring.hero.toneGood'),
  bad: t('monitoring.hero.toneBad'),
  neutral: t('monitoring.hero.toneNeutral'),
}))
const TONE_CLASS: Record<string, string> = {
  good: 'text-success', bad: 'text-danger', neutral: 'text-muted-foreground',
}
const sentTone = (v: number) => (v >= 65 ? 'text-success' : v >= 45 ? 'text-warning' : 'text-danger')
const sentWord = (v: number) => (v >= 65
  ? t('monitoring.hero.sentPositive')
  : v >= 45 ? t('monitoring.hero.sentNeutral') : t('monitoring.hero.sentNegative'))

/**
 * График панели — тот же InteractiveAreaChart, что и в «Динамике видимости»
 * ниже, а не декоративная кривая.
 *
 * Раньше здесь рисовался самодельный path в растянутом viewBox: без дат под
 * осью, без сетки и без подсказки на наведении. Такая линия читается как
 * украшение — «сколько было 14-го числа» по ней узнать нельзя, и на вопрос
 * «это вообще мои данные?» она не отвечает. Ось X с датами, горизонтальная
 * сетка и кроссхейр с числом делают из неё график.
 */
const chartSeries = computed<AreaSeries[]>(() => [
  { key: 'vis', label: t('monitoring.metric.visibility'), color: SELF_COLOR },
])
const chartData = computed(() => {
  const labels = props.agg?.visTrend?.weekLabels || []
  const self = (props.agg?.visTrend?.series || []).find((x) => x.self)
  if (!self) return []
  return labels.map((w, i) => ({ date: trendLabel(w), vis: Number(self.data[i] ?? 0) }))
})
// Одна точка — это не динамика: рисовать по ней график значило бы показывать
// «линию» из одного замера.
const hasChart = computed(() => chartData.value.length >= 2 && visSeries.value.length >= 2)
</script>

<template>
  <section class="grid divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface lg:grid-cols-12 lg:divide-x lg:divide-y-0">
    <!-- ── Видимость ─────────────────────────────────────────────────────── -->
    <div class="p-5 lg:col-span-5">
      <div class="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">{{ $t('monitoring.metric.visibility') }}</div>
      <div class="mt-2 flex items-baseline gap-2.5">
        <span class="text-[40px] font-semibold leading-none tracking-tight tabular-nums">
          {{ loading ? '—' : pctFmt(kpi.visScore) }}
        </span>
        <!-- Дельта пилюлей, а не стрелкой: это второе по важности число на
             экране, и мелкий значок рядом с 40px цифрой пропадал. -->
        <span
          v-if="!loading && kpi.visDelta"
          class="rounded-full px-2 py-0.5 text-[12px] font-medium tabular-nums"
          :class="kpi.visDelta > 0 ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'"
        >{{ kpi.visDelta > 0 ? '+' : '' }}{{ kpi.visDelta }} {{ $t('monitoring.hero.pp') }}</span>
      </div>
      <div class="mt-1 text-[12.5px] text-muted-foreground">{{ $t('monitoring.hero.visHint') }}</div>

      <!-- -mx-1.5: подписи оси прижаты к краям панели, паддинг контейнера их
           и так отбивает — лишний отступ съедал бы ширину графика -->
      <InteractiveAreaChart
        v-if="hasChart" class="mt-3 -mx-1.5"
        :data="chartData" :series="chartSeries" :height="132" :ticks="4" unit="%" hide-legend
      />
      <div v-else class="mt-4 flex h-[132px] items-center text-[12.5px] text-muted-foreground/70">
        {{ $t('monitoring.hero.chartAfter') }}
      </div>

      <!-- Разбивка по движкам сразу здесь: «где именно меня не называют» —
           первый вопрос после «сколько», а матрица лежит далеко внизу. -->
      <div class="mt-4 space-y-2">
        <div v-for="e in engines" :key="e.key" class="flex items-center gap-2.5">
          <img :src="e.icon" :alt="e.label" class="size-4 shrink-0 object-contain" />
          <span class="w-24 shrink-0 truncate text-[12.5px] text-muted-foreground">{{ e.label }}</span>
          <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover">
            <span class="block h-full rounded-full" :style="{ width: `${e.vis}%`, background: SELF_COLOR }" />
          </span>
          <span class="w-9 shrink-0 text-right text-[12.5px] font-medium tabular-nums text-text-2">{{ e.vis }}%</span>
        </div>
      </div>
    </div>

    <!-- ── Позиция в нише ────────────────────────────────────────────────── -->
    <div class="p-5 lg:col-span-4">
      <div class="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">{{ $t('monitoring.hero.rankTitle') }}</div>
      <div class="mt-2 flex items-baseline gap-2.5">
        <span class="text-[40px] font-semibold leading-none tracking-tight tabular-nums"
              :class="!rivals && !loading ? 'text-muted-foreground/40' : ''">
          {{ loading || !rivals || !selfRank ? '—' : `#${selfRank}` }}
        </span>
      </div>
      <div class="mt-1 text-[12.5px] text-muted-foreground">{{ $t('monitoring.hero.rankHint') }}</div>

      <!-- Без конкурентов «#1» — не победа, а сравнение ни с кем. -->
      <div v-if="!rivals && !loading" class="mt-5 rounded-lg border border-border px-3 py-4 text-center">
        <p class="text-[12.5px] text-muted-foreground">{{ $t('monitoring.hero.noRivals') }}</p>
        <button
          type="button"
          class="mt-2 text-[12.5px] font-medium text-foreground underline decoration-dotted underline-offset-2"
          @click="emit('add-competitors')"
        >{{ $t('monitoring.addCompetitors') }}</button>
      </div>

      <div v-else class="mt-5 space-y-1">
        <div
          v-for="r in ladder" :key="r.brand"
          class="flex items-center gap-2.5 rounded-lg px-2.5 py-2"
          :class="r.self ? 'border border-brand/35 bg-brand/[0.12]' : ''"
        >
          <span class="w-4 shrink-0 text-[12px] tabular-nums"
                :class="r.self ? 'font-semibold text-brand-soft' : 'text-muted-foreground/60'">{{ r.rank }}</span>
          <!-- Фавиконка, как в остальных списках брендов: цветной квадрат
               остаётся фолбэком, когда иконка не отдалась. -->
          <BrandMark :brand="r.brand" :color="palette[r.brand] || SELF_COLOR" />
          <span class="flex-1 truncate text-[13px]"
                :class="r.self ? 'font-semibold text-foreground' : 'text-text-2'">{{ brandLabel(r.brand) }}</span>
          <span v-if="r.delta" class="shrink-0 text-[11.5px] tabular-nums"
                :class="r.delta > 0 ? 'text-success' : 'text-danger'">
            {{ r.delta > 0 ? '↑' : '↓' }}{{ Math.abs(r.delta) }}
          </span>
          <span class="w-9 shrink-0 text-right text-[12.5px] tabular-nums"
                :class="r.self ? 'text-text-2' : 'text-muted-foreground'">{{ r.vis }}%</span>
        </div>
      </div>
    </div>

    <!-- ── Тональность ───────────────────────────────────────────────────── -->
    <div class="p-5 lg:col-span-3">
      <div class="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">{{ $t('monitoring.hero.sentTitle') }}</div>
      <div class="mt-2 flex items-baseline gap-2.5">
        <span class="text-[40px] font-semibold leading-none tracking-tight tabular-nums"
              :class="selfSent == null && !loading ? 'text-muted-foreground/40' : ''">
          {{ loading || selfSent == null ? '—' : selfSent }}
        </span>
        <span v-if="!loading && selfSent != null" class="text-[12px] font-medium" :class="sentTone(selfSent)">
          {{ sentWord(selfSent) }}
        </span>
      </div>
      <div class="mt-1 text-[12.5px] text-muted-foreground">{{ $t('monitoring.hero.sentHint') }}</div>

      <div v-if="selfSent != null" class="mt-4 h-1.5 overflow-hidden rounded-full bg-surface-hover">
        <span class="block h-full rounded-full"
              :style="{ width: `${selfSent}%` }"
              :class="selfSent >= 65 ? 'bg-success' : selfSent >= 45 ? 'bg-warning' : 'bg-danger'" />
      </div>

      <div v-if="themes.length" class="mt-5 space-y-2">
        <div
          v-for="t in themes" :key="t.t"
          class="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2"
        >
          <span class="truncate text-[12.5px] text-text-2">{{ t.t }}</span>
          <span class="shrink-0 text-[11.5px] font-medium" :class="TONE_CLASS[t.tone] || TONE_CLASS.neutral">
            {{ TONE_LABEL[t.tone] || TONE_LABEL.neutral }}
          </span>
        </div>
      </div>
      <p v-else-if="!loading" class="mt-5 text-[12.5px] text-muted-foreground/70">
        {{ $t('monitoring.themesLater') }}
      </p>
    </div>
  </section>
</template>
