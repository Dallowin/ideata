import { computed, reactive } from 'vue'
import { api, type PlanContract } from '@/lib/api'
import { i18n } from '@/i18n'

// Тариф аккаунта, синглтон на сессию (как useAuth/useBrands): один фетч
// /scrape/me/plan, общий для «Подписки», «Команды» и будущих гейтов.
// Философия fail-open: пока тариф неизвестен — НЕ лочим фичи, авторитетный
// гейт остаётся на бэкенде; лочим только когда точно known-плана не хватает.
const state = reactive({ raw: null as PlanContract | null, checked: false })
let pending: Promise<void> | null = null

// Названия тарифов — фолбэк, если бэк не прислал title. Берём их из словаря
// витрины, чтобы кабинет на английском не подсовывал русское «Бестселлер».
// Присланный бэком title НЕ переводим: это строка из api.
const PLAN_KEYS = ['free', 'lite', 'pro', 'scale']
const planTitleFallback = (key: string) =>
  (PLAN_KEYS.includes(key) ? i18n.global.t(`subscription.plan.${key}.name`) : '')

export function usePlan() {
  function check(force = false): Promise<void> {
    if (state.checked && !force) return Promise.resolve()
    if (pending && !force) return pending
    pending = (async () => {
      try {
        state.raw = await api.myPlan()
      } catch {
        state.raw = null
      } finally {
        state.checked = true
        pending = null
      }
    })()
    return pending
  }

  const plan = computed(() => (state.raw?.plan || '').toLowerCase())
  const known = computed(() => !!plan.value)
  const title = computed(() => state.raw?.title || planTitleFallback(plan.value) || '—')
  const limits = computed(() => state.raw?.limits || {})
  const usage = computed(() => state.raw?.usage || {})
  const addons = computed(() => state.raw?.addons || [])
  const status = computed(() => state.raw?.status || '')
  const expiresAt = computed(() => state.raw?.expiresAt || null)
  const isFree = computed(() => plan.value === 'free')
  const isScale = computed(() => plan.value === 'scale')
  // платящий = точно знаем тариф и он не free → портал подписки вместо контакта
  const isPaid = computed(() => known.value && !isFree.value)
  // мест нет на free/lite (бэк отдаёт seats===1 = команды на тарифе нет)
  const noSeats = computed(() => limits.value.seats === 1)

  return { state, check, plan, known, title, limits, usage, addons, status, expiresAt, isFree, isScale, isPaid, noSeats }
}
