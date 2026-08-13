import { i18n } from '@/i18n'
// Типы и адаптеры данных AEO-трекера (реальный API, без мока).
// Подписи интентов, регионов и кириллических движков живут в словаре
// (prompts.intent.* / prompts.region.* / prompts.engine.*): здесь только ключи,
// иначе язык кабинета не переключить без перезагрузки данных.

export const INTENTS = {
  brand: { class: 'bg-violet-500/15 text-violet-300 border-violet-500/20' },
  compare: { class: 'bg-amber-500/15 text-amber-300 border-amber-500/20' },
  commercial: { class: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20' },
  info: { class: 'bg-sky-500/15 text-sky-300 border-sky-500/20' },
} as const

export type IntentKey = keyof typeof INTENTS

export const REGIONS = ['RU', 'KZ', 'BY', 'UZ', 'US', 'DE'] as const

export type RegionCode = typeof REGIONS[number]

/** Регион из geo трекера может быть любым — незнакомый код показываем как есть. */
export const isKnownRegion = (code: string): code is RegionCode =>
  (REGIONS as readonly string[]).includes(code)

/**
 * Движки, чьё название зависит от языка кабинета: у остальных оно одинаковое
 * («ChatGPT», «Perplexity»), и переводить там нечего.
 */
export const ENGINE_I18N = new Set(['alice', 'yandex'])

export const regionFlag = (cc: string) =>
  /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0))) : ''

// флаги с CDN (эмодзи-флаги не рендерятся на Windows/части линуксов)
export const flagUrl = (cc: string, w: 20 | 40 = 20) =>
  /^[A-Za-z]{2}$/.test(cc) ? `https://flagcdn.com/w${w}/${cc.toLowerCase()}.png` : ''

// фавиконки источников: скачанные локально (public/icons/sites), для
// незнакомых хостов компоненты фолбэчатся на google s2 через @error
export const LOCAL_FAVICONS = new Set([
  'habr.com', 'vc.ru', 'ideata.io', 'rb.ru', 'sostav.ru', 'seonews.ru', 'searchengines.guru',
  'vk.com', 'dzen.ru', 'startpack.ru', 'spark.ru', 'cossa.ru', 'netology.ru', 'skillbox.ru', 'cloudflare.com',
])
export const faviconSrc = (host: string) =>
  LOCAL_FAVICONS.has(host) ? `/icons/sites/${host}.png` : `https://www.google.com/s2/favicons?domain=${host}&sz=64`

// Платформа для рендера (key бэкенда ≠ имя файла иконки)
export interface Platform { key: string; label: string; icon: string }

// полный реестр ключей scrapper (как AI_PLATFORMS в web/useAaMock)
export const PLATFORM_REGISTRY: Platform[] = [
  { key: 'claude', label: 'Claude', icon: '/icons/ai/claude.svg' },
  { key: 'gemini', label: 'Gemini', icon: '/icons/ai/googlegemini.svg' },
  { key: 'aio', label: 'AI Overviews', icon: '/icons/ai/google.svg' },
  { key: 'chatgpt', label: 'ChatGPT', icon: '/icons/ai/openai.svg' },
  { key: 'perplexity', label: 'Perplexity', icon: '/icons/ai/perplexity.svg' },
  { key: 'gigachat', label: 'GigaChat', icon: '/icons/ai/gigachat.svg' },
  { key: 'alice', label: 'Алиса', icon: '/icons/ai/alice.svg' },
  { key: 'yandex', label: 'Яндекс Поиск', icon: '/icons/ai/yandex.svg' },
  { key: 'copilot', label: 'Copilot', icon: '/icons/ai/copilot.svg' },
  { key: 'deepseek', label: 'DeepSeek', icon: '/icons/ai/deepseek.svg' },
  { key: 'grok', label: 'Grok', icon: '/icons/ai/x.svg' },
]

/**
 * Подписи движков для рендера. Латинские бренды одинаковы в обоих языках, а
 * «Алиса» и «Яндекс Поиск» переводятся (ENGINE_I18N) — иначе в английском
 * кабинете в разбивке по движкам стоит кириллица, и это первое, за что
 * цепляется глаз иностранца.
 */
export function platformsFor(keys: string[]): Platform[] {
  return keys.map((k) => {
    const p = PLATFORM_REGISTRY.find((x) => x.key === k)
      ?? { key: k, label: k, icon: '/icons/ai/openai.svg' }
    return ENGINE_I18N.has(k) ? { ...p, label: i18n.global.t(`prompts.engine.${k}`) } : p
  })
}

// ответ движка из реального прогона (aggregates.promptRows[].answers)
export interface RealAnswer {
  platform: string
  self?: boolean
  text?: string
  brandsFound?: Array<{ brand: string; pos?: number | null }>
  citations?: Array<string | { url?: string; host?: string; cat?: string }>
  judge?: { score?: number; sentiment?: string; reason?: string } | null
}

export interface PromptRow {
  id: number
  text: string
  intent: IntentKey
  region: RegionCode
  /** платформа → позиция бренда в ответе (0 = не упомянут) */
  engines: Record<string, number>
  vis: number
  trend: number[]
  delta: number
  citations: number
  /** статус прогона — ключ словаря prompts.run.*, а не готовая подпись */
  checked: 'running' | 'last'
  /** раздел продукта: генератор кладёт его в panel[].topic (см. scrapper
      core/aeo._site_sections). Пусто — промпт ни с одним разделом не сошёлся. */
  topic: string
  /** реальные ответы движков (есть только у строк из API) */
  answers?: RealAnswer[]
}


// ── адаптер реального трекера (/scrape/aeo/{id}) → строки таблицы ──────────
// Форма ответа — контракт web/pages/app/prompts.vue: panel (статусы промптов)
// × aggregates.promptRows (статистика прогонов) + aggregates.platforms.

const INTENT_MAP: Record<string, IntentKey> = {
  comparison: 'compare', alternatives: 'compare', how_to_choose: 'compare',
  best: 'commercial', commercial: 'commercial', pricing: 'commercial', transactional: 'commercial',
  use_case: 'info', informational: 'info', definition: 'info',
  reviews: 'brand', navigational: 'brand',
}

export function adaptTracker(full: any): { rows: PromptRow[]; platforms: Platform[] } {
  const keys: string[] = full?.aggregates?.platforms || []
  const stats = new Map<string, any>(
    (full?.aggregates?.promptRows || []).map((r: any) => [r.prompt, r]),
  )
  const panelRaw: any[] = full?.panel || full?.prompts || []
  const active = panelRaw.filter((p) => (p.status || 'active') === 'active')
  const region = (String(full?.geo || 'RU').slice(0, 2).toUpperCase()) as RegionCode

  const rows: PromptRow[] = active.map((it: any, i: number) => {
    const s = stats.get(it.prompt) || {}
    const answers: RealAnswer[] = s.answers || []
    const engines: Record<string, number> = {}
    for (const k of keys) {
      const a = answers.find((x) => x.platform === k)
      const mentioned = a ? !!a.self : (s.platforms || []).includes(k)
      engines[k] = mentioned
        ? (a?.brandsFound?.find((b) => b.pos != null)?.pos ?? s.pos ?? 1)
        : 0
    }
    // видимость берём с бэка (aggregates.promptRows[].vis — доля ответов с
    // брендом за окно). Свой пересчёт «упомянут / всего движков» оставлен
    // только как фолбэк: две формулы = разные числа в разных панелях.
    const mentionN = Object.values(engines).filter(Boolean).length
    const vis = Number.isFinite(s.vis)
      ? Math.round(s.vis)
      : (keys.length ? Math.round((mentionN / keys.length) * 100) : 0)
    const citations = answers.reduce((sum, a) => sum + ((a.citations || []).length), 0)
    return {
      id: i + 1,
      text: it.prompt,
      intent: INTENT_MAP[String(it.intent || '').toLowerCase()] ?? 'info',
      region,
      topic: String(it.topic || s.topic || '').trim(),
      engines,
      vis,
      // Понедельная серия и дельта приходят с бэка (aggregates.promptRows[]).
      // Раньше здесь рисовался спарклайн из 12 копий текущего значения с
      // дельтой 0: сортировка «по тренду» ничего не сортировала, а «+0» в
      // модалке был константой. Нет истории (первый прогон) — пустая серия,
      // и UI показывает «нет данных» вместо ровной линии.
      trend: Array.isArray(s.trend) ? s.trend.map((n: any) => Math.round(Number(n) || 0)) : [],
      delta: Number.isFinite(s.delta) ? Math.round(s.delta) : 0,
      citations,
      checked: full?.running ? 'running' : 'last',
      answers,
    }
  })
  return { rows, platforms: platformsFor(keys) }
}

// агрегат источников из реальных ответов: хост → урлы → промпты
export function adaptSources(rows: PromptRow[], ownDomain = ''): SourceRow[] {
  type UrlAcc = { n: number; prompts: Set<string> }
  type HostAcc = { n: number; engines: Set<string>; urls: Map<string, UrlAcc>; prompts: Set<string> }
  const byHost = new Map<string, HostAcc>()
  for (const r of rows) for (const a of (r.answers || [])) {
    for (const c of (a.citations || [])) {
      const url = typeof c === 'string' ? c : (c.url || '')
      const host = ((typeof c === 'object' && c.host) || url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] || '').toLowerCase()
      if (!host) continue
      const e = byHost.get(host) ?? { n: 0, engines: new Set<string>(), urls: new Map<string, UrlAcc>(), prompts: new Set<string>() }
      e.n += 1
      e.engines.add(a.platform)
      e.prompts.add(r.text)
      const u = e.urls.get(url) ?? { n: 0, prompts: new Set<string>() }
      u.n += 1
      u.prompts.add(r.text)
      e.urls.set(url, u)
      byHost.set(host, e)
    }
  }
  const total = [...byHost.values()].reduce((s, e) => s + e.n, 0) || 1
  const own = ownDomain.toLowerCase()
  return [...byHost.entries()]
    .map(([host, e], i) => ({
      id: i + 1,
      host,
      category: (own && (host === own || host.endsWith('.' + own)) ? 'Свой сайт' : 'СМИ') as SourceRow['category'],
      own: !!own && (host === own || host.endsWith('.' + own)),
      engines: [...e.engines],
      citations: e.n,
      share: Math.round((e.n / total) * 100),
      delta: 0,
      lastSeen: 'last',
      urls: [...e.urls.entries()]
        .map(([url, u]) => ({ url, n: u.n, prompts: [...u.prompts] }))
        .sort((a, b) => b.n - a.n),
      prompts: [...e.prompts],
    }))
    .sort((a, b) => b.citations - a.citations)
}

// ── источники (вкладка «Источники») ────────────────────────────────────────
export interface SourceUrl {
  url: string
  n: number
  prompts: string[]
}

export interface SourceRow {
  id: number
  host: string
  category: 'СМИ' | 'Блог' | 'Свой сайт' | 'Форум' | 'Каталог'
  own: boolean
  /** ключи платформ (мок = имена иконок, реальные = ключи scrapper) */
  engines: string[]
  citations: number
  share: number
  delta: number
  /** когда хост видели в последний раз — ключ словаря prompts.run.* */
  lastSeen: string
  /** раскрытие строки: конкретные URL с числом цитат и промптами */
  urls: SourceUrl[]
  /** уникальные промпты, в ответах на которые цитировался хост */
  prompts: string[]
}


// сегменты ответа для рендера в модалке (строка | чип бренда)
export type AnswerSegment = string | { brand: string; own?: boolean }
export interface AnswerBlock { type: 'p' | 'li'; parts: AnswerSegment[]; strong?: boolean }

// прифилл-ссылки «Открыть промпт» (движки с поддержкой ?q=);
// ключи и мок-набора (openai), и реального scrapper (chatgpt, aio, …)
export const PREFILL: Record<string, (q: string) => string> = {
  openai: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
  chatgpt: (q) => `https://chatgpt.com/?q=${encodeURIComponent(q)}`,
  perplexity: (q) => `https://www.perplexity.ai/search?q=${encodeURIComponent(q)}`,
  aio: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  copilot: (q) => `https://copilot.microsoft.com/?q=${encodeURIComponent(q)}`,
  grok: (q) => `https://grok.com/?q=${encodeURIComponent(q)}`,
}
