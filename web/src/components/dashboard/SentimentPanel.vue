<script setup lang="ts">
/**
 * За что ИИ вас хвалит и ругает (agg.sentThemes: {t, tone}).
 *
 * Баллы тональности переехали колонкой в «Вы и конкуренты» (канон Peec AI:
 * Brand · Visibility · Sentiment · Position одной таблицей) — оценка имеет
 * смысл только рядом с конкурентом: 58 плохо это или нормально, видно лишь
 * когда рядом 72. Здесь остаётся то, что в таблицу не влезает и ради чего
 * блок вообще существует: формулировки, которыми вас описывают.
 */
import { computed } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import type { TrackerAggregates } from '@/composables/useTracker'

const props = defineProps<{
  agg: TrackerAggregates | null
}>()

const themes = computed(() =>
  (props.agg?.sentThemes || [])
    .map((t: any) => (typeof t === 'string' ? { t, tone: 'neutral' } : t))
    .filter((t: any) => t?.t),
)

const CHIP: Record<string, string> = {
  good: 'border-success/25 bg-success-soft text-success',
  neutral: 'border-border bg-surface-2 text-muted-foreground',
  bad: 'border-danger/25 bg-danger-soft text-danger',
}
</script>

<template>
  <section class="rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 class="text-[13px] font-medium">{{ $t('monitoring.sentiment.title') }}</h2>
      <span class="text-[11.5px] text-muted-foreground">{{ $t('monitoring.sentiment.subtitle') }}</span>
    </div>

    <EmptyState
      v-if="!themes.length"
      :hint="$t('monitoring.themesLater')"
    />
    <div v-else class="flex flex-wrap gap-1.5 p-4">
      <span
        v-for="t in themes" :key="t.t"
        class="rounded-full border px-2.5 py-1 text-[11.5px]"
        :class="CHIP[t.tone] || CHIP.neutral"
      >{{ t.t }}</span>
    </div>
  </section>
</template>
