<script setup lang="ts">
/**
 * «Конкуренты» — сравнение с соперниками в одном месте.
 *
 * Раньше это было размазано по «Мониторингу»: рейтинг в одной панели, матрица
 * движков в другой, а «по каким именно вопросам нас обходят» не отвечал никто —
 * при том что вопрос ровно этот. Здесь: карточки участников, дневная динамика
 * всех линий, разрез по промптам и по источникам, и правка самого списка.
 *
 * Данных не запрашиваем: тот же синглтон трекера, что у «Мониторинга»,
 * «Промптов» и «Ссылок» (одна метрика — один источник). Разрезы считает
 * data/competitors.ts.
 */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Download, Users } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import CompetitorCards from '@/components/competitors/CompetitorCards.vue'
import PromptDuelTable from '@/components/competitors/PromptDuelTable.vue'
import SourceDuelTable from '@/components/competitors/SourceDuelTable.vue'
import CompetitorsDialog from '@/components/dashboard/CompetitorsDialog.vue'
import PlatformMatrixPanel from '@/components/dashboard/PlatformMatrixPanel.vue'
import VisibilityTrendPanel from '@/components/dashboard/VisibilityTrendPanel.vue'
import PromptModal from '@/components/prompts/PromptModal.vue'
import EmptyState from '@/components/EmptyState.vue'
import BrandWarmup from '@/components/BrandWarmup.vue'
import { useBrandBootstrap } from '@/composables/useBrandBootstrap'
import { useBrands } from '@/composables/useBrands'
import { useTracker } from '@/composables/useTracker'
import { api, isDemoMode } from '@/lib/api'
import { brandLabel } from '@/data/dashboard'
import { buildPromptDuels, buildRivalRows, buildSourceDuels, normDomain } from '@/data/competitors'
import type { PromptRow } from '@/data/prompts'

// Свежий бренд: вместо пустой таблицы показываем ход разбора.
const { phase: bootstrapPhase, initialize } = useBrandBootstrap()
const warming = computed(() => bootstrapPhase.value === 'analysing' || bootstrapPhase.value === 'idle')

const { t } = useI18n()
const { active, activeDomain, load: loadBrands } = useBrands()
const { state: tracker, load: loadTracker } = useTracker()

onMounted(() => { void initialize() })

const loading = computed(() => tracker.status === 'loading')

// ── разрезы ────────────────────────────────────────────────────────────────
const boardBrands = computed(() =>
  (tracker.agg?.leaderboard || []).map((b) => ({ brand: b.brand, self: b.self })))
const duels = computed(() => buildPromptDuels(tracker.rows, boardBrands.value))
const sources = computed(() => buildSourceDuels(tracker.rows, boardBrands.value))
const rivals = computed(() => buildRivalRows(tracker.agg, tracker.rows, duels.value))

const self = computed(() => rivals.value.find((r) => r.self) || null)
const others = computed(() => rivals.value.filter((r) => !r.self))
const leader = computed(() => rivals.value.reduce<typeof rivals.value[number] | null>(
  (m, r) => (!m || r.vis > m.vis ? r : m), null))
const lostPrompts = computed(() => duels.value.filter((d) => d.gap < 0).length)

const kpi = computed(() => [
  {
    key: 'rivals',
    l: t('competitors.kpi.rivals'),
    v: String(others.value.length),
    hint: t('competitors.kpi.rivalsHint'),
  },
  {
    key: 'mine',
    l: t('competitors.kpi.mine'),
    v: self.value ? `${self.value.vis}%` : '—',
    hint: self.value?.delta
      ? t('competitors.kpi.mineHint', { n: `${self.value.delta > 0 ? '+' : ''}${self.value.delta}` })
      : t('competitors.kpi.mineHintFlat'),
  },
  {
    key: 'leader',
    l: t('competitors.kpi.leader'),
    v: leader.value ? brandLabel(leader.value.brand) : '—',
    hint: leader.value?.self ? t('competitors.kpi.leaderYou') : t('competitors.kpi.leaderHint', { n: leader.value?.vis ?? 0 }),
  },
  {
    key: 'lost',
    l: t('competitors.kpi.lost'),
    v: `${lostPrompts.value}/${duels.value.length}`,
    hint: t('competitors.kpi.lostHint'),
  },
])

// ── правка списка ──────────────────────────────────────────────────────────
// В демо мутации не пускаем: трекера 9001 на бэке нет, и «Убрать» отвалилось бы
// ошибкой прямо на витрине.
const editable = computed(() => tracker.status === 'live' && !!tracker.meta?.id && !isDemoMode())
const dialogOpen = ref(false)
const busy = ref(false)
const error = ref('')

/**
 * Убрать конкурента. Правим ОБА места, как это делает диалог: трекер (из него
 * прогон читает соперников) и бренд (его наследуют новые трекеры). Сбой правки
 * бренда не отменяет уже применённое сравнение.
 */
async function removeRival(domain: string) {
  const id = tracker.meta?.id
  if (!id || busy.value) return
  const next = (tracker.meta?.competitors || []).filter((c) => normDomain(c) !== normDomain(domain))
  busy.value = true
  error.value = ''
  try {
    await api.aeoSetCompetitors(id, next)
    const bid = active.value?.id
    if (bid) {
      try {
        await api.updateBrand({ id: bid, competitors: next })
        await loadBrands(true)
      } catch { /* мониторинг уже обновлён — молча расходимся с брендом */ }
    }
    await loadTracker(true)
  } catch (e: any) {
    error.value = e?.message || t('competitors.errRemove')
  } finally {
    busy.value = false
  }
}

async function afterSave() {
  await loadTracker(true)
}

// ── детализация промпта: та же модалка, что в «Промптах» ────────────────────
const modalRow = ref<PromptRow | null>(null)
const modalOpen = ref(false)
function openPrompt(text: string) {
  const r = tracker.rows.find((x) => x.text === text)
  if (!r) return
  modalRow.value = r
  modalOpen.value = true
}

// ── выгрузка: матрица «промпт × бренд», как она на экране ───────────────────
function exportCsv() {
  const head = [
    t('prompts.csv.prompt'), t('competitors.csv.topic'), t('competitors.csv.engines'),
    ...rivals.value.map((r) => brandLabel(r.brand)),
    t('competitors.prompts.gap'),
  ]
  const lines = duels.value.map((d) => [
    `"${d.text.replaceAll('"', '""')}"`, `"${(d.topic || '').replaceAll('"', '""')}"`, d.engines,
    ...rivals.value.map((r) => d.vis[r.brand] ?? 0),
    d.gap,
  ].join(';'))
  const blob = new Blob(['﻿' + [head.join(';'), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'ideata-competitors.csv'
  a.click()
  URL.revokeObjectURL(a.href)
}
</script>

<template>
  <div class="space-y-4 p-5 lg:p-6">
    <div class="flex flex-wrap items-center gap-3">
      <div class="mr-auto min-w-0">
        <h1 class="text-lg font-semibold tracking-tight">{{ $t('routeTitle.competitors') }}</h1>
        <p class="mt-0.5 truncate text-[12.5px] text-muted-foreground">
          {{ $t('competitors.subtitle') }}
          <template v-if="others.length"> · {{ $t('competitors.inCompare', others.length) }}</template>
        </p>
      </div>
      <Button variant="outline" size="sm" :disabled="!duels.length" @click="exportCsv">
        <Download :size="14" /> CSV
      </Button>
      <Button v-if="editable" size="sm" @click="dialogOpen = true">
        <Users :size="14" /> {{ $t('competitors.configure') }}
      </Button>
    </div>

    <p v-if="error" class="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{{ error }}</p>

    <!-- сводка -->
    <section class="grid grid-cols-2 divide-x divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface lg:grid-cols-4 lg:divide-y-0">
      <div v-for="c in kpi" :key="c.key" class="min-w-0 px-4 py-3.5 sm:px-5">
        <div class="truncate text-[11.5px] text-muted-foreground">{{ c.l }}</div>
        <div class="mt-1.5 truncate text-[24px] font-semibold leading-none tracking-tight tabular-nums">
          {{ loading ? '—' : c.v }}
        </div>
        <div class="mt-1 truncate text-[11px] text-muted-foreground/60">{{ c.hint }}</div>
      </div>
    </section>

    <p v-if="loading" class="py-16 text-center text-[13px] text-muted-foreground">{{ $t('state.loading') }}</p>

    <template v-else-if="rivals.length">
      <CompetitorCards
        :rows="rivals" :editable="editable && !busy"
        @remove="removeRival" @add="dialogOpen = true"
      />

      <!--
        Сравнение без соперников — это вы напротив пустоты: рисовать таблицы с
        единственной колонкой значит показывать «первое место», которого никто
        не оспаривал. Пока конкурентов нет, зовём их добавить.
      -->
      <div v-if="!others.length" class="rounded-xl border border-border bg-surface px-6 py-12 text-center">
        <p class="text-[13px] font-medium">{{ $t('competitors.empty.title') }}</p>
        <p class="mx-auto mt-1 max-w-[380px] text-[12px] leading-[1.6] text-muted-foreground">
          {{ $t('competitors.empty.hint') }}
        </p>
        <Button v-if="editable" class="mt-3" size="sm" variant="outline" @click="dialogOpen = true">
          <Users :size="14" /> {{ $t('competitors.configure') }}
        </Button>
      </div>

      <template v-else>
        <!-- дневная динамика всех линий: та же панель, что на «Мониторинге» —
             второй такой график с другими числами был бы третьей правдой -->
        <VisibilityTrendPanel :agg="tracker.agg" :loading="loading" />

        <Tabs default-value="prompts">
          <TabsList class="border border-border bg-surface">
            <TabsTrigger value="prompts" class="text-[12.5px]">{{ $t('competitors.tabs.prompts') }}</TabsTrigger>
            <TabsTrigger value="sources" class="text-[12.5px]">{{ $t('competitors.tabs.sources') }}</TabsTrigger>
            <TabsTrigger value="engines" class="text-[12.5px]">{{ $t('competitors.tabs.engines') }}</TabsTrigger>
          </TabsList>

          <TabsContent value="prompts" class="mt-3">
            <PromptDuelTable :duels="duels" :brands="rivals" :loading="loading" @open-prompt="openPrompt" />
          </TabsContent>

          <TabsContent value="sources" class="mt-3">
            <SourceDuelTable :sources="sources" :brands="rivals" :loading="loading" />
          </TabsContent>

          <TabsContent value="engines" class="mt-3">
            <PlatformMatrixPanel :agg="tracker.agg" :loading="loading" />
          </TabsContent>
        </Tabs>
      </template>
    </template>

    <BrandWarmup v-else-if="warming" :rows="3" />
    <EmptyState v-else :title="$t('state.noData')" :hint="$t('competitors.noTracker')" />

    <CompetitorsDialog
      v-model:open="dialogOpen"
      :tracker-id="tracker.meta?.id"
      :current="tracker.meta?.competitors"
      @saved="afterSave"
    />

    <PromptModal
      v-model:open="modalOpen" :row="modalRow" :platforms="tracker.platforms"
      :own-brand="activeDomain.split('.')[0] || 'ideata'"
    />
  </div>
</template>
