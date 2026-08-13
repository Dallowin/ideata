<script setup lang="ts">
// Хороплет визитов по странам (unovis TopoJSONMap) + топ-список с флагами.
import { computed } from 'vue'
import { VisSingleContainer, VisTopoJSONMap } from '@unovis/vue'
import { WorldMapTopoJSON } from '@unovis/ts/maps'
import { flagUrl } from '@/data/prompts'
import { intlLocale } from '@/i18n'

export interface GeoRow {
  code: string      // ISO2
  country: string
  visits: number
  pct: number
}

const props = withDefaults(defineProps<{
  rows: GeoRow[]
  height?: number
  top?: number
}>(), { height: 210, top: 5 })

const maxVisits = computed(() => Math.max(1, ...props.rows.map((r) => r.visits)))

// интенсивность бренда по доле визитов; страны без данных красит CSS-переменная
const areas = computed(() => props.rows
  .filter((r) => r.code)
  .map((r) => ({
    id: r.code,
    color: `rgba(66, 103, 255, ${(0.18 + 0.72 * (r.visits / maxVisits.value)).toFixed(2)})`,
  })))

const topRows = computed(() => props.rows.slice(0, props.top))
</script>

<template>
  <div>
    <div
      class="overflow-hidden rounded-lg"
      :style="{
        '--vis-map-boundary-color': 'rgba(255,255,255,0.08)',
        '--vis-map-feature-color': 'rgba(255,255,255,0.05)',
      }"
    >
      <VisSingleContainer :data="{ areas }" :height="height" :duration="0">
        <VisTopoJSONMap
          :topojson="WorldMapTopoJSON"
          map-feature-name="countries"
          :area-color="(d: any) => d.color"
          :disable-zoom="true"
        />
      </VisSingleContainer>
    </div>

    <div class="mt-2 space-y-1">
      <div v-for="r in topRows" :key="r.country" class="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2">
        <img v-if="r.code" :src="flagUrl(r.code)" :alt="r.code" class="h-[10px] w-[14px] rounded-[2px] object-cover" loading="lazy" />
        <span v-else class="h-[10px] w-[14px] rounded-[2px] bg-surface-hover"></span>
        <span class="min-w-0 flex-1 truncate text-[12.5px] text-text-2">{{ r.country }}</span>
        <span class="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-surface-hover">
          <span class="block h-full rounded-full bg-gradient-to-r from-brand to-brand-soft" :style="{ width: (r.visits / maxVisits) * 100 + '%' }"></span>
        </span>
        <span class="w-12 shrink-0 text-right text-[12.5px] font-medium tabular-nums text-text-2">{{ r.visits.toLocaleString(intlLocale()) }}</span>
        <span class="w-11 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{{ Math.round(r.pct * 10) / 10 }}%</span>
      </div>
    </div>
  </div>
</template>
