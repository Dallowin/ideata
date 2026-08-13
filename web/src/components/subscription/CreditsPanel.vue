<script setup lang="ts">
// Кредиты: баланс, расход за период и пакеты докупки.
// Данные — из журнала списаний (useCredits → /blogwriter/credits). Если ручка
// не ответила, показываем пул тарифа и честно говорим, что расход неизвестен:
// рисовать ноль потраченных нельзя, списания идут по-настоящему.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Coins } from 'lucide-vue-next'
import { CREDIT_PACKS, CREDIT_PACKS_PURCHASABLE, TG_CONTACT, checkoutUrl, fmtMoney } from '@/data/pricing'
import { CREDITS_RATE_BASE, creditsPriceLabel } from '@/data/credits'
import { intlLocale } from '@/i18n'

const { t } = useI18n()

const props = defineProps<{
  /** пул тарифа за период */
  pool: number
  /** сколько потрачено (из журнала); null — расход неизвестен */
  used: number | null
  /** докупленные/начисленные кредиты сверх пула */
  extra?: number
  /** free-пул выдаётся разово и не возобновляется */
  oneTime?: boolean
}>()

const total = computed(() => props.pool + (props.extra || 0))
const left = computed(() => (props.used == null ? null : Math.max(0, total.value - props.used)))
const pct = computed(() =>
  props.used == null || !total.value ? 0 : Math.min(100, Math.round((props.used / total.value) * 100)),
)
const nf = (n: number) => n.toLocaleString(intlLocale())
const creditsText = (n: number) => t('subscription.units.credits', { n: nf(n) }, { plural: n })
// «1 000 кредитов = $29»: число базы — в data/credits, текст — в словаре
const rateText = computed(() =>
  t('subscription.rate', { n: nf(CREDITS_RATE_BASE), price: creditsPriceLabel(CREDITS_RATE_BASE) }))
// подписи пакетов — по коду продукта, цены и объёмы остаются в data/pricing
const packs = computed(() =>
  CREDIT_PACKS.map((p) => ({ ...p, note: t(`subscription.pack.${p.code}.note`) })))
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex flex-col divide-y divide-border lg:flex-row lg:divide-x lg:divide-y-0">
      <!-- баланс -->
      <div class="flex shrink-0 flex-col justify-center p-5 lg:w-[248px]">
        <span class="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground/70">
          <Coins :size="12" /> {{ $t('subscription.creditsPanel.label') }}
        </span>
        <div class="mt-1.5 flex items-baseline gap-1.5">
          <span class="text-[26px] font-semibold leading-none tracking-tight tabular-nums">
            {{ left == null ? nf(total) : nf(left) }}
          </span>
          <span class="text-[12px] text-muted-foreground">
            {{ left == null
              ? $t('subscription.creditsPanel.inPool')
              : $t('subscription.creditsPanel.ofTotal', { n: nf(total) }) }}
          </span>
        </div>
        <p class="mt-2 text-[12px] text-muted-foreground">
          <template v-if="left == null">{{ $t('subscription.creditsPanel.usageUnknown') }}</template>
          <template v-else-if="oneTime">{{ $t('subscription.creditsPanel.oneTimePool') }}</template>
          <template v-else>{{ $t('subscription.creditsPanel.renews') }}</template>
        </p>
      </div>

      <!-- расход -->
      <div class="flex min-w-0 flex-1 items-center p-5">
        <div class="w-full">
          <div class="mb-1.5 flex items-center justify-between gap-2 text-[12.5px]">
            <span class="text-muted-foreground">{{ $t('subscription.creditsPanel.spentLabel') }}</span>
            <span class="shrink-0 tabular-nums text-muted-foreground/70">
              <span class="font-semibold text-foreground">{{ used == null ? '—' : nf(used) }}</span> / {{ nf(total) }}
            </span>
          </div>
          <div class="h-1 overflow-hidden rounded-full bg-surface-hover">
            <div
              class="h-full rounded-full transition-all"
              :class="pct >= 100 ? 'bg-amber-400/90' : 'bg-foreground/70'"
              :style="{ width: pct + '%' }"
            ></div>
          </div>
          <p class="mt-2.5 text-[12px] text-muted-foreground/70">
            {{ $t('subscription.creditsPanel.spendNote') }}
          </p>
        </div>
      </div>
    </div>

    <!-- пакеты докупки -->
    <div class="border-t border-border bg-surface px-5 py-4">
      <div class="mb-3 flex items-baseline gap-2">
        <span class="text-[12px] font-medium">{{ $t('subscription.creditsPanel.buyTitle') }}</span>
        <span class="text-[11.5px] text-muted-foreground/70">
          {{ rateText }}<template v-if="!CREDIT_PACKS_PURCHASABLE"> · {{ $t('subscription.creditsPanel.viaSupport') }}</template>
        </span>
      </div>
      <div class="grid gap-3 sm:grid-cols-3">
        <a
          v-for="p in packs" :key="p.code"
          :href="CREDIT_PACKS_PURCHASABLE ? checkoutUrl(p.code) : TG_CONTACT"
          :target="CREDIT_PACKS_PURCHASABLE ? undefined : '_blank'"
          :rel="CREDIT_PACKS_PURCHASABLE ? undefined : 'noopener'"
          class="group flex items-center gap-3 rounded-xl border border-border/70 bg-surface px-4 py-3 transition hover:border-white/15 hover:bg-surface-2"
        >
          <span class="min-w-0 flex-1">
            <span class="block text-[13.5px] font-medium tabular-nums">{{ creditsText(p.credits) }}</span>
            <span class="mt-0.5 block text-[11.5px] text-muted-foreground">{{ p.note }}</span>
          </span>
          <span class="shrink-0 text-right">
            <span class="block text-[13px] font-semibold tabular-nums">{{ fmtMoney(p.price) }}</span>
            <ArrowRight :size="12" class="ml-auto mt-0.5 text-muted-foreground/40 transition group-hover:text-foreground" />
          </span>
        </a>
      </div>
    </div>
  </section>
</template>
