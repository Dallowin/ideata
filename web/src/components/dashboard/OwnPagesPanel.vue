<script setup lang="ts">
// Какие страницы вашего сайта нейросети реально цитируют (agg.watchedPages).
// Практический смысл: эти URL работают — их и надо усиливать контентом.
import { computed } from 'vue'
import { ArrowUpRight } from 'lucide-vue-next'
import EmptyState from '@/components/EmptyState.vue'
import type { TrackerAggregates } from '@/composables/useTracker'

const props = defineProps<{
  agg: TrackerAggregates | null
}>()

const pages = computed(() =>
  (props.agg?.watchedPages || []).map((p) => ({
    ...p,
    path: (() => {
      try {
        const u = new URL(p.url)
        return (u.pathname === '/' ? '/' : u.pathname.replace(/\/$/, '')) + (u.search || '')
      } catch { return p.url }
    })(),
  })),
)
const max = computed(() => Math.max(1, ...pages.value.map((p) => p.n)))
</script>

<template>
  <section class="rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 class="text-[13px] font-medium">{{ $t('monitoring.ownPages.title') }}</h2>
      <span class="text-[11.5px] text-muted-foreground">{{ $t('monitoring.ownPages.subtitle') }}</span>
    </div>
    <div class="space-y-0.5 p-2">
      <EmptyState
        v-if="!pages.length"
        compact
        :hint="$t('monitoring.ownPages.empty')"
      />
      <a
        v-for="p in pages" :key="p.url" :href="p.url" target="_blank" rel="noopener"
        class="group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2"
      >
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-1 text-[12.5px] text-text-2">
            <span class="truncate">{{ p.path }}</span>
            <ArrowUpRight :size="12" class="shrink-0 text-muted-foreground/0 transition group-hover:text-muted-foreground" />
          </span>
          <span class="mt-1 block h-1 overflow-hidden rounded-full bg-surface-hover">
            <span class="block h-full rounded-full bg-gradient-to-r from-brand to-brand-soft" :style="{ width: (p.n / max) * 100 + '%' }"></span>
          </span>
        </span>
        <span class="w-7 shrink-0 text-right text-[12.5px] font-medium tabular-nums text-text-2">{{ p.n }}</span>
      </a>
    </div>
  </section>
</template>
