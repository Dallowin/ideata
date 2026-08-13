/**
 * Разрезы «Конкуренты»: кто впереди по каждому промпту и по каждому источнику.
 *
 * Новых запросов нет — всё считается из того же ответа трекера, что уже
 * загружен для «Мониторинга», «Промптов» и «Ссылок»:
 *  · agg.leaderboard / platMatrix / rivalSent / visTrend — сводка по брендам;
 *  · rows[].answers[].brandsFound — кого движок назвал в ответе на промпт;
 *  · rows[].answers[].citations — на что он при этом сослался.
 *
 * ВАЖНО про источник чисел. Видимость по промпту здесь считается из ответов
 * ПОСЛЕДНЕГО прогона — «доля движков, назвавших бренд». Взять для своего бренда
 * оконный agg-показатель, а для конкурентов — свежий, было бы нечестно: в одной
 * строке стояли бы числа за разные периоды, и «отрыв» получался бы выдуманным.
 * Поэтому вся таблица считается по одному правилу, а разница с «Мониторингом»
 * (там окно прогонов) проговаривается в подписи панели.
 */
import type { TrackerAggregates } from '@/composables/useTracker'
import type { PromptRow, RealAnswer } from '@/data/prompts'
import { SELF_COLOR, brandPalette } from '@/data/dashboard'

/** Домен в сравнимый вид: без схемы, www и хвоста пути. */
export const normDomain = (v: string): string =>
  String(v || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]!.split('?')[0]!

/** Хост цитаты принадлежит бренду: сам домен или его поддомен. */
export const hostOf = (brand: string, host: string): boolean => {
  const b = normDomain(brand)
  const h = normDomain(host)
  return !!b && (h === b || h.endsWith('.' + b))
}

/** Бренд назван в ответе движка. Для своего бренда авторитетен флаг self:
 *  скрапер ставит его по алиасам, а в brandsFound имя может не совпасть с доменом. */
export function namedIn(a: RealAnswer, brand: string, self: boolean): boolean {
  if (self && a.self) return true
  const b = normDomain(brand)
  return (a.brandsFound || []).some((x) => normDomain(x.brand) === b)
}

/** Лучшая (минимальная) позиция бренда в ответе, если движок её дал. */
function posIn(a: RealAnswer, brand: string): number | null {
  const b = normDomain(brand)
  const hits = (a.brandsFound || [])
    .filter((x) => normDomain(x.brand) === b && x.pos != null)
    .map((x) => Number(x.pos))
    .filter((n) => Number.isFinite(n) && n > 0)
  return hits.length ? Math.min(...hits) : null
}

export interface RivalRow {
  brand: string
  self: boolean
  color: string
  /** видимость последнего прогона (agg.leaderboard) */
  vis: number
  sov: number
  pos: number | null
  /** Δ к прошлому прогону */
  delta: number
  sent: number | null
  /** серия по дням/неделям из visTrend — спарклайн карточки */
  trend: number[]
  /** отрыв от своего бренда в пп: + значит мы впереди */
  gap: number
  /** строка platMatrix: видимость по каждому движку */
  engines: number[]
  /** цитат на домен самого бренда */
  cites: number
  /** в скольких промптах бренд назван хотя бы одним движком */
  prompts: number
  /** промптов, где бренд обошёл нас по числу назвавших движков */
  wins: number
}

/**
 * Сводка по брендам: свой + конкуренты трекера. Порядок — по видимости, свой
 * бренд не поднимаем наверх искусственно (иначе «первое место» перестаёт быть
 * информацией).
 */
export function buildRivalRows(
  agg: TrackerAggregates | null,
  rows: PromptRow[],
  duels: PromptDuel[],
): RivalRow[] {
  const board = agg?.leaderboard || []
  if (!board.length) return []
  const palette = brandPalette(agg)
  const sentBy = new Map((agg?.rivalSent || []).map((s) => [s.brand, Number(s.score)]))
  const trendBy = new Map((agg?.visTrend?.series || []).map((s) => [s.brand, s.data.map(Number)]))
  const matrixBy = new Map((agg?.platMatrix || []).map((m) => [m.brand, m.vals.map(Number)]))
  const selfVis = board.find((b) => b.self)?.vis ?? 0

  // цитаты на домен бренда — по всем ответам всех промптов
  const cites = new Map<string, number>()
  const named = new Map<string, number>()
  for (const b of board) {
    let c = 0
    let p = 0
    for (const r of rows) {
      let inPrompt = false
      for (const a of r.answers || []) {
        if (namedIn(a, b.brand, b.self)) inPrompt = true
        for (const cit of a.citations || []) {
          const host = typeof cit === 'string' ? cit : (cit.host || cit.url || '')
          if (hostOf(b.brand, host)) c += 1
        }
      }
      if (inPrompt) p += 1
    }
    cites.set(b.brand, c)
    named.set(b.brand, p)
  }

  const wins = new Map<string, number>()
  for (const d of duels) {
    for (const b of board) {
      if (b.self) continue
      if ((d.vis[b.brand] ?? 0) > d.selfVis) wins.set(b.brand, (wins.get(b.brand) || 0) + 1)
    }
  }

  return board.map((b) => ({
    brand: b.brand,
    self: b.self,
    color: palette[b.brand] || SELF_COLOR,
    vis: b.vis,
    sov: b.sov,
    pos: b.pos,
    delta: b.delta,
    sent: sentBy.has(b.brand) ? sentBy.get(b.brand)! : null,
    trend: trendBy.get(b.brand) || [],
    gap: b.self ? 0 : selfVis - b.vis,
    engines: matrixBy.get(b.brand) || [],
    cites: cites.get(b.brand) || 0,
    prompts: named.get(b.brand) || 0,
    wins: wins.get(b.brand) || 0,
  }))
}

export interface PromptDuel {
  id: number
  text: string
  topic: string
  /** бренд → доля движков, назвавших его в ответе на этот промпт (0–100) */
  vis: Record<string, number>
  /** бренд → лучшая позиция в ответах (null — движки её не дали) */
  pos: Record<string, number | null>
  /** бренд с максимальной долей; '' — промпт не назвал никого из списка */
  leader: string
  selfVis: number
  /** наша доля минус лучшая у конкурентов: < 0 — промпт проигран */
  gap: number
  /** сколько движков вообще ответили на промпт */
  engines: number
}

/** Кто впереди в каждом промпте. Считается из ответов последнего прогона. */
export function buildPromptDuels(
  rows: PromptRow[],
  brands: { brand: string; self: boolean }[],
): PromptDuel[] {
  if (!brands.length) return []
  return rows.map((r) => {
    const answers = r.answers || []
    const total = answers.length
    const vis: Record<string, number> = {}
    const pos: Record<string, number | null> = {}
    for (const b of brands) {
      let hits = 0
      let best: number | null = null
      for (const a of answers) {
        if (!namedIn(a, b.brand, b.self)) continue
        hits += 1
        const p = posIn(a, b.brand)
        if (p != null && (best == null || p < best)) best = p
      }
      vis[b.brand] = total ? Math.round((hits / total) * 100) : 0
      pos[b.brand] = best
    }
    const selfBrand = brands.find((b) => b.self)?.brand || ''
    const selfVis = vis[selfBrand] ?? 0
    const bestRival = brands
      .filter((b) => !b.self)
      .reduce((m, b) => Math.max(m, vis[b.brand] ?? 0), 0)
    // лидер — максимум по строке; при равенстве побеждает свой бренд (нам не
    // нужен «лидер-конкурент» там, где счёт равный)
    let leader = ''
    let top = 0
    for (const b of brands) {
      const v = vis[b.brand] ?? 0
      if (v > top || (v === top && v > 0 && b.self)) { top = v; leader = b.brand }
    }
    return {
      id: r.id,
      text: r.text,
      topic: r.topic,
      vis,
      pos,
      leader: top > 0 ? leader : '',
      selfVis,
      gap: selfVis - bestRival,
      engines: total,
    }
  })
}

export interface SourceDuel {
  host: string
  /** домен принадлежит одному из брендов сравнения */
  brandOwner: string
  own: boolean
  total: number
  /** бренд → цитат этого хоста в ответах, где бренд назван */
  byBrand: Record<string, number>
  /** бренд с наибольшим числом таких цитат */
  leader: string
  prompts: number
}

/**
 * Кто «держит» каждый источник: сколько раз хост процитирован в ответах, где
 * назван тот или иной бренд. Это не «источник пишет про бренд» — это соседство
 * в одном ответе; подпись панели говорит ровно это.
 */
export function buildSourceDuels(
  rows: PromptRow[],
  brands: { brand: string; self: boolean }[],
): SourceDuel[] {
  const acc = new Map<string, { total: number; byBrand: Record<string, number>; prompts: Set<string> }>()
  for (const r of rows) {
    for (const a of r.answers || []) {
      const hit = brands.filter((b) => namedIn(a, b.brand, b.self))
      for (const cit of a.citations || []) {
        const raw = typeof cit === 'string' ? cit : (cit.host || cit.url || '')
        const host = normDomain(raw)
        if (!host) continue
        const e = acc.get(host) ?? { total: 0, byBrand: {}, prompts: new Set<string>() }
        e.total += 1
        e.prompts.add(r.text)
        for (const b of hit) e.byBrand[b.brand] = (e.byBrand[b.brand] || 0) + 1
        acc.set(host, e)
      }
    }
  }
  return [...acc.entries()]
    .map(([host, e]) => {
      const owner = brands.find((b) => hostOf(b.brand, host))
      let leader = ''
      let top = 0
      for (const b of brands) {
        const v = e.byBrand[b.brand] || 0
        if (v > top || (v === top && v > 0 && b.self)) { top = v; leader = b.brand }
      }
      return {
        host,
        brandOwner: owner?.brand || '',
        own: !!owner?.self,
        total: e.total,
        byBrand: e.byBrand,
        leader: top > 0 ? leader : '',
        prompts: e.prompts.size,
      }
    })
    .sort((a, b) => b.total - a.total)
}
