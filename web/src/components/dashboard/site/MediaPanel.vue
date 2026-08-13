<script setup lang="ts">
// Что говорят о бренде в медиа: видео и публикации, найденные разбором.
// Это площадки, с которых модели чаще всего и берут мнение о бренде.
import { computed } from 'vue'
import { ArrowUpRight, FileText, Youtube } from 'lucide-vue-next'
import EmptyState from '@/components/EmptyState.vue'
import type { SiteFacts } from '@/composables/useSiteAnalytic'

const props = defineProps<{ facts: SiteFacts | null }>()

const items = computed(() => (props.facts?.mediaMentions || []).slice(0, 6))
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 class="text-[13px] font-medium">Медиа о бренде</h2>
      <span class="text-[11.5px] text-muted-foreground">видео и пресса</span>
    </div>

    <EmptyState v-if="!items.length" hint="Упоминания в видео и прессе собираются во время разбора сайта." />
    <div v-else class="divide-y divide-white/[0.04]">
      <a
        v-for="m in items" :key="m.url" :href="m.url" target="_blank" rel="noopener"
        class="group flex gap-3 px-4 py-3 transition-colors hover:bg-surface-2"
      >
        <component
          :is="m.platform === 'youtube' ? Youtube : FileText" :size="15"
          class="mt-0.5 shrink-0" :class="m.platform === 'youtube' ? 'text-rose-400/80' : 'text-muted-foreground'"
        />
        <div class="min-w-0 flex-1">
          <div class="flex items-start gap-1">
            <span class="line-clamp-2 text-[12.5px] leading-snug text-text-2">{{ m.title }}</span>
            <ArrowUpRight :size="12" class="mt-0.5 shrink-0 text-muted-foreground/0 transition group-hover:text-muted-foreground" />
          </div>
          <div class="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground/80">
            <span v-if="m.author" class="truncate">{{ m.author }}</span>
            <template v-if="m.metric">
              <span class="size-0.5 rounded-full bg-current opacity-50"></span>
              <span class="shrink-0">{{ m.metric }}</span>
            </template>
          </div>
        </div>
      </a>
    </div>
  </section>
</template>
