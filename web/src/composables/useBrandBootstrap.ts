import { computed, onScopeDispose, reactive } from 'vue'
import { useBrands } from '@/composables/useBrands'
import { useSiteAnalytic } from '@/composables/useSiteAnalytic'
import { useTracker } from '@/composables/useTracker'
import { api } from '@/lib/api'
import { i18n } from '@/i18n'

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

const state = reactive({
  pollers: 0,
  starting: false,
  recovering: false,
  error: '',
  errorDomain: '',
})
let timer: ReturnType<typeof setInterval> | null = null
let loadPending: Promise<void> | null = null
let loadKey = ''
let startPending: Promise<void> | null = null
let startKey = ''
let recoveryPending: Promise<boolean> | null = null
let recoveryKey = ''
let failedRecoveryKey = ''

const norm = (d: string) => String(d || '').trim().toLowerCase()
  .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]!.split('?')[0]!

function fallbackError(e: any): string {
  const message = e?.serverMessage
    || (e?.message && !/^(HTTP \d+|network)$/i.test(e.message) ? e.message : '')
  return message || i18n.global.t('warmup.startError')
}

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
    if (state.starting || state.recovering || siteRunning.value || firstRunPending.value || tracker.running) {
      return 'analysing'
    }
    // статусы ещё не приехали — молчим, а не пугаем пустотой
    if (tracker.status === 'loading' || site.status === 'idle' || site.status === 'loading') return 'unknown'
    return 'idle'
  })

  /** Шаги для полосы прогресса: бренд заведён → сайт разобран → промпты → прогон. */
  const steps = computed<BootstrapStep[]>(() => {
    const brand: StepState = active.value ? 'done' : 'wait'
    const siteStep: StepState = siteDone.value ? 'done' : (siteRunning.value || state.starting) ? 'active' : 'wait'
    const promptsStep: StepState = tracker.trackerId !== null
      ? (tracker.status === 'live' ? 'done' : 'active')
      : state.recovering ? 'active' : 'wait'
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

  function clearError(domain: string) {
    state.error = ''
    state.errorDomain = domain
  }

  function reportError(domain: string, e: any) {
    state.errorDomain = domain
    state.error = fallbackError(e)
  }

  /** Оба статуса читаются как одна операция: все страницы делят один in-flight. */
  function loadState(force = false): Promise<void> {
    const domain = norm(active.value?.domain || '')
    if (loadPending && loadKey === domain) return loadPending
    if (loadPending) return loadPending.then(() => loadState(true))
    const run = Promise.all([loadTracker(force), loadSite(force)]).then(() => undefined)
    loadKey = domain
    loadPending = run
    void run.finally(() => {
      if (loadPending === run) {
        loadPending = null
        loadKey = ''
      }
    })
    return run
  }

  /**
   * Страховка для завершённых до авто-provision разборов. Она никогда не
   * запускает site_analytic: использует только уже готовый analysisId, а
   * domain:id не пробуется повторно после ошибки без явного Retry.
   */
  function recoverTracker(retry = false): Promise<boolean> {
    const domain = norm(active.value?.domain || '')
    const analysisId = site.analysisId
    if (!domain || site.status !== 'done' || !analysisId || tracker.trackerId !== null) {
      if (domain && tracker.trackerId !== null) clearError(domain)
      return Promise.resolve(true)
    }

    const key = `${domain}:${analysisId}`
    if (!retry && failedRecoveryKey === key) return Promise.resolve(false)
    if (recoveryPending && recoveryKey === key) return recoveryPending
    if (recoveryPending) return recoveryPending.then(() => recoverTracker(retry))

    recoveryKey = key
    state.recovering = true
    clearError(domain)
    const run = (async () => {
      try {
        await api.aeoTrack(domain, analysisId, active.value?.competitors || [])
        await loadTracker(true)
        if (tracker.trackerId === null) throw new Error()
        failedRecoveryKey = ''
        clearError(domain)
        return true
      } catch (e) {
        failedRecoveryKey = key
        reportError(domain, e)
        return false
      } finally {
        state.recovering = false
      }
    })()
    recoveryPending = run
    void run.finally(() => {
      if (recoveryPending === run) {
        recoveryPending = null
        recoveryKey = ''
      }
    })
    return run
  }

  /** Начальная загрузка и recovery доступны всем прямым входам в кабинет. */
  async function initialize(force = false): Promise<boolean> {
    await loadState(force)
    return recoverTracker(false)
  }

  function refresh() {
    return initialize(true)
  }

  /**
   * Единственная frontend-точка запуска. Повторный клик ждёт тот же promise;
   * running/done анализ не стартует заново, done без трекера идёт в recovery.
   */
  async function startAnalysis(requestedDomain?: string, requestedGeo?: string): Promise<void> {
    const domain = norm(requestedDomain || active.value?.domain || '')
    if (startPending && startKey === domain) return startPending
    if (startPending) {
      try { await startPending } catch { /* другой домен всё равно должен продолжить */ }
      return startAnalysis(requestedDomain, requestedGeo)
    }
    const run = (async () => {
      if (!domain) throw new Error()
      state.starting = true
      clearError(domain)
      try {
        // После сетевого сбоя Retry сначала перечитывает состояние. Только
        // подтверждённый none имеет право создать новую LLM-задачу.
        await loadState(site.status === 'error')
        if (site.status === 'done' && site.analysisId) {
          if (!(await recoverTracker(true))) throw new Error(state.error)
          return
        }
        // Не плодим LLM-задачи, если запуск уже принят бэкендом.
        if (site.status === 'running') return
        // Неизвестное состояние нельзя трактовать как «разбора нет»: сначала
        // пользователь увидит ошибку и сможет безопасно повторить чтение.
        if (site.status === 'error') throw new Error()

        await api.siteAnalyticStart(
          domain,
          requestedGeo || active.value?.geo || undefined,
        )
        await loadState(true)
        // cached=true может сразу вернуть done. На этом пути также используем
        // тот же снимок, не запускаем второй site analysis.
        if (site.status === 'done' && site.analysisId && tracker.trackerId === null) {
          if (!(await recoverTracker(true))) throw new Error(state.error)
        }
      } catch (e) {
        if (!state.error || state.errorDomain !== domain) reportError(domain, e)
        throw e
      } finally {
        state.starting = false
      }
    })()
    startKey = domain
    startPending = run
    try {
      await run
    } finally {
      if (startPending === run) {
        startPending = null
        startKey = ''
      }
    }
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
        if (phase.value === 'analysing') void refresh()
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
    phase, steps, percent, initialize, refresh, startAnalysis, watchProgress, earlyCompetitors,
    starting: computed(() => state.starting),
    error: computed(() => state.errorDomain === norm(active.value?.domain || '') ? state.error : ''),
    domain: computed(() => active.value?.domain || ''),
  }
}
