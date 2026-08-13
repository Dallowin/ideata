<script setup lang="ts">
// «Подписка»: текущий тариф с лимитами и оплатой + смена тарифа.
// Данные — только реальный контракт /scrape/me/plan (usePlan), витрина цен —
// data/pricing (та же сетка, что на лендинге). Структура ленты «тариф · лимиты ·
// действия» и мер использования — канон биллинга Kajabi/Twingate.
//
// Текст — из словаря `subscription.*`, числа остаются в data/pricing и
// подставляются в строки словаря: цифры в ru и en физически одни и те же.
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Check, CreditCard, Gift, Send } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import CreditsPanel from '@/components/subscription/CreditsPanel.vue'
import ModelRates from '@/components/subscription/ModelRates.vue'
import { usePlan } from '@/composables/usePlan'
import { useCredits } from '@/composables/useCredits'
import { intlLocale } from '@/i18n'
import {
  ADDONS, PLANS, PLAN_ORDER, PORTAL_URL, TG_CONTACT, YEARLY_DISCOUNT_PCT,
  checkoutUrl, fmtMoney, yearly, type Plan,
} from '@/data/pricing'
import { MODEL_CLASSES, postsFor } from '@/data/credits'

const { t, tm, rt } = useI18n()

const {
  check, plan, known, title, limits, usage, addons, expiresAt, isFree, isScale, isPaid,
} = usePlan()

// Баланс — из журнала списаний (credit_ledger через /blogwriter/credits).
// /scrape/me/plan кредиты не отдаёт, поэтому раньше сюда подставлялся пул из
// витрины и расход всегда выглядел нулевым. Витрина осталась фолбэком ровно на
// случай, когда ручка не ответила.
const { state: credits, load: loadCredits, spentKnown } = useCredits()
const planRow = computed(() => PLANS.find((p) => p.key === plan.value) || null)
const creditPool = computed(() =>
  (credits.loaded && !credits.failed ? credits.pool : 0)
  || (limits.value as any).credits
  || planRow.value?.credits
  || 0)
const creditsUsed = computed(() => (spentKnown.value ? credits.spent : null))
const creditsExtra = computed(() => (credits.loaded && !credits.failed ? credits.granted : 0))

/** числа — по языку интерфейса: «1 500» в русском, «1,500» в английском */
const nf = (n: number) => n.toLocaleString(intlLocale())

// «1 500 кредитов ≈ 75 постов на быстрой» — расшифровка пула в карточке тарифа
const fastClass = MODEL_CLASSES[0]!
const poolHint = (credits: number) => {
  if (!credits) return ''
  const n = postsFor(credits, fastClass)
  return t('subscription.card.poolHint', { n: nf(n) }, { plural: n })
}
const creditsText = (n: number) => t('subscription.units.credits', { n: nf(n) }, { plural: n })

const loading = ref(true)
onMounted(async () => {
  try { await Promise.all([check(), loadCredits()]) } finally { loading.value = false }
})

// ── лимиты тарифа: показываем только те, что бэк реально прислал ──────────
const meters = computed(() => {
  const l = limits.value, u = usage.value
  const rows: { label: string; used: number; total: number }[] = []
  if (l.prompts != null) rows.push({ label: t('subscription.meter.prompts'), used: u.prompts ?? 0, total: l.prompts })
  if (l.brands != null) rows.push({ label: t('subscription.meter.brands'), used: u.brands ?? 0, total: l.brands })
  if (l.postsPerDay) rows.push({ label: t('subscription.meter.postsToday'), used: u.postsToday ?? 0, total: l.postsPerDay })
  return rows
})
const pct = (r: { used: number; total: number }) => (r.total > 0 ? Math.min(100, Math.round((r.used / r.total) * 100)) : 0)

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'long', year: 'numeric' }) : ''

// ── витрина тарифов ───────────────────────────────────────────────────────
// Текст карточки собирается из словаря, числа приходят из data/pricing
// подстановками ({prompts}, {credits}…) — разойтись между языками нечему.
type PlanCard = Plan & { name: string; audience: string; badgeText: string; included: string[] }
const planCards = computed<PlanCard[]>(() => {
  const proName = t('subscription.plan.pro.name')
  return PLANS.map((p) => {
    const vars = { ...p.vars, credits: nf(p.credits), pro: proName }
    // tm на промахе возвращает объект, а не массив — .map по нему роняет экран
    const raw = tm(`subscription.plan.${p.key}.included`)
    const included = Array.isArray(raw) ? (raw as unknown[]) : []
    return {
      ...p,
      name: t(`subscription.plan.${p.key}.name`),
      audience: t(`subscription.plan.${p.key}.audience`),
      badgeText: p.badge ? t(`subscription.plan.${p.key}.badge`) : '',
      included: included.map((m) => rt(m as string, vars)),
    }
  })
})

// Докупки мониторинга: текст в словаре, число промптов — в data/pricing.
const addonCards = computed(() =>
  ADDONS.map((a) => ({
    ...a,
    title: t(`subscription.addon.${a.code}.title`, a.vars),
    scope: t(`subscription.addon.${a.code}.scope`),
  })))

// Годовой тариф в платёжке НЕ заведён: чекаут всегда месячный. Тумблер
// оставляем как справку о скидке, но по умолчанию показываем реальную цену —
// иначе человек видит 1 493 ₽, а списывается 1 990 ₽.
const annual = ref(false)
const priceOf = (p: Plan) => (p.monthly === 0 ? fmtMoney(0) : fmtMoney(annual.value ? yearly(p.monthly) : p.monthly))
const isCurrent = (key: string) => known.value && plan.value === key
// «Расширить» / «Перейти» / «Понизить» — по позиции тарифа относительно текущего
const ctaLabel = (p: PlanCard) => {
  if (!known.value) {
    return p.monthly ? t('subscription.plans.ctaPick', { plan: p.name }) : t('subscription.plans.ctaStartFree')
  }
  const diff = (PLAN_ORDER[p.key] ?? 0) - (PLAN_ORDER[plan.value] ?? 0)
  return diff > 0
    ? t('subscription.plans.ctaUpgrade', { plan: p.name })
    : t('subscription.plans.ctaDowngrade', { plan: p.name })
}
// числа бесплатного разбора (10 промптов / 9 движков) — из тарифной сетки
const freeVars = PLANS.find((p) => p.key === 'free')!.vars
const plansRef = ref<HTMLElement | null>(null)
const scrollToPlans = () => plansRef.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
</script>

<template>
  <div class="space-y-5 p-5 lg:p-6">
    <!-- шапка -->
    <div class="flex flex-wrap items-center gap-3">
      <div class="mr-auto">
        <h1 class="text-lg font-semibold tracking-tight">{{ $t('nav.subscription') }}</h1>
        <p class="mt-0.5 text-[12.5px] text-muted-foreground">{{ $t('subscription.subtitle') }}</p>
      </div>
    </div>

    <!-- ═══ текущий тариф: лента «план · лимиты · действия» ═══ -->
    <div class="overflow-hidden rounded-xl border border-border bg-surface">
      <div class="flex flex-col divide-y divide-border lg:flex-row lg:divide-x lg:divide-y-0">
        <!-- план -->
        <div class="flex shrink-0 flex-col justify-center p-5 lg:w-[248px]">
          <span class="text-[11px] uppercase tracking-wide text-muted-foreground/70">{{ $t('subscription.current.label') }}</span>
          <div class="mt-1.5 flex items-baseline gap-2">
            <span class="text-[26px] font-semibold leading-none tracking-tight">
              {{ loading ? '—' : title }}
            </span>
          </div>
          <p v-if="!loading && expiresAt" class="mt-2 text-[12px] text-muted-foreground">
            {{ $t('subscription.current.renews', { date: fmtDate(expiresAt) }) }}
          </p>
          <p v-else-if="!loading && isFree" class="mt-2 text-[12px] text-muted-foreground">
            {{ $t('subscription.current.freeNote') }}
          </p>
        </div>

        <!-- лимиты -->
        <div class="flex min-w-0 flex-1 items-center p-5">
          <div v-if="meters.length" class="grid w-full grid-cols-1 gap-x-10 gap-y-4 sm:grid-cols-2">
            <div v-for="m in meters" :key="m.label">
              <div class="mb-1.5 flex items-center justify-between gap-2 text-[12.5px]">
                <span class="truncate text-muted-foreground">{{ m.label }}</span>
                <span class="shrink-0 tabular-nums text-muted-foreground/70">
                  <span class="font-semibold text-foreground">{{ m.used }}</span> / {{ m.total }}
                </span>
              </div>
              <div class="h-1 overflow-hidden rounded-full bg-surface-hover">
                <div
                  class="h-full rounded-full transition-all"
                  :class="pct(m) >= 100 ? 'bg-amber-400/90' : 'bg-foreground/70'"
                  :style="{ width: pct(m) + '%' }"
                ></div>
              </div>
            </div>
          </div>
          <p v-else class="text-[12.5px] text-muted-foreground/70">
            {{ loading ? $t('subscription.meter.loading') : $t('subscription.meter.empty') }}
          </p>
        </div>

        <!-- действия -->
        <div class="flex shrink-0 flex-col justify-center gap-2 p-5 lg:w-[236px]">
          <Button v-if="!isScale" size="sm" class="h-8 w-full text-[12.5px]" @click="scrollToPlans">
            {{ $t('subscription.action.upgrade') }} <ArrowRight :size="14" />
          </Button>
          <Button v-if="isPaid" as-child variant="outline" size="sm" class="h-8 w-full border-border bg-surface text-[12.5px]">
            <a :href="PORTAL_URL"><CreditCard :size="13" /> {{ $t('subscription.action.portal') }}</a>
          </Button>
          <Button v-else as-child variant="outline" size="sm" class="h-8 w-full border-border bg-surface text-[12.5px]">
            <a :href="TG_CONTACT" target="_blank" rel="noopener"><Send :size="13" /> {{ $t('subscription.action.contact') }}</a>
          </Button>
        </div>
      </div>

      <!-- футер ленты: активные докупки + подпись об оплате -->
      <div class="flex flex-wrap items-center gap-x-5 gap-y-1.5 border-t border-border bg-surface px-5 py-2.5">
        <div v-if="addons.length" class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span class="text-[11px] uppercase tracking-wide text-muted-foreground/70">{{ $t('subscription.addonsActive') }}</span>
          <!-- a.title приходит с бэка — не переводим -->
          <span v-for="a in addons" :key="a.code" class="text-[12px] text-muted-foreground">
            {{ a.title }} <span class="tabular-nums text-muted-foreground/60">{{ fmtMoney(a.price) }}{{ $t('subscription.price.perMonth') }}</span>
          </span>
        </div>
        <p class="text-[12px] text-muted-foreground/70">
          <template v-if="isPaid">{{ $t('subscription.billing.portalNote') }}</template>
          <template v-else>{{ $t('subscription.billing.cardNote') }}</template>
          {{ $t('subscription.billing.ruNote') }}
        </p>
      </div>
    </div>

    <CreditsPanel :pool="creditPool" :used="creditsUsed" :extra="creditsExtra" :one-time="isFree" />

    <ModelRates :pool="creditPool" />

    <!-- ═══ free: разовый бесплатный разбор ═══ -->
    <div
      v-if="!loading && isFree"
      class="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl border p-4"
      :class="usage.freeRunUsed
        ? 'border-border bg-surface'
        : 'border-emerald-500/20 bg-emerald-500/[0.04]'"
    >
      <Gift :size="17" :class="usage.freeRunUsed ? 'text-muted-foreground/60' : 'text-emerald-400/90'" />
      <div class="mr-auto min-w-0">
        <div class="flex items-center gap-2">
          <span class="text-[13.5px] font-medium">{{ $t('subscription.free.title') }}</span>
          <span
            class="rounded-full border px-1.5 py-0.5 text-[10px] font-medium"
            :class="usage.freeRunUsed
              ? 'border-border bg-surface-2 text-muted-foreground'
              : 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'"
          >{{ usage.freeRunUsed ? $t('subscription.free.badgeUsed') : $t('subscription.free.badgeAvailable') }}</span>
        </div>
        <p class="mt-0.5 text-[12.5px] leading-snug text-muted-foreground">
          {{ usage.freeRunUsed
            ? $t('subscription.free.usedHint')
            : $t('subscription.free.availableHint', freeVars) }}
        </p>
      </div>
      <Button v-if="!usage.freeRunUsed" as-child size="sm" class="h-8 text-[12.5px]">
        <RouterLink to="/">{{ $t('subscription.free.run') }} <ArrowRight :size="13" /></RouterLink>
      </Button>
      <Button v-else variant="outline" size="sm" class="h-8 border-border bg-surface text-[12.5px]" @click="scrollToPlans">
        {{ $t('subscription.free.choosePlan') }} <ArrowRight :size="13" />
      </Button>
    </div>

    <!-- ═══ смена тарифа ═══ -->
    <section ref="plansRef" class="scroll-mt-6 space-y-3 pt-1">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 class="text-[13px] font-medium">{{ $t('subscription.plans.title') }}</h2>
          <p class="mt-0.5 text-[12.5px] text-muted-foreground">
            {{ $t('subscription.plans.hint', { pct: YEARLY_DISCOUNT_PCT }) }}
          </p>
        </div>
        <div class="inline-flex items-center rounded-lg border border-border bg-surface-2 p-0.5 text-[12.5px] font-medium">
          <button
            type="button" class="h-7 rounded-md px-3 transition"
            :class="!annual ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'"
            @click="annual = false"
          >{{ $t('subscription.plans.month') }}</button>
          <button
            type="button" class="inline-flex h-7 items-center gap-1.5 rounded-md px-3 transition"
            :class="annual ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'"
            @click="annual = true"
          >
            {{ $t('subscription.plans.year') }}
            <span class="text-[10.5px] font-semibold" :class="annual ? 'text-emerald-600' : 'text-emerald-400'">
              {{ $t('subscription.plans.discount', { pct: YEARLY_DISCOUNT_PCT }) }}
            </span>
          </button>
        </div>
      </div>

      <div class="grid items-stretch gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div
          v-for="p in planCards" :key="p.key"
          class="relative flex flex-col rounded-xl border p-5 transition"
          :class="isCurrent(p.key)
            ? 'border-foreground/25 bg-surface-hover'
            : p.featured ? 'border-border bg-surface-2 hover:border-border/80' : 'border-border bg-surface hover:border-border/80'"
        >
          <div class="flex h-6 items-center justify-between gap-2">
            <span class="text-[14px] font-semibold">{{ p.name }}</span>
            <span
              v-if="isCurrent(p.key)"
              class="rounded-full bg-foreground px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap text-background"
            >{{ $t('subscription.plans.yourPlan') }}</span>
            <span
              v-else-if="p.badgeText"
              class="rounded-full border border-border bg-surface-hover px-2 py-0.5 text-[10px] font-medium whitespace-nowrap text-muted-foreground"
            >{{ p.badgeText }}</span>
          </div>

          <div class="mt-3 flex items-baseline gap-1.5">
            <span class="text-[28px] font-semibold leading-none tracking-tight">{{ priceOf(p) }}</span>
            <span class="text-[12px] text-muted-foreground/70">
              {{ p.monthly ? $t('subscription.price.perMonth') : $t('subscription.price.oneTime') }}
            </span>
          </div>
          <p class="mt-1.5 min-h-[16px] text-[11.5px] text-muted-foreground/60">
            <template v-if="p.monthly && annual">
              {{ $t('subscription.price.annualNote', { price: fmtMoney(p.monthly) }) }}
            </template>
            <template v-else-if="!p.monthly">{{ $t('subscription.price.noCard') }}</template>
          </p>

          <div class="mt-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
            <div class="text-[13px] font-medium tabular-nums">
              {{ creditsText(p.credits) }}<span class="text-muted-foreground">{{ p.monthly ? $t('subscription.price.perMonth') : ' ' + $t('subscription.price.oneTime') }}</span>
            </div>
            <div class="mt-0.5 text-[11px] text-muted-foreground/70">{{ poolHint(p.credits) }}</div>
          </div>

          <p class="mt-2.5 min-h-[34px] text-[12.5px] leading-snug text-muted-foreground">{{ p.audience }}</p>

          <div class="mt-4">
            <span
              v-if="isCurrent(p.key)"
              class="inline-flex h-8 w-full items-center justify-center rounded-md border border-border bg-surface-2 text-[12.5px] font-medium text-muted-foreground"
            >{{ $t('subscription.plans.active') }}</span>
            <Button
              v-else-if="p.monthly" as-child size="sm" class="h-8 w-full text-[12.5px]"
              :variant="p.featured ? 'default' : 'outline'"
              :class="p.featured ? '' : 'border-border bg-surface'"
            >
              <a :href="checkoutUrl(p.key, annual ? 'year' : 'month')">
                {{ ctaLabel(p) }} <ArrowRight :size="13" />
              </a>
            </Button>
            <span
              v-else
              class="inline-flex h-8 w-full items-center justify-center rounded-md border border-border bg-surface text-[12.5px] font-medium text-muted-foreground/70"
            >{{ $t('subscription.plans.freeCta') }}</span>
          </div>

          <ul class="mt-4 flex-1 space-y-2 border-t border-border pt-4">
            <li v-for="f in p.included" :key="f" class="flex items-start gap-2 text-[12.5px] leading-snug text-muted-foreground">
              <Check :size="13" class="mt-0.5 shrink-0 text-muted-foreground/50" />
              <span>{{ f }}</span>
            </li>
          </ul>

          <a
            v-if="p.contact && !isCurrent(p.key)" :href="TG_CONTACT" target="_blank" rel="noopener"
            class="mt-3 inline-flex items-center justify-center gap-1.5 text-[12px] text-muted-foreground/70 transition hover:text-foreground"
          >
            <Send :size="12" /> {{ $t('subscription.plans.contact') }}
          </a>
        </div>
      </div>
    </section>

    <!-- ═══ докупки ═══ -->
    <section class="space-y-3 pt-1">
      <div>
        <h2 class="text-[13px] font-medium">{{ $t('subscription.addonsSection.title') }}</h2>
        <p class="mt-0.5 text-[12.5px] text-muted-foreground">{{ $t('subscription.addonsSection.hint') }}</p>
      </div>
      <div class="grid gap-3 sm:grid-cols-3">
        <div v-for="a in addonCards" :key="a.code" class="flex items-center gap-3 rounded-xl border border-border bg-surface p-4">
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-medium">{{ a.title }}</div>
            <div class="mt-0.5 text-[11.5px] text-muted-foreground/70">{{ a.scope }}</div>
          </div>
          <div class="shrink-0 text-right">
            <div class="text-[13px] font-semibold tabular-nums">{{ fmtMoney(a.monthly) }}</div>
            <div class="text-[11px] text-muted-foreground/60">{{ $t('subscription.addonsSection.perMonth') }}</div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>
