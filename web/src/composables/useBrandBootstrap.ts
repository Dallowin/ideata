import { computed, onScopeDispose, reactive } from 'vue'
import { useBrands } from '@/composables/useBrands'
import { useSiteAnalytic } from '@/composables/useSiteAnalytic'
import { useTracker } from '@/composables/useTracker'

/**
 * В каком состоянии бренд СРАЗУ после добавления. Раньше кабинет знал только
 * «есть данные / нет данных», поэтому свежий бренд открывался пустыми экранами
 * без единого слова о том, что происходит и сколько ждать.
 *
 * Фазы:
 *  - `ready`    — панель отдала прогоны, рисуем настоящие экраны;
 *  - `analysing`— разбор сайта в очереди/считается либо панель заведена, но
 *                 первого прогона ещё нет: показываем шаги и скелетоны;
 *  - `idle`     — ничего не запущено (free без разбора): зовём запустить;
 *  - `unknown`  — ещё грузим статусы, ничего не утверждаем.
 *
 * Пока идёт разбор — опрашиваем бэк, чтобы экран сам сменился на данные.
 * Опрос редкий: обе ручки ходят в скраппер, а разбор занимает минуты.
 */
const POLL_MS = 15_000

export type BootstrapPhase = 'unknown' | 'analysing' | 'idle' | 'ready'
export type StepState = 'done' | 'active' | 'wait'

export interface BootstrapStep {
  key: 'brand' | 'site' | 'prompts' | 'run'
  state: StepState
}

const state = reactive({ pollers: 0 })
let timer: ReturnType<typeof setInterval> | null = null

export function useBrandBootstrap() {
  const { active } = useBrands()
  const { state: tracker, load: loadTracker } = useTracker()
  const { state: site, load: loadSite } = useSiteAnalytic()

  const siteRunning = computed(() => site.status === 'running')
  const siteDone = computed(() => site.status === 'done')
  /** панель заведена, но прогонов ещё нет — либо крутится первый */
  const firstRunPending = computed(() =>
    tracker.trackerId !== null && tracker.status === 'empty')

  const phase = computed<BootstrapPhase>(() => {
    if (tracker.status === 'live') return 'ready'
    // статусы ещё не приехали — молчим, а не пугаем пустотой
    if (tracker.status === 'loading' || site.status === 'idle' || site.status === 'loading') return 'unknown'
    if (siteRunning.value || firstRunPending.value || tracker.running) return 'analysing'
    return 'idle'
  })

  /** Шаги для полосы прогресса: бренд заведён → сайт разобран → промпты → прогон. */
  const steps = computed<BootstrapStep[]>(() => {
    const brand: StepState = active.value ? 'done' : 'wait'
    const siteStep: StepState = siteDone.value ? 'done' : siteRunning.value ? 'active' : 'wait'
    const promptsStep: StepState = tracker.trackerId !== null
      ? (tracker.status === 'live' ? 'done' : 'active')
      : 'wait'
    const runStep: StepState = tracker.status === 'live'
      ? 'done'
      : (tracker.running ? 'active' : 'wait')
    return [
      { key: 'brand', state: brand },
      { key: 'site', state: siteStep },
      { key: 'prompts', state: promptsStep },
      { key: 'run', state: runStep },
    ]
  })

  const doneCount = computed(() => steps.value.filter((s) => s.state === 'done').length)
  const percent = computed(() => Math.round((doneCount.value / steps.value.length) * 100))

  /**
   * Конкуренты, найденные РАЗБОРОМ САЙТА. Появляются на пару минут раньше
   * первого прогона по движкам, поэтому во время ожидания это единственные
   * настоящие данные, которые уже можно показать. Мониторинг потом посчитает
   * по ним долю голоса — здесь только список находок, без метрик видимости.
   *
   * Голые названия («GetBlogger») отбрасываем: трекер ищет упоминания по
   * домену, и без точки это не домен (та же фильтрация, что в CompetitorsDialog).
   */
  const earlyCompetitors = computed(() => {
    const self = (active.value?.domain || '').toLowerCase().replace(/^www\./, '')
    return (site.facts?.competitors || [])
      .map((c) => ({
        domain: String(c.domain || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, ''),
        traffic: c.traffic ?? null,
        dr: c.dr ?? null,
        shared: c.shared ?? null,
        source: c.source || '',
      }))
      .filter((c) => c.domain.includes('.') && c.domain !== self)
      .slice(0, 8)
  })

  function refresh() {
    loadTracker(true)
    loadSite(true)
  }

  /**
   * Подписка на автообновление: пока на экране есть хоть один потребитель и
   * фаза «считается», раз в POLL_MS перечитываем статусы. Счётчик — чтобы
   * несколько компонентов на странице не заводили по своему таймеру.
   */
  function watchProgress() {
    state.pollers += 1
    if (!timer) {
      timer = setInterval(() => {
        if (phase.value === 'analysing') refresh()
      }, POLL_MS)
    }
    onScopeDispose(() => {
      state.pollers -= 1
      if (state.pollers <= 0 && timer) {
        clearInterval(timer)
        timer = null
        state.pollers = 0
      }
    })
  }

  return {
    phase, steps, percent, refresh, watchProgress, earlyCompetitors,
    domain: computed(() => active.value?.domain || ''),
  }
}
