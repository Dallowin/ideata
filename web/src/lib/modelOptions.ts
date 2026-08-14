/**
 * Пункты селектора моделей для действий блог-райтера (композер «Написать
 * статью», «Профиль агента»). Один билдер на всех: цена везде считается в
 * КРЕДИТАХ за статью, а не в $/1М токенов — токены пользователь не считает, а
 * цену статьи да, и валюта продукта одна (см. data/credits).
 *
 * Прайс за 1М и контекст остаются, но в карточке по наведению — в списке видно
 * главное. Словарь общий (`blog.modelPick.*`), чтобы подписи не разъезжались.
 */
import type { ModelOption } from '@/components/ModelSelect.vue'
import { i18n } from '@/i18n'
import { USD_RUB, postPriceText } from '@/data/credits'

const t = (key: string, named?: Record<string, unknown>) =>
  (named ? i18n.global.t(key, named) : i18n.global.t(key))

/** каталожная модель из /blogwriter/models/catalog */
export interface CatalogModel {
  id: string
  label: string
  inUsd?: number | null
  outUsd?: number | null
  desc?: string | null
  context?: number | null
}

/** прайс за 1М токенов — тоже в кредитах: 1 кредит = 1 ₽ себестоимости */
const price1M = (usd?: number | null) =>
  usd == null ? '—' : t('blog.modelPick.per1M', { n: Math.round(usd * USD_RUB) })

const contextText = (n?: number | null) =>
  !n ? null : n >= 1e6
    ? t('blog.modelPick.contextM', { n: (n / 1e6).toFixed(n % 1e6 ? 1 : 0) })
    : t('blog.modelPick.contextK', { n: Math.round(n / 1000) })

/** Пункт селектора: справа — вилка цены статьи, детали — в карточке ховера. */
export function articleModelOption(m: CatalogModel): ModelOption {
  return {
    id: m.id,
    label: m.label,
    hint: postPriceText(m),
    card: {
      desc: m.desc || null,
      rows: [
        { label: t('blog.modelPick.rows.post'), value: postPriceText(m) || '—' },
        { label: t('blog.modelPick.rows.input'), value: price1M(m.inUsd) },
        { label: t('blog.modelPick.rows.output'), value: price1M(m.outUsd) },
        ...(contextText(m.context) ? [{ label: t('blog.modelPick.rows.context'), value: contextText(m.context)! }] : []),
      ],
    },
  }
}

export const articleModelOptions = (list: CatalogModel[]): ModelOption[] => list.map(articleModelOption)
