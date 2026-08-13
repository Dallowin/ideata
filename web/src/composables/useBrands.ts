import { computed, reactive } from 'vue'
import { api, type ApiBrand } from '@/lib/api'

// Бренды воркспейса (как web/useBrands, но без мок-ветки: реальный GraphQL).
// Синглтон — общий для свитчера сайдбара и страниц.
// failed — запрос НЕ дошёл до бэка. Без этого флага сбой сети неотличим от
// «брендов нет», а на этом различии стоит funnel онбординга: пустой список
// уводит в мастер, и без флага туда же уезжал бы каждый, у кого моргнул api.
const state = reactive({ brands: [] as ApiBrand[], loaded: false, loading: false, failed: false })
// общий in-flight промис: параллельные load() из сайдбара и страниц ждут ОДИН
// запрос (ранний return без await отдавал пустой activeDomain — гонка)
let pending: Promise<void> | null = null

function ensureOneActive() {
  if (state.brands.length && !state.brands.some((b) => b.isActive)) state.brands[0]!.isActive = true
}

export function useBrands() {
  function load(force = false): Promise<void> {
    if (state.loaded && !force) return Promise.resolve()
    if (pending && !force) return pending
    state.loading = true
    pending = (async () => {
      try {
        state.brands = (await api.myBrands()) || []
        state.failed = false
      } catch {
        state.brands = []
        state.failed = true
      } finally {
        ensureOneActive()
        state.loaded = true
        state.loading = false
      }
    })()
    return pending
  }

  async function setActive(id: number) {
    state.brands.forEach((b) => { b.isActive = b.id === id }) // optimistic
    try { await api.setActiveBrand(id) } catch { await load(true) }
  }

  const active = computed<ApiBrand | null>(() => state.brands.find((b) => b.isActive) || state.brands[0] || null)
  const activeDomain = computed(() => active.value?.domain || '')

  return { state, load, setActive, active, activeDomain }
}
