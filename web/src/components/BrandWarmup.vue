<script setup lang="ts">
/**
 * Что происходит с брендом, пока данных ещё нет.
 *
 * Свежий бренд открывался пустыми экранами: ни что считается, ни сколько
 * ждать, ни почему везде прочерки. Здесь — те же шаги, что реально идут на
 * бэке (разбор сайта → панель промптов → первый прогон), полоса прогресса и
 * скелетоны на месте будущих панелей, чтобы страница не выглядела сломанной.
 *
 * Данные не выдумываем: серые плашки — это ЗАГЛУШКИ формы, а не цифры.
 * Состояние тянем из useBrandBootstrap, оно же само обновляется.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Loader2, Play, RefreshCw } from 'lucide-vue-next'
import { useRouter } from 'vue-router'
import { Button } from '@/components/ui/button'
import { useBrandBootstrap } from '@/composables/useBrandBootstrap'
import { useBrands } from '@/composables/useBrands'
import { api } from '@/lib/api'
import { intlLocale } from '@/i18n'

const props = withDefaults(defineProps<{
  /** сколько строк-скелетонов рисовать под шагами (форма будущей панели) */
  rows?: number
}>(), { rows: 3 })

const { t } = useI18n()
const router = useRouter()
const { active } = useBrands()
const { phase, steps, percent, refresh, watchProgress, earlyCompetitors, domain } = useBrandBootstrap()
watchProgress()

const analysing = computed(() => phase.value === 'analysing')
// Домен может быть ещё не прочитан (список брендов в полёте) — без фолбэка
// в тексте оставалась дыра: «Мы ещё не разбирали .»
const domainLabel = computed(() => domain.value || t('warmup.yourSite'))

// Иконка сайта конкурента — тот же источник, что в диалоге выбора конкурентов.
const faviconSrc = (d: string) => `https://www.google.com/s2/favicons?domain=${d}&sz=64`
const intl = () => intlLocale()
/** Трафик показываем компактно (12.4K), пустой — прочерком, а не нулём. */
const trafficLabel = (n: number | null) =>
  n == null ? '—' : new Intl.NumberFormat(intl(), { notation: 'compact', maximumFractionDigits: 1 }).format(n)

// Запуск разбора руками — для случая, когда ничего не запущено (free-тариф).
const starting = ref(false)
const startErr = ref('')
async function start() {
  if (starting.value || !active.value) return
  starting.value = true
  startErr.value = ''
  try {
    await api.siteAnalyticStart(active.value.domain, active.value.geo || undefined)
    refresh()
  } catch (e: any) {
    // self-host: тарифов/оплаты нет — показываем текст ошибки как есть.
    startErr.value = e?.serverMessage || t('warmup.startError')
  } finally {
    starting.value = false
  }
}
</script>

<template>
  <section class="rounded-2xl border border-border bg-surface p-5 lg:p-6">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <h2 class="text-[15px] font-semibold tracking-[-0.01em]">
          {{ analysing ? $t('warmup.title.analysing') : $t('warmup.title.idle') }}
        </h2>
        <p class="mt-1 text-[12.5px] leading-snug text-muted-foreground">
          {{ analysing ? $t('warmup.hint.analysing', { domain: domainLabel }) : $t('warmup.hint.idle', { domain: domainLabel }) }}
        </p>
      </div>

      <Button v-if="analysing" variant="outline" size="sm" class="h-8 gap-1.5 text-[12px]" @click="refresh">
        <RefreshCw :size="13" /> {{ $t('warmup.refresh') }}
      </Button>
      <Button v-else size="sm" class="h-8 gap-1.5 text-[12px]" :disabled="starting" @click="start">
        <Loader2 v-if="starting" :size="13" class="animate-spin" /><Play v-else :size="13" />
        {{ $t('warmup.start') }}
      </Button>
    </div>

    <p v-if="startErr" class="mt-2 text-[12px] text-amber-300/80">{{ startErr }}</p>

    <!-- полоса прогресса: доля ЗАВЕРШЁННЫХ шагов, без фейкового «ползёт само» -->
    <div v-if="analysing" class="mt-4 h-1 w-full overflow-hidden rounded-full bg-surface-hover">
      <div
        class="h-full rounded-full bg-brand-soft transition-[width] duration-700"
        :style="{ width: `${Math.max(percent, 6)}%` }"
      ></div>
    </div>

    <!-- шаги: ровно то, что происходит на бэке -->
    <ol class="mt-4 grid gap-2 sm:grid-cols-2">
      <li
        v-for="s in steps" :key="s.key"
        class="flex items-center gap-2 rounded-xl border border-border/70 px-3 py-2.5"
        :class="s.state === 'wait' ? 'opacity-55' : ''"
      >
        <span
          class="grid size-5 shrink-0 place-items-center rounded-full"
          :class="s.state === 'done' ? 'bg-emerald-500/15 text-emerald-400'
            : s.state === 'active' ? 'bg-brand-soft/15 text-brand-soft' : 'bg-surface-hover text-muted-foreground'"
        >
          <Check v-if="s.state === 'done'" :size="12" />
          <Loader2 v-else-if="s.state === 'active'" :size="12" class="animate-spin" />
          <span v-else class="size-1.5 rounded-full bg-current"></span>
        </span>
        <span class="min-w-0">
          <span class="block truncate text-[12.5px] font-medium">{{ $t(`warmup.steps.${s.key}.title`) }}</span>
          <span class="block truncate text-[11.5px] text-muted-foreground">
            {{ $t(`warmup.steps.${s.key}.${s.state}`) }}
          </span>
        </span>
      </li>
    </ol>

    <p v-if="analysing" class="mt-3 text-[11.5px] text-muted-foreground/70">{{ $t('warmup.eta') }}</p>

    <!-- Первые НАСТОЯЩИЕ данные: конкурентов находит разбор сайта, он
         заканчивается заметно раньше прогона по движкам. Показываем их сразу,
         чтобы ожидание не было пустым, и честно помечаем, что это находки
         разбора, а не результат мониторинга. -->
    <div v-if="earlyCompetitors.length" class="mt-5 border-t border-border pt-4">
      <div class="flex items-baseline justify-between gap-3">
        <h3 class="text-[13px] font-semibold">{{ $t('warmup.rivals.title') }}</h3>
        <span class="text-[11.5px] text-muted-foreground/70">{{ $t('warmup.rivals.note') }}</span>
      </div>

      <ul class="mt-2.5 divide-y divide-border/70">
        <li v-for="c in earlyCompetitors" :key="c.domain" class="flex items-center gap-2.5 py-2">
          <img :src="faviconSrc(c.domain)" width="16" height="16" class="shrink-0 rounded-sm" loading="lazy" alt="" />
          <span class="min-w-0 flex-1 truncate text-[12.5px]">{{ c.domain }}</span>
          <span v-if="c.source === 'ai'" class="shrink-0 text-[10px] text-violet-300">{{ $t('monitoring.competitors.aiNames') }}</span>
          <span class="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
            {{ $t('warmup.rivals.traffic', { v: trafficLabel(c.traffic) }) }}
          </span>
          <span v-if="c.dr != null" class="shrink-0 text-[11.5px] tabular-nums text-muted-foreground/70">
            {{ $t('warmup.rivals.dr', { v: c.dr }) }}
          </span>
        </li>
      </ul>
    </div>

    <!-- форма будущих панелей: серые плашки, чтобы страница не читалась как сломанная -->
    <div v-if="rows > 0" class="mt-5 space-y-2.5 border-t border-border pt-5" aria-hidden="true">
      <div
        v-for="i in rows" :key="i"
        class="h-3 animate-pulse rounded bg-surface-hover"
        :style="{ width: `${100 - (i - 1) * 14}%` }"
      ></div>
    </div>
  </section>
</template>
