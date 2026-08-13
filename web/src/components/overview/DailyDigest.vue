<script setup lang="ts">
// Сводка — крупным типографским блоком с воздухом (референс Адиля: «Remote3
// shows up 8% of the time in AI answers»): пара живых фраз с инлайн-иконками
// бренда и движка и подсвеченными числами, без карточек и буллетов.
// Данные реальные: agg.kpi + agg.platMatrix + agg.changes.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { TrackerAggregates } from '@/composables/useTracker'
import { faviconSrc, platformsFor } from '@/data/prompts'

const { t } = useI18n()

const props = defineProps<{
  agg: TrackerAggregates | null
  domain?: string
  loading?: boolean
  greeting?: string
}>()

const vis = computed(() => props.agg?.kpi?.visScore ?? null)
const delta = computed(() => props.agg?.kpi?.visDelta ?? 0)

// движок, где бренд виден лучше всего — из своей строки матрицы
const bestEngine = computed(() => {
  const row = props.agg?.platMatrix?.find((r) => r.self)
  const keys = props.agg?.platforms || []
  if (!row || !keys.length) return null
  let bi = -1
  let bv = 0
  row.vals.forEach((v, i) => { if (v > bv) { bv = v; bi = i } })
  if (bi < 0) return null
  const p = platformsFor([keys[bi]!])[0]
  return p ? { ...p, v: bv } : null
})

// «N промптам» / «N новых источников» — числительное со склонённым словом
// отдельным ключом: иначе пришлось бы дублировать всю фразу в четырёх формах
const promptsDat = (n: number) => t('overview.units.promptsDat', { n }, n)
const sourcesCount = (n: number) => t('overview.units.newSources', { n }, n)

// третья строка — самое заметное изменение прогона, если оно есть
const change = computed(() => {
  const c = props.agg?.changes
  if (!c?.prevRunAt) return null
  // самый тревожный сигнал вперёд: конкурент обошёл → просадка охвата → рост
  const passed = (c.rivals || []).find((r) => r.passedUs)
  if (passed) return t('overview.digest.change.passed', { brand: passed.brand, from: passed.from, to: passed.to })
  const drops = (c.visMoves || []).filter((m) => m.to < m.from)
  if (drops.length) {
    return t('overview.digest.change.drop', {
      items: promptsDat(drops.length),
      prompt: drops[0]!.prompt,
      from: drops[0]!.fromEngines,
      to: drops[0]!.toEngines,
    })
  }
  if (c.gained?.length) return t('overview.digest.change.gained', { items: promptsDat(c.gained.length) })
  if (c.newSources?.length) return t('overview.digest.change.newSources', { items: sourcesCount(c.newSources.length) })
  if (c.lost?.length) return t('overview.digest.change.lost', { items: promptsDat(c.lost.length) })
  return null
})

const hasData = computed(() => vis.value != null)
</script>

<template>
  <section class="py-2">
    <p class="text-[14px] text-muted-foreground">{{ greeting || $t('overview.digest.helloFallback') }} 👋</p>

    <div v-if="loading" class="mt-5 text-[20px] text-muted-foreground">{{ $t('overview.digest.loading') }}</div>

    <div v-else-if="!hasData" class="mt-5 max-w-[640px] text-[20px] leading-relaxed text-muted-foreground sm:text-[22px]">
      {{ $t('overview.digest.empty') }}
    </div>

    <div v-else class="mt-5 space-y-3.5 text-[21px] leading-[1.45] tracking-tight sm:text-[24px]">
      <!-- строка 1: как часто называют -->
      <p class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <img
          v-if="domain" :src="faviconSrc(domain)" :alt="domain" width="26" height="26"
          class="size-[26px] shrink-0 rounded-[7px] bg-surface-hover p-0.5"
        />
        <span class="font-medium">{{ domain || $t('overview.digest.brandFallback') }}</span>
        <span class="text-muted-foreground">{{ $t('overview.digest.mentionedIn') }}</span>
        <span :class="delta < 0 ? 'text-rose-400' : 'text-emerald-400'">{{ vis }}%</span>
        <span class="text-muted-foreground">{{ $t('overview.digest.ofAnswers') }}</span>
        <span v-if="delta" class="text-[15px] text-muted-foreground/70">
          {{ $t('overview.digest.delta', { delta: (delta > 0 ? '+' : '') + delta }) }}
        </span>
      </p>

      <!-- строка 2: где лучше всего -->
      <p v-if="bestEngine" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground">
        {{ $t('overview.digest.bestIn') }}
        <img :src="bestEngine.icon" :alt="bestEngine.label" width="26" height="26" class="size-[26px] shrink-0 rounded-[7px] bg-surface-hover p-1" />
        <span class="font-medium text-foreground">{{ bestEngine.label }}</span>
        <span>{{ $t('overview.digest.bestSuffix', { v: bestEngine.v }) }}</span>
      </p>

      <!-- строка 3: что поменялось -->
      <p v-if="change" class="text-muted-foreground">{{ change }}</p>
    </div>
  </section>
</template>
