<script setup lang="ts">
// Семантика разбора: кластеры (и где тонко), интенты спроса, распределение
// позиций. Одна карточка на три блока — вопрос один: «за что нас находят».
import { computed } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import type { SiteFacts } from '@/composables/useSiteAnalytic'
import { nf } from '@/data/dashboard'

const props = defineProps<{ facts: SiteFacts | null }>()

const clusters = computed(() => props.facts?.clusters || [])
const intents = computed(() => props.facts?.intents || [])
const posDist = computed(() => props.facts?.posDist || [])
const maxPos = computed(() => Math.max(1, ...posDist.value.map((p) => p.count)))

const STRENGTH: Record<string, string> = {
  'сильный': 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300',
  'средний': 'border-border bg-surface-hover text-muted-foreground',
  'тонкий': 'border-amber-500/25 bg-amber-500/10 text-amber-300',
}
const empty = computed(() => !clusters.value.length && !intents.value.length && !posDist.value.length)
</script>

<template>
  <section class="rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 class="text-[13px] font-medium">Семантика</h2>
      <span class="text-[11.5px] text-muted-foreground">из разбора</span>
    </div>

    <EmptyState v-if="empty" hint="Кластеры и интенты соберутся при следующем разборе сайта." />
    <template v-else>
      <!-- кластеры -->
      <div v-if="clusters.length" class="space-y-1.5 p-3">
        <div v-for="c in clusters" :key="c.name" class="flex items-center gap-2.5">
          <span class="min-w-0 flex-1 truncate text-[12.5px] text-text-2">{{ c.name }}</span>
          <span class="shrink-0 text-[12px] tabular-nums text-muted-foreground">{{ nf(c.kws) }}</span>
          <span class="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px]" :class="STRENGTH[c.strength] || STRENGTH['средний']">{{ c.strength }}</span>
        </div>
      </div>

      <!-- интенты -->
      <div v-if="intents.length" class="border-t border-border p-3">
        <div class="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground/70">Интенты спроса</div>
        <div class="space-y-1.5">
          <div v-for="i in intents" :key="i.label" class="flex items-center gap-2.5">
            <span class="w-32 shrink-0 truncate text-[12px] text-text-2">{{ i.label }}</span>
            <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover">
              <span class="block h-full rounded-full bg-muted-foreground/35" :style="{ width: i.pct + '%' }"></span>
            </span>
            <span class="w-8 shrink-0 text-right text-[12px] tabular-nums text-text-2">{{ i.pct }}%</span>
          </div>
        </div>
      </div>

      <!-- распределение позиций -->
      <div v-if="posDist.length" class="border-t border-border p-3">
        <div class="mb-2.5 text-[11px] uppercase tracking-wide text-muted-foreground/70">Позиции в поиске</div>
        <div class="flex items-end gap-1.5">
          <div v-for="p in posDist" :key="p.bucket" class="flex-1 text-center">
            <div class="mb-1 text-[11px] tabular-nums text-muted-foreground">{{ nf(p.count) }}</div>
            <div
              class="mx-auto w-full rounded-t bg-gradient-to-t from-brand/40 to-brand-soft/70"
              :style="{ height: 6 + (p.count / maxPos) * 56 + 'px' }"
            ></div>
            <div class="mt-1 text-[10.5px] text-muted-foreground/70">{{ p.bucket }}</div>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
