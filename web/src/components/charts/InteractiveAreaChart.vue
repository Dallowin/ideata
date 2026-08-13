<script setup lang="ts">
// Интерактивный area-чарт в стиле shadcn «Area Chart – Interactive»:
// градиентные области с чёткой кромкой, кроссхейр с тултипом, ось дат,
// горизонтальная сетка. Серии рисуются оверлеем (как в референсе).
import { computed, useId } from 'vue'
import { VisArea, VisAxis, VisCrosshair, VisLine, VisTooltip, VisXYContainer } from '@unovis/vue'
import { CurveType } from '@unovis/ts'
import { intlLocale } from '@/i18n'

export interface AreaSeries {
  key: string
  label: string
  color: string
}

const props = withDefaults(defineProps<{
  /** точки: { date: 'дд.мм' | ISO, [seriesKey]: number } */
  data: Record<string, any>[]
  series: AreaSeries[]
  height?: number
  /** количество подписей на оси X */
  ticks?: number
  /** скрыть встроенную легенду (когда снаружи есть свои бейджи) */
  hideLegend?: boolean
  /** 'area' — заливка под линией (одна-две серии); 'line' — только линии
   * (сравнение нескольких брендов: заливки перекрывают друг друга) */
  variant?: 'area' | 'line'
  /** единица измерения в тултипе: '%' → «42%» */
  unit?: string
}>(), { height: 250, ticks: 6, variant: 'area', unit: '' })

const uid = useId().replace(/:/g, '')
// id градиента по ИНДЕКСУ серии: ключи бывают с пробелами/кириллицей
// («Прямые заходы») — такие id ломают url(#…) и заливка падает в чёрный
const gradId = (i: number) => `iac-${uid}-${i}`

// индекс вшиваем в данные: Vue-обёртка unovis зовёт аксессор без второго
// аргумента, (_, i) => i отдаёт NaN и график не рисуется
const rows = computed(() => props.data.map((d, i) => ({ ...d, __i: i })))
const x = (d: any) => d.__i
const yFor = (key: string) => (d: any) => Number(d[key] ?? 0)

const labels = computed(() => props.data.map((d) => String(d.date ?? '')))
const tickFormat = (v: number) => labels.value[Math.round(v)] ?? ''

// Тултип кроссхейра — только СОДЕРЖИМОЕ: саму карточку (фон, рамку, тень,
// паддинги) рисует элемент тултипа unovis, стилизованный через --vis-tooltip-*
// ниже. Своя обёртка с фоном давала вторую карточку — светлый ореол вокруг.
function tooltipTemplate(d: any): string {
  const i = Number(d?.__i ?? -1)
  const rows = props.series.map((s) => `
    <div style="display:flex;align-items:center;gap:6px;min-width:130px">
      <span style="width:8px;height:8px;border-radius:2px;background:${s.color}"></span>
      <span style="color:#a1a1aa;font-size:11.5px">${s.label}</span>
      <span style="margin-left:auto;font-weight:600;font-variant-numeric:tabular-nums;font-size:11.5px">${Number(d[s.key] ?? 0).toLocaleString(intlLocale())}${props.unit}</span>
    </div>`).join('')
  return `
    <div style="font-size:11px;font-weight:600;margin-bottom:5px">${labels.value[i] ?? ''}</div>
    ${rows}`
}

const crosshairColor = (_: any, i: number) => props.series[i % props.series.length]!.color

// смена состава серий (кол-во/ключи) ломает переиспользование контейнера
// unovis (области перестают рисоваться) → пересоздаём контейнер целиком
const remountKey = computed(() => props.series.map((s) => s.key).join('|'))
</script>

<template>
  <!-- --vis-tooltip-*: карточку подсказки рисует сам unovis, а его дефолт —
       светлый (тёмная тема включается его же селекторами, у нас html.dark),
       поэтому цвета задаём явно -->
  <div
    class="relative w-full"
    :style="{
      '--vis-axis-grid-color': 'rgba(255,255,255,0.06)',
      '--vis-axis-domain-color': 'transparent',
      '--vis-axis-tick-color': 'transparent',
      '--vis-axis-tick-label-color': 'rgba(161,161,170,0.7)',
      '--vis-axis-tick-label-font-size': '11px',
      '--vis-axis-font-family': 'inherit',
      '--vis-crosshair-line-stroke-color': 'rgba(255,255,255,0.3)',
      '--vis-crosshair-circle-stroke-color': '#0b0b0f',
      '--vis-tooltip-background-color': 'rgba(20,20,24,0.96)',
      '--vis-tooltip-border-color': 'rgba(255,255,255,0.08)',
      '--vis-tooltip-text-color': '#e4e4e7',
      '--vis-tooltip-border-radius': '10px',
      '--vis-tooltip-padding': '8px 10px',
      '--vis-tooltip-box-shadow': '0 8px 24px rgba(0,0,0,0.5)',
      '--vis-tooltip-transition-duration': '80ms',
      '--vis-dark-tooltip-background-color': 'rgba(20,20,24,0.96)',
      '--vis-dark-tooltip-border-color': 'rgba(255,255,255,0.08)',
      '--vis-dark-tooltip-text-color': '#e4e4e7',
    }"
  >
    <!-- градиенты областей -->
    <svg width="0" height="0" class="absolute" aria-hidden="true">
      <defs>
        <linearGradient v-for="(s, i) in series" :id="gradId(i)" :key="s.key" x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%" :stop-color="s.color" stop-opacity="0.45" />
          <stop offset="95%" :stop-color="s.color" stop-opacity="0.03" />
        </linearGradient>
      </defs>
    </svg>

    <!-- duration=0: d3-транзишены на rAF не доезжают в фоновых вкладках -->
    <VisXYContainer :key="remountKey" :data="rows" :height="height" :duration="0" :margin="{ top: 8, right: 4, bottom: 0, left: 4 }">
      <template v-for="(s, i) in series" :key="s.key">
        <VisArea v-if="variant === 'area'" :x="x" :y="yFor(s.key)" :color="`url(#${gradId(i)})`" :curve-type="CurveType.MonotoneX" :opacity="1" />
        <VisLine :x="x" :y="yFor(s.key)" :color="s.color" :line-width="1.75" :curve-type="CurveType.MonotoneX" />
      </template>
      <VisAxis
        type="x" :tick-format="tickFormat" :num-ticks="ticks"
        :grid-line="false" :domain-line="false" :tick-line="false"
      />
      <VisAxis
        type="y" :num-ticks="4" :tick-format="() => ''"
        :grid-line="true" :domain-line="false" :tick-line="false"
      />
      <VisCrosshair :template="tooltipTemplate" :color="crosshairColor" />
      <!-- без VisTooltip кроссхейр рисует линию, но подсказку не показывает:
           в unovis шаблон крестика рендерит именно компонент тултипа -->
      <VisTooltip />
    </VisXYContainer>

    <!-- легенда -->
    <div v-if="!hideLegend && series.length > 1" class="mt-2 flex items-center justify-center gap-4">
      <span v-for="s in series" :key="s.key" class="inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
        <span class="size-2 rounded-[3px]" :style="{ background: s.color }"></span>{{ s.label }}
      </span>
    </div>
  </div>
</template>

