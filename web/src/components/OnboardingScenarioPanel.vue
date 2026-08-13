<script setup lang="ts">
// Пульт сценариев онбординга (только для мока). Ветки финала на живом бэке
// достаются лишь сменой тарифа, потраченным бесплатным разбором или падением
// создания бренда — прокликать их иначе нельзя. Тут они переключаются на лету.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown, RotateCcw, SlidersHorizontal } from 'lucide-vue-next'
import type { Scenario } from '@/composables/useOnboardingMock'

defineProps<{ scenario: Scenario; screen: string }>()
defineEmits<{ reset: [] }>()

const { t } = useI18n()
const open = ref(true)

const ROWS = computed<{ key: keyof Scenario; label: string; options: { value: unknown; label: string }[] }[]>(() => [
  {
    key: 'plan', label: t('onboarding.scenario.plan.label'),
    options: [
      { value: 'free', label: t('onboarding.scenario.plan.free') },
      { value: 'paid', label: t('onboarding.scenario.plan.paid') },
    ],
  },
  {
    key: 'freeRunUsed', label: t('onboarding.scenario.freeRun.label'),
    options: [
      { value: false, label: t('onboarding.scenario.freeRun.available') },
      { value: true, label: t('onboarding.scenario.freeRun.used') },
    ],
  },
  {
    key: 'emailVerified', label: t('onboarding.scenario.email.label'),
    options: [
      { value: true, label: t('onboarding.scenario.email.verified') },
      { value: false, label: t('onboarding.scenario.email.no') },
    ],
  },
  {
    key: 'outcome', label: t('onboarding.scenario.outcome.label'),
    options: [
      { value: 'ok', label: t('onboarding.scenario.outcome.ok') },
      { value: 'brandLimit', label: t('onboarding.scenario.outcome.limit') },
      { value: 'error', label: t('onboarding.scenario.outcome.error') },
    ],
  },
  {
    key: 'peek', label: t('onboarding.scenario.peek.label'),
    options: [
      { value: 'found', label: t('onboarding.scenario.peek.found') },
      { value: 'empty', label: t('onboarding.scenario.peek.empty') },
      { value: 'slow', label: t('onboarding.scenario.peek.slow') },
    ],
  },
])
</script>

<template>
  <div class="fixed bottom-4 right-4 z-40 w-[268px] rounded-[14px] border border-border bg-background/95 backdrop-blur">
    <button
      type="button" class="flex w-full items-center gap-2 px-3 py-2.5 text-[12px] font-medium text-muted-foreground transition hover:text-foreground"
      @click="open = !open"
    >
      <SlidersHorizontal :size="13" />
      {{ $t('onboarding.scenario.title') }}
      <span class="ml-auto rounded-full border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide">{{ screen }}</span>
      <ChevronDown :size="13" :class="open ? 'rotate-180 transition' : 'transition'" />
    </button>

    <div v-if="open" class="space-y-2.5 border-t border-border px-3 py-3">
      <div v-for="row in ROWS" :key="row.key">
        <p class="mb-1 text-[11px] text-muted-foreground/70">{{ row.label }}</p>
        <div class="flex flex-wrap gap-1">
          <button
            v-for="opt in row.options" :key="String(opt.value)" type="button"
            class="rounded-full border px-2 py-0.5 text-[11.5px] transition"
            :class="scenario[row.key] === opt.value
              ? 'border-white/30 bg-surface-hover text-foreground'
              : 'border-border text-muted-foreground hover:text-foreground'"
            @click="(scenario[row.key] as unknown) = opt.value"
          >{{ opt.label }}</button>
        </div>
      </div>

      <button
        type="button"
        class="mt-1 inline-flex w-full items-center justify-center gap-1.5 rounded-[10px] border border-border py-1.5 text-[12px] text-muted-foreground transition hover:text-foreground"
        @click="$emit('reset')"
      ><RotateCcw :size="12" /> {{ $t('onboarding.scenario.reset') }}</button>
    </div>
  </div>
</template>
