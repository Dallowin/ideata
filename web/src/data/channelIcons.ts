// Логотипы площадок публикации: эмодзи рисуются по-разному в разных ОС, а
// один и тот же канал теперь показывается в трёх местах (композер соцсетей,
// диалог публикации статьи и чипы автопостинга в контент-плане) — держать три
// копии таблицы значило бы разъехаться на первом же новом канале.
// ВНИМАНИЕ: /icons/ai/x.svg — это логотип Grok (<title>Grok</title>), поэтому
// для X берём фавикон домена.
import { faviconSrc } from '@/data/prompts'

export const CHANNEL_ICONS: Record<string, string> = {
  tg: faviconSrc('telegram.org'),
  x: faviconSrc('x.com'),
  vk: '/icons/sites/vk.com.png',
  dzen: '/icons/sites/dzen.ru.png',
  threads: faviconSrc('threads.com'),
  bluesky: faviconSrc('bsky.app'),
  mastodon: faviconSrc('mastodon.social'),
  linkedin: faviconSrc('linkedin.com'),
  // каналы статьи: ключи другие, но площадки те же
  devto: faviconSrc('dev.to'),
  wordpress: faviconSrc('wordpress.org'),
  ghost: faviconSrc('ghost.org'),
  telegraph: faviconSrc('telegra.ph'),
}

/**
 * Каналы, куда кабинет умеет отправлять САМ. Остальным (vk/dzen/threads и
 * ленты по RSS) мы отдаём только текст на копирование — планировать автопостинг
 * туда нечего, поэтому в расписании их нет вовсе.
 */
export const AUTO_PUBLISH_CHANNELS = new Set(['tg', 'x', 'bluesky', 'mastodon', 'linkedin'])

/**
 * Каналы, куда автопостинга нет и не будет: VK и Дзен закрыты для внешних
 * публикаций, Threads мы отдаём копированием, RSS площадка забирает сама.
 * Планировщик их не показывает — иначе это обещание, которое некому исполнить.
 */
export const NO_AUTO_PUBLISH = new Set(['threads', 'vk', 'dzen', 'rss'])

/**
 * Читаемые названия каналов. Обычно их присылает бэк вместе с профилем
 * площадки, но в расписании контент-плана приходит только ключ — а «tg» в чипе
 * календаря ни о чём не говорит.
 */
const CHANNEL_LABELS: Record<string, string> = {
  tg: 'Telegram',
  x: 'X',
  vk: 'VK',
  dzen: 'Дзен',
  threads: 'Threads',
  bluesky: 'Bluesky',
  mastodon: 'Mastodon',
  linkedin: 'LinkedIn',
  devto: 'dev.to',
  wordpress: 'WordPress',
  ghost: 'Ghost',
  telegraph: 'Telegraph',
}
export const channelLabel = (key: string) => CHANNEL_LABELS[key] || key
