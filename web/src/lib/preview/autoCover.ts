/**
 * Автообложка статьи: собрать JPEG по шаблону ПО УМОЛЧАНИЮ и положить его
 * обложкой рана. Нужна там, где студию не открывают: запустил тему — обложка
 * уже есть, а не «сделаю потом» (и потом никто не делает).
 *
 * Сцену рендерим СВОЮ, а не из useSceneStudio: состояние студии там модульное
 * (одно на всё приложение), и фоновый рендер затирал бы холст, который автор
 * прямо сейчас правит.
 *
 * Шаблон по умолчанию: последний сохранённый шаблон автора (это и есть «его»
 * оформление), иначе первый из встроенных.
 */
import { api } from '@/lib/api'
import { embedFontCss, rasterize, toDataUri } from './rasterize'
import { cloneScene, renderSceneParts, type Scene } from './scene'
import { SCENE_TEMPLATES, sceneFontsHref } from './scenes'

/** Сцена-шаблон по умолчанию: свой сохранённый → встроенный. */
export async function defaultCoverScene(): Promise<Scene> {
  try {
    const rows = (await api.previewScenes())?.scenes || []
    const raw = rows[0]?.scene
    const s = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (s?.objects?.length) return cloneScene(s as Scene)
  } catch { /* нет своих шаблонов / не залогинен — берём встроенный */ }
  return cloneScene(SCENE_TEMPLATES[0].scene)
}

/** Подставить заголовок в самый крупный текст сцены (как fillHeadline студии). */
function fillHeadline(scene: Scene, title: string): void {
  const t = title.trim()
  if (!t) return
  const texts = scene.objects.filter((o) => o.type === 'text')
  if (!texts.length) return
  const biggest = texts.reduce((a, b) => ((b.size || 0) > (a.size || 0) ? b : a))
  biggest.text = t
}

/** Собрать JPEG сцены в браузере (шрифты и картинки инлайнятся — иначе canvas тайнится). */
async function toJpeg(scene: Scene): Promise<Blob> {
  const parts = renderSceneParts(scene)
  let css = parts.css
  let inner = parts.inner
  try { css = (await embedFontCss(sceneFontsHref())) + css } catch { /* без встроенных шрифтов — системные */ }
  if (scene.bg.image && !scene.bg.image.startsWith('data:')) {
    try { css = css.split(scene.bg.image).join(await toDataUri(scene.bg.image)) } catch { /* ignore */ }
  }
  for (const o of scene.objects) {
    if (o.type === 'image' && o.src && !o.src.startsWith('data:')) {
      try { inner = inner.split(o.src).join(await toDataUri(o.src)) } catch { /* ignore */ }
    }
  }
  return rasterize({ css, inner, width: scene.width, height: scene.height },
    { mime: 'image/jpeg', scale: 2, jpegBg: scene.bg.color })
}

/**
 * JPEG обложки по шаблону по умолчанию с заголовком `title`.
 * `bgImage` — подложка (например, AI-фон из runs/:id/cover): бэк отдаёт только
 * картинку и обложку рану не проставляет, композицию всё равно собирает клиент.
 */
export async function buildCoverBlob(title: string, bgImage?: string): Promise<Blob> {
  const scene = await defaultCoverScene()
  fillHeadline(scene, title)
  if (bgImage) scene.bg.image = bgImage
  return toJpeg(scene)
}

/**
 * Сделать обложку рану по шаблону по умолчанию. Возвращает URL обложки или
 * null: это фоновая любезность, и падать из-за неё нельзя — ни на старте
 * генерации, ни в инспекторе.
 */
export async function makeDefaultCover(runId: string, title: string, bgImage?: string): Promise<string | null> {
  if (!runId) return null
  try {
    const { coverUrl } = await api.blogSaveCover(runId, await buildCoverBlob(title, bgImage))
    return coverUrl || null
  } catch {
    return null
  }
}
