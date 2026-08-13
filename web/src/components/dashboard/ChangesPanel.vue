<script setup lang="ts">
// «Что изменилось с прошлого прогона» — диф с бэкенда (agg.changes): где
// бренд появился и где пропал, куда сдвинулась позиция, какие домены-источники
// пришли и ушли. Все ответы каждого прогона хранятся в aeo_answers, диф
// считается по ним же — цифры сходятся с остальными панелями.
import { computed } from 'vue'
import { ArrowDown, ArrowUp, Minus, Plus } from 'lucide-vue-next'
import EmptyState from '@/components/EmptyState.vue'
import type { TrackerAggregates } from '@/composables/useTracker'
import { intlLocale } from '@/i18n'

const props = defineProps<{
  agg: TrackerAggregates | null
  platforms?: { key: string; label: string; icon: string }[]
  loading?: boolean
}>()

const ch = computed(() => props.agg?.changes || null)
const metrics = computed(() => ch.value?.metrics || [])
const rivals = computed(() => (ch.value?.rivals || []).slice(0, 4))
const gained = computed(() => ch.value?.gained || [])
const lost = computed(() => ch.value?.lost || [])
const visMoves = computed(() => (ch.value?.visMoves || []).slice(0, 5))
const moves = computed(() => (ch.value?.posMoves || []).slice(0, 4))
const newSources = computed(() => (ch.value?.newSources || []).slice(0, 6))
const goneSources = computed(() => (ch.value?.goneSources || []).slice(0, 6))

const empty = computed(() =>
  !metrics.value.length && !rivals.value.length && !gained.value.length && !lost.value.length
  && !moves.value.length && !visMoves.value.length
  && !newSources.value.length && !goneSources.value.length)

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short' }) : ''
const platLabel = (key: string) => props.platforms?.find((p) => p.key === key)?.label || key
const brandShort = (b: string) => String(b || '').replace(/^www\./, '')
/** «42% → 35%» для долей и «1,5 → 3,0» для позиции (разделитель — по языку) */
const fmtVal = (v: number, unit: string) =>
  (unit === 'pos' ? v.toLocaleString(intlLocale()) : `${v}%`)
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
      <div>
        <h2 class="text-[13px] font-medium">{{ $t('monitoring.changes.title') }}</h2>
        <p class="mt-0.5 text-[11.5px] text-muted-foreground">
          <template v-if="ch?.prevRunAt">
            {{ $t('monitoring.changes.compare', { last: fmtDate(ch.lastRunAt), prev: fmtDate(ch.prevRunAt) }) }}
          </template>
          <template v-else>{{ $t('monitoring.changes.subtitle') }}</template>
        </p>
      </div>
      <div v-if="!loading && (gained.length || lost.length)" class="flex items-center gap-2 text-[11.5px]">
        <span v-if="gained.length" class="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-emerald-300">
          <Plus :size="10" />{{ $t('monitoring.changes.gainedBadge', gained.length) }}
        </span>
        <span v-if="lost.length" class="inline-flex items-center gap-1 rounded-full border border-rose-500/25 bg-rose-500/10 px-2 py-0.5 text-rose-300">
          <Minus :size="10" />{{ $t('monitoring.changes.lostBadge', { n: lost.length }) }}
        </span>
      </div>
    </div>

    <div v-if="loading" class="py-12 text-center text-[13px] text-muted-foreground">{{ $t('state.loading') }}</div>
    <EmptyState
      v-else-if="!ch?.prevRunAt"
      :title="$t('monitoring.changes.noPrevTitle')"
      :hint="$t('monitoring.changes.noPrevHint')"
    />
    <EmptyState
      v-else-if="empty"
      :title="$t('monitoring.changes.sameTitle')"
      :hint="$t('monitoring.changes.sameHint')"
    />

    <!-- метрики монитора: всё, что ушло за порог значимости -->
    <template v-else>
    <div v-if="metrics.length || rivals.length" class="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-4 py-3">
      <span v-for="m in metrics" :key="m.key" class="inline-flex items-baseline gap-1.5 text-[12.5px]">
        <span class="text-muted-foreground">{{ m.label }}</span>
        <span class="tabular-nums text-muted-foreground/70">{{ fmtVal(m.from, m.unit) }}</span>
        <component :is="m.good ? ArrowUp : ArrowDown" :size="11" :class="m.good ? 'text-emerald-400' : 'text-rose-400'" />
        <span class="font-medium tabular-nums" :class="m.good ? 'text-emerald-400' : 'text-rose-400'">{{ fmtVal(m.to, m.unit) }}</span>
      </span>

      <span
        v-for="r in rivals" :key="r.brand"
        class="inline-flex items-baseline gap-1.5 rounded-full border px-2.5 py-1 text-[12px]"
        :class="r.passedUs || r.diverged ? 'border-rose-500/25 bg-rose-500/[0.07]' : 'border-border bg-surface-2'"
      >
        <span :class="r.passedUs || r.diverged ? 'text-rose-300' : 'text-muted-foreground'">{{ brandShort(r.brand) }}</span>
        <span class="tabular-nums text-muted-foreground/70">{{ r.from }}% → {{ r.to }}%</span>
        <span v-if="r.passedUs" class="text-[11px] text-rose-300">{{ $t('monitoring.changes.passedUs') }}</span>
      </span>
    </div>

    <div class="grid gap-px bg-border sm:grid-cols-2">
      <!-- появились / пропали -->
      <div class="space-y-3 bg-background p-4">
        <div v-if="gained.length">
          <div class="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-emerald-400/90">
            <Plus :size="11" /> {{ $t('monitoring.changes.gained') }}
          </div>
          <div v-for="g in gained.slice(0, 5)" :key="g.prompt" class="py-1">
            <div class="truncate text-[12.5px] text-text-2">{{ g.prompt }}</div>
            <div v-if="g.platforms?.length" class="mt-0.5 truncate text-[11px] text-muted-foreground/70">
              {{ g.platforms.map(platLabel).join(', ') }}
            </div>
          </div>
          <div v-if="gained.length > 5" class="pt-1 text-[11px] text-muted-foreground/60">{{ $t('monitoring.changes.andMore', { n: gained.length - 5 }) }}</div>
        </div>

        <div v-if="lost.length" :class="gained.length ? 'border-t border-border pt-3' : ''">
          <div class="mb-1.5 flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-rose-400/90">
            <Minus :size="11" /> {{ $t('monitoring.changes.lost') }}
          </div>
          <div v-for="l in lost.slice(0, 5)" :key="l.prompt" class="py-1">
            <div class="truncate text-[12.5px] text-text-2">{{ l.prompt }}</div>
            <div v-if="l.platforms?.length" class="mt-0.5 truncate text-[11px] text-muted-foreground/70">
              {{ $t('monitoring.changes.wasIn', { list: l.platforms.map(platLabel).join(', ') }) }}
            </div>
          </div>
          <div v-if="lost.length > 5" class="pt-1 text-[11px] text-muted-foreground/60">{{ $t('monitoring.changes.andMore', { n: lost.length - 5 }) }}</div>
        </div>

        <p v-if="!gained.length && !lost.length" class="text-[12.5px] text-muted-foreground/60">
          {{ $t('monitoring.changes.noPromptChanges') }}
        </p>
      </div>

      <!-- охват, позиции и источники -->
      <div class="space-y-3 bg-background p-4">
        <div v-if="visMoves.length">
          <div class="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/70">{{ $t('monitoring.changes.engineReach') }}</div>
          <div v-for="m in visMoves" :key="m.prompt" class="flex items-center gap-2 py-1">
            <span class="min-w-0 flex-1 truncate text-[12.5px] text-text-2">{{ m.prompt }}</span>
            <span
              class="inline-flex shrink-0 items-center gap-1 text-[12px] tabular-nums"
              :class="m.to > m.from ? 'text-emerald-400' : 'text-rose-400'"
            >
              <component :is="m.to > m.from ? ArrowUp : ArrowDown" :size="11" />
              {{ $t('monitoring.changes.enginesMove', { from: m.fromEngines, to: m.toEngines, total: m.total }) }}
            </span>
          </div>
        </div>

        <div v-if="moves.length" :class="visMoves.length ? 'border-t border-border pt-3' : ''">
          <div class="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/70">{{ $t('monitoring.changes.posShift') }}</div>
          <div v-for="m in moves" :key="m.prompt" class="flex items-center gap-2 py-1">
            <span class="min-w-0 flex-1 truncate text-[12.5px] text-text-2">{{ m.prompt }}</span>
            <span
              class="inline-flex shrink-0 items-center gap-1 text-[12px] tabular-nums"
              :class="m.to < m.from ? 'text-emerald-400' : 'text-rose-400'"
            >
              <component :is="m.to < m.from ? ArrowUp : ArrowDown" :size="11" />
              {{ m.from }} → {{ m.to }}
            </span>
          </div>
        </div>

        <div v-if="newSources.length" :class="moves.length || visMoves.length ? 'border-t border-border pt-3' : ''">
          <div class="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/70">{{ $t('monitoring.changes.newSources') }}</div>
          <div class="flex flex-wrap gap-1">
            <span
              v-for="s in newSources" :key="s.host"
              class="rounded-full border border-emerald-500/20 bg-emerald-500/[0.07] px-2 py-0.5 text-[11px] text-emerald-300/90"
            >{{ s.host }} <span class="tabular-nums opacity-70">×{{ s.n }}</span></span>
          </div>
        </div>

        <div v-if="goneSources.length" :class="moves.length || visMoves.length || newSources.length ? 'border-t border-border pt-3' : ''">
          <div class="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/70">{{ $t('monitoring.changes.goneSources') }}</div>
          <div class="flex flex-wrap gap-1">
            <span
              v-for="s in goneSources" :key="s.host"
              class="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-muted-foreground"
            >{{ s.host }}</span>
          </div>
        </div>

        <p v-if="!moves.length && !visMoves.length && !newSources.length && !goneSources.length" class="text-[12.5px] text-muted-foreground/60">
          {{ $t('monitoring.changes.noOtherChanges') }}
        </p>
      </div>
    </div>
    </template>
  </section>
</template>
