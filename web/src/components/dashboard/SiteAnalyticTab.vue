<script setup lang="ts">
// Вкладка «Дополнительные» — данные AI-разбора сайта (site_analytic), которых
// нет у AEO-трекера: семантика, ссылочный профиль, техбаза и готовность к
// ИИ-краулу, конкуренты по органике, медиа и план действий.
// Трафика здесь намеренно нет — он живёт на «Трафике» из Метрики/GSC/Cloudflare.
import { computed, onMounted } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import SiteKpiStrip from '@/components/dashboard/site/SiteKpiStrip.vue'
import SemanticsPanel from '@/components/dashboard/site/SemanticsPanel.vue'
import KeywordsPanel from '@/components/dashboard/site/KeywordsPanel.vue'
import PagesPanel from '@/components/dashboard/site/PagesPanel.vue'
import BacklinksPanel from '@/components/dashboard/site/BacklinksPanel.vue'
import TechAeoPanel from '@/components/dashboard/site/TechAeoPanel.vue'
import SiteCompetitorsPanel from '@/components/dashboard/site/SiteCompetitorsPanel.vue'
import GapPanel from '@/components/dashboard/site/GapPanel.vue'
import MediaPanel from '@/components/dashboard/site/MediaPanel.vue'
import PlanPanel from '@/components/dashboard/site/PlanPanel.vue'
import { useSiteAnalytic } from '@/composables/useSiteAnalytic'
import { agoLabel } from '@/data/dashboard'

const { state, load, facts } = useSiteAnalytic()
onMounted(() => load())

const ready = computed(() => state.status === 'done')
</script>

<template>
  <div class="space-y-4">
    <!-- статус разбора -->
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
      <template v-if="ready">
        <span>{{ $t('monitoring.siteTab.last') }}<template v-if="state.finishedAt"> · {{ agoLabel(state.finishedAt) }}</template></span>
      </template>
      <template v-else-if="state.status === 'loading'">
        <Loader2 :size="12" class="animate-spin" /> {{ $t('monitoring.siteTab.loading') }}
      </template>
      <template v-else-if="state.status === 'running'">
        <Loader2 :size="12" class="animate-spin" /> {{ $t('monitoring.siteTab.running') }}
      </template>
    </div>

    <!-- разбора нет / не смогли прочитать -->
    <div
      v-if="!ready && state.status !== 'loading' && state.status !== 'running'"
      class="rounded-xl border border-border bg-surface px-5 py-10 text-center"
    >
      <p class="text-[13px] font-medium">
        {{ state.status === 'error' ? $t('monitoring.siteTab.errTitle') : $t('monitoring.siteTab.emptyTitle') }}
      </p>
      <p class="mx-auto mt-1.5 max-w-md text-[12.5px] leading-relaxed text-muted-foreground">
        {{ state.status === 'error'
          ? $t('monitoring.siteTab.errHint')
          : $t('monitoring.siteTab.emptyHint') }}
      </p>
      <p v-if="state.status !== 'error'" class="mt-2 text-[12px] text-muted-foreground/60">
        {{ $t('monitoring.siteTab.note') }}
      </p>
    </div>

    <template v-else-if="ready">
      <SiteKpiStrip :facts="facts" />

      <div class="grid gap-4 lg:grid-cols-5">
        <SemanticsPanel class="lg:col-span-2" :facts="facts" />
        <KeywordsPanel class="lg:col-span-3" :facts="facts" />
      </div>

      <div class="grid gap-4 lg:grid-cols-5">
        <PagesPanel class="lg:col-span-2" :facts="facts" />
        <BacklinksPanel class="lg:col-span-3" :facts="facts" />
      </div>

      <TechAeoPanel :facts="facts" />

      <div class="grid gap-4 lg:grid-cols-5">
        <SiteCompetitorsPanel class="lg:col-span-3" :facts="facts" />
        <GapPanel class="lg:col-span-2" :facts="facts" />
      </div>

      <div class="grid gap-4 lg:grid-cols-5">
        <PlanPanel class="lg:col-span-3" :facts="facts" />
        <MediaPanel class="lg:col-span-2" :facts="facts" />
      </div>
    </template>
  </div>
</template>
