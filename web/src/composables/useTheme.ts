/**
 * Тема кабинета: светлая или тёмная.
 *
 * Класс вешаем на <html> — так же, как это делает Tailwind (`@custom-variant
 * dark`) и наши токены (`html.light` / `html.dark` задают color-scheme). Выбор
 * храним в localStorage, а не в куке: тема нужна ровно этому браузеру и никакого
 * отношения к серверу не имеет.
 *
 * Дефолт светлый. Тёмная остаётся выбором пользователя, а не единственным
 * вариантом: дашборд с данными читается на светлом фоне лучше.
 */
import { ref } from 'vue'

export type Theme = 'light' | 'dark'
const KEY = 'ideata_theme'

/** Что стоит сейчас. Значение читаем один раз при загрузке модуля. */
const theme = ref<Theme>(read())

function read(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light' // приватный режим без localStorage — не повод падать
  }
}

/** Применить класс к <html>. Оба класса взаимоисключающие. */
export function applyTheme(next: Theme) {
  const el = document.documentElement
  el.classList.toggle('dark', next === 'dark')
  el.classList.toggle('light', next === 'light')
}

export function useTheme() {
  function set(next: Theme) {
    theme.value = next
    applyTheme(next)
    try { localStorage.setItem(KEY, next) } catch { /* приватный режим */ }
  }
  const toggle = () => set(theme.value === 'dark' ? 'light' : 'dark')
  return { theme, set, toggle }
}

/** Вызвать до монтирования приложения, чтобы не мигнуть чужой темой. */
export function initTheme() {
  applyTheme(read())
}
