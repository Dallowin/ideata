/**
 * Язык кабинета.
 *
 * Источник правды — кука `ideata_lang` на домене `.ideata.io`: её же ставит
 * лендинг, поэтому выбравший английский на сайте попадает в английский
 * кабинет, а не обратно в русский. Куки нет — смотрим язык браузера.
 *
 * URL языком не управляет: кабинет за авторизацией, индексировать нечего, и
 * префикс /en только ломал бы сохранённые ссылки на страницы.
 *
 * Словари лежат по разделам (locales/<язык>/<раздел>.json) и грузятся лениво:
 * второй язык подтягивается только при переключении.
 */
import { createI18n } from 'vue-i18n'

export const LOCALES = ['en', 'ru'] as const
export type Locale = (typeof LOCALES)[number]
export const LOCALE_NAMES: Record<Locale, string> = { en: 'English', ru: 'Русский' }

const COOKIE = 'ideata_lang'

function readCookie(name: string): string {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'))
  return m ? decodeURIComponent(m[1]!) : ''
}

function writeCookie(name: string, value: string) {
  // domain=.ideata.io — чтобы кука была общей с лендингом. На localhost и в
  // превью домена нет: там кука хостовая, иначе браузер её просто отбросит.
  const host = location.hostname
  const onIdeata = host.endsWith('ideata.io')
  const domain = onIdeata ? '; domain=.ideata.io' : ''
  const secure = location.protocol === 'https:' ? '; secure' : ''
  // Гасим хостовую куку того же имени: до 28.07 её писал лендинг, и браузер
  // слал обе — язык зависел от порядка, а не от выбора.
  if (onIdeata) document.cookie = `${name}=; path=/; max-age=0`
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${60 * 60 * 24 * 365}${domain}${secure}; samesite=lax`
}

const isLocale = (v: string): v is Locale => (LOCALES as readonly string[]).includes(v)

export function detectLocale(): Locale {
  // ?lang=en — принудительный язык: нужен для съёмки скриншотов кабинета и
  // чтобы прислать человеку ссылку на нужной локали, не трогая его куку.
  const fromQuery = new URLSearchParams(location.search).get('lang') || ''
  if (isLocale(fromQuery)) return fromQuery
  const fromCookie = readCookie(COOKIE)
  if (isLocale(fromCookie)) return fromCookie
  const nav = (navigator.languages?.[0] || navigator.language || '').toLowerCase()
  // русский интерфейс ближе не только россиянам: у стран СНГ второй язык — русский
  return /^(ru|be|kk|ky|uz|tg|tk|hy|az)/.test(nav) ? 'ru' : 'en'
}

// Vite отдаёт сюда все словари сразу как ленивые импорты — раздел добавляется
// созданием файла, править этот список не нужно.
const FILES = import.meta.glob<{ default: Record<string, unknown> }>('./locales/*/*.json')

const loaded = new Set<string>()

export async function loadMessages(locale: Locale): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  for (const path in FILES) {
    if (!path.startsWith(`./locales/${locale}/`)) continue
    const mod = await FILES[path]!()
    Object.assign(out, mod.default)
  }
  return out
}

export const i18n = createI18n({
  legacy: false,
  locale: 'ru',
  fallbackLocale: 'en',
  // ключ, которого нет, и так виден на экране — в консоли эти предупреждения
  // только заглушают настоящие ошибки
  missingWarn: false,
  fallbackWarn: false,
  messages: {},
  pluralRules: {
    // Правило по умолчанию знает три ветки (0 / 1 / остальное) — русскому мало:
    // «21 промпт», но «22 промпта» и «25 промптов». Строки с 2-3 формами
    // ведут себя как раньше.
    ru: (choice: number, choicesLength: number): number => {
      const n = Math.abs(choice)
      if (choicesLength < 4) return Math.min(n, choicesLength - 1)
      if (n === 0) return 0
      const mod10 = n % 10
      const mod100 = n % 100
      if (mod10 === 1 && mod100 !== 11) return 1
      if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 2
      return 3
    },
  },
})

export async function setLocale(locale: Locale, { persist = true } = {}) {
  if (!loaded.has(locale)) {
    i18n.global.setLocaleMessage(locale, (await loadMessages(locale)) as never)
    loaded.add(locale)
  }
  i18n.global.locale.value = locale
  document.documentElement.lang = locale
  if (persist) writeCookie(COOKIE, locale)
}

/** Локаль для Intl: форматы дат и чисел идут за языком интерфейса. */
export function intlLocale(): string {
  return i18n.global.locale.value === 'ru' ? 'ru-RU' : 'en-US'
}

/** Стартовая загрузка — до mount, иначе первый кадр рисуется голыми ключами. */
export async function initI18n() {
  await setLocale(detectLocale(), { persist: false })
}
