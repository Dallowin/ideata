<script setup lang="ts">
// План действий из разбора: приоритеты сверху, ниже — задачи с обоснованием,
// оценкой «выхлоп / усилие» и пошаговым как-делать (раскрывается по клику).
import { computed, ref } from 'vue'
import { ChevronDown } from 'lucide-vue-next'
import EmptyState from '@/components/EmptyState.vue'
import type { SiteFacts } from '@/composables/useSiteAnalytic'

const props = defineProps<{ facts: SiteFacts | null }>()

const priorities = computed(() => props.facts?.priorities || [])
// сортируем по выхлопу, при равном — по меньшему усилию: сверху то, что стоит брать первым
const plan = computed(() =>
  [...(props.facts?.plan || [])].sort((a, b) => (b.impact ?? 0) - (a.impact ?? 0) || (a.effort ?? 0) - (b.effort ?? 0)),
)

const open = ref(new Set<string>())
const toggle = (t: string) => {
  const next = new Set(open.value)
  next.has(t) ? next.delete(t) : next.add(t)
  open.value = next
}
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <div>
        <h2 class="text-[13px] font-medium">План действий</h2>
        <p class="mt-0.5 text-[11.5px] text-muted-foreground">Что делать, чтобы ИИ начал называть вас</p>
      </div>
      <span v-if="plan.length" class="text-[11.5px] text-muted-foreground">{{ plan.length }} задач</span>
    </div>

    <EmptyState
      v-if="!plan.length && !priorities.length"
      hint="План строит LLM-слой по ответам движков — появится вместе со следующим разбором."
    />
    <template v-else>
      <!-- приоритеты -->
      <div v-if="priorities.length" class="space-y-1.5 border-b border-border bg-surface px-4 py-3">
        <div class="text-[11px] uppercase tracking-wide text-muted-foreground/70">Главное сейчас</div>
        <div v-for="(p, i) in priorities" :key="p.t" class="flex gap-2 text-[12.5px] text-text-2">
          <span class="shrink-0 tabular-nums text-muted-foreground/60">{{ i + 1 }}.</span>
          <span class="min-w-0">{{ p.t }}</span>
        </div>
      </div>

      <!-- задачи -->
      <div class="divide-y divide-white/[0.04]">
        <div v-for="p in plan" :key="p.t">
          <button type="button" class="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-surface-2" @click="toggle(p.t)">
            <ChevronDown :size="14" class="mt-0.5 shrink-0 text-muted-foreground/60 transition-transform" :class="open.has(p.t) ? 'rotate-180' : ''" />
            <span class="min-w-0 flex-1">
              <span class="block text-[12.5px] leading-snug text-foreground">{{ p.t }}</span>
              <span v-if="p.why" class="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">{{ p.why }}</span>
            </span>
            <span class="flex shrink-0 items-center gap-2">
              <span v-if="p.ref" class="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10.5px] whitespace-nowrap text-muted-foreground">{{ p.ref }}</span>
              <span v-if="p.impact" class="flex items-center gap-0.5" :title="`Выхлоп ${p.impact} из 5`">
                <span
                  v-for="n in 5" :key="n" class="size-1.5 rounded-full"
                  :class="n <= (p.impact || 0) ? 'bg-emerald-400/80' : 'bg-surface-hover'"
                ></span>
              </span>
            </span>
          </button>

          <div v-if="open.has(p.t)" class="px-4 pb-3 pl-11">
            <ol v-if="p.how?.length" class="space-y-1.5">
              <li v-for="(s, i) in p.how" :key="s" class="flex gap-2 text-[12px] leading-snug text-muted-foreground">
                <span class="shrink-0 tabular-nums text-muted-foreground/50">{{ i + 1 }}.</span>
                <span class="min-w-0">{{ s }}</span>
              </li>
            </ol>
            <p v-else class="text-[12px] text-muted-foreground/60">Шаги не расписаны в этом разборе.</p>
            <p v-if="p.effort" class="mt-2 text-[11px] text-muted-foreground/60">Усилие — {{ p.effort }} из 5</p>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
