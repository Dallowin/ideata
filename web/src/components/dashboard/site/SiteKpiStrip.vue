<script setup lang="ts">
// KPI AI-разбора сайта (без трафика — он живёт на «Трафике» из Метрики/GSC).
import { computed } from 'vue'
import type { SiteFacts } from '@/composables/useSiteAnalytic'
import { nf } from '@/data/dashboard'

const props = defineProps<{ facts: SiteFacts | null }>()

const cells = computed(() => {
  const f = props.facts || {}
  return [
    { key: 'authority', l: 'Авторитет домена', hint: 'по ссылочному профилю', v: f.authority == null ? '—' : String(f.authority) },
    { key: 'kw', l: 'Ключей в видимости', hint: 'органика в регионе разбора', v: nf(f.kwTotal) },
    { key: 'ref', l: 'Доменов-доноров', hint: f.backlinksTotal ? `${nf(f.backlinksTotal)} ссылок` : 'ссылаются на сайт', v: nf(f.refDomains) },
    { key: 'perf', l: 'PageSpeed', hint: 'мобильный, 0–100', v: f.perfScore == null ? '—' : String(f.perfScore) },
    { key: 'spam', l: 'Spam score', hint: f.dofollowPct == null ? 'токсичность доноров' : `dofollow — ${Math.round(f.dofollowPct)}%`, v: f.spamScore == null ? '—' : String(f.spamScore) },
  ]
})

// PageSpeed и spam красим по порогам — это оценки, а не нейтральные числа
const tone = (key: string, raw?: number | null) => {
  if (raw == null) return ''
  if (key === 'perf') return raw >= 90 ? 'text-emerald-400' : raw >= 50 ? 'text-amber-400' : 'text-rose-400'
  if (key === 'spam') return raw <= 5 ? 'text-emerald-400' : raw <= 15 ? 'text-amber-400' : 'text-rose-400'
  return ''
}
const rawOf = (key: string) => (key === 'perf' ? props.facts?.perfScore : key === 'spam' ? props.facts?.spamScore : null)
</script>

<template>
  <section class="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface sm:grid-cols-3 lg:grid-cols-5 lg:divide-y-0">
    <div v-for="c in cells" :key="c.key" class="min-w-0 px-4 py-3.5 sm:px-5">
      <div class="truncate text-[11.5px] text-muted-foreground">{{ c.l }}</div>
      <div class="mt-1.5 text-[24px] font-semibold leading-none tracking-tight tabular-nums" :class="tone(c.key, rawOf(c.key))">{{ c.v }}</div>
      <div class="mt-1 truncate text-[11px] text-muted-foreground/60">{{ c.hint }}</div>
    </div>
  </section>
</template>
