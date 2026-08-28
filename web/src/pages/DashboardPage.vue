<script setup lang="ts">
// «Мониторинг» (корневая страница) — панель AI-видимости бренда на реальных
// агрегатах трекера
// (kpi / visTrend / leaderboard / platMatrix / цитаты / тональность).
// Раскладка по канону Peec AI + Profound: KPI-стрип → график с рейтингом
// рядом → матрица движков → промпты и тональность → источники → упоминания.
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { Loader2 } from 'lucide-vue-next'
import BrandWarmup from '@/components/BrandWarmup.vue'
import { useBrandBootstrap } from '@/composables/useBrandBootstrap'
import SiteAnalyticTab from '@/components/dashboard/SiteAnalyticTab.vue'
import ExportMenu from '@/components/dashboard/ExportMenu.vue'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/ui/panel'
import ChangesPanel from '@/components/dashboard/ChangesPanel.vue'
import KpiStrip from '@/components/dashboard/KpiStrip.vue'
import OverviewHero from '@/components/dashboard/OverviewHero.vue'
import CompetitorsDialog from '@/components/dashboard/CompetitorsDialog.vue'
import VisibilityTrendPanel from '@/components/dashboard/VisibilityTrendPanel.vue'
import LeaderboardPanel from '@/components/dashboard/LeaderboardPanel.vue'
import PlatformMatrixPanel from '@/components/dashboard/PlatformMatrixPanel.vue'
import PromptsPanel from '@/components/dashboard/PromptsPanel.vue'
import SentimentPanel from '@/components/dashboard/SentimentPanel.vue'
import SourcesPanel from '@/components/dashboard/SourcesPanel.vue'
import CitationTypesPanel from '@/components/dashboard/CitationTypesPanel.vue'
import OwnPagesPanel from '@/components/dashboard/OwnPagesPanel.vue'
import MentionsPanel from '@/components/dashboard/MentionsPanel.vue'
import { useBrands } from '@/composables/useBrands'
import { useTracker } from '@/composables/useTracker'
import { agoLabel } from '@/data/dashboard'

const { t } = useI18n()
const { activeDomain } = useBrands()
const { state: tracker, load } = useTracker()
// Пока по бренду нет ни одного прогона — вместо панелей с прочерками
// показываем, что именно считается и сколько это занимает.
const { phase, initialize } = useBrandBootstrap()
const warming = computed(() => phase.value === 'analysing' || phase.value === 'idle')
onMounted(() => { void initialize() })

// Диалог конкурентов открывается и из заблокированных KPI, и из рейтинга —
// это два места, где человек упирается в их отсутствие.
const rivalsOpen = ref(false)

// две вкладки: живые данные трекера и данные AI-разбора сайта. Первая
// называется «Основное», а не «Мониторинг», — иначе дублировала бы заголовок
// страницы. Состояние в ?tab=extra: ссылка на «Дополнительные» открывается сразу.
const route = useRoute()
const router = useRouter()
const TABS = computed(() => [
  { key: 'monitor', label: t('monitoring.page.tabMain') },
  { key: 'extra', label: t('monitoring.page.tabExtra') },
])
const tab = ref(TABS.value.some((x) => x.key === route.query.tab) ? String(route.query.tab) : 'monitor')
watch(tab, (t) => {
  const q = { ...route.query }
  if (t === 'monitor') delete q.tab
  else q.tab = t
  router.replace({ query: q })
})

const loading = computed(() => tracker.status === 'loading')
const agg = computed(() => tracker.agg)
const meta = computed(() => tracker.meta)

// отметки прогонов по профилям тарифа (run_meta): показываем только те,
// что бэкенд реально проставил — пустые профили не выдумываем
// Раньше в шапке висели четыре отметки прогонов (ежедневный / средний срез /
// полный срез / Яндекс). Это внутренняя кухня профилей: пользователю важно
// одно — насколько свежие данные он смотрит. Берём самую позднюю из отметок.
const lastRunAt = computed(() => {
  const m = meta.value
  if (!m) return null
  const stamps = [m.microAt, m.midAt, m.fullAt, m.yandexAt, m.lastRunAt]
    .filter(Boolean) as string[]
  if (!stamps.length) return null
  return stamps.reduce((a, b) => (new Date(a) > new Date(b) ? a : b))
})

const promptsNote = computed(() => {
  const m = meta.value
  if (!m) return ''
  const parts = [t('monitoring.page.activePrompts', m.activeCount)]
  if (m.suggestedCount) parts.push(t('monitoring.page.suggestedPrompts', { n: m.suggestedCount }))
  return parts.join(' · ')
})
</script>

<template>
  <div class="relative min-h-dvh">
    <!-- декор в духе new.ideata.io: аврора-свечение + дот-грид, приглушённые -->
    <div class="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[420px] overflow-hidden" aria-hidden="true">
      <div class="absolute left-1/2 top-[-260px] h-[520px] w-[900px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(66,103,255,0.16),rgba(124,58,237,0.08),transparent)] blur-2xl"></div>
      <div class="absolute inset-0 bg-[radial-gradient(rgba(255,255,255,0.05)_1px,transparent_1px)] [background-size:22px_22px] [mask-image:linear-gradient(to_bottom,rgba(0,0,0,0.5),transparent_70%)]"></div>
    </div>

    <div class="space-y-4 p-5 lg:p-6">
      <!-- шапка: бренд, статус трекера, отметки прогонов -->
      <PageHeader :title="$t('nav.monitoring')">
        <template #meta>
          <!-- «прогон идёт» — временное состояние, а не бейдж-украшение -->
          <Badge v-if="meta?.running" variant="muted">
            <Loader2 :size="10" class="animate-spin" /> {{ $t('monitoring.page.running') }}
          </Badge>
        </template>
        <template #description>
          {{ activeDomain || meta?.domain || '—' }}
          <template v-if="promptsNote"> · {{ promptsNote }}</template>
          <template v-if="agg?.runs"> · {{ $t('monitoring.page.runsInWindow', agg.runs) }}</template>
        </template>
        <template #actions>
          <span v-if="lastRunAt" class="hidden text-[12px] text-muted-foreground sm:inline">
            <i18n-t keypath="time.updated" scope="global">
              <template #when><span class="text-text-2">{{ agoLabel(lastRunAt) }}</span></template>
            </i18n-t>
          </span>
          <ExportMenu
            :rows="tracker.rows" :platforms="tracker.platforms" :sources="tracker.sources"
            :domain="activeDomain || meta?.domain || ''"
          />
        </template>
      </PageHeader>

      <!-- переключатель вкладок -->
      <div class="flex items-center gap-5 border-b border-border">
        <button
          v-for="tb in TABS" :key="tb.key" type="button"
          class="-mb-px border-b-2 px-1 pb-2.5 text-[13px] font-medium transition"
          :class="tab === tb.key
            ? 'border-foreground text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground'"
          @click="tab = tb.key"
        >{{ tb.label }}</button>
      </div>

      <SiteAnalyticTab v-if="tab === 'extra'" />

      <BrandWarmup v-else-if="warming" :rows="4" />

      <template v-else>
      <!-- Первый экран — три панели вместо строки из пяти равнозначных цифр:
           одна главная метрика на панель, разбивка по движкам сразу под
           графиком, рейтинг списком. Раскладка перенесена из маркетинговой
           панели лендинга, где жила на захардкоженных числах. -->
      <OverviewHero :agg="agg" :meta="meta" :loading="loading" @add-competitors="rivalsOpen = true" />

      <KpiStrip :agg="agg" :meta="meta" :loading="loading" @add-competitors="rivalsOpen = true" />

      <div class="grid gap-4 lg:grid-cols-5">
        <VisibilityTrendPanel class="lg:col-span-3" :agg="agg" :loading="loading" />
        <!-- self-start: в гриде панель растягивалась под высоту графика, и
             короткое пустое состояние превращалось в полкарточки пустоты. -->
        <LeaderboardPanel class="self-start lg:col-span-2" :agg="agg" :loading="loading" @add-competitors="rivalsOpen = true" />
      </div>

      <!--
        Порядок: сначала СОСТОЯНИЕ (где вы стоите — целиком, по движкам, по
        промптам), потом ДИФ, потом ДОКАЗАТЕЛЬСТВА (источники, упоминания).
        «Что изменилось» стояло третьим блоком сверху, хотя это сравнение двух
        прогонов: читатель видел дельту раньше, чем сам расклад, и трактовать
        её было не от чего. У Peec AI и Profound на обзоре диф вообще не живёт
        — первым экраном идут видимость и рейтинг.
      -->
      <PlatformMatrixPanel :agg="agg" :loading="loading" />

      <div class="grid gap-4 lg:grid-cols-5">
        <PromptsPanel class="lg:col-span-3" :rows="tracker.rows" :platforms="tracker.platforms" />
        <SentimentPanel class="self-start lg:col-span-2" :agg="agg" />
      </div>

      <ChangesPanel :agg="agg" :platforms="tracker.platforms" :loading="loading" />

      <div class="grid gap-4 lg:grid-cols-3">
        <SourcesPanel :sources="tracker.sources" />
        <CitationTypesPanel :agg="agg" />
        <OwnPagesPanel :agg="agg" />
      </div>

      <MentionsPanel :rows="tracker.rows" :platforms="tracker.platforms" />
      </template>
    </div>

    <!-- Сохранение конкурентов меняет состав сравнения, поэтому агрегаты
         перезапрашиваем: иначе KPI остались бы заблокированными до перезагрузки. -->
    <CompetitorsDialog
      v-model:open="rivalsOpen"
      :tracker-id="meta?.id ?? null"
      :current="meta?.competitors"
      @saved="load(true)"
    />
  </div>
</template>
