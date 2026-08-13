<script setup lang="ts">
// Рейтинг брендов последнего прогона: видимость (полоса в строке), доля
// голоса, средняя позиция, дельта к прошлому прогону. Канон Peec AI
// «Rankings» — компактная таблица рядом с графиком, своя строка подсвечена.
import { computed } from 'vue'
import { Plus } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import type { TrackerAggregates } from '@/composables/useTracker'
import { SELF_COLOR, brandLabel, brandPalette, posFmt } from '@/data/dashboard'
import BrandMark from './BrandMark.vue'

const props = defineProps<{
  agg: TrackerAggregates | null
  loading?: boolean
}>()
const emit = defineEmits<{ 'add-competitors': [] }>()

const palette = computed(() => brandPalette(props.agg))

/**
 * Тональность — колонкой здесь, а не отдельной панелью внизу (канон Peec AI:
 * Brand · Visibility · Sentiment · Position одной таблицей).
 *
 * Своей панелью она отвечала на вопрос «как ко мне относятся» в отрыве от
 * «кто вообще впереди», хотя смысл у оценки появляется только рядом с
 * конкурентом: 58 — это плохо или нормально, видно лишь когда рядом 72.
 */
const sentBy = computed<Record<string, number>>(() => {
  const out: Record<string, number> = {}
  for (const s of props.agg?.rivalSent || []) out[s.brand] = s.score
  return out
})
const hasSent = computed(() => Object.keys(sentBy.value).length > 0)

// 0–100: ниже 45 — скорее негатив, выше 65 — уверенный позитив
const toneClass = (v: number) => (v >= 65 ? 'text-success' : v >= 45 ? 'text-warning' : 'text-danger')

const rows = computed(() =>
  (props.agg?.leaderboard || []).map((r, i) => ({
    ...r, rank: i + 1,
    color: palette.value[r.brand] || SELF_COLOR,
    sent: sentBy.value[r.brand] ?? null,
  })),
)
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <div>
        <h2 class="text-[13px] font-medium">{{ $t('monitoring.leaderboard.title') }}</h2>
        <p class="mt-0.5 text-[11.5px] text-muted-foreground">{{ $t('monitoring.leaderboard.subtitle') }}</p>
      </div>
    </div>

    <div v-if="loading" class="py-14 text-center text-[13px] text-muted-foreground">{{ $t('state.loading') }}</div>
    <!--
      Одна строка — это не рейтинг, а вы напротив пустоты: раньше таблица с
      единственным собой выглядела как честное первое место. Пустое состояние
      начинается с «конкурентов нет», а не с «данных нет».
    -->
    <div v-else-if="rows.length <= 1" class="px-6 py-12 text-center">
      <p class="text-[13px] font-medium">{{ $t('monitoring.leaderboard.emptyTitle') }}</p>
      <!-- Ни слова о том, что кандидаты уже найдены: разбор их предлагает не
           всегда, и обещание в пустом состоянии превращается в обман ровно у
           тех, кому помочь было нечем. -->
      <p class="mx-auto mt-1 max-w-[300px] text-[12px] text-muted-foreground">
        {{ $t('monitoring.leaderboard.emptyHint') }}
      </p>
      <Button class="mt-3" size="sm" variant="outline" @click="emit('add-competitors')">
        <Plus :size="14" /> {{ $t('monitoring.addCompetitors') }}
      </Button>
    </div>
    <table v-else class="w-full text-[12.5px]">
      <thead>
        <tr class="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground/70">
          <th class="px-4 py-2 text-left font-medium">{{ $t('monitoring.col.brand') }}</th>
          <th class="w-[132px] px-2 py-2 text-left font-medium">{{ $t('monitoring.col.visibility') }}</th>
          <th class="w-[68px] px-2 py-2 text-right font-medium">{{ $t('monitoring.col.sov') }}</th>
          <th v-if="hasSent" class="w-[64px] px-2 py-2 text-right font-medium">{{ $t('monitoring.col.tone') }}</th>
          <th class="w-[56px] px-2 py-2 text-right font-medium">{{ $t('monitoring.col.pos') }}</th>
          <th class="w-[58px] px-4 py-2 text-right font-medium">Δ</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-white/[0.04]">
        <tr v-for="r in rows" :key="r.brand" :class="r.self ? 'bg-surface-2' : ''">
          <td class="px-4 py-2.5">
            <div class="flex min-w-0 items-center gap-2">
              <span class="w-3 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground/60">{{ r.rank }}</span>
              <BrandMark :brand="r.brand" :color="r.color" />
              <span class="truncate" :class="r.self ? 'font-medium text-foreground' : 'text-text-2'">{{ brandLabel(r.brand) }}</span>
              <span v-if="r.self" class="shrink-0 rounded-full border border-border bg-surface-hover px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ $t('monitoring.you') }}</span>
            </div>
          </td>
          <td class="px-2 py-2.5">
            <div class="flex items-center gap-2">
              <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover">
                <span class="block h-full rounded-full" :style="{ width: r.vis + '%', background: r.color }"></span>
              </span>
              <span class="w-8 shrink-0 text-right tabular-nums" :class="r.self ? 'font-medium' : 'text-text-2'">{{ r.vis }}%</span>
            </div>
          </td>
          <td class="px-2 py-2.5 text-right tabular-nums text-text-2">{{ r.sov }}%</td>
          <!-- Прочерк, а не ноль: судья оценивает бренд только там, где тот
               упомянут, и «нет оценки» ≠ «оценили на ноль». -->
          <td v-if="hasSent" class="px-2 py-2.5 text-right tabular-nums"
              :class="r.sent == null ? 'text-muted-foreground/40' : toneClass(r.sent)">
            {{ r.sent == null ? '—' : r.sent }}
          </td>
          <td class="px-2 py-2.5 text-right tabular-nums text-text-2">{{ posFmt(r.pos) }}</td>
          <td class="px-4 py-2.5 text-right tabular-nums"
              :class="r.delta > 0 ? 'text-emerald-400' : r.delta < 0 ? 'text-rose-400' : 'text-muted-foreground/50'">
            {{ r.delta > 0 ? '+' : '' }}{{ r.delta || '—' }}
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>
