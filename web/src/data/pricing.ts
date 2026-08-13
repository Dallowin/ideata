// Тарифная сетка Ideata — синхронизирована с лендингом (www/usePricing) и с
// долларовым контуром старого кабинета. Валюта одна: $. Рубли убраны, потому
// что платёжка (Polar) выставляет счёт в долларах, а РФ-карты она не проводит —
// показывать ₽ в кабинете значило бы называть цену, которую нельзя оплатить.
//
// Списки преимуществ дословно повторяют лендинг: человек не должен видеть на
// «Подписке» другой набор обещаний, чем тот, по которому пришёл.
// Реальные лимиты приходят с бэка (usePlan), сетка тут — витрина.
//
// ТЕКСТ тарифа (название, для кого, список «включено») лежит в словаре
// i18n (`subscription.plan.<key>.*`), а ЧИСЛА — здесь: словарь получает их
// подстановками ({prompts}, {credits}…), поэтому цифры физически не могут
// разойтись между языками.
import { intlLocale } from '@/i18n'

export interface Plan {
  key: 'free' | 'lite' | 'pro' | 'scale'
  /** цена в $ за месяц (единственная валюта витрины) */
  monthly: number
  /** пул кредитов на LLM-действия: посты, вопросы ассистенту, ад-хок разборы */
  credits: number
  featured?: boolean
  /** есть ли бейдж; его текст — в словаре (`subscription.plan.<key>.badge`) */
  badge?: boolean
  contact?: boolean
  /** числа для подстановки в строки «включено» из словаря */
  vars: Record<string, number>
}

export const TG_CONTACT = 'https://t.me/ideata_bot'
/**
 * Оплата — серверный редирект на Polar-чекаут (обычный <a>, не SPA-роут).
 * Годовой период — отдельный продукт в Polar; бэк ответит понятной ошибкой,
 * если он не заведён, и НЕ спишет месячную цену под видом годовой.
 */
export const checkoutUrl = (planKey: string, period: 'month' | 'year' = 'month') =>
  `/billing/checkout?plan=${planKey}${period === 'year' ? '&period=year' : ''}`
export const PORTAL_URL = '/billing/portal'

export const PLANS: Plan[] = [
  {
    key: 'free',
    monthly: 0,
    credits: 100,
    vars: { prompts: 10, engines: 9 },
  },
  {
    key: 'lite',
    monthly: 29,
    credits: 400,
    vars: { prompts: 25, runs: 2 },
  },
  {
    key: 'pro',
    monthly: 119,
    featured: true,
    badge: true,
    credits: 1500,
    vars: { prompts: 50, brands: 2 },
  },
  {
    key: 'scale',
    monthly: 299,
    contact: true,
    credits: 3000,
    vars: { prompts: 125, brands: 5 },
  },
]

/**
 * Пополнение баланса кредитов. Продукты заведены в Polar как разовые платежи,
 * чекаут их принимает, а вебхук начисляет кредиты по СУММЕ платежа
 * (reason='topup' в credit_ledger, идемпотентно по order_id).
 *
 * Числа кредитов здесь — витрина: бэк считает их сам из суммы по той же цене
 * ($0.029 за кредит), поэтому расхождения быть не может.
 */
export const CREDIT_PACKS_PURCHASABLE = true
export const CREDIT_PACKS = [
  { code: 'credits_5', credits: 170, price: 5 },
  { code: 'credits_50', credits: 1720, price: 50 },
  { code: 'credits_500', credits: 17240, price: 500 },
]

/** докупка лимитов мониторинга — она осталась на тарифной оси, не на кредитной */
export const ADDONS = [
  { code: 'prompts_25', monthly: 29, vars: { prompts: 25 } },
]

/** порядок тарифов — для «Расширить» / «Понизить» на карточках */
export const PLAN_ORDER: Record<string, number> = { free: 0, lite: 1, pro: 2, scale: 3 }

export const fmtMoney = (n: number) => '$' + n.toLocaleString(intlLocale())
/** скидка за годовую оплату, % — то же число в тексте витрины и в расчёте */
export const YEARLY_DISCOUNT_PCT = 25
/** годовая оплата — на YEARLY_DISCOUNT_PCT % дешевле месячной */
export const yearly = (monthly: number) => Math.round(monthly * (1 - YEARLY_DISCOUNT_PCT / 100))
