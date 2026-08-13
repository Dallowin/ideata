<script setup lang="ts">
// «Ссылки» — полный разбор цитат из ответов ИИ (была заглушка).
// Данные — общий синглтон трекера, повторного запроса нет: те же числа,
// что на «Мониторинге».
import { computed, onMounted } from 'vue'
import LinksAnalysis from '@/components/links/LinksAnalysis.vue'
import ExportMenu from '@/components/dashboard/ExportMenu.vue'
import { useBrands } from '@/composables/useBrands'
import { useTracker } from '@/composables/useTracker'

const { activeDomain } = useBrands()
const { state: tracker, load } = useTracker()
onMounted(() => load())

const loading = computed(() => tracker.status === 'loading')
</script>

<template>
  <div class="space-y-4 p-5 lg:p-6">
    <div class="flex flex-wrap items-center gap-3">
      <div class="mr-auto min-w-0">
        <h1 class="text-lg font-semibold tracking-tight">{{ $t('routeTitle.links') }}</h1>
        <p class="mt-0.5 truncate text-[12.5px] text-muted-foreground">
          {{ $t('links.subtitle') }}
          <template v-if="tracker.sources.length"> · {{ $t('links.domains', tracker.sources.length) }}</template>
        </p>
      </div>
      <ExportMenu
        :rows="tracker.rows" :platforms="tracker.platforms" :sources="tracker.sources"
        :domain="activeDomain || tracker.meta?.domain || ''"
      />
    </div>

    <LinksAnalysis
      :sources="tracker.sources" :platforms="tracker.platforms"
      :agg="tracker.agg" :loading="loading"
    />
  </div>
</template>
