/**
 * Конверсии цвета для пикера: внутри работаем в HSVA (так устроены плоскость
 * насыщенности и полоса тона), наружу отдаём валидный CSS — hex при alpha=1,
 * иначе rgba(). Парсим то, что реально встречается в сценах: hex 3/6/8,
 * rgb()/rgba(), hsl()/hsla() и `transparent`.
 */
export interface Hsva { h: number; s: number; v: number; a: number }
export interface Rgb { r: number; g: number; b: number }

const clamp = (v: number, min = 0, max = 1) => Math.min(max, Math.max(min, v))

export function hsvToRgb({ h, s, v }: { h: number; s: number; v: number }): Rgb {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) }
}

export function rgbToHsv({ r, g, b }: Rgb): { h: number; s: number; v: number } {
  const R = r / 255, G = g / 255, B = b / 255
  const max = Math.max(R, G, B), min = Math.min(R, G, B)
  const d = max - min
  let h = 0
  if (d) {
    if (max === R) h = 60 * (((G - B) / d) % 6)
    else if (max === G) h = 60 * ((B - R) / d + 2)
    else h = 60 * ((R - G) / d + 4)
  }
  if (h < 0) h += 360
  return { h, s: max ? d / max : 0, v: max }
}

export function rgbToHex({ r, g, b }: Rgb): string {
  return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
}

export function hsvToHex(c: { h: number; s: number; v: number }): string { return rgbToHex(hsvToRgb(c)) }

/** Разобрать любую поддерживаемую строку в HSVA. Не распознали — чёрный. */
export function parseColor(input: string): Hsva {
  const s = String(input ?? '').trim().toLowerCase()
  if (!s || s === 'transparent') return { h: 0, s: 0, v: 0, a: 0 }

  const hex = s.match(/^#([0-9a-f]{3,8})$/)
  if (hex) {
    let x = hex[1]
    if (x.length === 3 || x.length === 4) x = x.split('').map((c) => c + c).join('')
    const r = parseInt(x.slice(0, 2), 16), g = parseInt(x.slice(2, 4), 16), b = parseInt(x.slice(4, 6), 16)
    const a = x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1
    return { ...rgbToHsv({ r, g, b }), a }
  }

  const rgb = s.match(/^rgba?\(([^)]+)\)$/)
  if (rgb) {
    const p = rgb[1].split(/[,/\s]+/).filter(Boolean).map(Number)
    if (p.length >= 3 && p.slice(0, 3).every((n) => Number.isFinite(n))) {
      return { ...rgbToHsv({ r: p[0], g: p[1], b: p[2] }), a: p[3] != null && Number.isFinite(p[3]) ? clamp(p[3]) : 1 }
    }
  }

  const hsl = s.match(/^hsla?\(([^)]+)\)$/)
  if (hsl) {
    const p = hsl[1].split(/[,/\s]+/).filter(Boolean).map((t) => Number(t.replace('%', '')))
    if (p.length >= 3 && p.slice(0, 3).every((n) => Number.isFinite(n))) {
      const [h, sl, l] = [p[0], p[1] / 100, p[2] / 100]
      const v = l + sl * Math.min(l, 1 - l)
      return { h: ((h % 360) + 360) % 360, s: v ? 2 * (1 - l / v) : 0, v, a: p[3] != null && Number.isFinite(p[3]) ? clamp(p[3]) : 1 }
    }
  }

  return { h: 0, s: 0, v: 0, a: 1 }
}

/** CSS-строка для модели: hex, если непрозрачный, иначе rgba(). */
export function toCss(c: Hsva): string {
  const { r, g, b } = hsvToRgb(c)
  return c.a >= 1 ? rgbToHex({ r, g, b }) : `rgba(${r}, ${g}, ${b}, ${Math.round(c.a * 100) / 100})`
}

export type ColorFormat = 'hex' | 'rgb' | 'css' | 'hsl'

/** Человекочитаемое представление в выбранном формате (для поля вывода). */
export function formatColor(c: Hsva, format: ColorFormat): string {
  const { r, g, b } = hsvToRgb(c)
  const a = Math.round(c.a * 100) / 100
  if (format === 'rgb') return `${r}, ${g}, ${b}`
  if (format === 'css') return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`
  if (format === 'hsl') {
    const l = c.v * (1 - c.s / 2)
    const sl = l === 0 || l === 1 ? 0 : (c.v - l) / Math.min(l, 1 - l)
    const h = Math.round(c.h), S = Math.round(sl * 100), L = Math.round(l * 100)
    return a >= 1 ? `hsl(${h}, ${S}%, ${L}%)` : `hsla(${h}, ${S}%, ${L}%, ${a})`
  }
  return rgbToHex({ r, g, b }).toUpperCase()
}
