import { reactive } from 'vue'
import { api } from '@/lib/api'

// Идеи тем Blog Writer. Синглтон: кэш живёт в модуле, поэтому возврат на
// страницу показывает данные МГНОВЕННО, а обновление идёт молча в фоне
// (лоадер — только когда показывать нечего).
export interface Idea {
  title: string
  angle?: string
  intent?: string
  keyword?: string
  queries?: string[]
  score?: number
  source?: { domain?: string; url?: string; title?: string }
}

const state = reactive({
  brand: [] as Idea[],
  competitors: [] as Idea[],
  loading: false,
  loaded: false,
  /** оба запроса упали — это НЕ «идей нет», предлагаем повторить */
  failed: false,
})

export function useBlogIdeas() {
  async function load(force = false): Promise<void> {
    if (state.loaded && !force) return
    // лоадер только при пустом кэше
    if (!state.brand.length && !state.competitors.length) state.loading = true
    try {
      const [b, c] = await Promise.all([
        api.blogTopicIdeas().catch(() => null),
        api.blogCompetitorIdeas().catch(() => null),
      ])
      if (b) state.brand = b.topics || []
      if (c) state.competitors = c.topics || []
      // loaded только по факту успеха хотя бы одного запроса: раньше полный
      // провал тоже помечался «загружено», и страница навсегда застревала на
      // «идей нет» — повторный load() уже не ходил на бэк
      state.loaded = !!(b || c)
      state.failed = !b && !c
    } finally {
      state.loading = false
    }
  }

  return { state, load }
}
