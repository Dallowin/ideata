/**
 * Демо-трекер: кабинет целиком на вымышленных данных.
 *
 * Нужен для показов и скриншотов. Снимать настоящий кабинет для сайта нельзя —
 * там метрики живых брендов: чужая видимость, чужая тональность, чужие
 * промпты. Один скриншот публикует их навсегда.
 *
 * Подмешивается на уровне клиента API (lib/api.ts) — так экран рисуют те же
 * компоненты и с тем же контрактом, что и на реальных данных: демо не может
 * «разъехаться» с продуктом, потому что это и есть продукт.
 *
 * Бренды вымышленные, имена проверены на отсутствие живых носителей.
 *
 * Тексты демо — наши, а не бэкенда, поэтому они живут в словаре и собираются
 * ВНУТРИ функций: на верхнем уровне модуля словарь ещё не загружен (модуль
 * импортируется до initI18n), и в константы попали бы голые ключи.
 */
import { i18n } from '@/i18n'

const t = (key: string, arg?: any): string =>
  arg === undefined ? (i18n.global.t as any)(key) : (i18n.global.t as any)(key, arg)

// Бренд и конкуренты вымышленные (домены не заняты) — снимать демо с живого
// кабинета нельзя: один кадр публикует метрики настоящих брендов навсегда.
// Домены и источники цитат идут за языком: .ru и vc.ru/habr.com в русском
// демо, .io и reddit/G2 в английском — иначе иностранец видит витрину, где
// его рынка нет вовсе.
const isEn = () => i18n.global.locale.value === 'en'
const SELF = () => (isEn() ? 'orbileo.io' : 'orbileo.ru')
const RIVALS = () => (isEn()
  ? ['nubeco.io', 'sylvaro.io', 'tandemio.io']
  : ['nubeco.ru', 'sylvaro.ru', 'tandemio.ru'])
/** Внешние площадки, которые цитируют движки: в рунете свои, на западе свои. */
const SOURCES = () => (isEn()
  ? [{ d: 'reddit.com', u: 'https://reddit.com/r/SaaS/ai-visibility' },
     { d: 'g2.com', u: 'https://g2.com/categories/ai-visibility' },
     { d: 'producthunt.com', u: 'https://producthunt.com/topics/seo' }]
  : [{ d: 'vc.ru', u: 'https://vc.ru/services/ai-visibility' },
     { d: 'habr.com', u: 'https://habr.com/ru/articles/aeo' },
     { d: 'pikabu.ru', u: 'https://pikabu.ru/story/aeo' }])
// Ключи — из PLATFORM_REGISTRY (data/prompts), иначе подписи в матрице и
// брейкдауне печатают сырой ключ вместо названия движка.
// Набор движков в демо тоже языковой: западной аудитории Алиса и Яндекс в
// витрине ничего не говорят, русской — наоборот, это единственное, чего нет
// у зарубежных трекеров.
const PLATFORMS = () => (isEn()
  ? ['chatgpt', 'perplexity', 'aio', 'gemini', 'claude', 'grok', 'deepseek', 'copilot']
  : ['chatgpt', 'perplexity', 'aio', 'alice', 'gemini', 'deepseek', 'claude', 'yandex'])

/** Ряд с провалами и отскоками: монотонный рост читается как рисунок. */
const VIS_SELF = [34, 31, 38, 36, 43, 41, 47, 44, 52, 49, 57, 55, 63, 68]
const VIS_R1 = [61, 59, 62, 58, 60, 57, 59, 55, 58, 56, 54, 52, 50, 49]
const VIS_R2 = [18, 21, 19, 23, 22, 25, 24, 26, 25, 24, 26, 25, 23, 24]
const VIS_R3 = [12, 11, 13, 10, 12, 11, 10, 12, 11, 9, 10, 9, 10, 9]

const WEEKS = VIS_SELF.map((_, i) => {
  const d = new Date(Date.UTC(2026, 5, 1 + i * 2))
  return d.toISOString().slice(0, 10)
})

/** Темы демо-бренда — те же строки, что уходят в панель и в карточку бренда. */
const topics = () => [
  t('monitoring.demo.topicAeo'),
  t('monitoring.demo.topicMonitoring'),
  t('monitoring.demo.topicComparison'),
]

/** Цифры промпта постоянны, текст и тема — из словаря. */
const prompts = () => {
  const [aeo, monitoring, comparison] = topics()
  return [
    { prompt: t('monitoring.demo.prompt1'), vis: 82, pos: 1, intent: 'commercial', topic: aeo! },
    { prompt: t('monitoring.demo.prompt2'), vis: 64, pos: 1, intent: 'informational', topic: aeo! },
    { prompt: t('monitoring.demo.prompt3'), vis: 47, pos: 2, intent: 'commercial', topic: monitoring! },
    { prompt: t('monitoring.demo.prompt4'), vis: 31, pos: 2, intent: 'commercial', topic: monitoring! },
    { prompt: t('monitoring.demo.prompt5'), vis: 18, pos: 3, intent: 'comparison', topic: comparison! },
    { prompt: t('monitoring.demo.prompt6'), vis: 12, pos: 3, intent: 'informational', topic: aeo! },
  ]
}

const answerText = () => t('monitoring.demo.answer', { self: SELF(), rival: RIVALS()[0] })

function answersFor(pos: number) {
  const text = answerText()
  return PLATFORMS().slice(0, 5).map((p, i) => ({
    platform: p,
    self: i < 3,
    text,
    brandsFound: i < 3 ? [{ brand: SELF(), pos }] : [{ brand: RIVALS()[0], pos: 1 }],
    citations: [
      { url: `https://${SELF()}/pricing`, host: SELF(), cat: t('monitoring.demo.catOwn') },
      { url: SOURCES()[0]!.u, host: SOURCES()[0]!.d, cat: t('monitoring.demo.catMedia') },
      { url: SOURCES()[1]!.u, host: SOURCES()[1]!.d, cat: t('monitoring.demo.catUgc') },
    ],
    judge: { score: 78, sentiment: 'positive', reason: t('monitoring.demo.judgeReason') },
  }))
}

const brandRow = (brand: string, data: number[], self: boolean, sov: number, pos: number, delta: number) => ({
  brand, self, data, vis: data[data.length - 1], sov, pos, delta,
})

/**
 * Идентификаторы намеренно не нулевые: по коду встречается проверка вида
 * `if (t?.id)`, и трекер с id 0 молча считался бы отсутствующим.
 */
const DEMO_ID = 9001

/** Полная карточка трекера — тот же контракт, что отдаёт /scrape/aeo/:id. */
export function demoTracker() {
  const PROMPTS = prompts()
  const leaderboard = [
    { brand: SELF(), self: true, vis: 68, sov: 46, pos: 1.1, delta: 2 },
    { brand: RIVALS()[0], self: false, vis: 49, sov: 33, pos: 1.6, delta: -1 },
    { brand: RIVALS()[1], self: false, vis: 24, sov: 17, pos: 2.4, delta: -3 },
    { brand: RIVALS()[2], self: false, vis: 9, sov: 8, pos: 3.1, delta: 0 },
  ]
  return {
    id: DEMO_ID,
    domain: SELF(),
    competitors: RIVALS(),
    geo: isEn() ? 'US' : 'RU',
    active: true,
    activeCount: 125,
    suggestedCount: 0,
    inactiveCount: 0,
    promptsLimit: null,
    promptCap: 125,
    running: false,
    last_run_at: new Date().toISOString(),
    panel: PROMPTS.map((p, i) => ({ id: i + 1, prompt: p.prompt, status: 'active', topic: p.topic })),
    aggregates: {
      runs: 20,
      promptsCount: PROMPTS.length,
      platforms: PLATFORMS(),
      kpi: { visScore: 68, visDelta: 13, sov: 46, avgPos: 1.1, citeShare: 24 },
      visTrend: {
        weekLabels: WEEKS,
        granularity: 'day',
        series: [
          brandRow(SELF(), VIS_SELF, true, 46, 1.1, 13),
          brandRow(RIVALS()[0], VIS_R1, false, 33, 1.6, -1),
          brandRow(RIVALS()[1], VIS_R2, false, 17, 2.4, -3),
          brandRow(RIVALS()[2], VIS_R3, false, 8, 3.1, 0),
        ],
      },
      citeShareTrend: [9, 8, 11, 10, 13, 12, 15, 14, 18, 17, 20, 19, 23, 24],
      leaderboard,
      platMatrix: [
        { brand: SELF(), self: true, vals: [81, 74, 69, 66, 62, 51, 58, 55] },
        { brand: RIVALS()[0], self: false, vals: [62, 57, 51, 38, 47, 30, 39, 34] },
        { brand: RIVALS()[1], self: false, vals: [28, 24, 22, 18, 20, 12, 17, 15] },
        { brand: RIVALS()[2], self: false, vals: [11, 9, 8, 7, 8, 4, 6, 5] },
      ],
      promptRows: PROMPTS.map((p) => ({
        ...p,
        mentioned: true,
        platforms: PLATFORMS().slice(0, 3),
        judgeScore: 78,
        judgeSentiment: 'positive',
        answers: answersFor(p.pos),
      })),
      citeCats: [
        { label: t('monitoring.demo.catOwn'), pct: 34 },
        { label: t('monitoring.demo.catCatalogs'), pct: 26 },
        { label: t('monitoring.demo.catUgc'), pct: 21 },
        { label: t('monitoring.demo.catMedia'), pct: 12 },
        { label: t('monitoring.demo.catOther'), pct: 7 },
      ],
      topCiteDomains: [
        { d: SELF(), n: 42, own: true },
        { d: SOURCES()[0]!.d, n: 28, own: false },
        { d: SOURCES()[1]!.d, n: 21, own: false },
        { d: SOURCES()[2]!.d, n: 14, own: false },
        { d: RIVALS()[0], n: 11, own: false },
      ],
      watchedPages: [
        { url: `https://${SELF()}/`, n: 38, delta: 4 },
        { url: `https://${SELF()}/pricing`, n: 24, delta: 2 },
        { url: `https://${SELF()}/blog/aeo-guide`, n: 17, delta: 6 },
        { url: `https://${SELF()}/about`, n: 9, delta: 0 },
      ],
      rivalSent: [
        { brand: SELF(), self: true, score: 82 },
        { brand: RIVALS()[0], self: false, score: 64 },
        { brand: RIVALS()[1], self: false, score: 57 },
      ],
      sentThemes: [
        { t: t('monitoring.demo.themeAccurate'), tone: 'good' },
        { t: t('monitoring.demo.themeOnboarding'), tone: 'good' },
        { t: t('monitoring.demo.themeYandex'), tone: 'good' },
        { t: t('monitoring.demo.themePrice'), tone: 'bad' },
      ],
      changes: {
        prevRunAt: new Date(Date.now() - 7 * 864e5).toISOString(),
        gained: [{ prompt: PROMPTS[2]!.prompt, platforms: ['openai', 'perplexity'] }],
        lost: [{ prompt: PROMPTS[5]!.prompt, platforms: ['deepseek'] }],
        metrics: [
          { label: t('monitoring.metric.visibility'), from: 55, to: 68, unit: '%', good: true },
          { label: t('monitoring.metric.cite'), from: 19, to: 24, unit: '%', good: true },
        ],
        newSources: [{ d: SOURCES()[0]!.d, n: 6 }, { d: SOURCES()[1]!.d, n: 4 }],
        goneSources: [{ d: SOURCES()[2]!.d, n: 2 }],
      },
    },
  }
}

/** Список трекеров — одна карточка демо-бренда. */
export function demoTrackerList() {
  return { items: [{ id: DEMO_ID, domain: SELF(), active: true }] }
}

export const DEMO_BRAND = SELF()

/** Бренд воркспейса в демо — иначе трекер не найдётся по активному домену. */
export function demoBrands() {
  return [{
    id: DEMO_ID,
    domain: SELF(),
    name: 'Orbileo',
    description: t('monitoring.demo.brandDesc'),
    competitors: RIVALS(),
    geo: isEn() ? 'US' : 'RU',
    language: isEn() ? 'en' : 'ru',
    topics: topics(),
    aliases: [],
    isActive: true,
    createdAt: new Date().toISOString(),
    ownerUserId: DEMO_ID,
    ownerName: 'demo',
    myRole: 'owner',
  }]
}
