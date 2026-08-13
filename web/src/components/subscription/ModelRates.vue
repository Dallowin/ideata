<script setup lang="ts">
// Прайс по классам моделей: сколько кредитов стоит пост и вопрос ассистенту.
// В интерфейсе выбирается КЛАСС — полусотня моделей в одном селекторе
// парализует выбор; конкретные модели раскрываются внутри класса.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronDown } from 'lucide-vue-next'
import {
  CREDITS_RATE_BASE, MODEL_CLASSES, classMessageRange, classPostRange, creditsPriceLabel,
  creditsPerMessage, creditsPerPost, postsFor,
} from '@/data/credits'
import { intlLocale } from '@/i18n'

const { t } = useI18n()
const props = defineProps<{ pool?: number }>()

const open = ref(new Set<string>())
const toggle = (k: string) => {
  const n = new Set(open.value)
  n.has(k) ? n.delete(k) : n.add(k)
  open.value = n
}

const nf = (n: number) => n.toLocaleString(intlLocale())
const rateText = computed(() =>
  t('subscription.rate', { n: nf(CREDITS_RATE_BASE), price: creditsPriceLabel(CREDITS_RATE_BASE) }))

const rows = computed(() =>
  MODEL_CLASSES.map((c) => {
    const [pMin, pMax] = classPostRange(c)
    const [mMin, mMax] = classMessageRange(c)
    const posts = props.pool ? postsFor(props.pool, c) : null
    return {
      c,
      // подписи класса живут в словаре, ключ — в data/credits
      label: t(`subscription.modelClass.${c.key}.label`),
      hint: t(`subscription.modelClass.${c.key}.hint`),
      post: t('subscription.units.creditsShort', { v: pMin === pMax ? `${pMin}` : `${pMin}–${pMax}` }),
      msg: t('subscription.units.creditsShort', { v: mMin === mMax ? `${mMin}` : `${mMin}–${mMax}` }),
      // цена статьи в валюте витрины: кредиты × цена кредита
      postRub: pMin === pMax
        ? creditsPriceLabel(pMin)
        : `${creditsPriceLabel(pMin)}–${creditsPriceLabel(pMax)}`,
      posts,
      postsText: posts ? t('subscription.modelRates.upTo', { n: nf(posts) }, { plural: posts }) : '',
    }
  }),
)

const chipTitle = (m: { vendor: string; inUsd: number; outUsd: number }) =>
  t('subscription.modelRates.chipTitle', { vendor: m.vendor, in: '$' + m.inUsd, out: '$' + m.outUsd })
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-border px-4 py-3">
      <div>
        <h2 class="text-[13px] font-medium">{{ $t('subscription.modelRates.title') }}</h2>
        <p class="mt-0.5 text-[11.5px] text-muted-foreground">
          {{ $t('subscription.modelRates.hint') }}
        </p>
      </div>
      <span class="text-[11.5px] text-muted-foreground/70">{{ rateText }}</span>
    </div>

    <table class="w-full text-[12.5px]">
      <thead>
        <tr class="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground/70">
          <th class="px-4 py-2 text-left font-medium">{{ $t('subscription.modelRates.colClass') }}</th>
          <th class="w-[112px] px-2 py-2 text-right font-medium">{{ $t('subscription.modelRates.colPost') }}</th>
          <th class="w-[104px] px-2 py-2 text-right font-medium">{{ $t('subscription.modelRates.colMessage') }}</th>
          <th class="w-[150px] px-4 py-2 text-right font-medium">{{ $t('subscription.modelRates.colEnough') }}</th>
        </tr>
      </thead>
      <tbody class="divide-y divide-white/[0.04]">
        <template v-for="r in rows" :key="r.c.key">
          <tr class="cursor-pointer transition hover:bg-surface" @click="toggle(r.c.key)">
            <td class="px-4 py-3">
              <div class="flex items-center gap-2">
                <ChevronDown :size="13" class="shrink-0 text-muted-foreground/50 transition-transform" :class="open.has(r.c.key) ? 'rotate-180' : ''" />
                <span class="min-w-0">
                  <span class="block font-medium">{{ r.label }}</span>
                  <span class="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">{{ r.hint }}</span>
                </span>
              </div>
            </td>
            <td class="px-2 py-3 text-right">
              <span class="block tabular-nums">{{ r.post }}</span>
              <span class="mt-0.5 block text-[11px] tabular-nums text-muted-foreground/60">{{ r.postRub }}</span>
            </td>
            <td class="px-2 py-3 text-right">
              <span v-if="r.c.chat" class="tabular-nums">{{ r.msg }}</span>
              <span v-else class="text-[11.5px] text-muted-foreground/60">{{ $t('subscription.modelRates.notInChat') }}</span>
            </td>
            <td class="px-4 py-3 text-right tabular-nums text-muted-foreground">
              <template v-if="r.posts">{{ r.postsText }}</template>
              <template v-else>—</template>
            </td>
          </tr>

          <tr v-if="open.has(r.c.key)">
            <td colspan="4" class="bg-surface px-4 pb-3.5 pt-1">
              <div class="flex flex-wrap gap-1.5 pl-5">
                <!-- m.label — название модели вендора, не переводится -->
                <span
                  v-for="m in r.c.models" :key="m.id"
                  class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 py-1 pl-2.5 pr-2 text-[11.5px]"
                  :title="chipTitle(m)"
                >
                  <span class="text-text-2">{{ m.label }}</span>
                  <span class="tabular-nums text-muted-foreground/60">
                    {{ creditsPerPost(m) }}·{{ creditsPerMessage(m) }}
                  </span>
                </span>
              </div>
              <p class="mt-2 pl-5 text-[11px] text-muted-foreground/60">
                {{ $t('subscription.modelRates.chipLegend') }}
              </p>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </section>
</template>
