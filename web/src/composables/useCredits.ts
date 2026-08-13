import { computed, reactive } from 'vue'
import { api } from '@/lib/api'

/**
 * Баланс кредитов — из журнала списаний, а не из витрины.
 *
 * Страница «Подписка» брала пул и расход из `/scrape/me/plan`, который кредиты
 * не отдаёт вообще: фолбэк молча подставлял число из тарифной сетки, и человек,
 * потративший половину пула, видел его нетронутым с подписью «списания
 * появятся, когда включим учёт». Списания при этом уже шли.
 *
 * Настоящий баланс живёт в NestJS (`credit_ledger`) и отдаётся ручкой
 * `/blogwriter/credits`: pool + granted − spent, окно зависит от тарифа
 * (у free пул разовый). `degraded: true` — учёт недоступен; тогда честно
 * показываем пул тарифа и говорим, что расход неизвестен, а не рисуем ноль.
 */
export interface CreditsState {
  pool: number
  granted: number
  spent: number
  balance: number
  /** учёт недоступен (нет таблицы/БД) — расход показывать нельзя */
  degraded: boolean
  /** запрос не дошёл до бэка */
  failed: boolean
  loaded: boolean
  loading: boolean
}

const state = reactive<CreditsState>({
  pool: 0, granted: 0, spent: 0, balance: 0,
  degraded: false, failed: false, loaded: false, loading: false,
})
let pending: Promise<void> | null = null

export function useCredits() {
  function load(force = false): Promise<void> {
    if (state.loaded && !force) return Promise.resolve()
    if (pending && !force) return pending
    state.loading = true
    pending = (async () => {
      try {
        const r = await api.blogCredits()
        state.pool = Number(r?.pool || 0)
        state.granted = Number(r?.granted || 0)
        state.spent = Number(r?.spent || 0)
        state.balance = Number(r?.balance ?? (state.pool + state.granted - state.spent))
        state.degraded = !!r?.degraded
        state.failed = false
      } catch {
        // не дошли до бэка — это НЕ «потрачено ноль»
        state.failed = true
      } finally {
        state.loaded = true
        state.loading = false
        pending = null
      }
    })()
    return pending
  }

  /** Расход известен только когда учёт поднят и запрос дошёл. */
  const spentKnown = computed(() => state.loaded && !state.failed && !state.degraded)

  return { state, load, spentKnown }
}
