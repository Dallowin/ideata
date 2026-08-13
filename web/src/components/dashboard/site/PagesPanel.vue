<script setup lang="ts">
// Сильные страницы сайта по разбору: сколько ключей держит и какой органический
// потенциал. Это карта того, что уже работает — её и усиливать под ИИ-ответы.
import { computed } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import type { SiteFacts } from '@/composables/useSiteAnalytic'
import { fmtK, nf } from '@/data/dashboard'

const props = defineProps<{ facts: SiteFacts | null }>()

const pages = computed(() => (props.facts?.topPages || []).slice(0, 6))
const max = computed(() => Math.max(1, ...pages.value.map((p) => p.traffic || 0)))
const short = (u: string) => {
  const s = String(u || '')
  try { return new URL(s).pathname || '/' } catch { return s.startsWith('/') ? s : '/' + s }
}
</script>

<template>
  <section class="rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 class="text-[13px] font-medium">Сильные страницы</h2>
      <span class="text-[11.5px] text-muted-foreground">ключей / потенциал</span>
    </div>

    <EmptyState v-if="!pages.length" compact hint="Страницы появятся после разбора сайта." />
    <div v-else class="space-y-0.5 p-2">
      <div v-for="p in pages" :key="p.url" class="rounded-lg px-2 py-2 transition-colors hover:bg-surface-2">
        <div class="flex items-center gap-2">
          <span class="min-w-0 flex-1 truncate text-[12.5px] text-text-2">{{ short(p.url) }}</span>
          <span class="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">{{ nf(p.kws) }} кл.</span>
          <span class="w-14 shrink-0 text-right text-[12px] font-medium tabular-nums text-text-2">{{ fmtK(p.traffic) }}</span>
        </div>
        <span class="mt-1.5 block h-1 overflow-hidden rounded-full bg-surface-hover">
          <span class="block h-full rounded-full bg-gradient-to-r from-brand to-brand-soft" :style="{ width: ((p.traffic || 0) / max) * 100 + '%' }"></span>
        </span>
      </div>
    </div>
  </section>
</template>
