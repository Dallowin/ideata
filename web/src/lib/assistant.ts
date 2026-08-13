// Интент-роутер ассистента: типовые вопросы отвечаются ДЕТЕРМИНИРОВАННО из тех
// же агрегатов, что рисуют панели. Ни модели, ни токенов, ни списания кредитов —
// и цифры гарантированно совпадают с «Мониторингом», потому что источник один.
//
// Модель нужна только на свободные формулировки, которые сюда не попали.
// Пока LLM не подключён, на них отвечаем честным «не понял» со списком умений —
// выдумывать ответ нельзя.
import type { TrackerAggregates, TrackerMeta } from '@/composables/useTracker'
import type { PromptRow, SourceRow } from '@/data/prompts'
import { platformsFor } from '@/data/prompts'
import type { SiteFacts } from '@/composables/useSiteAnalytic'
import { i18n, intlLocale } from '@/i18n'

export interface AssistantCtx {
  agg: TrackerAggregates | null
  meta: TrackerMeta | null
  rows: PromptRow[]
  sources: SourceRow[]
  facts: SiteFacts | null
  domain?: string
}

export interface AssistantAnswer {
  /** абзацы ответа */
  text: string[]
  /** куда отправить за подробностями */
  link?: { label: string; to: string }
  /** ответ собран из данных, а не моделью */
  grounded: true
}

// ── нормализация и матчинг ────────────────────────────────────────────────
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9\s]/gi, ' ')

interface Intent {
  key: string
  /** ключевые слова: хотя бы одно из каждой группы */
  all: string[][]
  /** однозначные слова — их наличие решает исход при ничьей (вес ×5) */
  anchor?: string[]
  run: (c: AssistantCtx) => AssistantAnswer | null
}

// Файл не компонент, поэтому переводчик берём у глобального инстанса.
const t = (key: string, named: Record<string, unknown> = {}) => (i18n.global.t as any)(key, named)
/** форма с числительным: t(ключ, n) выбирает нужную форму множественного числа */
const tn = (key: string, n: number, named: Record<string, unknown> = {}) =>
  (i18n.global.t as any)(key, { n, ...named }, n)
/** «N промптов» в нужном падеже — числительное отдельно от самой фразы */
const nPrompts = (n: number, form: 'Nom' | 'Gen' | 'Dat' = 'Dat') => tn(`overview.units.prompts${form}`, n)
const nf = (n: number) => n.toLocaleString(intlLocale())
const brand = (b: string) => String(b || '').replace(/^www\./, '')

// ── ответы ────────────────────────────────────────────────────────────────
function whatChanged(c: AssistantCtx): AssistantAnswer | null {
  const ch = c.agg?.changes
  if (!ch) return null
  if (!ch.prevRunAt) {
    return { grounded: true, text: [t('overview.answers.changed.single')] }
  }
  const out: string[] = []
  const m = ch.metrics || []
  if (m.length) {
    // подписи метрик приходят с бэка — берём как есть
    out.push(t('overview.answers.changed.metrics', {
      list: m.map((x) => `${x.label} ${x.from}${x.unit === 'pp' ? '%' : ''} → ${x.to}${x.unit === 'pp' ? '%' : ''}`).join(', '),
    }))
  }
  if (ch.gained?.length) {
    out.push(t('overview.answers.changed.gained', {
      items: nPrompts(ch.gained.length),
      list: ch.gained.slice(0, 3).map((g) => `«${g.prompt}»`).join(', '),
    }))
  }
  if (ch.lost?.length) {
    out.push(t('overview.answers.changed.lost', {
      n: ch.lost.length,
      list: ch.lost.slice(0, 3).map((g) => `«${g.prompt}»`).join(', '),
    }))
  }
  const drops = (ch.visMoves || []).filter((x) => x.to < x.from)
  if (drops.length) {
    out.push(t('overview.answers.changed.drops', {
      items: nPrompts(drops.length),
      prompt: drops[0]!.prompt,
      from: drops[0]!.fromEngines,
      to: drops[0]!.toEngines,
    }))
  }
  if (ch.newSources?.length) out.push(t('overview.answers.changed.newSources', { list: ch.newSources.slice(0, 5).map((s) => s.host).join(', ') }))
  if (ch.goneSources?.length) out.push(t('overview.answers.changed.goneSources', { list: ch.goneSources.slice(0, 5).map((s) => s.host).join(', ') }))
  if (!out.length) out.push(t('overview.answers.changed.nothing'))
  return { grounded: true, text: out, link: { label: t('overview.answers.link.monitoring'), to: '/monitoring' } }
}

function whyVisibility(c: AssistantCtx): AssistantAnswer | null {
  const k = c.agg?.kpi
  if (!k || k.visScore == null) return null
  const d = k.visDelta ?? 0
  const out: string[] = []
  out.push(d === 0
    ? t('overview.answers.vis.flat', { v: k.visScore })
    : t(d > 0 ? 'overview.answers.vis.up' : 'overview.answers.vis.down', { d: Math.abs(d), v: k.visScore }))

  const ch = c.agg?.changes
  const reasons: string[] = []
  if (ch?.lost?.length) {
    reasons.push(t('overview.answers.vis.reasonLost', {
      items: nPrompts(ch.lost.length, 'Gen'),
      list: ch.lost.slice(0, 2).map((x) => `«${x.prompt}»`).join(', '),
    }))
  }
  const drops = (ch?.visMoves || []).filter((x) => x.to < x.from)
  if (drops.length) reasons.push(t('overview.answers.vis.reasonNarrow', { items: nPrompts(drops.length) }))
  const risen = (ch?.rivals || []).filter((r) => r.delta > 0)
  if (risen.length) reasons.push(t('overview.answers.vis.reasonRivals', { list: risen.slice(0, 2).map((r) => `${brand(r.brand)} ${r.from}% → ${r.to}%`).join(', ') }))
  if (ch?.gained?.length) reasons.push(t('overview.answers.vis.reasonGained', { items: nPrompts(ch.gained.length, 'Nom') }))

  if (reasons.length) out.push(t('overview.answers.vis.because', { list: reasons.join('; ') }))
  else if (ch?.prevRunAt) out.push(t('overview.answers.vis.noChange'))

  if (k.sov != null || k.avgPos != null || k.citeShare != null) {
    const bits = []
    if (k.sov != null) bits.push(t('overview.answers.vis.sov', { v: k.sov }))
    if (k.avgPos != null) bits.push(t('overview.answers.vis.avgPos', { v: k.avgPos }))
    if (k.citeShare != null) bits.push(t('overview.answers.vis.citeShare', { v: k.citeShare }))
    out.push(t('overview.answers.vis.nearby', { list: bits.join(', ') }))
  }
  return { grounded: true, text: out, link: { label: t('overview.answers.link.weekly'), to: '/monitoring' } }
}

function competitors(c: AssistantCtx): AssistantAnswer | null {
  const lb = c.agg?.leaderboard || []
  if (!lb.length) return null
  if (lb.length === 1) {
    return { grounded: true, text: [t('overview.answers.rivals.none')], link: { label: t('overview.answers.link.brandSettings'), to: '/settings' } }
  }
  const me = lb.find((r) => r.self)
  const rank = lb.findIndex((r) => r.self) + 1
  const out: string[] = []
  out.push(me
    ? t('overview.answers.rivals.rankVis', { rank, n: lb.length, vis: me.vis })
    : t('overview.answers.rivals.rank', { rank, n: lb.length }))
  for (const r of lb) {
    // названия брендов и конкурентов приходят с бэка — не переводятся
    out.push(t('overview.answers.rivals.row', {
      name: r.self ? t('overview.answers.rivals.self', { brand: brand(r.brand) }) : brand(r.brand),
      vis: r.vis,
      delta: r.delta ? ` (${r.delta > 0 ? '+' : ''}${r.delta})` : '',
    }))
  }
  const passed = (c.agg?.changes?.rivals || []).filter((r) => r.passedUs)
  if (passed.length) out.push(t('overview.answers.rivals.passed', { list: passed.map((r) => `${brand(r.brand)} (${r.from}% → ${r.to}%)`).join(', ') }))
  const grow = [...lb].filter((r) => !r.self && r.delta > 0).sort((a, b) => b.delta - a.delta)[0]
  if (grow) out.push(t('overview.answers.rivals.fastest', { brand: brand(grow.brand), d: grow.delta }))
  return { grounded: true, text: out, link: { label: t('overview.answers.link.youAndRivals'), to: '/monitoring' } }
}

function contentGaps(c: AssistantCtx): AssistantAnswer | null {
  const blind = c.rows.filter((r) => r.vis === 0)
  const gaps = c.facts?.gapRows || []
  if (!blind.length && !gaps.length) return null
  const out: string[] = []
  if (blind.length) {
    out.push(t('overview.answers.gaps.blind', {
      items: nPrompts(blind.length),
      list: blind.slice(0, 3).map((r) => `«${r.text}»`).join(', '),
    }))
    const withCites = blind.filter((r) => r.citations > 0)
    if (withCites.length) out.push(t('overview.answers.gaps.withCites', { n: withCites.length }))
  }
  if (gaps.length) {
    out.push(t('overview.answers.gaps.site', {
      list: gaps.slice(0, 3).map((g) => t('overview.answers.gaps.gapItem', { kw: g.kw, vol: nf(g.vol), kd: g.kd })).join(', '),
    }))
  }
  const thin = c.facts?.thinCluster?.name
  if (thin) out.push(t('overview.answers.gaps.thin', { name: thin }))
  return { grounded: true, text: out, link: { label: t('overview.answers.link.writePost'), to: '/blog/new' } }
}

function sources(c: AssistantCtx): AssistantAnswer | null {
  const top = c.sources.slice(0, 5)
  const cats = c.agg?.citeCats || []
  if (!top.length && !cats.length) return null
  const out: string[] = []
  if (top.length) {
    out.push(t('overview.answers.sources.top', {
      list: top.map((s) => t('overview.answers.sources.topItem', { host: s.host, n: s.citations })).join(', '),
    }))
  }
  const own = c.sources.find((s) => s.own)
  const share = c.agg?.kpi?.citeShare
  out.push(own
    ? t('overview.answers.sources.own', { share: share ?? own.share, items: tn('overview.units.links', own.citations) })
    : t('overview.answers.sources.noOwn'))
  // подписи типов источников считает бэк — оставляем как есть
  if (cats.length) {
    out.push(t('overview.answers.sources.cats', {
      list: cats.slice(0, 4).map((x) => t('overview.answers.sources.catItem', { label: x.label, pct: x.pct })).join(', '),
    }))
  }
  const pages = c.agg?.watchedPages || []
  if (pages.length) out.push(t('overview.answers.sources.pages', { list: pages.slice(0, 3).map((p) => p.url.replace(/^https?:\/\/[^/]+/, '') || '/').join(', ') }))
  return { grounded: true, text: out, link: { label: t('overview.answers.link.links'), to: '/links' } }
}

function engines(c: AssistantCtx): AssistantAnswer | null {
  const row = c.agg?.platMatrix?.find((r) => r.self)
  const keys = c.agg?.platforms || []
  if (!row || !keys.length) return null
  const plats = platformsFor(keys)
  const pairs = row.vals.map((v, i) => ({ v, label: plats[i]?.label || keys[i] })).sort((a, b) => b.v - a.v)
  const best = pairs.filter((p) => p.v > 0).slice(0, 3)
  const worst = pairs.filter((p) => p.v === 0)
  const out: string[] = []
  if (best.length) {
    out.push(t('overview.answers.engines.best', {
      list: best.map((p) => t('overview.answers.engines.bestItem', { label: p.label, v: p.v })).join(', '),
    }))
  }
  if (worst.length) out.push(t('overview.answers.engines.worst', { list: worst.map((p) => p.label).join(', ') }))
  return { grounded: true, text: out, link: { label: t('overview.answers.link.engineMatrix'), to: '/monitoring' } }
}

function sentiment(c: AssistantCtx): AssistantAnswer | null {
  const rs = c.agg?.rivalSent || []
  if (!rs.length) return null
  const me = rs.find((r) => r.self)
  const out: string[] = []
  if (me) out.push(t('overview.answers.sentiment.self', { score: me.score }))
  const others = rs.filter((r) => !r.self)
  if (others.length) {
    out.push(t('overview.answers.sentiment.rivals', {
      list: others.map((r) => t('overview.answers.sentiment.rivalItem', { brand: brand(r.brand), score: r.score })).join(', '),
    }))
  }
  // темы тональности формулирует модель на бэке — показываем как есть
  const themes = (c.agg?.sentThemes || []).map((x: any) => (typeof x === 'string' ? { t: x, tone: 'neutral' } : x)).filter((x: any) => x?.t)
  if (themes.length) {
    const good = themes.filter((x: any) => x.tone === 'good').map((x: any) => x.t)
    const bad = themes.filter((x: any) => x.tone === 'bad').map((x: any) => x.t)
    if (good.length) out.push(t('overview.answers.sentiment.good', { list: good.join(', ') }))
    if (bad.length) out.push(t('overview.answers.sentiment.bad', { list: bad.join(', ') }))
  }
  return { grounded: true, text: out, link: { label: t('overview.answers.link.sentiment'), to: '/monitoring' } }
}

function promptsState(c: AssistantCtx): AssistantAnswer | null {
  const m = c.meta
  if (!m) return null
  const out = [m.promptCap
    ? tn('overview.answers.prompts.panelCap', m.activeCount, { cap: m.promptCap })
    : tn('overview.answers.prompts.panel', m.activeCount)]
  if (m.suggestedCount) out.push(t('overview.answers.prompts.suggested', { n: m.suggestedCount }))
  const top = [...c.rows].sort((a, b) => b.vis - a.vis).slice(0, 3)
  if (top.length) {
    out.push(t('overview.answers.prompts.top', {
      list: top.map((r) => t('overview.answers.prompts.topItem', { text: r.text, vis: r.vis })).join(', '),
    }))
  }
  return { grounded: true, text: out, link: { label: t('overview.answers.link.prompts'), to: '/prompts' } }
}

function siteHealth(c: AssistantCtx): AssistantAnswer | null {
  const f = c.facts
  if (!f) return null
  const out: string[] = []
  if (f.perfScore != null) out.push(t('overview.answers.site.pagespeed', { n: f.perfScore }))
  const cr = f.crawl
  if (cr) {
    const miss: string[] = []
    if (!cr.has_robots || cr.robots_blocks_all) miss.push('robots.txt')
    if (!cr.has_sitemap) miss.push('sitemap.xml')
    if (!cr.has_llms_txt) miss.push('llms.txt')
    if (!cr.has_faq_schema) miss.push(t('overview.answers.site.faqSchema'))
    out.push(miss.length
      ? t('overview.answers.site.crawlMissing', { list: miss.join(', ') })
      : t('overview.answers.site.crawlOk'))
  }
  if (f.refDomains != null) {
    out.push(f.spamScore != null
      ? t('overview.answers.site.refDomainsSpam', { n: nf(f.refDomains), spam: f.spamScore })
      : t('overview.answers.site.refDomains', { n: nf(f.refDomains) }))
  }
  return out.length ? { grounded: true, text: out, link: { label: t('overview.answers.link.extra'), to: '/monitoring?tab=extra' } } : null
}

// Ключевые слова живут В КОДЕ, а не в словаре: это не текст на экран, а
// матчинг ввода, и списки нужны СРАЗУ на обоих языках — англоязычный юзер
// пишет по-английски, но ответ собирается из тех же агрегатов.
const INTENTS: Intent[] = [
  { key: 'rivals', anchor: ['конкурент', 'соперник', 'обошел', 'обогнал', 'обходят', 'competitor', 'rival', 'passed us', 'overtook'], all: [['конкурент', 'соперник', 'обошел', 'обогнал', 'сравни', 'растет', 'рейтинг', 'место', 'кто', 'competitor', 'rival', 'compare', 'ranking', 'faster', 'who']], run: competitors },
  { key: 'changed', anchor: ['изменилось', 'изменения', 'сводка', 'итоги', 'changed', 'digest', 'summary'], all: [['изменилось', 'изменения', 'нового', 'новости', 'сводка', 'итоги', 'неделю', 'прогон', 'вчера', 'changed', 'change', 'new', 'summary', 'digest', 'last run', 'week', 'yesterday']], run: whatChanged },
  { key: 'gaps', anchor: ['темы', 'тема', 'контент', 'написать', 'статью', 'topic', 'content', 'article'], all: [['темы', 'тема', 'контент', 'писать', 'написать', 'статью', 'пост', 'не называют', 'без нас', 'закрыть', 'что писать', 'topic', 'content', 'write', 'article', 'post', 'without us', 'cover']], run: contentGaps },
  { key: 'sources', anchor: ['источник', 'ссылк', 'цитат', 'домен', 'source', 'citation', 'cite', 'backlink'], all: [['источник', 'ссылк', 'цитат', 'домен', 'цитируют', 'хватает', 'source', 'citation', 'cite', 'link', 'domain', 'missing']], run: sources },
  { key: 'engines', anchor: ['движ', 'нейросет', 'chatgpt', 'perplexity', 'gemini', 'платформ', 'engine'], all: [['движ', 'модел', 'нейросет', 'chatgpt', 'perplexity', 'gemini', 'claude', 'платформ', 'где видно', 'engine', 'model', 'platform', 'where are we visible']], run: engines },
  { key: 'sentiment', anchor: ['тональность', 'сентимент', 'хвалят', 'ругают', 'sentiment', 'praise'], all: [['тональность', 'сентимент', 'отзыв', 'хвалят', 'ругают', 'мнение', 'говорят', 'sentiment', 'review', 'opinion', 'praise', 'complain', 'say about']], run: sentiment },
  { key: 'site', anchor: ['техничк', 'pagespeed', 'robots', 'llms', 'краул', 'донор', 'беклинк', 'crawl', 'referring domain'], all: [['сайт', 'техничк', 'pagespeed', 'скорость', 'robots', 'llms', 'разметк', 'краул', 'донор', 'беклинк', 'site', 'pagespeed', 'speed', 'schema', 'crawl', 'backlink', 'referring']], run: siteHealth },
  { key: 'prompts', anchor: ['промпт', 'панель', 'prompt'], all: [['промпт', 'запрос', 'панель', 'prompt', 'panel', 'query']], run: promptsState },
  { key: 'visibility', anchor: ['видимость', 'visibility'], all: [['видимость', 'упала', 'выросла', 'просела', 'падает', 'растет', 'почему', 'visibility', 'dropped', 'fell', 'grew', 'rose', 'why']], run: whyVisibility },
]

/**
 * Компактный снимок бренда для LLM: только посчитанные числа, без сырых текстов
 * ответов движков (это 90% объёма и почти нулевая польза). ~2–3k токенов.
 * Уходит на бэк как есть — модель видит ровно это и ничего кроме.
 */
export function buildSnapshot(c: AssistantCtx): string {
  const agg = c.agg
  const snap: Record<string, unknown> = { бренд: c.domain || null }
  if (agg?.kpi) snap.метрики = agg.kpi
  if (agg?.changes) {
    const ch = agg.changes
    snap.измененияПрогона = {
      прошлыйПрогон: ch.prevRunAt, последний: ch.lastRunAt,
      началиНазывать: ch.gained?.map((g) => g.prompt),
      пересталиНазывать: ch.lost?.map((g) => g.prompt),
      сдвигиМетрик: ch.metrics,
      конкуренты: ch.rivals,
      охватПромптов: ch.visMoves,
      новыеИсточники: ch.newSources, ушедшиеИсточники: ch.goneSources,
    }
  }
  if (agg?.leaderboard?.length) snap.рейтинг = agg.leaderboard.map((r) => ({ бренд: r.brand, свой: r.self, видимость: r.vis, доляГолоса: r.sov, позиция: r.pos, дельта: r.delta }))
  const selfRow = agg?.platMatrix?.find((r) => r.self)
  if (selfRow && agg?.platforms) snap.движки = agg.platforms.map((p, i) => ({ движок: p, видимость: selfRow.vals[i] }))
  if (agg?.citeCats?.length) snap.типыИсточников = agg.citeCats
  if (agg?.rivalSent?.length) snap.тональность = { оценки: agg.rivalSent, темы: agg.sentThemes }
  if (c.sources.length) snap.топИсточников = c.sources.slice(0, 8).map((s) => ({ домен: s.host, цитат: s.citations, свой: s.own }))
  const blind = c.rows.filter((r) => r.vis === 0).slice(0, 8).map((r) => r.text)
  if (blind.length) snap.промптыБезУпоминаний = blind
  if (c.meta) snap.панель = { активныхПромптов: c.meta.activeCount, наПодтверждение: c.meta.suggestedCount, лимитТарифа: c.meta.promptCap }
  if (c.facts) {
    const f = c.facts
    snap.разборСайта = {
      pageSpeed: f.perfScore, доменовДоноров: f.refDomains, spamScore: f.spamScore,
      краул: f.crawl, разрывыСемантики: (f.gapRows || []).slice(0, 5).map((g) => ({ запрос: g.kw, спрос: g.vol, сложность: g.kd })),
      тонкийКластер: f.thinCluster?.name,
    }
  }
  return JSON.stringify(snap)
}

/**
 * Пытается ответить на вопрос из данных. null — не распознали или для этого
 * интента данных ещё нет (тогда наверх уходит честный ответ, а не выдумка).
 *
 * Матчим по числу совпавших слов (а не «все группы»): вопросы формулируют
 * по-разному, и жёсткое совпадение всех групп проваливало половину. Берём
 * интент с максимумом совпадений; при ничьей — приоритет из порядка INTENTS.
 */
export function routeQuestion(q: string, ctx: AssistantCtx): AssistantAnswer | null {
  const text = norm(q)
  const scored = INTENTS
    .map((i, idx) => {
      const words = i.all.reduce((s, group) => s + group.reduce((g, w) => g + (text.includes(norm(w)) ? 1 : 0), 0), 0)
      const anchor = (i.anchor || []).some((w) => text.includes(norm(w))) ? 5 : 0
      return { i, idx, score: words + anchor }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.idx - b.idx)

  for (const { i } of scored) {
    const a = i.run(ctx)
    if (a) return a
  }
  // ничего не совпало по словам, но вопрос звучит как вопрос про бренд —
  // отдаём главную метрику, а не отфутболиваем в «не понял»
  if (/[?]|как|что|где|почему|скольк|наск|\b(how|what|where|why|which|how many|how much)\b/i.test(q)) {
    return whyVisibility(ctx)
  }
  return null
}
