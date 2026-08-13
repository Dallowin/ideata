<script setup lang="ts">
// Топ промптов по видимости — реальные строки трекера.
import { computed } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import type { Platform, PromptRow } from '@/data/prompts'

const props = defineProps<{
  rows: PromptRow[]
  platforms: Platform[]
}>()

const top = computed(() => [...props.rows].sort((a, b) => b.vis - a.vis).slice(0, 6))
const platMeta = (key: string) => props.platforms.find((p) => p.key === key)
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 class="text-[13px] font-medium">{{ $t('monitoring.prompts.title') }}</h2>
      <RouterLink to="/prompts" class="text-[11.5px] text-muted-foreground transition hover:text-foreground">
        {{ rows.length ? $t('monitoring.prompts.active', rows.length) : $t('monitoring.prompts.all') }} →
      </RouterLink>
    </div>
    <EmptyState v-if="!top.length" :hint="$t('monitoring.prompts.empty')" />
    <div v-else class="divide-y divide-white/[0.04]">
      <RouterLink
        v-for="r in top" :key="r.id" to="/prompts"
        class="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2"
      >
        <span class="flex-1 truncate text-[12.5px] text-text-2">{{ r.text }}</span>
        <span class="flex shrink-0 -space-x-1.5">
          <template v-for="p in platforms" :key="p.key">
            <img
              v-if="(r.engines[p.key] ?? 0) > 0"
              :src="platMeta(p.key)?.icon" :alt="p.label" :title="p.label"
              class="size-[18px] rounded-full bg-surface-2 p-0.5 ring-2 ring-background"
            />
          </template>
        </span>
        <span class="w-11 shrink-0 text-right text-[12.5px] font-medium tabular-nums" :class="r.vis > 50 ? 'text-emerald-400' : 'text-muted-foreground'">{{ r.vis }}%</span>
      </RouterLink>
    </div>
  </section>
</template>
