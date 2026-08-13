/**
 * Стор конструктора обложек: сцена, шаблоны, объекты, фон, undo/redo, экспорт,
 * «Мои шаблоны» (в БД). Порт студии из кабинета web под app: без Nuxt-
 * автоимпортов и без мультиязычных слотов (тут одна сцена = одна обложка).
 *
 * Состояние — модульное (одно на приложение): студия живёт на одной странице,
 * а инспектор/галерея должны видеть ту же сцену, что и холст.
 */
import { computed, reactive, ref } from 'vue'
import { api } from '@/lib/api'
import { i18n } from '@/i18n'
import type { Scene, SceneObject } from '@/lib/preview/scene'
import { cloneScene, newId, renderSceneParts } from '@/lib/preview/scene'
import { SCENE_TEMPLATES, sceneFontsHref, SF, type SceneTemplate } from '@/lib/preview/scenes'
import { embedFontCss, rasterize, toDataUri } from '@/lib/preview/rasterize'

const scene = reactive<Scene>(cloneScene(SCENE_TEMPLATES[0].scene))
const selectedId = ref('')
const activeTplId = ref<string>(SCENE_TEMPLATES[0].id)

// история (commit-based): снапшоты сцены в точках коммита
const history = reactive<Scene[]>([])
const hIdx = ref(-1)
let histInit = false

// Шаблоны живут на сервере (preview_scenes): localStorage терялся при смене
// браузера и не переезжал между машинами. Старые локальные шаблоны при первом
// заходе переносим на сервер и чистим ключ.
export interface SavedScene { id: string; name: string; scene: Scene; savedAt: number }
const MY_KEY = 'ideata:preview:scenes:v1'
const myScenes = ref<SavedScene[]>([])
let myLoaded = false

function fromRow(r: any): SavedScene {
  return { id: String(r.id), name: r.name, scene: r.scene, savedAt: new Date(r.updatedAt || Date.now()).getTime() }
}

async function migrateLocal() {
  let local: any[] = []
  try { local = JSON.parse(localStorage.getItem(MY_KEY) || '[]') } catch { local = [] }
  if (!local.length) return
  for (const t of local) {
    if (t?.scene?.objects) {
      try { await api.previewSaveScene(t.name || i18n.global.t('preview.myTemplate'), t.scene) } catch { return } // сервер не ответил — оставляем локальные до следующего раза
    }
  }
  try { localStorage.removeItem(MY_KEY) } catch { /* ignore */ }
}

let myLoading = false
async function loadMy() {
  if (myLoaded || myLoading) return
  myLoading = true
  await migrateLocal()
  try {
    myScenes.value = ((await api.previewScenes())?.scenes || []).map(fromRow)
    // флаг «загружено» ставим ТОЛЬКО по факту ответа сервера: раньше сбой
    // (не залогинен/бэк лёг) навсегда закрывал повторную попытку
    myLoaded = true
  } catch {
    // не залогинен / бэк недоступен — показываем то, что осталось локально
    try { myScenes.value = JSON.parse(localStorage.getItem(MY_KEY) || '[]') } catch { myScenes.value = [] }
  } finally {
    myLoading = false
  }
}

function replaceScene(s: Scene) {
  scene.width = s.width; scene.height = s.height
  scene.bg = { ...s.bg }
  scene.objects.splice(0, scene.objects.length, ...cloneScene(s).objects)
}

export function useSceneStudio() {
  void loadMy()
  const rendering = ref(false)
  const selected = computed<SceneObject | null>(() => scene.objects.find((o) => o.id === selectedId.value) || null)
  const canUndo = computed(() => hIdx.value > 0)
  const canRedo = computed(() => hIdx.value < history.length - 1)

  /* --------------------------------------------------- история */
  function commit() {
    history.splice(hIdx.value + 1)
    history.push(cloneScene(scene))
    if (history.length > 60) history.shift()
    hIdx.value = history.length - 1
  }
  // сид начального состояния: иначе первое действие нечего было бы отменять
  function resetHistory() { history.splice(0, history.length); hIdx.value = -1; commit() }
  if (!histInit) { histInit = true; resetHistory() }
  function undo() { if (hIdx.value <= 0) return; hIdx.value--; replaceScene(history[hIdx.value]); selectedId.value = '' }
  function redo() { if (hIdx.value >= history.length - 1) return; hIdx.value++; replaceScene(history[hIdx.value]); selectedId.value = '' }

  /* --------------------------------------------------- шаблоны */
  function loadTemplate(t: SceneTemplate) {
    replaceScene(t.scene); activeTplId.value = t.id; selectedId.value = ''; resetHistory()
  }
  function loadScene(t: SavedScene) {
    replaceScene(t.scene); activeTplId.value = t.id; selectedId.value = ''; resetHistory()
  }

  /* --------------------------------------------------- объекты */
  function addText() {
    // текст-заглушка нового объекта: автор его тут же переписывает, поэтому
    // берём язык интерфейса — дальше это уже контент обложки
    const o: SceneObject = { id: newId(), type: 'text', x: Math.round(scene.width / 2 - 200), y: Math.round(scene.height / 2 - 30), w: 400, text: i18n.global.t('preview.tool.text'), font: SF.grotesk, size: 48, weight: 700, color: '#111111', align: 'left', lh: 1.1 }
    scene.objects.push(o); selectedId.value = o.id; commit()
  }
  function addBlock() {
    const o: SceneObject = { id: newId(), type: 'block', x: Math.round(scene.width / 2 - 120), y: Math.round(scene.height / 2 - 4), w: 240, h: 8, fill: '#111111', radius: 4 }
    scene.objects.push(o); selectedId.value = o.id; commit()
  }
  function addImage(src: string) {
    const w = Math.round(scene.width * 0.42), h = Math.round(w * 0.66)
    const o: SceneObject = { id: newId(), type: 'image', src, x: Math.round((scene.width - w) / 2), y: Math.round((scene.height - h) / 2), w, h, fit: 'cover', radius: 12 }
    scene.objects.push(o); selectedId.value = o.id; commit()
  }
  /** Фон-картинку — в отдельный слой (двигать/ресайзить на холсте). */
  function bgToLayer() {
    if (!scene.bg.image) return
    const o: SceneObject = { id: newId(), type: 'image', src: scene.bg.image, x: 0, y: 0, w: scene.width, h: scene.height, fit: 'cover', radius: 0 }
    scene.objects.unshift(o) // под остальные объекты
    scene.bg.image = ''
    selectedId.value = o.id; commit()
  }
  function removeSelected() { const i = scene.objects.findIndex((o) => o.id === selectedId.value); if (i >= 0) { scene.objects.splice(i, 1); selectedId.value = ''; commit() } }
  function duplicate() { const o = selected.value; if (!o) return; const c: SceneObject = { ...JSON.parse(JSON.stringify(o)), id: newId(), x: o.x + 24, y: o.y + 24 }; scene.objects.push(c); selectedId.value = c.id; commit() }
  function forward() { const i = scene.objects.findIndex((o) => o.id === selectedId.value); if (i >= 0 && i < scene.objects.length - 1) { const [o] = scene.objects.splice(i, 1); scene.objects.splice(i + 1, 0, o); commit() } }
  function backward() { const i = scene.objects.findIndex((o) => o.id === selectedId.value); if (i > 0) { const [o] = scene.objects.splice(i, 1); scene.objects.splice(i - 1, 0, o); commit() } }
  function nudge(dx: number, dy: number) { const o = selected.value; if (!o) return; o.x += dx; o.y += dy }

  /** Выровнять выбранный объект по холсту. w/h — измеренные размеры (px холста). */
  function alignSelected(kind: string, w: number, h: number) {
    const o = selected.value; if (!o) return
    const M = 80
    if (kind === 'left') o.x = M
    else if (kind === 'hcenter') o.x = Math.round((scene.width - w) / 2)
    else if (kind === 'right') o.x = scene.width - w - M
    else if (kind === 'top') o.y = M
    else if (kind === 'vmiddle') o.y = Math.round((scene.height - h) / 2)
    else if (kind === 'bottom') o.y = scene.height - h - M
    commit()
  }

  /** Подставить заголовок статьи в самый крупный текст сцены. */
  function fillHeadline(title: string) {
    const t = title.trim()
    if (!t) return
    const texts = scene.objects.filter((o) => o.type === 'text')
    if (!texts.length) return
    const biggest = texts.reduce((a, b) => ((b.size || 0) > (a.size || 0) ? b : a))
    biggest.text = t
    commit()
  }

  /* --------------------------------------------------- сцена/фон */
  function setSize(w: number, h: number) { scene.width = w; scene.height = h; commit() }
  function setBgImage(url: string) { scene.bg.image = url; commit() }
  function clearBgImage() { scene.bg.image = ''; commit() }

  /* --------------------------------------------------- экспорт */
  async function toImageBlob(mime: 'image/png' | 'image/jpeg' = 'image/png', scale = 2, sc: Scene = scene): Promise<Blob> {
    const parts = renderSceneParts(sc)
    let css = parts.css, inner = parts.inner
    try { css = (await embedFontCss(sceneFontsHref())) + css } catch (e) { console.warn('[scene] шрифты не встроились', e) }
    // внешние картинки → data-URI, иначе canvas тайнится и toBlob падает
    if (sc.bg.image && !sc.bg.image.startsWith('data:')) { try { css = css.split(sc.bg.image).join(await toDataUri(sc.bg.image)) } catch { /* ignore */ } }
    for (const o of sc.objects) { if (o.type === 'image' && o.src && !o.src.startsWith('data:')) { try { inner = inner.split(o.src).join(await toDataUri(o.src)) } catch { /* ignore */ } } }
    return rasterize({ css, inner, width: sc.width, height: sc.height }, { mime, scale, jpegBg: sc.bg.color })
  }
  const toJpegBlob = () => toImageBlob('image/jpeg', 2)
  function dl(blob: Blob, name: string) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000) }
  async function downloadPng() {
    rendering.value = true
    try { dl(await toImageBlob('image/png', 2), `preview-${scene.width}x${scene.height}.png`) } finally { rendering.value = false }
  }

  /* --------------------------------------------------- Мои шаблоны */
  function firstText(): string { return scene.objects.find((o) => o.type === 'text' && o.text)?.text || '' }

  /** Сохранить текущий холст шаблоном. Пишем на сервер, список обновляем ответом. */
  async function saveScene(name?: string): Promise<SavedScene | null> {
    const title = (name || firstText() || i18n.global.t('preview.myTemplate')).trim().slice(0, 60)
    try {
      const row = await api.previewSaveScene(title, cloneScene(scene))
      const t = fromRow(row)
      myScenes.value.unshift(t); activeTplId.value = t.id
      return t
    } catch {
      return null
    }
  }

  async function deleteScene(id: string) {
    try { await api.previewDeleteScene(Number(id)) } catch { return }
    myScenes.value = myScenes.value.filter((t) => t.id !== id)
  }

  return {
    scene, selectedId, selected, rendering, commit,
    templates: SCENE_TEMPLATES, activeTplId, myScenes,
    canUndo, canRedo, undo, redo,
    loadTemplate, loadScene,
    addText, addBlock, addImage, bgToLayer, removeSelected, duplicate, forward, backward, nudge, alignSelected, fillHeadline,
    setSize, setBgImage, clearBgImage,
    toImageBlob, toJpegBlob, downloadPng,
    saveScene, deleteScene,
  }
}
