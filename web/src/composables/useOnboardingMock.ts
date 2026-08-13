import { reactive } from 'vue'

// Мок-бэкенд онбординга. Настоящих ручек в новом кабинете нет: useBrands умеет
// только читать (myBrands) и переключать (setActiveBrand), мутации создания
// бренда в lib/api.ts не существует, site_peek никто не дёргает. Чтобы флоу
// можно было прокликать целиком — включая ветки, до которых на живом бэке
// добраться можно только подделав тариф или сломав создание, — все ответы и
// задержки живут здесь. Сценарий переключается пультом на самом экране.
//
// Когда флоу будут выводить на реальный бэк: заменить тела sitePeek/createBrand/
// startAnalysis на вызовы api.*, сам стейт-машина страницы менять не придётся.

export interface Scenario {
  /** тариф аккаунта: на free финал предлагает разовый разбор, на платном — сразу запускает */
  plan: 'free' | 'paid'
  /** разовый бесплатный разбор уже потрачен → на финале апселл вместо кнопки запуска */
  freeRunUsed: boolean
  /** почта не подтверждена → запуск разбора отдаёт 403 EMAIL_NOT_VERIFIED */
  emailVerified: boolean
  /** чем кончится создание бренда */
  outcome: 'ok' | 'brandLimit' | 'error'
  /** что вернёт сбор информации о сайте */
  peek: 'found' | 'empty' | 'slow'
}

export const scenario = reactive<Scenario>({
  plan: 'free',
  freeRunUsed: false,
  emailVerified: false,
  outcome: 'ok',
  peek: 'found',
})

/** Ошибка с кодом — как их отдаёт настоящий api-слой (e.code проверяет страница). */
export class MockApiError extends Error {
  code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function brandOf(domain: string): string {
  const base = domain.split('.')[0] || ''
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : 'Бренд'
}

// Пара живых описаний для демо + нейтральный шаблон на всё остальное: экран
// сбора показывает подтянутую мету, и пустая строка там ломает всю анимацию.
const CANNED: Record<string, string> = {
  'stripe.com': 'Финансовая инфраструктура для интернета: приём платежей, выплаты и биллинг для бизнеса любого размера.',
  'vk.ru': 'Социальная сеть: общение, музыка, видео, сообщества и мини-приложения.',
  'ideata.io': 'Мониторинг видимости бренда в ответах нейросетей: ChatGPT, Алиса, Perplexity и другие движки.',
}

export const mockApi = {
  /** Мета главной страницы — то, что на проде отдаёт scrapper /tools/site_peek. */
  async sitePeek(domain: string): Promise<{ found: boolean; description: string; lang: string }> {
    await sleep(scenario.peek === 'slow' ? 4200 : 900)
    if (scenario.peek === 'empty') return { found: false, description: '', lang: 'ru' }
    const desc = CANNED[domain]
      || `${brandOf(domain)} — описание с главной страницы сайта ${domain}. Его подтянет site_peek, когда флоу выведут на живой бэк.`
    return { found: true, description: desc, lang: /\.(io|com|dev)$/.test(domain) ? 'en' : 'ru' }
  },

  /** Тариф аккаунта — контракт /me/plan (усечённый до полей, нужных финалу). */
  async myPlan(): Promise<{ plan: string; usage: { freeRunUsed: boolean } }> {
    await sleep(350)
    return { plan: scenario.plan, usage: { freeRunUsed: scenario.freeRunUsed } }
  },

  /** Создание бренда — та самая мутация, которой в новом кабинете ещё нет. */
  async createBrand(payload: {
    domain: string; name: string; description?: string
    geo: string; language: string; topics: string[]
  }): Promise<{ id: number; domain: string; name: string }> {
    await sleep(1200)
    if (scenario.outcome === 'brandLimit') {
      throw new MockApiError(
        'PLAN_LIMIT_BRANDS',
        'На тарифе Free можно вести один бренд. Расширьте тариф, чтобы добавить ещё.',
      )
    }
    if (scenario.outcome === 'error') {
      throw new MockApiError('INTERNAL', 'Не удалось создать бренд: сервис временно недоступен.')
    }
    return { id: 1, domain: payload.domain, name: payload.name }
  },

  /** Запуск разбора: на неподтверждённой почте прод отдаёт 403 EMAIL_NOT_VERIFIED. */
  async startAnalysis(): Promise<{ started: boolean }> {
    await sleep(800)
    if (!scenario.emailVerified) {
      throw new MockApiError('EMAIL_NOT_VERIFIED', 'Подтвердите email, чтобы запустить разбор.')
    }
    return { started: true }
  },

  /** Подтверждение кода из письма. В моке проходит любой код из шести цифр. */
  async verifyCode(code: string): Promise<boolean> {
    await sleep(600)
    if (!/^\d{6}$/.test(code)) return false
    scenario.emailVerified = true
    return true
  },
}
