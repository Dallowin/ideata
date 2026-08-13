<script setup lang="ts">
// Ссылочный профиль: рост доноров, качество (dofollow / spam) и анкор-лист.
// Для ИИ это сигнал доверия — модели чаще цитируют то, на что ссылаются.
import { computed } from 'vue'
import InteractiveAreaChart from '@/components/charts/InteractiveAreaChart.vue'
import EmptyState from '@/components/EmptyState.vue'
import type { SiteFacts } from '@/composables/useSiteAnalytic'
import { SELF_COLOR, nf } from '@/data/dashboard'

const props = defineProps<{ facts: SiteFacts | null }>()

const anchors = computed(() => (props.facts?.anchors || []).slice(0, 6))
const trend = computed(() => props.facts?.refDomainsTrend || [])
const labels = computed(() => props.facts?.monthLabels || [])
const chartData = computed(() =>
  trend.value.map((v, i) => ({ date: labels.value[i] || String(i + 1), ref: v })),
)
const series = [{ key: 'ref', label: 'Домены-доноры', color: SELF_COLOR }]
const empty = computed(() => !anchors.value.length && trend.value.length < 2)
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 class="text-[13px] font-medium">Ссылочный профиль</h2>
      <span class="text-[11.5px] text-muted-foreground">
        <template v-if="facts?.dofollowPct != null">dofollow {{ Math.round(facts.dofollowPct) }}%</template>
        <template v-else>из разбора</template>
      </span>
    </div>

    <EmptyState v-if="empty" hint="Профиль доноров соберётся при следующем разборе сайта." />
    <template v-else>
      <div v-if="trend.length >= 2" class="px-2 pt-3">
        <InteractiveAreaChart :data="chartData" :series="series" :height="140" :ticks="4" variant="line" hide-legend />
      </div>

      <div v-if="anchors.length" class="p-3" :class="trend.length >= 2 ? 'border-t border-border' : ''">
        <div class="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground/70">Анкоры ссылок</div>
        <div class="space-y-1.5">
          <div v-for="a in anchors" :key="a.a" class="flex items-center gap-2.5">
            <span class="w-36 shrink-0 truncate text-[12px] text-text-2" :title="a.a">{{ a.a }}</span>
            <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover">
              <span class="block h-full rounded-full bg-muted-foreground/35" :style="{ width: a.pct + '%' }"></span>
            </span>
            <span class="w-8 shrink-0 text-right text-[12px] tabular-nums text-text-2">{{ a.pct }}%</span>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-border px-4 py-2.5 text-[11.5px] text-muted-foreground">
        <span>Доноров <span class="tabular-nums text-foreground">{{ nf(facts?.refDomains) }}</span></span>
        <span>Ссылок <span class="tabular-nums text-foreground">{{ nf(facts?.backlinksTotal) }}</span></span>
        <span v-if="facts?.spamScore != null">Spam <span class="tabular-nums text-foreground">{{ facts.spamScore }}</span></span>
      </div>
    </template>
  </section>
</template>
