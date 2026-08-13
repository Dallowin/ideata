<script setup lang="ts">
// Последние упоминания бренда — реальные сниппеты из ответов движков
// (answers с self=true), обрезанные до пары строк.
import { computed } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import type { Platform, PromptRow } from '@/data/prompts'

const props = defineProps<{
  rows: PromptRow[]
  platforms: Platform[]
}>()

const mentions = computed(() => {
  const out: { icon: string; engine: string; prompt: string; text: string }[] = []
  for (const r of props.rows) {
    for (const a of (r.answers || [])) {
      if (!a.self || !a.text) continue
      const p = props.platforms.find((x) => x.key === a.platform)
      out.push({
        icon: p?.icon ?? '/icons/ai/openai.svg',
        engine: p?.label ?? a.platform,
        prompt: r.text,
        text: a.text.replace(/[#*`>\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180),
      })
      if (out.length >= 4) return out
    }
  }
  return out
})
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 class="text-[13px] font-medium">{{ $t('monitoring.mentions.title') }}</h2>
      <span v-if="mentions.length" class="text-[11.5px] text-muted-foreground">{{ $t('monitoring.mentions.subtitle') }}</span>
    </div>
    <EmptyState v-if="!mentions.length" :hint="$t('monitoring.mentions.empty')" />
    <div v-else class="divide-y divide-white/[0.04]">
      <div v-for="m in mentions" :key="m.prompt + m.engine" class="flex gap-3 px-4 py-3 transition-colors hover:bg-surface-2">
        <img :src="m.icon" :alt="m.engine" class="mt-0.5 size-5 shrink-0 rounded-full bg-surface-2 p-0.5" />
        <div class="min-w-0 flex-1">
          <p class="line-clamp-2 text-[12.5px] leading-snug text-text-2">{{ m.text }}…</p>
          <div class="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground/80">
            <span class="font-medium text-muted-foreground">{{ m.engine }}</span>
            <span class="size-0.5 rounded-full bg-current opacity-50"></span>
            <span class="truncate">{{ m.prompt }}</span>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
