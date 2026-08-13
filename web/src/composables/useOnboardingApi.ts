import { api } from '@/lib/api'
import { i18n } from '@/i18n'
import { mockApi, scenario, MockApiError } from './useOnboardingMock'

/**
 * Бэкенд онбординга: живой по умолчанию, мок — только в dev по флагу.
 *
 * Мастер писался на моке, пока в кабинете не было ни создания бренда, ни
 * site_peek. Мутация createBrand в api при этом существовала с самого начала —
 * не хватало только клиента, поэтому «Бренд создан» на экране означало ровно
 * ничего: в базе не появлялось ни строки.
 *
 * Контракт совпадает с мок-версией один в один, поэтому экраны не изменились:
 * переключение живой/мок — это подмена этого объекта, а не правка стейт-машины.
 * VITE_ONBOARDING_MOCK=1 в dev возвращает пульт сценариев (ветки финала иначе
 * не прокликать: лимит тарифа, сбой создания, неподтверждённая почта).
 */
export const useMock = import.meta.env.DEV
  && import.meta.env.VITE_ONBOARDING_MOCK === '1'

/** Ошибка с кодом — единый вид для обеих реализаций. */
export class OnboardingError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

function toError(e: any): OnboardingError {
  // GraphQL кладёт код в extensions.code (см. lib/api.gql), REST — в status
  // Порядок важен: машинный код (GraphQL extensions.code либо scrapper
  // detail.code) точнее, чем http-статус.
  const code = e?.code
    || (e?.status === 402 ? 'PAYMENT_REQUIRED' : '')
    || (e?.status === 403 ? 'FORBIDDEN' : '')
    || 'INTERNAL'
  // текст от бэкенда идёт на экран как есть — переводим только собственный фолбэк
  const msg = e?.serverMessage || e?.message || i18n.global.t('onboarding.errors.requestFailed')
  return new OnboardingError(code, msg)
}

export interface OnboardingApi {
  sitePeek(domain: string): Promise<{ found: boolean; description: string; lang: string }>
  myPlan(): Promise<{ plan: string; usage: { freeRunUsed: boolean } }>
  createBrand(payload: {
    domain: string; name: string; description?: string
    geo: string; language: string; topics: string[]
  }): Promise<{ id: number; domain: string; name?: string | null }>
  startAnalysis(domain: string, geo: string): Promise<{ started: boolean }>
  verifyCode(code: string): Promise<boolean>
}

const liveApi: OnboardingApi = {
  async sitePeek(domain) {
    try {
      const r = await api.sitePeek(domain)
      return {
        found: !!r.found && !!r.description,
        description: (r.description || '').trim(),
        lang: (r.lang || '').toString(),
      }
    } catch {
      // недоступный сайт — не ошибка мастера: идём дальше без описания
      return { found: false, description: '', lang: '' }
    }
  },

  async myPlan() {
    try {
      const p = await api.myPlan()
      return {
        plan: p?.plan || 'free',
        usage: { freeRunUsed: !!p?.usage?.freeRunUsed },
      }
    } catch {
      return { plan: 'free', usage: { freeRunUsed: false } }
    }
  },

  async createBrand(payload) {
    try {
      return await api.createBrand(payload)
    } catch (e) {
      throw toError(e)
    }
  },

  async startAnalysis(domain, geo) {
    try {
      await api.siteAnalyticStart(domain, geo)
      return { started: true }
    } catch (e) {
      throw toError(e)
    }
  },

  async verifyCode(code) {
    try {
      await api.verifyEmail(code)
      return true
    } catch {
      return false
    }
  },
}

/** Мок под тем же контрактом — ошибки приводим к общему типу. */
const mockAdapter: OnboardingApi = {
  sitePeek: (domain) => mockApi.sitePeek(domain),
  myPlan: () => mockApi.myPlan(),
  createBrand: async (p) => {
    try {
      return await mockApi.createBrand(p)
    } catch (e) {
      throw e instanceof MockApiError ? new OnboardingError(e.code, e.message) : toError(e)
    }
  },
  startAnalysis: async () => {
    try {
      return await mockApi.startAnalysis()
    } catch (e) {
      throw e instanceof MockApiError ? new OnboardingError(e.code, e.message) : toError(e)
    }
  },
  verifyCode: (code) => mockApi.verifyCode(code),
}

export const onboardingApi: OnboardingApi = useMock ? mockAdapter : liveApi
export { scenario }
