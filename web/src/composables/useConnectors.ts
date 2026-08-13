import { reactive, ref } from 'vue'
import { api } from '@/lib/api'
import { useBrands } from '@/composables/useBrands'
import { i18n } from '@/i18n'

// Статусы коннекторов данных (Метрика / GSC / Cloudflare) per-brand.
// Живые статусы с фолбэком на «демо»; общий для «Настроек» и «AI-трафика».
//
// title/desc/detail — геттеры поверх словаря: коннекторы живут в модульном
// синглтоне, а язык переключается без перезагрузки, поэтому строку нельзя
// «запечь» один раз при создании.
export interface Connector {
  key: 'metrika' | 'gsc' | 'cloudflare'
  title: string
  desc: string
  icon: string
  connected: boolean | null // null = статус неизвестен (демо)
  detail: string
  connectHref?: string
  /** Внутреннее: подпись статуса — ключ словаря и «сырое» значение с бэка. */
  detailKey: string
  detailRaw: string
}

const DEMO = 'traffic.connectors.state.demo'

const connectors = reactive<Connector[]>([
  {
    key: 'metrika',
    get title() { return i18n.global.t('traffic.connectors.metrika.title') },
    get desc() { return i18n.global.t('traffic.connectors.metrika.desc') },
    icon: '/icons/ai/yandex.svg',
    connected: null,
    detailKey: DEMO,
    detailRaw: '',
    // подпись бэка (имя счётчика, домен, зона) не переводим — она как есть
    get detail() { return this.detailRaw || i18n.global.t(this.detailKey) },
    set detail(v: string) { this.detailRaw = v },
  },
  {
    key: 'gsc',
    get title() { return i18n.global.t('traffic.connectors.gsc.title') },
    get desc() { return i18n.global.t('traffic.connectors.gsc.desc') },
    icon: '/icons/ai/google.svg',
    connected: null,
    detailKey: DEMO,
    detailRaw: '',
    get detail() { return this.detailRaw || i18n.global.t(this.detailKey) },
    set detail(v: string) { this.detailRaw = v },
  },
  {
    key: 'cloudflare',
    get title() { return i18n.global.t('traffic.connectors.cloudflare.title') },
    get desc() { return i18n.global.t('traffic.connectors.cloudflare.desc') },
    icon: '/icons/sites/cloudflare.com.png',
    connected: null,
    detailKey: DEMO,
    detailRaw: '',
    get detail() { return this.detailRaw || i18n.global.t(this.detailKey) },
    set detail(v: string) { this.detailRaw = v },
  },
])

const statusSource = ref<'loading' | 'live' | 'mock'>('loading')
let pending: Promise<void> | null = null
/** id бренда, для которого прочитаны статусы */
let loadedFor: number | null = null

export function useConnectors() {
  const { load: loadBrands, active } = useBrands()

  /** Отключить коннектор и перечитать статусы. */
  async function disconnect(key: Connector['key']): Promise<void> {
    const id = active.value?.id
    if (!id) return
    if (key === 'metrika') await api.metrikaDisconnect(id)
    else if (key === 'gsc') await api.gscDisconnect(id)
    else if (key === 'cloudflare') await api.cloudflareDisconnect(id)
    await load(true)
  }

  function load(force = false): Promise<void> {
    // коннекторы per-brand: после смены бренда статусы предыдущего невалидны
    if (loadedFor !== null && loadedFor !== (active.value?.id ?? null)) force = true
    if (pending && !force) return pending
    pending = (async () => {
      try {
        await loadBrands()
        const id = active.value?.id
        loadedFor = id ?? null
        if (!id) throw new Error('no brand')
        const [mk, gs, cf] = await Promise.allSettled([
          api.metrikaStatus(id), api.gscStatus(id), api.cloudflareStatus(id),
        ])
        const apply = (key: Connector['key'], res: PromiseSettledResult<any>) => {
          const c = connectors.find((x) => x.key === key)!
          if (res.status === 'fulfilled') {
            c.connected = !!res.value?.connected
            c.detailRaw = c.connected
              ? (res.value?.counterName || res.value?.site || res.value?.zoneName || '')
              : ''
            c.detailKey = c.connected
              ? 'traffic.connectors.state.connected'
              : (res.value?.enabled === false
                ? 'traffic.connectors.state.notConfigured'
                : 'traffic.connectors.state.notConnected')
          }
        }
        apply('metrika', mk); apply('gsc', gs); apply('cloudflare', cf)
        statusSource.value = connectors.some((c) => c.connected !== null) ? 'live' : 'mock'
        for (const c of connectors) {
          if (c.key === 'metrika') c.connectHref = `/metrika/connect?brandId=${id}`
          if (c.key === 'gsc') c.connectHref = `/gsc/connect?brandId=${id}`
        }
      } catch {
        statusSource.value = 'mock'
      }
    })()
    return pending
  }

  return { connectors, statusSource, load, disconnect }
}
