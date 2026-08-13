/**
 * Разбор ответа публикации в строки «куда ушла статья».
 *
 * Бэк уже возвращает результат по каждому каналу (publishRunToBlog), но страница
 * до сих пор брала оттуда только slug и статус — пользователь жал «Опубликовать»
 * и не узнавал, доехало ли до dev.to, Ghost и остальных. Здесь ответ
 * превращается в плоский список строк для панели.
 *
 * Канал, которого в ответе нет, в список НЕ попадает: значит он выключен, и
 * строка «не настроен» была бы шумом. Показываем только то, что участвовало.
 */

export type TargetState =
  /** опубликовано (или обновлено) */
  | 'ok'
  /** уже было опубликовано, второй раз не постили */
  | 'skipped'
  /** канал включён, но публикация не удалась */
  | 'error'
  /** канал включён, но настроек не хватило — до сети не дошли */
  | 'unconfigured'
  /** автопубликации нет by design: напоминание сделать руками (Дзен) */
  | 'manual'

export interface PublishTarget {
  key: string
  /** имя площадки как есть — бренды не переводятся */
  label: string
  /** ключ локали вместо label: у «Сайта» и «Дзена» имя языкозависимое */
  labelKey?: string
  state: TargetState
  url?: string
  /** обновили уже существующую публикацию, а не создали новую */
  updated?: boolean
  /** текст ошибки от площадки (приходит с бэка готовым) */
  error?: string
}

/** Общая форма результата канала: у всех коннекторов она одинаковая. */
interface ChannelResult {
  attempted?: boolean
  ok?: boolean
  url?: string
  error?: string
  updated?: boolean
  skipped?: boolean
}

/** Ключ ответа → имя канала. Порядок задаёт порядок строк в панели. */
const CHANNELS: { key: string; label: string; labelKey?: string }[] = [
  { key: 'external', label: '', labelKey: 'site' },
  { key: 'telegram', label: 'Telegram' },
  { key: 'devto', label: 'dev.to' },
  { key: 'bluesky', label: 'Bluesky' },
  { key: 'mastodon', label: 'Mastodon' },
  { key: 'wordpress', label: 'WordPress' },
  { key: 'ghost', label: 'Ghost' },
  { key: 'telegraph', label: 'Telegraph' },
]

function stateOf(r: ChannelResult): TargetState {
  if (r.skipped) return 'skipped'
  if (r.ok) return 'ok'
  // до сети не дошли — не хватило настроек; отличаем от реального провала,
  // потому что чинится это в разных местах
  return r.attempted ? 'error' : 'unconfigured'
}

/** Собрать строки панели из ответа POST /blog/publish. */
export function publishTargets(res: any): PublishTarget[] {
  if (!res || typeof res !== 'object') return []
  const out: PublishTarget[] = []

  for (const { key, label, labelKey } of CHANNELS) {
    const r = res[key] as ChannelResult | undefined
    if (!r || typeof r !== 'object') continue
    const state = stateOf(r)
    out.push({
      key,
      label,
      labelKey,
      state,
      // у сайта своя ссылка — она в корне ответа, а не внутри канала
      url: r.url || (key === 'external' ? res.url : '') || undefined,
      updated: state === 'ok' && !!r.updated,
      error: r.error || undefined,
    })
  }

  // Дзен забирает статьи сам по RSS — публиковать нам нечего, но напомнить стоит
  if (res.dzen?.enabled) {
    out.push({ key: 'dzen', label: '', labelKey: 'dzen', state: 'manual', url: res.dzen.url || undefined })
  }
  return out
}
