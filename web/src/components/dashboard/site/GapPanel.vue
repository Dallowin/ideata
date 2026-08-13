<script setup lang="ts">
// Разрывы семантики: запросы, где конкурент в топе, а вас нет. Отсортированы
// по «score» бэка (объём против сложности) — это готовый список тем контента.
import { computed } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import type { SiteFacts } from '@/composables/useSiteAnalytic'
import { fmtK } from '@/data/dashboard'

const props = defineProps<{ facts: SiteFacts | null }>()

const rows = computed(() => (props.facts?.gapRows || []).slice(0, 8))
const kdTone = (kd: number) => (kd <= 20 ? 'text-emerald-400' : kd <= 45 ? 'text-amber-400' : 'text-rose-400')
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <div>
        <h2 class="text-[13px] font-medium">Разрывы семантики</h2>
        <p class="mt-0.5 text-[11.5px] text-muted-foreground">Запросы, где конкурент есть, а вас нет</p>
      </div>
    </div>

    <EmptyState v-if="!rows.length" hint="Гэп считается, когда в разборе задан конкурент для сравнения." />
    <table v-else class="w-full text-[12.5px]">
      <thead>
        <tr class="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground/70">
          <th class="px-4 py-2 text-left font-medium">Запрос</th>
          <th class="w-[72px] px-2 py-2 text-right font-medium">Объём</th>
          <th class="w-[64px] px-4 py-2 text-right font-medium">Слож.</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-white/[0.04]">
        <tr v-for="r in rows" :key="r.kw" class="hover:bg-surface">
          <td class="max-w-0 truncate px-4 py-2 text-text-2">{{ r.kw }}</td>
          <td class="px-2 py-2 text-right tabular-nums text-text-2">{{ fmtK(r.vol) }}</td>
          <td class="px-4 py-2 text-right tabular-nums" :class="kdTone(r.kd)">{{ r.kd }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
