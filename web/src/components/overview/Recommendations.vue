<script setup lang="ts">
// Рекомендации — СТРОКИ-ИНСАЙТЫ (канон Contra «Discovery insights» +
// Cloudflare «Security Insights» из Mobbin): иконка, заголовок, строка
// МЕТАДАННЫХ вместо описания и действие справа. Стена карточек с одинаковым
// абзацем под каждой темой забракована — текст повторялся, данных не было.
//
// Всё считается по реальным данным: панель промптов, конкуренты, коннекторы,
// тариф, промпты без упоминаний и разрывы семантики из разбора сайта.
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Check, Clock, Layers, Link2, MessageSquareText, Plug, Radio,
  RefreshCw, Sparkles, Swords, Target, TrendingDown,
} from 'lucide-vue-next'
import { intlLocale } from '@/i18n'
import { useConnectors } from '@/composables/useConnectors'
import { usePlan } from '@/composables/usePlan'
import { useSiteAnalytic } from '@/composables/useSiteAnalytic'
import type { TrackerAggregates, TrackerMeta } from '@/composables/useTracker'
import { platformsFor, type Platform, type PromptRow } from '@/data/prompts'

const props = defineProps<{
  rows: PromptRow[]
  agg: TrackerAggregates | null
  meta: TrackerMeta | null
}>()

const { t } = useI18n()
const { connectors, load: loadConnectors } = useConnectors()
const { check: checkPlan, isFree } = usePlan()
const { state: site, load: loadSite } = useSiteAnalytic()
onMounted(() => { loadConnectors(); checkPlan(); loadSite() })

function refresh() {
  loadConnectors()
  checkPlan(true)
  loadSite(true)
}

/**
 * Группы — как «лента агентов» у Okara: не свалка карточек, а направления со
 * счётчиками. Порядок фиксированный и означает срочность: сначала то, что уже
 * горит (пробелы и конкуренты), потом работа (контент), потом донастройка.
 */
type Group = 'gap' | 'rivals' | 'content' | 'setup'
const GROUPS: Group[] = ['gap', 'rivals', 'content', 'setup']

interface Row {
  key: string
  icon: any
  title: string
  /** короткие факты через точку — вместо абзаца-описания */
  meta: string[]
  /** движки, где ответ прошёл без бренда (иконками) */
  engines?: Platform[]
  group: Group
  action: string
  to: string
}

/** Тема уезжает в композер параметрами — «Написать» должно открывать черновик
 *  по конкретному пробелу, а не пустое поле, где всё надо вспоминать заново. */
const writeTo = (topic: string, q?: string) =>
  `/blog/new?topic=${encodeURIComponent(topic.slice(0, 300))}`
  + (q ? `&q=${encodeURIComponent(q)}` : '')

// ── что донастроить ───────────────────────────────────────────────────────
const setup = computed<Row[]>(() => {
  const out: Row[] = []
  const m = props.meta

  if (m?.suggestedCount) {
    out.push({
      key: 'suggested', icon: MessageSquareText, group: 'setup',
      title: t('overview.recs.setup.suggested.title', { n: m.suggestedCount }, m.suggestedCount),
      meta: [t('overview.recs.setup.suggested.m1'), t('overview.recs.setup.suggested.m2')],
      action: t('overview.recs.action.open'), to: '/prompts',
    })
  }
  if (m && m.promptCap && m.activeCount < m.promptCap) {
    out.push({
      key: 'pool', icon: Target, group: 'setup',
      title: t('overview.recs.setup.pool.title'),
      meta: [
        t('overview.recs.setup.pool.m1', { n: m.activeCount, cap: m.promptCap }),
        t('overview.recs.setup.pool.m2'),
      ],
      action: t('action.add'), to: '/prompts',
    })
  }
  if ((props.agg?.leaderboard?.length ?? 0) <= 1) {
    out.push({
      key: 'rivals', icon: Swords, group: 'setup',
      title: t('overview.recs.setup.rivals.title'),
      meta: [t('overview.recs.setup.rivals.m1')],
      action: t('overview.recs.action.specify'), to: '/settings',
    })
  }
  for (const c of connectors.filter((x) => x.connected === false)) {
    out.push({
      key: 'conn-' + c.key, icon: Plug, group: 'setup',
      // название и описание коннектора приходят из каталога интеграций — как есть
      title: t('overview.recs.setup.connector.title', { name: c.title }),
      meta: [c.desc],
      action: t('overview.recs.action.connect'), to: '/settings',
    })
  }
  if (site.status === 'none') {
    out.push({
      key: 'analytic', icon: Layers, group: 'setup',
      title: t('overview.recs.setup.analytic.title'),
      meta: [t('overview.recs.setup.analytic.m1'), t('overview.recs.setup.analytic.m2')],
      action: t('overview.recs.action.open'), to: '/monitoring?tab=extra',
    })
  }
  if (isFree.value) {
    out.push({
      key: 'plan', icon: Sparkles, group: 'setup',
      title: t('overview.recs.setup.plan.title'),
      meta: [t('overview.recs.setup.plan.m1'), t('overview.recs.setup.plan.m2')],
      action: t('overview.recs.action.plans'), to: '/subscription',
    })
  }
  return out
})

// ── пробелы: где нас не называют прямо сейчас ──────────────────────────────
const gaps = computed<Row[]>(() => {
  const out: Row[] = []

  // промпты, где нас не называют: показываем, какие движки отвечали без нас.
  // Тема уезжает в композер — по такому промпту сразу пишется материал.
  for (const r of props.rows.filter((x) => x.vis === 0).slice(0, 4)) {
    const keys = [...new Set((r.answers || []).map((a) => a.platform))]
    out.push({
      key: 'p-' + r.id, icon: MessageSquareText, group: 'gap',
      // текст промпта — пользовательский, не переводится
      title: r.text,
      meta: [
        t('overview.recs.topic.noMentions'),
        ...(r.citations ? [t('overview.recs.topic.citations', { n: r.citations }, r.citations)] : []),
      ],
      engines: platformsFor(keys).slice(0, 4),
      action: t('overview.recs.action.write'), to: writeTo(r.text, r.text),
    })
  }

  // Движки, которые не назвали бренд НИ РАЗУ за окно. Это другой сигнал, чем
  // «низкая видимость»: ноль на движке чинится не текстом, а присутствием в
  // источниках, на которых он обучен или которые он ищет.
  const selfRow = (props.agg?.platMatrix || []).find((r) => r.self)
  const plats = platformsFor(props.agg?.platforms || [])
  const silent = selfRow
    ? plats.filter((_, i) => Number(selfRow.vals?.[i] ?? 0) === 0)
    : []
  if (silent.length) {
    out.push({
      key: 'silent', icon: Radio, group: 'gap',
      title: t('overview.recs.gap.silent.title', { n: silent.length }, silent.length),
      meta: [t('overview.recs.gap.silent.m1'), t('overview.recs.gap.silent.m2')],
      engines: silent.slice(0, 4),
      action: t('overview.recs.action.open'), to: '/monitoring',
    })
  }
  return out
})

// ── конкуренты: что изменилось за последний прогон ─────────────────────────
const rivals = computed<Row[]>(() => {
  const out: Row[] = []
  const ch = props.agg?.changes

  for (const r of (ch?.rivals || []).filter((x) => x.passedUs).slice(0, 3)) {
    out.push({
      key: 'passed-' + r.brand, icon: Swords, group: 'rivals',
      title: t('overview.recs.rivals.passed.title', { brand: r.brand }),
      meta: [
        t('overview.recs.rivals.passed.m1', { from: r.from, to: r.to }),
        t('overview.recs.rivals.passed.m2'),
      ],
      action: t('overview.recs.action.compare'), to: '/competitors',
    })
  }
  // Промпты, где нас называли, а в этом прогоне перестали: самый ранний
  // сигнал просадки — раньше, чем это видно в средней видимости.
  const lost = ch?.lost || []
  if (lost.length) {
    out.push({
      key: 'lost', icon: TrendingDown, group: 'rivals',
      title: t('overview.recs.rivals.lost.title', { n: lost.length }, lost.length),
      meta: [lost.slice(0, 2).map((x) => x.prompt).join(' · ')],
      action: t('overview.recs.action.analyze'), to: '/prompts',
    })
  }
  return out
})

// ── темы для контента ─────────────────────────────────────────────────────
const topics = computed<Row[]>(() => {
  const out: Row[] = []
  for (const g of (site.facts?.gapRows || []).slice(0, 3)) {
    out.push({
      key: 'g-' + g.kw, icon: Link2, group: 'content',
      title: g.kw,
      meta: [
        t('overview.recs.topic.demand', { vol: g.vol.toLocaleString(intlLocale()) }),
        t('overview.recs.topic.difficulty', { kd: g.kd }),
        t('overview.recs.topic.rivalTop'),
      ],
      action: t('overview.recs.action.write'), to: writeTo(g.kw, g.kw),
    })
  }
  const thin = site.facts?.thinCluster?.name
  if (thin) {
    out.push({
      key: 'thin', icon: Layers, group: 'content',
      title: t('overview.recs.topic.thin.title', { name: thin }),
      meta: [t('overview.recs.topic.thin.m1'), t('overview.recs.topic.thin.m2')],
      action: t('overview.recs.action.toPlan'), to: '/blog',
    })
  }
  return out
})

/**
 * Лента направлений: группа с заголовком и счётчиком, внутри — карточки.
 * Пустые группы не рисуем: «0 задач» — это не информация, а шум.
 */
const feed = computed(() => {
  const byGroup: Record<Group, Row[]> = {
    gap: gaps.value, rivals: rivals.value, content: topics.value, setup: setup.value,
  }
  return GROUPS
    .map((g) => ({
      group: g,
      title: t(`overview.recs.group.${g}`),
      items: byGroup[g].map((r) => ({ ...r, desc: r.meta.filter(Boolean).join(' · ') })),
    }))
    .filter((s) => s.items.length)
})
const total = computed(() => feed.value.reduce((n, s) => n + s.items.length, 0))
</script>

<template>
  <section class="space-y-4">
    <div class="flex items-center justify-between gap-3">
      <p class="text-[13px] text-muted-foreground">{{ $t('overview.recs.head') }}</p>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition hover:text-foreground"
        @click="refresh"
      >
        <RefreshCw :size="13" /> {{ $t('action.refresh') }}
      </button>
    </div>

    <div v-if="!total" class="flex items-center gap-2.5 rounded-2xl border border-border/70 px-5 py-8 text-[13px] text-muted-foreground">
      <Check :size="15" class="text-emerald-400" />
      {{ $t('overview.recs.empty') }}
    </div>

    <div v-for="s in feed" :key="s.group" class="space-y-4">
      <!-- шапка направления со счётчиком: видно, где сколько работы -->
      <div class="flex items-center gap-2 pt-1">
        <h2 class="text-[13px] font-medium">{{ s.title }}</h2>
        <span class="rounded-full bg-surface-2 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground">{{ s.items.length }}</span>
      </div>

      <article
        v-for="r in s.items" :key="r.key"
        class="rounded-2xl border border-border/60 bg-surface px-5 py-4"
      >
        <!-- шапка: иконка + заголовок + часики -->
        <div class="flex items-center gap-3">
          <span class="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-surface-2">
            <component :is="r.icon" :size="16" class="text-foreground/70" />
          </span>
          <h3 class="min-w-0 flex-1 truncate text-[15px] font-semibold leading-tight">{{ r.title }}</h3>
          <Clock :size="14" class="shrink-0 text-muted-foreground/50" />
        </div>

        <!-- пунктирный разделитель -->
        <div class="my-3.5 border-t border-dashed border-border/60"></div>

        <!-- описание -->
        <p class="text-[13.5px] leading-relaxed text-muted-foreground">{{ r.desc }}</p>

        <!-- низ: тег слева + действие справа -->
        <div class="mt-4 flex items-center justify-between gap-3">
          <!-- тег категории убран: её теперь несёт заголовок направления,
               и дублировать его в каждой карточке — шум -->
          <div class="flex items-center gap-2">
            <span v-if="r.engines?.length" class="flex items-center -space-x-1.5">
              <img
                v-for="e in r.engines" :key="e.key" :src="e.icon" :alt="e.label"
                :title="$t('overview.recs.engineTitle', { engine: e.label })"
                class="size-5 rounded-full bg-surface-2 p-0.5 ring-2 ring-background"
              />
            </span>
          </div>
          <RouterLink
            :to="r.to"
            class="shrink-0 rounded-full border border-border px-4 py-2 text-[13px] font-medium text-foreground transition hover:bg-surface-hover"
          >{{ r.action }}</RouterLink>
        </div>
      </article>
    </div>
  </section>
</template>
