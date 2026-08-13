<script setup lang="ts">
// Топ цитируемых доменов — реальный агрегат из ответов трекера.
import { computed } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import { faviconSrc, type SourceRow } from '@/data/prompts'

const props = defineProps<{
  sources: SourceRow[]
}>()

const top = computed(() => props.sources.slice(0, 5))
const max = computed(() => Math.max(1, ...top.value.map((s) => s.citations)))

function onFaviconError(e: Event, host: string) {
  const img = e.target as HTMLImageElement
  const fallback = `https://www.google.com/s2/favicons?domain=${host}&sz=64`
  if (img.src !== fallback) img.src = fallback
}
</script>

<template>
  <section class="rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 class="text-[13px] font-medium">{{ $t('monitoring.sources.title') }}</h2>
      <RouterLink to="/prompts" class="text-[11.5px] text-muted-foreground transition hover:text-foreground">{{ $t('monitoring.sources.all') }} →</RouterLink>
    </div>
    <div class="space-y-1 p-2">
      <EmptyState v-if="!top.length" compact :hint="$t('monitoring.sources.empty')" />
      <div v-for="s in top" :key="s.host" class="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2">
        <img :src="faviconSrc(s.host)" width="16" height="16" class="shrink-0 rounded-sm" loading="lazy" @error="onFaviconError($event, s.host)" />
        <span class="w-28 shrink-0 truncate text-[12.5px]" :class="s.own ? 'font-medium text-brand-soft' : 'text-text-2'">{{ s.host }}</span>
        <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover">
          <span class="block h-full rounded-full" :class="s.own ? 'bg-gradient-to-r from-brand to-brand-soft' : 'bg-muted-foreground/35'" :style="{ width: (s.citations / max) * 100 + '%' }"></span>
        </span>
        <span class="w-8 shrink-0 text-right text-[12.5px] font-medium tabular-nums text-text-2">{{ s.citations }}</span>
      </div>
    </div>
  </section>
</template>
