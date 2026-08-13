import { reactive } from 'vue'
import { api, type PlanScheduleEntry } from '@/lib/api'

// Контент-план Blog Writer. Синглтон с кэшем ПО МЕСЯЦАМ: возврат на страницу
// (или переключение месяца назад) показывает слоты мгновенно, обновление идёт
// молча в фоне. Лоадер — только когда для месяца ещё ничего нет.
const cache = reactive<Record<string, any[]>>({})
// расписание автопостинга того же месяца: отдельным кэшем, потому что живёт
// оно на статьях, а не на слотах плана — общего id у них нет
const schedules = reactive<Record<string, PlanScheduleEntry[]>>({})
// месяцы, для которых последний запрос упал: сбой ≠ «план пуст»
const failed = reactive<Record<string, boolean>>({})
const state = reactive({ loading: false })

export function useBlogPlan() {
  /** слоты месяца из кэша (пусто, если ещё не грузили) */
  const itemsOf = (key: string): any[] => cache[key] || []
  /** запланированные отправки месяца (пусто, если ещё не грузили) */
  const scheduleOf = (key: string): PlanScheduleEntry[] => schedules[key] || []
  const hasCache = (key: string) => Array.isArray(cache[key])
  /** последний запрос месяца упал — страница показывает «Повторить», а не «План пуст» */
  const hasFailed = (key: string) => !!failed[key]

  async function load(key: string, from: string, to: string): Promise<void> {
    if (!hasCache(key)) state.loading = true
    try {
      const r = await api.blogPlan(from, to)
      cache[key] = r?.items || []
      // поля schedule может не быть вовсе (старый бэк) — тогда чипов просто нет
      schedules[key] = r?.schedule || []
      failed[key] = false
    } catch {
      // кэш ошибкой НЕ затираем: пустой массив читался как «план пуст» и
      // прятал сбой 500 за нейтральной подсказкой
      failed[key] = true
    } finally {
      state.loading = false
    }
  }

  /** локально заменить слоты месяца (после create/update/remove — без перезапроса) */
  function setItems(key: string, items: any[]) { cache[key] = items }
  /** локально заменить расписание месяца (оптимистичный перенос чипа) */
  function setSchedule(key: string, entries: PlanScheduleEntry[]) { schedules[key] = entries }

  return { state, itemsOf, scheduleOf, hasCache, hasFailed, load, setItems, setSchedule }
}
