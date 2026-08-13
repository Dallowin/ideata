<script setup lang="ts">
// Из каких типов источников ИИ берёт факты о рынке: свой сайт, СМИ, отзывы,
// конкуренты (agg.citeCats). Канон Peec AI «Domain types» — строки-бары с %.
import { computed } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import type { TrackerAggregates } from '@/composables/useTracker'

const props = defineProps<{
  agg: TrackerAggregates | null
}>()

// «Свой сайт» подсвечиваем — это метрика, за которую и борется контент.
// Категории приходят с бэкенда по-русски и не переводятся; английский вариант
// в списке — только у демо-данных, поэтому ищем оба написания.
const cats = computed(() => (props.agg?.citeCats || []).slice(0, 7))
const isOwn = (label: string) => /свой сайт|own site/i.test(label)
</script>

<template>
  <section class="rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 class="text-[13px] font-medium">{{ $t('monitoring.citeTypes.title') }}</h2>
      <span class="text-[11.5px] text-muted-foreground">{{ $t('monitoring.citeTypes.subtitle') }}</span>
    </div>
    <div class="space-y-1 p-2">
      <EmptyState v-if="!cats.length" compact :hint="$t('monitoring.citeTypes.empty')" />
      <div v-for="c in cats" :key="c.label" class="flex items-center gap-3 rounded-lg px-2 py-2">
        <span class="w-28 shrink-0 truncate text-[12.5px]" :class="isOwn(c.label) ? 'font-medium text-brand-soft' : 'text-text-2'">{{ c.label }}</span>
        <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover">
          <span
            class="block h-full rounded-full"
            :class="isOwn(c.label) ? 'bg-gradient-to-r from-brand to-brand-soft' : 'bg-muted-foreground/35'"
            :style="{ width: c.pct + '%' }"
          ></span>
        </span>
        <span class="w-9 shrink-0 text-right text-[12.5px] font-medium tabular-nums text-text-2">{{ c.pct }}%</span>
      </div>
    </div>
  </section>
</template>
