<script setup lang="ts">
// Матрица «бренд × движок»: где именно вас называют, а где — конкурентов
// (канон Profound «Matrix View» — тепловые ячейки с процентом).
// Источник — agg.platMatrix + agg.platforms, порядок колонок = порядок бэка.
import { computed } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import type { TrackerAggregates } from '@/composables/useTracker'
import { SELF_COLOR, brandLabel, brandPalette } from '@/data/dashboard'
import BrandMark from './BrandMark.vue'
import { platformsFor } from '@/data/prompts'

const props = defineProps<{
  agg: TrackerAggregates | null
  loading?: boolean
}>()

const platforms = computed(() => platformsFor(props.agg?.platforms || []))
const palette = computed(() => brandPalette(props.agg))
const rows = computed(() =>
  (props.agg?.platMatrix || []).map((r) => ({ ...r, color: palette.value[r.brand] || SELF_COLOR })),
)

/**
 * Движки, у которых НИ ОДИН бренд не набрал ни процента за всё окно.
 *
 * Это почти наверняка молчащий движок (у нас так висел Grok — сначала с битым
 * слугом, потом без кредитов), а не рынок, где никого не называют. Разница
 * принципиальная: колонка сплошных «—» читается как «вас тут не знают» и
 * толкает чинить контент вместо интеграции.
 */
const silent = computed(() => {
  const rs = props.agg?.platMatrix || []
  if (!rs.length) return new Set<number>()
  const out = new Set<number>()
  const n = platforms.value.length
  for (let i = 0; i < n; i++) {
    if (rs.every((r) => !Number(r.vals?.[i]))) out.add(i)
  }
  return out
})

// заливка ячейки: чем выше видимость, тем плотнее. Свою строку красим
// фирменным синим, конкурентов — нейтральным, чтобы взгляд цеплял свою.
const cellStyle = (v: number, self: boolean) => ({
  background: v ? (self ? `rgba(66,103,255,${0.12 + (v / 100) * 0.55})` : `rgba(255,255,255,${0.03 + (v / 100) * 0.14})`) : 'transparent',
})
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <div>
        <h2 class="text-[13px] font-medium">{{ $t('monitoring.matrix.title') }}</h2>
        <p class="mt-0.5 text-[11.5px] text-muted-foreground">{{ $t('monitoring.matrix.subtitle') }}</p>
      </div>
    </div>

    <div v-if="loading" class="py-14 text-center text-[13px] text-muted-foreground">{{ $t('state.loading') }}</div>
    <EmptyState v-else-if="!rows.length || !platforms.length" :hint="$t('monitoring.matrix.empty')" />
    <div v-else class="overflow-x-auto">
      <table class="w-full min-w-[620px] text-[12px]">
        <thead>
          <tr class="border-b border-border">
            <th class="sticky left-0 z-[1] bg-background px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{{ $t('monitoring.col.brand') }}</th>
            <th v-for="(p, i) in platforms" :key="p.key" class="px-1 py-2 text-center font-medium">
              <div class="flex flex-col items-center gap-1" :class="silent.has(i) ? 'opacity-40' : ''">
                <img
                  :src="p.icon" :alt="p.label"
                  :title="silent.has(i) ? $t('monitoring.matrix.silentEngine', { engine: p.label }) : p.label"
                  class="size-4 rounded-full bg-surface-2 p-0.5"
                />
                <span class="max-w-[62px] truncate text-[10px] text-muted-foreground/70">{{ p.label }}</span>
              </div>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-white/[0.04]">
          <tr v-for="r in rows" :key="r.brand">
            <td class="sticky left-0 z-[1] bg-background px-4 py-1.5">
              <div class="flex min-w-0 items-center gap-2">
                <BrandMark :brand="r.brand" :color="r.color" />
                <span class="max-w-[150px] truncate text-[12.5px]" :class="r.self ? 'font-medium text-foreground' : 'text-text-2'">{{ brandLabel(r.brand) }}</span>
              </div>
            </td>
            <td v-for="(v, i) in r.vals" :key="i" class="p-0.5">
              <!-- У молчащего движка ставим «нет» вместо «—»: прочерк тут
                   означает «бренд не назвали», и путать эти два состояния
                   нельзя — выводы из них противоположные. -->
              <div
                :title="silent.has(i)
                  ? $t('monitoring.matrix.silentCell', { engine: platforms[i]?.label ?? '' })
                  : $t('monitoring.matrix.cell', { brand: brandLabel(r.brand), engine: platforms[i]?.label ?? '', v })"
                class="flex h-8 items-center justify-center rounded-md tabular-nums"
                :class="silent.has(i)
                  ? 'text-muted-foreground/25'
                  : (v ? (r.self ? 'font-medium text-foreground' : 'text-text-2') : 'text-muted-foreground/30')"
                :style="silent.has(i) ? {} : cellStyle(v, r.self)"
              >{{ silent.has(i) ? $t('monitoring.matrix.no') : (v ? v + '%' : '—') }}</div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
