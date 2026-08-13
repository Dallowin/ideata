<script setup lang="ts">
// Техническая база под ИИ-ответы: Core Web Vitals, готовность к краулу
// LLM-агентами (robots / llms.txt / schema) и тех-стек сайта.
import { computed } from 'vue'
import { Check, Minus, X } from 'lucide-vue-next'
import EmptyState from '@/components/EmptyState.vue'
import type { SiteFacts } from '@/composables/useSiteAnalytic'

const props = defineProps<{ facts: SiteFacts | null }>()

// пороги Core Web Vitals — гуглевские, чтобы цвет означал то же, что в PSI
const vitals = computed(() => {
  const f = props.facts || {}
  const mk = (label: string, v: number | null | undefined, fmt: (n: number) => string, good: number, mid: number) => ({
    label,
    value: v == null ? '—' : fmt(v),
    tone: v == null ? '' : v <= good ? 'text-emerald-400' : v <= mid ? 'text-amber-400' : 'text-rose-400',
  })
  return [
    mk('LCP', f.lcp, (n) => n.toFixed(1).replace('.', ',') + ' с', 2.5, 4),
    mk('CLS', f.cls, (n) => String(Math.round(n * 100) / 100).replace('.', ','), 0.1, 0.25),
    mk('INP', f.inp, (n) => Math.round(n) + ' мс', 200, 500),
  ]
})

const crawl = computed(() => props.facts?.crawl || null)
const checks = computed(() => {
  const c = crawl.value
  if (!c) return []
  return [
    { label: 'robots.txt', ok: !!c.has_robots && !c.robots_blocks_all, note: c.robots_blocks_all ? 'закрывает весь сайт' : '' },
    { label: 'sitemap.xml', ok: !!c.has_sitemap, note: '' },
    { label: 'llms.txt', ok: !!c.has_llms_txt, note: c.has_llms_txt ? '' : 'даёт LLM карту сайта' },
    { label: 'FAQ-разметка', ok: !!c.has_faq_schema, note: c.has_faq_schema ? '' : 'усиливает попадание в ответы' },
    { label: 'Title и description', ok: !!(c.title && c.description), note: '' },
  ]
})

const tech = computed(() => Object.entries(props.facts?.tech || {}).filter(([, v]) => Array.isArray(v) && v.length))
const empty = computed(() => !crawl.value && !tech.value.length && props.facts?.perfScore == null)
</script>

<template>
  <section class="rounded-xl border border-border bg-surface">
    <div class="flex items-center justify-between border-b border-border px-4 py-3">
      <div>
        <h2 class="text-[13px] font-medium">Техническая база</h2>
        <p class="mt-0.5 text-[11.5px] text-muted-foreground">Скорость, готовность к ИИ-краулу и стек сайта</p>
      </div>
    </div>

    <EmptyState v-if="empty" hint="Технические факты собираются краулером во время разбора сайта." />
    <div v-else class="grid gap-px bg-border sm:grid-cols-3">
      <!-- Core Web Vitals -->
      <div class="bg-background p-4">
        <div class="text-[11px] uppercase tracking-wide text-muted-foreground/70">Core Web Vitals</div>
        <div class="mt-3 space-y-2.5">
          <div v-for="v in vitals" :key="v.label" class="flex items-baseline justify-between gap-2">
            <span class="text-[12.5px] text-text-2">{{ v.label }}</span>
            <span class="text-[13px] font-medium tabular-nums" :class="v.tone">{{ v.value }}</span>
          </div>
        </div>
      </div>

      <!-- готовность к краулу -->
      <div class="bg-background p-4">
        <div class="text-[11px] uppercase tracking-wide text-muted-foreground/70">Готовность к ИИ-краулу</div>
        <div class="mt-3 space-y-2">
          <div v-for="c in checks" :key="c.label" class="flex items-start gap-2">
            <component
              :is="c.ok ? Check : X" :size="13"
              class="mt-0.5 shrink-0" :class="c.ok ? 'text-emerald-400' : 'text-rose-400/80'"
            />
            <span class="min-w-0 text-[12.5px] text-text-2">
              {{ c.label }}
              <span v-if="c.note" class="block text-[11px] text-muted-foreground/70">{{ c.note }}</span>
            </span>
          </div>
          <div v-if="crawl?.schema_types?.length" class="flex flex-wrap gap-1 pt-1">
            <span
              v-for="s in crawl.schema_types" :key="s"
              class="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10.5px] text-muted-foreground"
            >{{ s }}</span>
          </div>
        </div>
      </div>

      <!-- тех-стек -->
      <div class="bg-background p-4">
        <div class="text-[11px] uppercase tracking-wide text-muted-foreground/70">Стек</div>
        <div v-if="tech.length" class="mt-3 space-y-2.5">
          <div v-for="[group, items] in tech" :key="group">
            <div class="text-[11px] text-muted-foreground/70">{{ group }}</div>
            <div class="mt-1 flex flex-wrap gap-1">
              <span
                v-for="t in items" :key="t"
                class="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-text-2"
              >{{ t }}</span>
            </div>
          </div>
        </div>
        <div v-else class="mt-3 flex items-center gap-1.5 text-[12px] text-muted-foreground/60">
          <Minus :size="12" /> не определён
        </div>
      </div>
    </div>
  </section>
</template>
