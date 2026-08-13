import { computed, reactive } from 'vue'
import { api } from '@/lib/api'

// Статьи/раны Blog Writer активного бренда (GET /blogwriter/posts). Синглтон:
// сайдбар-темы и страница «Темы» делят один запрос. Мока нет.
export interface BlogRun {
  id: string
  topic: string
  title: string | null
  status: string
  /** язык версии (пусто = оригинал/дефолт бренда) */
  locale: string
  /** id группы переводов — у всех локалей одной статьи общий (у оригинала = его id) */
  groupId: string
  category: string
  views: number
  wordCount: number | null
  coverUrl: string | null
  blogStatus: string
  error: string | null
  createdAt: string
  updatedAt: string
}

/** Статья + собранные по группе локали (для списка тем — схлопнутые переводы). */
export interface BlogGroup extends BlogRun {
  /** коды локалей всех версий (напр. ['en','de']); оригинал часто с пустой locale */
  locales: string[]
  /** сколько всего версий в группе (оригинал + переводы) */
  variantCount: number
}

/** Схлопнуть раны по groupId: представитель — оригинал (id===groupId) или самый свежий. */
export function groupByLocale(runs: BlogRun[]): BlogGroup[] {
  const groups = new Map<string, BlogRun[]>()
  for (const r of runs) {
    const key = r.groupId || r.id
    const arr = groups.get(key)
    if (arr) arr.push(r)
    else groups.set(key, [r])
  }
  return [...groups.entries()].map(([key, list]) => {
    const rep = list.find((r) => r.id === key)
      ?? [...list].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())[0]!
    const locales = [...new Set(list.map((r) => r.locale).filter(Boolean))]
    return { ...rep, locales, variantCount: list.length }
  })
}

export type RunPhase = 'running' | 'awaiting' | 'error' | 'published' | 'ready' | 'draft'

export function runPhase(r: BlogRun): RunPhase {
  if (/queu|run|progress|generat|pending|stream/i.test(r.status)) return 'running'
  // awaiting_sources / awaiting_outline — ран стоит и ЖДЁТ решения автора.
  // Раньше проваливалось в 'draft', и пошаговые темы висели «черновиками»,
  // хотя без человека они не сдвинутся.
  if (/^awaiting/i.test(r.status)) return 'awaiting'
  if (r.error || /error|fail/i.test(r.status)) return 'error'
  if (r.blogStatus) return 'published'
  if (/done|ready|complete|final/i.test(r.status)) return 'ready'
  return 'draft'
}

const state = reactive({
  runs: [] as BlogRun[],
  // 'error' отдельно от 'empty': сбой запроса — это НЕ «статей нет»
  status: 'loading' as 'loading' | 'live' | 'empty' | 'error',
})
let pending: Promise<void> | null = null

export function useBlogRuns() {
  function load(force = false): Promise<void> {
    if (pending && !force) return pending
    // лоадер показываем ТОЛЬКО когда показывать нечего; если данные уже есть
    // (возврат на страницу / принудительное обновление) — молча обновляем
    if (!state.runs.length) state.status = 'loading'
    pending = (async () => {
      try {
        const rows = await api.blogPosts()
        state.runs = Array.isArray(rows) ? rows : []
        state.status = state.runs.length ? 'live' : 'empty'
      } catch {
        if (!state.runs.length) state.status = 'error'
      } finally {
        // без сброса первый же промис оставался в pending навсегда, и load()
        // больше никогда не ходил на бэк: список тем жил до F5
        pending = null
      }
    })()
    return pending
  }

  const live = computed(() => state.status === 'live')
  return { state, load, live }
}
