<script setup lang="ts">
// Конкуренты по данным разбора (не по AEO-трекеру): органика, рост, общие
// ключи, авторитет. Бейдж источника показывает, откуда конкурент взялся —
// его назвал ИИ или он нашёлся по пересечению семантики.
import { computed } from 'vue'
import EmptyState from '@/components/EmptyState.vue'
import type { SiteFacts } from '@/composables/useSiteAnalytic'
import { faviconSrc } from '@/data/prompts'
import { fmtK, nf } from '@/data/dashboard'

const props = defineProps<{ facts: SiteFacts | null }>()

const rows = computed(() => (props.facts?.competitors || []).slice(0, 8))

const SOURCE: Record<string, { label: string; class: string }> = {
  ai: { label: 'ИИ называет', class: 'border-violet-500/25 bg-violet-500/10 text-violet-300' },
  seo: { label: 'по семантике', class: 'border-border bg-surface-hover text-muted-foreground' },
}
function onFaviconError(e: Event, host: string) {
  const img = e.target as HTMLImageElement
  const fb = `https://www.google.com/s2/favicons?domain=${host}&sz=64`
  if (img.src !== fb) img.src = fb
}
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <h2 class="text-[13px] font-medium">Конкуренты по разбору</h2>
      <span class="text-[11.5px] text-muted-foreground">органика и семантика</span>
    </div>

    <EmptyState v-if="!rows.length" hint="Конкуренты определяются во время разбора сайта — по пересечению семантики и по ответам ИИ." />
    <div v-else class="overflow-x-auto">
      <table class="w-full min-w-[520px] text-[12.5px]">
        <thead>
          <tr class="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground/70">
            <th class="px-4 py-2 text-left font-medium">Домен</th>
            <th class="w-[84px] px-2 py-2 text-right font-medium">Трафик</th>
            <th class="w-[70px] px-2 py-2 text-right font-medium">Рост</th>
            <th class="w-[86px] px-2 py-2 text-right font-medium">Общих кл.</th>
            <th class="w-[54px] px-4 py-2 text-right font-medium">DR</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-white/[0.04]">
          <tr v-for="c in rows" :key="c.domain" class="hover:bg-surface">
            <td class="px-4 py-2.5">
              <div class="flex min-w-0 items-center gap-2">
                <img :src="faviconSrc(c.domain)" width="14" height="14" class="shrink-0 rounded-sm" loading="lazy" @error="onFaviconError($event, c.domain)" />
                <span class="truncate text-text-2">{{ c.domain }}</span>
                <span
                  v-if="c.source && SOURCE[c.source]"
                  class="shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] whitespace-nowrap"
                  :class="SOURCE[c.source]!.class"
                >
                  {{ SOURCE[c.source]!.label }}<template v-if="c.source === 'ai' && c.mentions"> ×{{ c.mentions }}</template>
                </span>
              </div>
            </td>
            <td class="px-2 py-2.5 text-right tabular-nums text-text-2">{{ fmtK(c.traffic) }}</td>
            <td class="px-2 py-2.5 text-right tabular-nums"
                :class="(c.growth ?? 0) > 0 ? 'text-emerald-400' : (c.growth ?? 0) < 0 ? 'text-rose-400' : 'text-muted-foreground/50'">
              <template v-if="c.growth != null">{{ c.growth > 0 ? '+' : '' }}{{ c.growth }}%</template>
              <template v-else>—</template>
            </td>
            <td class="px-2 py-2.5 text-right tabular-nums text-muted-foreground">{{ nf(c.shared) }}</td>
            <td class="px-4 py-2.5 text-right tabular-nums text-muted-foreground">{{ c.dr ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
