/**
 * Объектная модель холста превью (Canva-lite). Сцена = холст W×H + фон + список
 * объектов с абсолютными координатами. Объекты можно таскать и править текст по
 * дабл-клику (см. PreviewCanvas.vue). Тот же рендер в HTML идёт в экспорт PNG.
 *
 * Координаты/размеры — в ПИКСЕЛЯХ холста (true canvas px); редактор рисует .stage
 * в этих px и масштабирует через transform: scale(fit). Так живой холст и PNG
 * совпадают пиксель-в-пиксель, а объект переносится делением дельты мыши на scale.
 */

export type ObjType = 'text' | 'block' | 'image'

export interface SceneObject {
  id: string
  type: ObjType
  x: number
  y: number
  w: number
  h?: number // text — авто, block/image — обязательна
  opacity?: number
  // --- text ---
  text?: string
  font?: string        // CSS font-family stack
  size?: number        // px в координатах холста
  weight?: number
  color?: string
  align?: 'left' | 'center' | 'right'
  lh?: number          // line-height (множитель)
  ls?: number          // letter-spacing, px
  caps?: boolean
  italic?: boolean
  // --- fill (block, или подложка-пилюля у текста) ---
  fill?: string
  radius?: number
  pad?: number         // паддинг у текста-пилюли, px
  // --- image ---
  src?: string
  fit?: 'cover' | 'contain'
}

export interface GradientStop { color: string; pos: number } // pos 0..100

export interface SceneBg {
  type: 'solid' | 'gradient'
  color: string
  color2?: string       // legacy 2-точечный градиент (фолбэк, если нет stops)
  angle?: number
  gradType?: 'linear' | 'radial'
  stops?: GradientStop[] // многоступенчатый градиент (Figma-стиль)
  image?: string        // AI-фон поверх заливки
  scrim?: number        // затемнение/осветление фото под текст (0..1)
  imgX?: number         // позиция фон-картинки по X, % (0..100, дефолт 50)
  imgY?: number         // позиция по Y, % (дефолт 50)
  imgZoom?: number      // масштаб фон-картинки, % (100..300, дефолт 100)
}

/** Значение градиента (много-стоповый / радиальный / линейный с углом). */
export function gradientValue(bg: SceneBg): string {
  const stops = (bg.stops && bg.stops.length >= 2)
    ? bg.stops
    : [{ color: bg.color, pos: 0 }, { color: bg.color2 || bg.color, pos: 100 }]
  const list = [...stops].sort((a, b) => a.pos - b.pos).map((s) => `${s.color} ${Math.round(s.pos)}%`).join(', ')
  return bg.gradType === 'radial'
    ? `radial-gradient(circle at 50% 45%, ${list})`
    : `linear-gradient(${bg.angle ?? 160}deg, ${list})`
}

export interface Scene {
  width: number
  height: number
  bg: SceneBg
  objects: SceneObject[]
}

const esc = (s: string) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Значение ДЛЯ АТРИБУТА: esc + двойная кавычка. Без этого стек шрифта из SF
 * (`font-family:"Space Grotesk", …`) обрывает style="…" на первой же кавычке →
 * разметка невалидна → экспорт падает «svg render failed». В редакторе не видно:
 * там Vue биндит :style ОБЪЕКТОМ через DOM, а строка-атрибут только в экспорте. */
const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;')

/** Инлайн-стиль объекта — ОДИН источник для редактора (:style) и экспорта (строка). */
export function objStyle(o: SceneObject): Record<string, string> {
  const s: Record<string, string> = {
    position: 'absolute',
    left: o.x + 'px',
    top: o.y + 'px',
    width: o.w + 'px',
    ...(o.h ? { height: o.h + 'px' } : {}),
    ...(o.opacity != null ? { opacity: String(o.opacity) } : {}),
  }
  if (o.type === 'text') {
    s.fontFamily = o.font || 'Inter, sans-serif'
    s.fontSize = (o.size || 40) + 'px'
    s.fontWeight = String(o.weight || 600)
    s.color = o.color || '#111111'
    s.textAlign = o.align || 'left'
    s.lineHeight = String(o.lh ?? 1.08)
    s.letterSpacing = (o.ls ?? 0) + 'px'
    if (o.caps) s.textTransform = 'uppercase'
    if (o.italic) s.fontStyle = 'italic'
    s.whiteSpace = 'pre-wrap'
    s.wordBreak = 'break-word'
    if (o.fill) {
      s.background = o.fill
      s.borderRadius = (o.radius ?? 999) + 'px'
      s.padding = (o.pad ?? 10) + 'px ' + (o.pad ?? 10) * 1.6 + 'px'
      s.display = 'inline-block'
      s.width = 'auto' as any
    }
  } else if (o.type === 'block') {
    s.background = o.fill || '#111111'
    s.borderRadius = (o.radius || 0) + 'px'
    s.height = (o.h || 6) + 'px'
  } else if (o.type === 'image') {
    s.objectFit = o.fit || 'cover'
    s.height = (o.h || 200) + 'px'
    s.borderRadius = (o.radius || 0) + 'px'
    s.overflow = 'hidden'
  }
  return s
}

function styleString(o: SceneObject): string {
  const st = objStyle(o)
  return Object.entries(st).map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}:${v}`).join(';')
}

/** Фон сцены как CSS background (заливка/градиент + опц. AI-фото со скримом). */
export function bgCss(bg: SceneBg): string {
  const base = bg.type === 'gradient' ? gradientValue(bg) : bg.color
  if (bg.image) {
    // Порядок слоёв в CSS background: ПЕРВЫЙ — сверху. Скрим (для читаемости) →
    // картинка → заливка-фолбэк. Раньше заливка стояла ВЫШЕ картинки и прятала её.
    const a = bg.scrim ?? 0.35
    const px = bg.imgX ?? 50, py = bg.imgY ?? 50, zoom = bg.imgZoom ?? 100
    // cover-масштаб от зума: 100% = cover; больше — приближаем (можно панорамировать)
    const size = zoom === 100 ? 'cover' : `${zoom}%`
    return `background:linear-gradient(180deg, rgba(0,0,0,${a * 0.4}), rgba(0,0,0,${a})), url("${bg.image}") ${px}% ${py}% / ${size} no-repeat, ${base};`
  }
  return `background:${base};`
}

/** Отрендерить сцену в самодостаточный inner-HTML (без обёртки) + css сцены.
 * ВАЖНО: пустые теги пишем самозакрытыми (<img/>, <br/>). Этот же HTML идёт в SVG
 * <foreignObject> при экспорте PNG, а там XML-парсер: незакрытый <img> или <br>
 * рвёт разметку и весь экспорт падает с «svg render failed». В HTML-превью
 * (iframe) самозакрытая форма читается идентично, так что источник остаётся один. */
export function renderSceneParts(scene: Scene) {
  const inner = scene.objects.map((o) => {
    if (o.type === 'image') {
      return `<img src="${escAttr(o.src || '')}" style="${escAttr(styleString(o))}" alt=""/>`
    }
    if (o.type === 'block') {
      return `<div style="${escAttr(styleString(o))}"></div>`
    }
    return `<div style="${escAttr(styleString(o))}">${esc(o.text || '').replace(/\n/g, '<br/>')}</div>`
  }).join('')
  const css = `*{margin:0;padding:0;box-sizing:border-box}
.stage{position:relative;overflow:hidden;${bgCss(scene.bg)}width:${scene.width}px;height:${scene.height}px}`
  return { css, inner, width: scene.width, height: scene.height }
}

/** Полный HTML-документ сцены (для iframe-миниатюр галереи). fontsHref — <link>. */
export function composeScene(scene: Scene, fontsHref = ''): string {
  const p = renderSceneParts(scene)
  const link = fontsHref
    ? `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="${fontsHref}" rel="stylesheet">`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8">${link}<style>${p.css}</style></head><body><div class="stage">${p.inner}</div></body></html>`
}

let _id = 0
export function newId(): string { return 'o' + (++_id).toString(36) + Math.floor(performance.now() % 1000).toString(36) }

export function cloneScene(s: Scene): Scene {
  return JSON.parse(JSON.stringify(s))
}
