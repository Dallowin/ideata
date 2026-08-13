<script setup lang="ts">
/**
 * Спарклайн метрики — голый SVG, без графической библиотеки.
 *
 * Полноценный график в карточку KPI тянуть нельзя: InteractiveAreaChart весит
 * 200 КБ, а тут нужна линия из десятка точек, которую никто не наводит мышью.
 *
 * Ось Y всегда начинается с нуля и растягивается до максимума ряда: без этого
 * колебание 41→43% рисуется горкой во всю карточку и метрика читается как
 * обвал. Плоский ряд (все значения равны) кладём посередине, иначе деление на
 * нулевой размах даёт NaN и линия исчезает.
 */
import { computed } from 'vue'

const props = withDefaults(defineProps<{
  values: number[]
  color?: string
  /** заливка под линией — для «главной» метрики карточки */
  fill?: boolean
}>(), { color: 'currentColor', fill: true })

const W = 100
const H = 28

const d = computed(() => {
  const v = (props.values || []).filter((n) => Number.isFinite(n))
  if (v.length < 2) return { line: '', area: '' }
  const max = Math.max(...v, 0)
  const min = 0
  const span = max - min || 1
  const step = W / (v.length - 1)
  const pts = v.map((n, i) => {
    const x = i * step
    const y = H - ((n - min) / span) * (H - 2) - 1
    return [x, y] as const
  })
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `${line} L${W},${H} L0,${H} Z`
  return { line, area }
})
</script>

<template>
  <svg
    v-if="d.line" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none"
    class="h-7 w-full" aria-hidden="true"
  >
    <path v-if="fill" :d="d.area" :fill="color" fill-opacity="0.08" />
    <path :d="d.line" fill="none" :stroke="color" stroke-width="1.5"
          stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
  </svg>
  <!-- Ровная черта вместо пустоты: карточка без истории должна занимать ту же
       высоту, иначе строка KPI прыгает при появлении второго прогона. -->
  <div v-else class="flex h-7 items-center">
    <span class="h-px w-full bg-hairline"></span>
  </div>
</template>
