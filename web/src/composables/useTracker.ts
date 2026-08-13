import { computed, reactive } from 'vue'
import { api } from '@/lib/api'
import { useBrands } from '@/composables/useBrands'
import { adaptSources, adaptTracker, type Platform, type PromptRow, type SourceRow } from '@/data/prompts'

// ── контракт aggregate_monitoring (scrapper core/aeo.py) ──────────────────
export interface BrandRow {
  brand: string
  self: boolean
  vis: number
  sov: number
  pos: number | null
  delta: number
}
/** диф последнего прогона с предыдущим (aggregate_monitoring.changes) */
export interface TrackerChanges {
  prevRunAt: string | null
  lastRunAt: string | null
  gained: { prompt: string; platforms?: string[] }[]
  lost: { prompt: string; platforms?: string[] }[]
  /** любая метрика монитора, ушедшая за порог значимости */
  metrics: { key: string; label: string; unit: 'pp' | 'pos'; from: number; to: number; delta: number; good: boolean }[]
  /** конкуренты, которые заметно двинулись или обошли нас за прогон */
  rivals: { brand: string; from: number; to: number; delta: number; passedUs: boolean; diverged: boolean }[]
  /** охват просел/вырос внутри промпта: % движков, назвавших бренд */
  visMoves: { prompt: string; from: number; to: number; fromEngines: number; toEngines: number; total: number }[]
  posMoves: { prompt: string; from: number; to: number }[]
  newSources: { host: string; n: number }[]
  goneSources: { host: string; n: number }[]
}
export interface TrackerAggregates {
  changes?: TrackerChanges
  kpi?: { visScore?: number; visDelta?: number; sov?: number; avgPos?: number | null; citeShare?: number }
  runs?: number
  promptsCount?: number
  platforms?: string[]
  leaderboard?: BrandRow[]
  visTrend?: {
    /** метки точек: «2026-W29» либо «2026-07-24» — зависит от granularity */
    weekLabels: string[]
    /** 'day' при частых прогонах, 'week' при редких */
    granularity?: 'day' | 'week'
    series: { brand: string; self: boolean; data: number[] }[]
  }
  citeShareTrend?: number[]
  platMatrix?: { brand: string; self: boolean; vals: number[] }[]
  citeCats?: { label: string; pct: number }[]
  topCiteDomains?: { d: string; n: number; own: boolean }[]
  watchedPages?: { url: string; n: number; delta: number }[]
  rivalSent?: { brand: string; self: boolean; score: number }[]
  /** темы тональности: бэк шлёт {t, tone}, старые прогоны — просто строки */
  sentThemes?: Array<{ t: string; tone?: 'good' | 'neutral' | 'bad' } | string>
}
/** шапка трекера: домен, счётчики панели, отметки прогонов по профилям тарифа */
export interface TrackerMeta {
  /** id трекера — нужен для мутаций панели промптов */
  id: number | null
  domain: string
  competitors: string[]
  activeCount: number
  suggestedCount: number
  inactiveCount: number
  promptsLimit: number | null
  promptCap: number | null
  lastRunAt: string | null
  microAt: string | null
  midAt: string | null
  fullAt: string | null
  yandexAt: string | null
  running: boolean
}

// Единый загрузчик AEO-трекера активного бренда: промпты, платформы, источники.
// Синглтон — «Мониторинг» и «Промпты» делят один запрос. Мока нет: пусто = «Нет данных».
//
// Кроме адаптированных строк храним СЫРЫЕ агрегаты бэкенда (aggregate_monitoring):
// kpi/leaderboard/visTrend/platMatrix/citeCats/topCiteDomains/watchedPages/
// rivalSent/sentThemes. Панели мониторинга читают их напрямую — считать те же
// метрики второй раз из rows нельзя (получаются другие числа, см. ревью /app).
const state = reactive({
  rows: [] as PromptRow[],
  platforms: [] as Platform[],
  sources: [] as SourceRow[],
  status: 'loading' as 'loading' | 'live' | 'empty',
  agg: null as TrackerAggregates | null,
  meta: null as TrackerMeta | null,
  /** id панели активного бренда — есть даже когда прогонов ещё нет (warmup) */
  trackerId: null as number | null,
  /** бэкенд сообщил, что прогон идёт прямо сейчас */
  running: false,
})
let pending: Promise<void> | null = null
/** Домен, для которого лежит state. Смена бренда без перезагрузки страницы
 *  оставляла синглтон нетронутым, и новый бренд открывался с цифрами старого. */
let loadedFor: string | null = null

const norm = (d: string) => String(d || '').trim().toLowerCase()
  .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]!.split('?')[0]!

export function useTracker() {
  const { state: brandState, load: loadBrands, activeDomain } = useBrands()

  function load(force = false): Promise<void> {
    // бренд сменился — данные предыдущего невалидны, грузим заново
    if (loadedFor !== null && loadedFor !== norm(activeDomain.value)) force = true
    if (pending && !force) return pending
    state.status = 'loading'
    pending = (async () => {
      try {
        await loadBrands()
        const dom = norm(activeDomain.value)
        loadedFor = dom
        const list: any = await api.aeoList()
        // Трекер строго по домену активного бренда. Первый из списка берём,
        // только когда брендов в аккаунте ВООБЩЕ нет (легаси-трекер без бренда):
        // иначе бренд без своего трекера показывал чужие цифры как свои.
        const noBrands = brandState.loaded && !brandState.failed && !brandState.brands.length
        const t = (list?.items || []).find((x: any) => norm(x.domain) === dom)
          || (!dom && noBrands ? (list?.items || [])[0] : null)
        state.trackerId = t?.id ?? null
        if (t?.id) {
          const full: any = await api.aeoGet(t.id)
          const adapted = adaptTracker(full)
          state.running = !!full?.running
          if (adapted.rows.length) {
            state.rows = adapted.rows
            state.platforms = adapted.platforms
            state.sources = adaptSources(adapted.rows, dom)
            state.agg = (full?.aggregates as TrackerAggregates) || null
            state.meta = {
              id: t.id,
              domain: full?.domain || dom,
              competitors: full?.competitors || [],
              activeCount: full?.activeCount ?? adapted.rows.length,
              suggestedCount: full?.suggestedCount ?? 0,
              inactiveCount: full?.inactiveCount ?? 0,
              promptsLimit: full?.promptsLimit ?? null,
              promptCap: full?.promptCap ?? null,
              lastRunAt: full?.last_run_at ?? null,
              microAt: full?.microAt ?? null,
              midAt: full?.midAt ?? null,
              fullAt: full?.fullAt ?? null,
              yandexAt: full?.yandexAt ?? null,
              running: !!full?.running,
            }
            state.status = 'live'
            return
          }
        }
      } catch { /* не авторизован / трекера нет */ }
      state.rows = []
      state.platforms = []
      state.sources = []
      state.agg = null
      state.meta = null
      state.status = 'empty'
      // trackerId/running НЕ трогаем: по ним экран отличает «панели нет»
      // от «панель есть, ждём первый прогон»
    })()
    return pending
  }

  const live = computed(() => state.status === 'live')

  return { state, load, live }
}

/** Панель бренда заведена, но прогонов ещё нет — экран «идёт первый разбор». */
export const trackerPending = () => state.trackerId !== null && state.status !== 'live'
