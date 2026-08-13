<script setup lang="ts">
/**
 * Карточки сравнения: свой бренд и каждый конкурент одной плиткой.
 *
 * Плитка отвечает на три вопроса сразу — сколько у него сейчас, куда он идёт
 * (спарклайн по дням) и насколько он близко к нам (отрыв в пп). Таблица ниже
 * даёт то же в столбик для сравнения по колонкам, но «кто наступает на пятки»
 * читается именно с карточек.
 */
import { computed } from 'vue'
import { Plus, X } from 'lucide-vue-next'
import BrandMark from '@/components/dashboard/BrandMark.vue'
import { brandLabel, posFmt } from '@/data/dashboard'
import type { RivalRow } from '@/data/competitors'

const props = defineProps<{
  rows: RivalRow[]
  loading?: boolean
  /** список конкурентов правится (есть трекер и права) */
  editable?: boolean
}>()
const emit = defineEmits<{ remove: [string]; add: [] }>()

/** Спарклайн: ось от нуля не тянем — на карточке важна форма, а не масштаб. */
function spark(s: number[], w = 96, h = 26): string {
  if (s.length < 2) return ''
  const min = Math.min(...s)
  const max = Math.max(...s)
  const span = max - min || 1
  return s
    .map((v, i) => `${((i / (s.length - 1)) * w).toFixed(1)},${(2 + (1 - (v - min) / span) * (h - 4)).toFixed(1)}`)
    .join(' ')
}

const toneClass = (v: number) => (v >= 65 ? 'text-success' : v >= 45 ? 'text-warning' : 'text-danger')

// Свободные места в сравнении: бэк берёт максимум четырёх соперников, поэтому
// плитку «добавить» показываем, только пока есть куда добавлять.
const LIMIT = 4
const freeSlot = computed(() => props.editable && props.rows.filter((r) => !r.self).length < LIMIT)
</script>

<template>
  <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
    <article
      v-for="r in rows" :key="r.brand"
      class="group relative flex flex-col rounded-xl border bg-surface p-4"
      :class="r.self ? 'border-brand/35 bg-brand/[0.05]' : 'border-border'"
    >
      <div class="flex items-center gap-2">
        <BrandMark :brand="r.brand" :color="r.color" :size="16" />
        <span class="min-w-0 flex-1 truncate text-[13px] font-medium">{{ brandLabel(r.brand) }}</span>
        <span
          v-if="r.self"
          class="shrink-0 rounded-full border border-border bg-surface-hover px-1.5 py-0.5 text-[10px] text-muted-foreground"
        >{{ $t('monitoring.you') }}</span>
        <button
          v-else-if="editable" type="button"
          class="shrink-0 rounded-md p-1 text-muted-foreground/50 transition hover:bg-surface-hover hover:text-rose-300"
          :title="$t('competitors.cards.remove', { domain: brandLabel(r.brand) })"
          :aria-label="$t('competitors.cards.remove', { domain: brandLabel(r.brand) })"
          @click="emit('remove', r.brand)"
        ><X :size="13" /></button>
      </div>

      <div class="mt-3 flex items-end justify-between gap-3">
        <div>
          <div class="flex items-baseline gap-2">
            <span class="text-[28px] font-semibold leading-none tracking-tight tabular-nums">{{ r.vis }}%</span>
            <span
              v-if="r.delta"
              class="rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums"
              :class="r.delta > 0 ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'"
            >{{ r.delta > 0 ? '+' : '' }}{{ r.delta }}</span>
          </div>
          <div class="mt-1 text-[11.5px] text-muted-foreground">{{ $t('competitors.cards.vis') }}</div>
        </div>
        <!-- одна точка истории — не динамика: линию из неё не рисуем -->
        <svg v-if="spark(r.trend)" viewBox="0 0 96 26" class="h-[26px] w-24 shrink-0" preserveAspectRatio="none" aria-hidden="true">
          <polyline :points="spark(r.trend)" fill="none" :stroke="r.color" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.9" />
        </svg>
      </div>

      <div class="mt-3.5 grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
        <div>
          <div class="text-[13px] font-medium tabular-nums">{{ r.sov }}%</div>
          <div class="mt-0.5 text-[10.5px] text-muted-foreground">{{ $t('monitoring.col.sov') }}</div>
        </div>
        <div>
          <div class="text-[13px] font-medium tabular-nums">{{ posFmt(r.pos) }}</div>
          <div class="mt-0.5 text-[10.5px] text-muted-foreground">{{ $t('monitoring.col.pos') }}</div>
        </div>
        <div>
          <div class="text-[13px] font-medium tabular-nums" :class="r.sent == null ? 'text-muted-foreground/40' : toneClass(r.sent)">
            {{ r.sent == null ? '—' : r.sent }}
          </div>
          <div class="mt-0.5 text-[10.5px] text-muted-foreground">{{ $t('monitoring.col.tone') }}</div>
        </div>
      </div>

      <!-- строка отрыва: у своей карточки её нет — сравнивать себя не с кем -->
      <p v-if="!r.self" class="mt-3 text-[11.5px] leading-[1.5] text-muted-foreground">
        <span :class="r.gap > 0 ? 'text-success' : r.gap < 0 ? 'text-danger' : ''">
          {{ r.gap > 0 ? $t('competitors.cards.ahead', { n: Math.abs(r.gap) }) : r.gap < 0 ? $t('competitors.cards.behind', { n: Math.abs(r.gap) }) : $t('competitors.cards.even') }}
        </span>
        <template v-if="r.wins"> · {{ $t('competitors.cards.wins', { n: r.wins }) }}</template>
      </p>
    </article>

    <button
      v-if="freeSlot" type="button"
      class="flex min-h-[168px] flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-border text-muted-foreground transition hover:border-brand/40 hover:text-foreground"
      @click="emit('add')"
    >
      <Plus :size="16" />
      <span class="text-[12.5px] font-medium">{{ $t('competitors.cards.add') }}</span>
      <span class="text-[11px] text-muted-foreground/70">{{ $t('competitors.cards.addHint', { n: LIMIT - rows.filter((x) => !x.self).length }) }}</span>
    </button>
  </div>
</template>
