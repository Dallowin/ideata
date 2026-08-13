// Общие мелочи панелей мониторинга: палитра брендов для серий/легенд и формат чисел.
//
// Форматтеры зовутся из шаблонов на каждый рендер, поэтому язык берётся у i18n
// в момент вызова: словарь тут не кэшируем, иначе после переключения языка
// подписи остались бы на старом.
import { i18n, intlLocale } from '@/i18n'

const t = (key: string, arg?: any): string =>
  arg === undefined ? (i18n.global.t as any)(key) : (i18n.global.t as any)(key, arg)

/** свой бренд — фирменный синий, конкуренты — спокойные оттенки (без радуги) */
export const SELF_COLOR = '#4267ff'
export const RIVAL_COLORS = ['#a1a1aa', '#22c55e', '#f59e0b', '#e879f9', '#38bdf8']

export const brandColor = (i: number, self: boolean) =>
  self ? SELF_COLOR : RIVAL_COLORS[i % RIVAL_COLORS.length]!

/**
 * Один цвет на бренд для ВСЕХ панелей мониторинга. Порядок берём из visTrend /
 * platMatrix (там он канонический: свой домен + конкуренты бренда), а не из
 * лидерборда — тот отсортирован по видимости и цвета бы «прыгали» между
 * панелями. Свой бренд всегда фирменный синий.
 */
export function brandPalette(agg: {
  visTrend?: { series: { brand: string; self: boolean }[] }
  platMatrix?: { brand: string; self: boolean }[]
  leaderboard?: { brand: string; self: boolean }[]
} | null): Record<string, string> {
  const src = agg?.visTrend?.series || agg?.platMatrix || agg?.leaderboard || []
  const map: Record<string, string> = {}
  let rival = 0
  for (const b of src) {
    if (map[b.brand]) continue
    map[b.brand] = b.self ? SELF_COLOR : RIVAL_COLORS[rival++ % RIVAL_COLORS.length]!
  }
  return map
}

/** домен → короткая подпись бренда (ideata.io → ideata.io, www режем в API) */
export const brandLabel = (b: string) => String(b || '').replace(/^www\./, '')

export const pctFmt = (n?: number | null) => (n == null ? '—' : `${Math.round(n)}%`)
/** 12345 → «12 345», null → «—» */
export const nf = (n?: number | null) => (n == null ? '—' : Math.round(n).toLocaleString(intlLocale()))
/** 12345 → «12,3 тыс.» для тесных ячеек */
export const fmtK = (n?: number | null) => {
  if (n == null) return '—'
  // разделитель дробной части — по языку интерфейса («12,3» / «12.3»)
  const dec = (v: number, d: number) =>
    v.toLocaleString(intlLocale(), { minimumFractionDigits: d, maximumFractionDigits: d })
  if (Math.abs(n) < 1000) return String(Math.round(n))
  if (Math.abs(n) < 1_000_000) return t('monitoring.fmt.k', { v: dec(n / 1000, n < 10_000 ? 1 : 0) })
  return t('monitoring.fmt.m', { v: dec(n / 1_000_000, 1) })
}
export const posFmt = (n?: number | null) => (n == null ? '—' : String(n))

/** «2 дн. назад» / «сегодня» для отметок прогонов */
export function agoLabel(iso?: string | null): string {
  if (!iso) return '—'
  const ts = new Date(iso).getTime()
  if (!Number.isFinite(ts)) return '—'
  const days = Math.floor((Date.now() - ts) / 86_400_000)
  if (days <= 0) return t('time.today')
  if (days === 1) return t('time.yesterday')
  if (days < 7) return t('monitoring.fmt.daysAgo', days)
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return t('monitoring.fmt.weeksAgo', weeks)
  return new Date(iso).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short' })
}

/** ISO-неделя 2026-W31 → «нед. 31» для оси графика */
export const weekLabel = (w: string) => {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(w || ''))
  return m ? t('monitoring.fmt.week', { n: Number(m[2]) }) : String(w || '')
}

/**
 * Подпись точки тренда. Бэк отдаёт бакеты либо по неделям («2026-W29»), либо по
 * дням («2026-07-24») — гранулярность зависит от частоты прогонов и приходит в
 * visTrend.granularity. Ежедневный мониторинг раньше рисовался недельными
 * средними, и провалы внутри недели были не видны.
 */
export const trendLabel = (v: string) => {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''))
  if (!d) return weekLabel(v)
  // порядок «день.месяц» / «месяц/день» — за языком интерфейса; UTC, иначе
  // бакет 2026-07-24 в западных зонах уезжает на сутки назад
  return new Date(Date.UTC(Number(d[1]), Number(d[2]) - 1, Number(d[3])))
    .toLocaleDateString(intlLocale(), { day: '2-digit', month: '2-digit', timeZone: 'UTC' })
}

/** Фавиконка домена: в списках она читается быстрее цветного квадрата. */
export const brandFavicon = (brand: string) => {
  const host = String(brand || '').trim().toLowerCase().replace(/^https?:\/\//, '').split('/')[0]
  return host ? `https://www.google.com/s2/favicons?domain=${host}&sz=64` : ''
}
