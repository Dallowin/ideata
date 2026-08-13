<script setup lang="ts">
// «Обзор» — домашняя страница кабинета в духе Lobe/PostHog Max:
// сводка изменений за день → чат-ассистент по данным бренда (пока демо) →
// рекомендации: что донастроить и какие темы брать в контент.
// Цифры сводки и рекомендаций реальные — из тех же агрегатов, что «Мониторинг».
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import BrandWarmup from '@/components/BrandWarmup.vue'
import DailyDigest from '@/components/overview/DailyDigest.vue'
import AssistantChat from '@/components/overview/AssistantChat.vue'
import Recommendations from '@/components/overview/Recommendations.vue'
import { useAuth } from '@/composables/useAuth'
import { useConnectors } from '@/composables/useConnectors'
import { useBrands } from '@/composables/useBrands'
import { useTracker } from '@/composables/useTracker'
import { useSiteAnalytic } from '@/composables/useSiteAnalytic'
import { useBrandBootstrap } from '@/composables/useBrandBootstrap'
import type { AssistantCtx } from '@/lib/assistant'

const { t } = useI18n()
const { auth, check } = useAuth()
const { activeDomain } = useBrands()
const { state: tracker, load } = useTracker()
// неподключённые интеграции — полоса-подсказка под полем ввода чата
const { connectors, load: loadConnectors } = useConnectors()
// разбор сайта нужен ассистенту для тем и техсостояния — грузим лениво
const { state: site, load: loadSite } = useSiteAnalytic()
onMounted(() => { check(); load(); loadConnectors(); loadSite() })
// Свежий бренд: пока данных нет — шаги разбора вместо пустой сводки и
// рекомендаций, посчитанных ни на чём.
const { phase } = useBrandBootstrap()
const warming = computed(() => phase.value === 'analysing' || phase.value === 'idle')

// один контекст на все ответы ассистента: те же данные, что рисуют панели
const assistantCtx = computed<AssistantCtx>(() => ({
  agg: tracker.agg,
  meta: tracker.meta,
  rows: tracker.rows,
  sources: tracker.sources,
  facts: site.facts,
  domain: activeDomain.value || tracker.meta?.domain,
}))
const missingConnectors = computed(() =>
  connectors.filter((c) => c.connected === false).map((c) => ({ key: c.key, title: c.title, icon: c.icon })),
)

const loading = computed(() => tracker.status === 'loading')
const hello = computed(() => {
  const h = new Date().getHours()
  const part = t(
    h < 5 ? 'overview.hello.night'
      : h < 12 ? 'overview.hello.morning'
        : h < 18 ? 'overview.hello.day' : 'overview.hello.evening',
  )
  const name = auth.authed ? (auth.name || '').split(' ')[0] : ''
  return name ? t('overview.hello.withName', { part, name }) : part
})
</script>

<template>
  <div class="relative min-h-dvh">
    <!-- мягкое свечение сверху, как на «Мониторинге» -->
    <div class="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[380px] overflow-hidden" aria-hidden="true">
      <div class="absolute left-1/2 top-[-240px] h-[480px] w-[820px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(66,103,255,0.16),rgba(124,58,237,0.08),transparent)] blur-2xl"></div>
    </div>

    <div class="mx-auto max-w-[1180px] space-y-10 px-5 py-8 lg:px-8 lg:py-10">
      <DailyDigest
        v-if="!warming"
        :agg="tracker.agg" :loading="loading" :greeting="hello"
        :domain="activeDomain || tracker.meta?.domain"
      />
      <template v-else>
        <h1 class="text-[22px] font-semibold tracking-[-0.02em]">{{ hello }}</h1>
        <BrandWarmup :rows="0" />
      </template>

      <AssistantChat :agg="tracker.agg" :ctx="assistantCtx" :missing-connectors="missingConnectors" />

      <Recommendations v-if="!warming" :rows="tracker.rows" :agg="tracker.agg" :meta="tracker.meta" />
    </div>
  </div>
</template>
