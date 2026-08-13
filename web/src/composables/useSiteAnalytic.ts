import { computed, reactive } from 'vue'
import { api } from '@/lib/api'
import { useBrands } from '@/composables/useBrands'

// Последний AI-разбор активного бренда (scrapper site_analytic): берём список
// «моих разборов», находим свежий готовый по домену и читаем его facts.
// Чтение бесплатное — заново разбор НЕ запускаем (это платный прогон).
// Ленивый синглтон: грузится, только когда открыли вкладку «Дополнительные».
//
// Контракт facts — тот же, что у старого кабинета (web/useAaApi): семантика,
// ссылочный профиль, тех-стек/CWV, краул-готовность, конкуренты, медиа, план.
export interface SiteFacts {
  authority?: number | null
  kwTotal?: number | null
  refDomains?: number | null
  backlinksTotal?: number | null
  spamScore?: number | null
  dofollowPct?: number | null
  perfScore?: number | null
  lcp?: number | null
  cls?: number | null
  inp?: number | null
  monthLabels?: string[]
  keywords?: { kw: string; vol: number; pos: number; prev?: number; intent?: string; etv?: number }[]
  intents?: { label: string; pct: number }[]
  posDist?: { bucket: string; count: number }[]
  clusters?: { name: string; kws: number; strength: string }[]
  thinCluster?: { name: string } | null
  topPages?: { url: string; traffic?: number; kws?: number }[]
  anchors?: { a: string; pct: number }[]
  refDomainsTrend?: number[]
  tech?: Record<string, string[]> | null
  crawl?: {
    title?: string; description?: string
    has_robots?: boolean; has_sitemap?: boolean; robots_blocks_all?: boolean
    has_llms_txt?: boolean; has_faq_schema?: boolean; schema_types?: string[]
  } | null
  competitors?: { domain: string; traffic?: number; growth?: number; shared?: number; dr?: number; source?: string; mentions?: number; verdict?: string }[]
  gapRows?: { kw: string; vol: number; kd: number; pos?: number; score?: number }[]
  mediaMentions?: { platform: string; title: string; url: string; author?: string; metric?: string; snippet?: string }[]
  plan?: { t: string; why?: string; impact?: number; effort?: number; ref?: string; how?: string[] }[]
  priorities?: { t: string; tab?: string }[]
  meta?: { geo?: string; domain?: string; collectedAt?: string | null } | null
}

const state = reactive({
  facts: null as SiteFacts | null,
  /** idle → пока не грузили; none → разбора нет; running → считается на бэке */
  status: 'idle' as 'idle' | 'loading' | 'done' | 'none' | 'running' | 'error',
  analysisId: null as number | null,
  finishedAt: null as string | null,
})
let pending: Promise<void> | null = null
/** домен, для которого лежит разбор: смена бренда без релоада не должна
 *  оставлять на экране факты предыдущего сайта */
let loadedFor: string | null = null

const norm = (d: string) => String(d || '').trim().toLowerCase()
  .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]!.split('?')[0]!

export function useSiteAnalytic() {
  const { load: loadBrands, activeDomain } = useBrands()

  function load(force = false): Promise<void> {
    if (loadedFor !== null && loadedFor !== norm(activeDomain.value)) force = true
    if (pending && !force) return pending
    if (state.status !== 'idle' && !force) return Promise.resolve()
    state.facts = null
    state.analysisId = null
    state.finishedAt = null
    state.status = 'loading'
    pending = (async () => {
      try {
        await loadBrands()
        const dom = norm(activeDomain.value)
        loadedFor = dom
        const list: any = await api.siteAnalyticList()
        const items: any[] = (list?.items || [])
          .filter((r: any) => !dom || norm(r.domain) === dom)
          .sort((a: any, b: any) => String(b.finished_at || b.created_at || '').localeCompare(String(a.finished_at || a.created_at || '')))
        const done = items.find((r) => r.status === 'done')
        if (!done) {
          // разбор ещё считается — покажем это отдельным состоянием
          state.status = items.some((r) => ['queued', 'running'].includes(r.status)) ? 'running' : 'none'
          return
        }
        const sa: any = await api.siteAnalytic(Number(done.id))
        if (sa?.status === 'done' && sa?.facts) {
          state.facts = sa.facts as SiteFacts
          state.analysisId = Number(done.id)
          state.finishedAt = done.finished_at || sa?.finished_at || null
          state.status = 'done'
          return
        }
        state.status = 'none'
      } catch {
        state.status = 'error'
      } finally {
        pending = null
      }
    })()
    return pending
  }

  const facts = computed(() => state.facts)
  return { state, load, facts }
}
