<script setup lang="ts">
// Топ-запросы разбора: объём, позиция и её изменение, потенциал трафика (ETV).
import { computed } from 'vue'
import { ArrowDown, ArrowUp } from 'lucide-vue-next'
import EmptyState from '@/components/EmptyState.vue'
import type { SiteFacts } from '@/composables/useSiteAnalytic'
import { fmtK, nf } from '@/data/dashboard'

const props = defineProps<{ facts: SiteFacts | null }>()

const rows = computed(() => (props.facts?.keywords || []).slice(0, 12))
// позиция выросла = число уменьшилось
const move = (r: { pos: number; prev?: number }) => (r.prev == null ? 0 : r.prev - r.pos)
const posTone = (pos: number) => (pos <= 3 ? 'text-emerald-400' : pos <= 10 ? 'text-foreground' : 'text-muted-foreground')
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 class="text-[13px] font-medium">Топ-запросы</h2>
      <span class="text-[11.5px] text-muted-foreground">органика в регионе разбора</span>
    </div>

    <EmptyState v-if="!rows.length" hint="Семантика подтянется при следующем разборе сайта." />
    <div v-else class="overflow-x-auto">
      <table class="w-full min-w-[520px] text-[12.5px]">
        <thead>
          <tr class="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground/70">
            <th class="px-4 py-2 text-left font-medium">Запрос</th>
            <th class="w-[112px] px-2 py-2 text-left font-medium">Интент</th>
            <th class="w-[74px] px-2 py-2 text-right font-medium">Объём</th>
            <th class="w-[78px] px-2 py-2 text-right font-medium">Позиция</th>
            <th class="w-[80px] px-4 py-2 text-right font-medium">Потенциал</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-white/[0.04]">
          <tr v-for="r in rows" :key="r.kw" class="hover:bg-surface">
            <td class="max-w-0 truncate px-4 py-2 text-text-2">{{ r.kw }}</td>
            <td class="px-2 py-2 text-[11.5px] text-muted-foreground">{{ r.intent || '—' }}</td>
            <td class="px-2 py-2 text-right tabular-nums text-text-2">{{ fmtK(r.vol) }}</td>
            <td class="px-2 py-2 text-right">
              <span class="inline-flex items-center gap-1 tabular-nums" :class="posTone(r.pos)">
                {{ r.pos }}
                <span
                  v-if="move(r)" class="inline-flex items-center text-[11px]"
                  :class="move(r) > 0 ? 'text-emerald-400' : 'text-rose-400'"
                >
                  <component :is="move(r) > 0 ? ArrowUp : ArrowDown" :size="10" />{{ Math.abs(move(r)) }}
                </span>
              </span>
            </td>
            <td class="px-4 py-2 text-right tabular-nums text-muted-foreground">{{ nf(r.etv) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
