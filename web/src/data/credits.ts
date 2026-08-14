// Кредиты — единая валюта LLM-действий (посты, вопросы ассистенту, ад-хок
// разборы). Мониторинг остаётся на тарифных лимитах: у него предсказуемая
// себестоимость, и смешивать их нельзя (сожжёшь кредиты на посты — останешься
// без прогонов, за которые платил).
//
// ЦЕНООБРАЗОВАНИЕ: 1 кредит = 1 ₽ по ОФИЦИАЛЬНОМУ прайсу модели у вендора.
// Цена продажи кредита — CREDIT_RUB / CREDIT_USD ниже.
//
// ВАЖНО: прайсы моделей живые и меняются. Этот файл — витрина для интерфейса;
// боевой расчёт списания берёт in/out из каталога OpenRouter (там официальный
// прайс вендора) с фолбэком на локальную таблицу. Формула одна и та же.
//
// Текст (подписи классов, единица «кр.») живёт в словаре `subscription.*`:
// функции ниже зовут `i18n.global.t` напрямую, потому что их используют и
// шаблоны блог-райтера, где своего `useI18n()` под рукой нет.
import { i18n, intlLocale } from '@/i18n'

const t = (key: string, named?: Record<string, unknown>) =>
  (named ? i18n.global.t(key, named) : i18n.global.t(key))

/** курс для перевода долларового прайса в рубли (как USD_RUB на бэке) */
export const USD_RUB = 90
/**
 * Цена кредита для клиента. Внутренняя математика осталась рублёвой (1 кредит =
 * 1 ₽ по официальному прайсу вендора — см. server/credits), а витрина
 * показывает доллары: платёжка выставляет счёт в них.
 * $0.029 ≈ 2 ₽ по тому же курсу, что в учёте затрат.
 */
export const CREDIT_RUB = 2
/**
 * Цена кредита в долларах. НЕ равна CREDIT_RUB / USD_RUB: это два разных курса.
 * USD_RUB = 90 — бухгалтерский, по нему считается себестоимость вызовов.
 * Витрина же привязана к тарифной сетке (Старт $29 ≈ 1 990 ₽, то есть ~69 ₽/$),
 * и цена кредита должна сходиться с пачками: 1 000 кредитов = $29, иначе на
 * одном экране «1 000 = $22» и пачка за $29 противоречат друг другу.
 */
export const CREDIT_USD = 0.029
/**
 * Цена в долларах для витрины. До $10 показываем центы: на мелких суммах
 * округление до целого превращало «$0.29» в «$0», а вилку — в «$3–$3».
 */
export function creditsPriceLabel(credits: number): string {
  const v = credits * CREDIT_USD
  if (v === 0) return '$0'
  if (v < 10) return '$' + v.toFixed(2)
  return '$' + Math.round(v).toLocaleString(intlLocale())
}
/** база подписи «1 000 кредитов = $29»: число живёт в коде, текст — в словаре */
export const CREDITS_RATE_BASE = 1000

/** типовой прогон блог-райтера: сумма стадий пайплайна (research→draft→гейты) */
export const POST_TOKENS = { in: 90_000, out: 25_000 }
/** типовой вопрос ассистенту: снимок бренда + история треда */
export const MSG_TOKENS = { in: 5_000, out: 500 }

export interface ModelRate {
  id: string
  label: string
  vendor: string
  /** $ за 1M токенов */
  inUsd: number
  outUsd: number
}

/** кредиты за действие: (токены/1M × $) × курс, округляем вверх до целого */
export function creditsFor(rate: ModelRate, tokens: { in: number; out: number }): number {
  const usd = (tokens.in / 1e6) * rate.inUsd + (tokens.out / 1e6) * rate.outUsd
  return Math.max(1, Math.ceil(usd * USD_RUB))
}

/**
 * Разброс расхода на статью: короткий материал по паре источников ↔ лонгрид с
 * большим ресёрчем и переписыванием. POST_TOKENS — типовая середина этой вилки,
 * по ней бэк считает гейт баланса.
 *
 * Пользователю показываем ИМЕННО вилку в кредитах («17–40 кр.»), а не прайс за
 * 1М токенов: токены он не считает, а цену статьи — да.
 */
export const POST_TOKENS_MIN = { in: 55_000, out: 15_000 }
export const POST_TOKENS_MAX = { in: 160_000, out: 45_000 }

type Price = { inUsd?: number | null; outUsd?: number | null }

/** «17–40» кредитов за действие на этой модели; null — прайса модели нет */
export function creditsRange(
  m: Price,
  low: { in: number; out: number },
  high: { in: number; out: number },
): [number, number] | null {
  if (m.inUsd == null || m.outUsd == null) return null
  const rate = { id: '', label: '', vendor: '', inUsd: m.inUsd, outUsd: m.outUsd }
  return [creditsFor(rate, low), creditsFor(rate, high)]
}

/** вилка цены СТАТЬИ строкой для подписи в селекторе: «17–40 кр.» */
export function postPriceText(m: Price): string | null {
  const r = creditsRange(m, POST_TOKENS_MIN, POST_TOKENS_MAX)
  return r ? t('subscription.units.creditsShort', { v: `${r[0]}–${r[1]}` }) : null
}

/** цена одного ВОПРОСА ассистенту: числа мелкие, вилка тут только шумит */
export function messagePriceText(m: Price): string | null {
  if (m.inUsd == null || m.outUsd == null) return null
  const n = creditsFor({ id: '', label: '', vendor: '', inUsd: m.inUsd, outUsd: m.outUsd }, MSG_TOKENS)
  return t('subscription.units.creditsApprox', { v: n })
}

export const creditsPerPost = (r: ModelRate) => creditsFor(r, POST_TOKENS)
export const creditsPerMessage = (r: ModelRate) => creditsFor(r, MSG_TOKENS)
export const rub = (credits: number) => credits * CREDIT_RUB
/** те же кредиты в долларах — для витрины */
export const usd = (credits: number) => credits * CREDIT_USD

// ── классы моделей ────────────────────────────────────────────────────────
// В интерфейсе выбираем КЛАСС, а не одну из полусотни моделей: селектор с
// полным списком парализует выбор, а поддержка тонет в вопросах «а эта чем
// лучше». Внутри класса — конкретные модели списком.
export interface ModelClass {
  /** подпись и пояснение класса — в словаре (`subscription.modelClass.<key>`) */
  key: 'fast' | 'standard' | 'premium' | 'max'
  /** можно ли выбирать в чате ассистента (на XL один вопрос стоит как пост) */
  chat: boolean
  models: ModelRate[]
}

export const MODEL_CLASSES: ModelClass[] = [
  {
    key: 'fast',
    chat: true,
    models: [
      { id: 'qwen3.5-flash', label: 'Qwen3.5 Flash', vendor: 'Qwen', inUsd: 0.065, outUsd: 0.26 },
      { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', vendor: 'DeepSeek', inUsd: 0.09, outUsd: 0.18 },
      { id: 'qwen3-32b', label: 'Qwen3 32B', vendor: 'Qwen', inUsd: 0.08, outUsd: 0.28 },
      { id: 'gpt-5-nano', label: 'GPT-5 Nano', vendor: 'OpenAI', inUsd: 0.05, outUsd: 0.4 },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', vendor: 'Google', inUsd: 0.1, outUsd: 0.4 },
      { id: 'deepseek-v3.2', label: 'DeepSeek V3.2', vendor: 'DeepSeek', inUsd: 0.2145, outUsd: 0.3218 },
      { id: 'gpt-4o-mini', label: 'GPT-4o mini', vendor: 'OpenAI', inUsd: 0.15, outUsd: 0.6 },
      { id: 'deepseek-v3.1', label: 'DeepSeek V3.1', vendor: 'DeepSeek', inUsd: 0.25, outUsd: 0.95 },
      { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', vendor: 'Google', inUsd: 0.25, outUsd: 1.5 },
      { id: 'qwen3.7-plus', label: 'Qwen3.7 Plus', vendor: 'Qwen', inUsd: 0.32, outUsd: 1.28 },
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', vendor: 'DeepSeek', inUsd: 0.435, outUsd: 0.87 },
      { id: 'gpt-5-mini', label: 'GPT-5 Mini', vendor: 'OpenAI', inUsd: 0.25, outUsd: 2 },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', vendor: 'OpenAI', inUsd: 0.4, outUsd: 1.6 },
      { id: 'kimi-k2.5', label: 'Kimi K2.5', vendor: 'Moonshot', inUsd: 0.375, outUsd: 2.025 },
      { id: 'qwen3-235b', label: 'Qwen3 235B', vendor: 'Qwen', inUsd: 0.455, outUsd: 1.82 },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', vendor: 'Google', inUsd: 0.3, outUsd: 2.5 },
      { id: 'kimi-k2-thinking', label: 'Kimi K2 Thinking', vendor: 'Moonshot', inUsd: 0.6, outUsd: 2.5 },
      { id: 'deepseek-r1', label: 'DeepSeek R1', vendor: 'DeepSeek', inUsd: 0.7, outUsd: 2.5 },
      { id: 'kimi-k2.6', label: 'Kimi K2.6', vendor: 'Moonshot', inUsd: 0.66, outUsd: 3.41 },
      { id: 'qwen3-max', label: 'Qwen3 Max', vendor: 'Qwen', inUsd: 0.78, outUsd: 3.9 },
      { id: 'grok-4.3', label: 'Grok 4.3', vendor: 'xAI', inUsd: 1.25, outUsd: 2.5 },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', vendor: 'OpenAI', inUsd: 0.75, outUsd: 4.5 },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', vendor: 'Anthropic', inUsd: 1, outUsd: 5 },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', vendor: 'OpenAI', inUsd: 1, outUsd: 6 },
      { id: 'qwen3.7-max', label: 'Qwen3.7 Max', vendor: 'Qwen', inUsd: 1.475, outUsd: 4.425 },
    ],
  },
  {
    key: 'standard',
    chat: true,
    models: [
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', vendor: 'Google', inUsd: 1.5, outUsd: 7.5 },
      { id: 'grok-4.5', label: 'Grok 4.5', vendor: 'xAI', inUsd: 2, outUsd: 6 },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', vendor: 'Google', inUsd: 1.5, outUsd: 9 },
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', vendor: 'Google', inUsd: 1.25, outUsd: 10 },
      { id: 'gpt-5.1', label: 'GPT-5.1', vendor: 'OpenAI', inUsd: 1.25, outUsd: 10 },
      { id: 'gpt-4.1', label: 'GPT-4.1', vendor: 'OpenAI', inUsd: 2, outUsd: 8 },
      { id: 'o3', label: 'o3', vendor: 'OpenAI', inUsd: 2, outUsd: 8 },
      { id: 'gpt-4o', label: 'GPT-4o', vendor: 'OpenAI', inUsd: 2.5, outUsd: 10 },
      { id: 'gpt-5.2', label: 'GPT-5.2', vendor: 'OpenAI', inUsd: 1.75, outUsd: 14 },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', vendor: 'OpenAI', inUsd: 2.5, outUsd: 15 },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', vendor: 'Anthropic', inUsd: 3, outUsd: 15 },
      { id: 'kimi-k3', label: 'Kimi K3', vendor: 'Moonshot', inUsd: 3, outUsd: 15 },
    ],
  },
  {
    key: 'premium',
    chat: true,
    models: [
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', vendor: 'Anthropic', inUsd: 5, outUsd: 25 },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', vendor: 'OpenAI', inUsd: 5, outUsd: 30 },
      { id: 'gpt-5.5', label: 'GPT-5.5', vendor: 'OpenAI', inUsd: 5, outUsd: 30 },
    ],
  },
  {
    key: 'max',
    chat: false,
    models: [
      { id: 'claude-fable-5', label: 'Claude Fable 5', vendor: 'Anthropic', inUsd: 10, outUsd: 50 },
      { id: 'gpt-5-pro', label: 'GPT-5 Pro', vendor: 'OpenAI', inUsd: 15, outUsd: 120 },
      { id: 'gpt-5.5-pro', label: 'GPT-5.5 Pro', vendor: 'OpenAI', inUsd: 30, outUsd: 180 },
    ],
  },
]

/** «от N до M кредитов» по классу — для витрины тарифов */
export function classPostRange(c: ModelClass): [number, number] {
  const v = c.models.map(creditsPerPost)
  return [Math.min(...v), Math.max(...v)]
}
export function classMessageRange(c: ModelClass): [number, number] {
  const v = c.models.map(creditsPerMessage)
  return [Math.min(...v), Math.max(...v)]
}

/** сколько постов выйдет из пула на самой дешёвой модели класса */
export const postsFor = (credits: number, c: ModelClass) =>
  Math.floor(credits / classPostRange(c)[0])

export const ALL_MODELS = MODEL_CLASSES.flatMap((c) => c.models)
