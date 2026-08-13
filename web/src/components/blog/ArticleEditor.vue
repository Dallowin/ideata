<script setup lang="ts">
// Редактор тела статьи на TipTap. В отличие от editor/RichEditor.vue (markdown
// для профиля агента), здесь I/O — HTML: тело поста хранится в body_html, PATCH
// принимает bodyHtml. StarterKit даёт заголовки/списки/цитаты/жирный. Всплывающий
// тулбар (bubble menu) — базовое форматирование по выделению плюс «Магическая
// ручка»: открывает AiEditPanel, который правит ИМЕННО выделенный фрагмент.
// Медиа (картинки/видео/аудио/файлы/встраивания/карточки ссылок) — своя нода
// media/MediaNode: один <figure data-kind=…> на все виды, см. контракт медиа.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Editor, EditorContent } from '@tiptap/vue-3'
import { BubbleMenu } from '@tiptap/vue-3/menus'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { DOMSerializer } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import {
  Bold, Heading2, Italic, Link2, List, ListOrdered, Loader2,
  PenTool, Quote, TriangleAlert, X as XIcon,
} from 'lucide-vue-next'
import AiEditPanel from './AiEditPanel.vue'
import { Media } from './media/MediaNode'
import MediaInsertDialog from './media/MediaInsertDialog.vue'
import InsertPlusMenu, { type PlusAction } from './media/InsertPlusMenu.vue'
import { MEDIA_ACCEPT, startUpload, uploadErrorText } from '@/composables/useMediaUpload'
import { api } from '@/lib/api'
// оформление медиа-блоков общее с превью статьи — см. media/media.css
import './media/media.css'

const props = defineProps<{ modelValue: string; placeholder?: string; title?: string; runId?: string }>()
const emit = defineEmits<{ (e: 'update:modelValue', v: string): void }>()

const { t } = useI18n()

// Пока открыта панель агента, фокус уходит в её поле и нативное выделение
// пропадает — поэтому подсвечиваем диапазон декорацией.
const aiKey = new PluginKey('aiSelection')
const AiSelection = Extension.create({
  name: 'aiSelection',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: aiKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, old) {
            const meta = tr.getMeta(aiKey)
            if (meta === null) return DecorationSet.empty
            if (meta) return DecorationSet.create(tr.doc, [Decoration.inline(meta.from, meta.to, { class: 'ai-sel' })])
            return old.map(tr.mapping, tr.doc)
          },
        },
        props: { decorations: (state) => aiKey.getState(state) },
      }),
    ]
  },
})

// защита от эха: setContent из-за внешнего обновления не должен слать update
let applyingExternal = false

const editor = new Editor({
  extensions: [
    StarterKit,
    // подсказка про drag&drop живёт здесь: строки «+ Медиа … или перетащите
    // файл» над редактором больше нет, а способ вставки терять нельзя
    Placeholder.configure({
      // подсказку TipTap читает один раз при создании редактора: смена языка
      // на лету её не переписывает, зато после перезагрузки она уже на месте
      placeholder: `${props.placeholder || t('blog.editor.placeholder.body')} ${t('blog.editor.placeholder.media')}`,
    }),
    AiSelection,
    Media.configure({ runId: props.runId || '' }),
  ],
  content: props.modelValue || '',
  editorProps: {
    attributes: { class: 'article-prose focus:outline-none' },
    handleDrop: (view, event, _slice, moved) => {
      // moved = перетащили существующий узел внутри документа, это не наше дело
      if (moved) return false
      const files = Array.from((event as DragEvent).dataTransfer?.files || [])
      if (!files.length) return false
      event.preventDefault()
      const coords = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })
      let at = coords?.pos ?? view.state.selection.from
      // каждый следующий файл кладём за предыдущим (медиа-нода = 1 позиция),
      // иначе пачка вставляется в обратном порядке
      for (const f of files) { insertUpload(f, at); at += 1 }
      return true
    },
    handlePaste: (view, event) => {
      const files = Array.from((event as ClipboardEvent).clipboardData?.files || [])
      if (files.length) {
        event.preventDefault()
        for (const f of files) insertUpload(f)
        return true
      }
      const text = ((event as ClipboardEvent).clipboardData?.getData('text/plain') || '').trim()
      // URL в ПУСТОМ абзаце = «хочу тут блок», а не ссылку внутри строки;
      // во всех остальных местах не мешаем обычной вставке
      if (text && /^https?:\/\/\S+$/i.test(text) && isEmptyParagraph(view.state)) {
        event.preventDefault()
        resolvePastedUrl(text)
        return true
      }
      return false
    },
  },
  onUpdate: ({ editor }) => {
    if (applyingExternal) return
    emit('update:modelValue', editor.getHTML())
  },
})
// runId переписываем через storage, а не options: при смене локали статьи роут
// меняет :id на том же инстансе компонента, и опции расширения уже не тронуть
editor.storage.media.runId = props.runId || ''
watch(() => props.runId, (v) => { editor.storage.media.runId = v || '' })

// внешнее изменение (загрузка/перегенерация секции) → перезалить контент
watch(
  () => props.modelValue,
  (v) => {
    if (v === editor.getHTML()) return
    applyingExternal = true
    editor.commands.setContent(v || '', { emitUpdate: false })
    applyingExternal = false
  },
)

// --- медиа -------------------------------------------------------------------
// Загрузка идёт в ран, поэтому без runId кнопки вставки файлов бессмысленны
// (ран создаётся раньше редактора, так что практически он всегда есть).
const canUpload = computed(() => !!props.runId)
const mediaError = ref('')
const mediaDialog = ref(false)
const mediaDialogTab = ref<'link' | 'library'>('link')
const fileEl = ref<HTMLInputElement>()
const fileAccept = ref('')

// «Файл или аудио» — один пункт меню: вид блока всё равно определяется по MIME
// (mp3 → плеер, pdf → плашка), заставлять автора выбирать заранее незачем
const ATTACH_ACCEPT = `${MEDIA_ACCEPT.audio},${MEDIA_ACCEPT.file}`

/** курсор стоит в пустом абзаце — только там URL превращаем в медиа-блок */
function isEmptyParagraph(state: EditorState): boolean {
  const { $from, empty } = state.selection
  return empty && $from.parent.type.name === 'paragraph' && $from.parent.content.size === 0
}

/** позиция ноды по метке незавершённой загрузки (текст вокруг мог уехать) */
function findUpload(uid: string): number | null {
  let at: number | null = null
  editor.state.doc.descendants((node, pos) => {
    if (at !== null) return false
    if (node.type.name === 'media' && node.attrs.uploadId === uid) { at = pos; return false }
    return true
  })
  return at
}

/** дописать атрибуты в ноду загрузки; false — ноду успели удалить */
function patchUpload(uid: string, attrs: Record<string, unknown>): boolean {
  const at = findUpload(uid)
  if (at === null) return false
  const node = editor.state.doc.nodeAt(at)
  if (!node) return false
  // addToHistory:false — прогресс загрузки не должен засорять Ctrl+Z
  const tr = editor.state.tr.setNodeMarkup(at, undefined, { ...node.attrs, ...attrs }).setMeta('addToHistory', false)
  editor.view.dispatch(tr)
  return true
}

/**
 * Вставить блок сразу, грузить в фоне: ждать ответа сервера с пустым местом в
 * тексте — худший из вариантов, особенно для видео на десятки мегабайт.
 * Пока файл летит, у ноды uploading:true и blob-URL для превью.
 */
function insertUpload(file: File, pos?: number) {
  if (!props.runId) { mediaError.value = t('blog.editor.upload.notReady'); return }
  const uid = `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
  let task
  try {
    task = startUpload(props.runId, file, (p) => { patchUpload(uid, { progress: p }) })
  } catch (e: any) {
    mediaError.value = e?.message || t('blog.editor.upload.badFile')
    return
  }
  const attrs = {
    kind: task.kind,
    src: task.preview,
    name: file.name,
    mime: file.type,
    size: file.size,
    uploading: true,
    progress: 0,
    uploadId: uid,
  }
  if (pos != null) editor.chain().focus().insertContentAt(pos, { type: 'media', attrs }).run()
  else editor.chain().focus().setMedia(attrs).run()

  task.promise
    .then((res) => {
      patchUpload(uid, {
        kind: res.kind,
        src: res.url,
        mime: res.mime || file.type,
        name: res.name || file.name,
        size: res.size ?? file.size,
        width: res.width ?? null,
        height: res.height ?? null,
        uploading: false,
        progress: 100,
        uploadError: '',
        uploadId: '',
      })
      // blob отпускаем с задержкой: браузер ещё дорисовывает кадр со старым src
      if (task.preview) setTimeout(() => URL.revokeObjectURL(task.preview), 5000)
    })
    .catch((e) => {
      const msg = uploadErrorText(e)
      // ноду могли удалить, пока грузилось — тогда покажем ошибку в тулбаре
      if (!patchUpload(uid, { uploading: false, uploadError: msg })) mediaError.value = msg
    })
}

function pickFiles(accept: string) {
  if (!canUpload.value) { mediaError.value = t('blog.editor.upload.notReady'); return }
  fileAccept.value = accept
  nextTick(() => fileEl.value?.click())
}
function onPickFiles(e: Event) {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files || [])
  input.value = '' // иначе повторный выбор того же файла не даёт change
  for (const f of files) insertUpload(f)
}

function openMediaDialog(tab: 'link' | 'library') {
  mediaDialogTab.value = tab
  mediaDialog.value = true
}
function onDialogInsert(attrs: Record<string, unknown>) {
  editor.chain().focus().setMedia(attrs).run()
}

/** выбор в плюс-меню: само меню ничего не вставляет, только сообщает, что нажали */
function onPlusAction(action: PlusAction) {
  if (action === 'image') pickFiles(MEDIA_ACCEPT.image)
  else if (action === 'video') pickFiles(MEDIA_ACCEPT.video)
  else if (action === 'attach') pickFiles(ATTACH_ACCEPT)
  else if (action === 'embed') openMediaDialog('link')
  else if (action === 'code') editor.chain().focus().toggleCodeBlock().run()
  else if (action === 'rule') editor.chain().focus().setHorizontalRule().run()
}

// --- вставленный URL ----------------------------------------------------------
const urlBusy = ref(false)
// когда ссылка не встраивается, решение за автором: карточка или обычная ссылка
const linkOffer = ref<{ url: string; data: any } | null>(null)

async function resolvePastedUrl(url: string) {
  urlBusy.value = true
  mediaError.value = ''
  try {
    const r = await api.blogMediaEmbed(url)
    if (r?.kind && r.kind !== 'link') {
      editor.chain().focus().setMedia({
        kind: r.kind, src: r.src || '', href: r.href || url, provider: r.provider || '',
        title: r.title || '', thumb: r.thumb || '', site: r.site || '', ratio: r.ratio ?? null,
      }).run()
    } else {
      linkOffer.value = { url, data: r || {} }
      insertPlainLink(url) // по умолчанию ведём себя как обычная вставка
    }
  } catch {
    insertPlainLink(url)
  } finally {
    urlBusy.value = false
  }
}
function insertPlainLink(url: string) {
  editor.chain().focus().insertContent(`<a href="${url.replace(/"/g, '&quot;')}">${url}</a>`).run()
}
/** заменить только что вставленную ссылку карточкой */
function acceptLinkCard() {
  const offer = linkOffer.value
  if (!offer) return
  linkOffer.value = null
  const d = offer.data || {}
  editor.chain().focus().undo().setMedia({
    kind: 'link', href: d.href || offer.url, title: d.title || '',
    desc: d.desc || '', thumb: d.thumb || '', site: d.site || '',
  }).run()
}

// --- «Магическая ручка» (правка выделения агентом) --------------------------
const panelEl = ref<HTMLElement>()
const aiRange = ref<{ from: number; to: number } | null>(null)
const aiHtml = ref('')
const aiPos = ref({ top: 0, left: 0 })
const aiOpen = computed(() => !!aiRange.value)

/**
 * HTML выделения. Если выделение внутри одного блока (openStart/openEnd > 0),
 * отдаём инлайн-HTML без обёртки <p> — иначе замена разорвала бы абзац.
 */
function selectionHtml(from: number, to: number): string {
  const slice = editor.state.doc.slice(from, to)
  const div = document.createElement('div')
  div.appendChild(DOMSerializer.fromSchema(editor.schema).serializeFragment(slice.content))
  if (slice.openStart > 0 && slice.openEnd > 0 && div.children.length === 1)
    return div.firstElementChild!.innerHTML
  return div.innerHTML
}

/**
 * Панель висит в body с position: fixed — редактор лежит внутри скроллящейся
 * секции с overflow-auto, и absolute-панель там просто обрезалась бы. Координаты
 * считаем от выделения: под ним, а если снизу не влезает — над ним; по краям
 * вьюпорта прижимаем с отступом.
 */
const PANEL_W = 460
const GAP = 8
function placePanel() {
  const r = aiRange.value
  if (!r) return
  const start = editor.view.coordsAtPos(r.from)
  const end = editor.view.coordsAtPos(r.to)
  const h = panelEl.value?.offsetHeight || 190
  const vw = window.innerWidth
  const vh = window.innerHeight
  let top = end.bottom + GAP
  if (top + h > vh - GAP) top = Math.max(GAP, start.top - h - GAP)
  aiPos.value = {
    top,
    left: Math.max(GAP, Math.min(start.left, vw - PANEL_W - GAP)),
  }
}

function openAi() {
  const { from, to } = editor.state.selection
  if (from === to) return
  aiHtml.value = selectionHtml(from, to)
  aiRange.value = { from, to }
  editor.view.dispatch(editor.state.tr.setMeta(aiKey, { from, to }))
  nextTick(placePanel)
}

function closeAi() {
  aiRange.value = null
  editor.view.dispatch(editor.state.tr.setMeta(aiKey, null))
}

/** заменить ИМЕННО выделенный фрагмент (пустой html = агент предложил удалить) */
function applyAi(html: string) {
  const r = aiRange.value
  if (!r) return
  closeAi()
  editor.chain().focus().insertContentAt({ from: r.from, to: r.to }, html || '').run()
}

function insertAi(html: string) {
  const r = aiRange.value
  if (!r) return
  closeAi()
  editor.chain().focus().insertContentAt(r.to, html).run()
}

// --- всплывающий тулбар ------------------------------------------------------
// Редактор лежит в скроллящейся секции (overflow-auto), которая режет тулбар по
// краям, — поэтому он живёт в body с fixed-позиционированием. Плагин пересчитывает
// его позицию по window resize и смене выделения, но не по скроллу внутренней
// секции: при скролле с активным выделением подталкиваем его сами (см. onScroll).
const bubbleOptions = shallowRef<Record<string, unknown> | null>(null)
const toBody = () => document.body

function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !aiRange.value) return
  // открыт селектор модели — Escape закрывает его, а не весь диалог
  if (document.querySelector('[data-slot="dropdown-menu-content"]')) return
  closeAi()
}
/** скролл любого контейнера: тянем за собой панель агента и тулбар */
function onScroll() {
  placePanel()
  // тулбар в body сам про этот скролл не знает — плагин слушает только resize
  if (!aiRange.value && !editor.state.selection.empty) window.dispatchEvent(new Event('resize'))
}

onMounted(() => {
  // опции плагин забирает один раз при регистрации, поэтому монтируем тулбар
  // только после того, как они посчитаны
  bubbleOptions.value = { placement: 'top', strategy: 'fixed', shift: { padding: 8 } }
  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', placePanel)
  window.addEventListener('scroll', onScroll, true)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('resize', placePanel)
  window.removeEventListener('scroll', onScroll, true)
  editor.destroy()
})
</script>

<template>
  <div class="article-editor">
    <BubbleMenu
      v-if="bubbleOptions" :editor="editor"
      :append-to="toBody" :options="bubbleOptions"
      :should-show="({ from, to }) => !aiOpen && from !== to"
      class="flex items-center gap-0.5 rounded-lg border border-border bg-popover p-1 shadow-xl"
      :class="{ 'bubble-off': aiOpen }"
    >
      <button type="button" class="ai-btn" @click="openAi">
        <PenTool :size="13" /> {{ $t('blog.editor.ai.title') }}
      </button>
      <span class="mx-0.5 h-4 w-px bg-border"></span>
      <button type="button" class="tb" :class="{ on: editor.isActive('bold') }" @click="editor.chain().focus().toggleBold().run()"><Bold :size="14" /></button>
      <button type="button" class="tb" :class="{ on: editor.isActive('italic') }" @click="editor.chain().focus().toggleItalic().run()"><Italic :size="14" /></button>
      <button type="button" class="tb" :class="{ on: editor.isActive('heading', { level: 2 }) }" @click="editor.chain().focus().toggleHeading({ level: 2 }).run()"><Heading2 :size="14" /></button>
      <button type="button" class="tb" :class="{ on: editor.isActive('bulletList') }" @click="editor.chain().focus().toggleBulletList().run()"><List :size="14" /></button>
      <button type="button" class="tb" :class="{ on: editor.isActive('orderedList') }" @click="editor.chain().focus().toggleOrderedList().run()"><ListOrdered :size="14" /></button>
      <button type="button" class="tb" :class="{ on: editor.isActive('blockquote') }" @click="editor.chain().focus().toggleBlockquote().run()"><Quote :size="14" /></button>
    </BubbleMenu>

    <!-- вход в медиа — плюс-меню на пустой строке (см. InsertPlusMenu ниже),
         поэтому над текстом остаётся только статус разбора вставленной ссылки -->
    <div v-if="urlBusy" class="mb-2 inline-flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
      <Loader2 :size="12" class="animate-spin" /> {{ $t('blog.editor.link.resolving') }}
    </div>

    <!-- ссылка не встроилась: по умолчанию она уже вставлена обычной, но
         предлагаем заменить карточкой, пока автор не ушёл дальше -->
    <div v-if="linkOffer" class="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-[12px]">
      <Link2 :size="13" class="shrink-0 text-muted-foreground" />
      <span class="min-w-0 flex-1 truncate text-muted-foreground">{{ $t('blog.editor.link.noEmbed') }}</span>
      <button type="button" class="shrink-0 rounded-md border border-border px-2 py-0.5 transition hover:bg-surface-hover" @click="acceptLinkCard">{{ $t('blog.editor.link.asCard') }}</button>
      <button type="button" class="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:text-foreground" @click="linkOffer = null"><XIcon :size="12" /></button>
    </div>

    <div v-if="mediaError" class="mb-2 flex items-start gap-2 rounded-lg border border-warning/25 bg-warning-soft px-2.5 py-1.5 text-[12px] text-warning">
      <TriangleAlert :size="13" class="mt-0.5 shrink-0" />
      <span class="min-w-0 flex-1">{{ mediaError }}</span>
      <button type="button" class="grid size-8 shrink-0 place-items-center rounded-md hover:bg-warning-soft" @click="mediaError = ''"><XIcon :size="12" /></button>
    </div>

    <EditorContent :editor="editor" />

    <!-- после EditorContent, чтобы Tab из текста попадал на «+», а не наоборот;
         визуально кнопка всё равно слева от строки (position: absolute) -->
    <InsertPlusMenu :editor="editor" @action="onPlusAction" />

    <input ref="fileEl" type="file" multiple class="hidden" :accept="fileAccept" @change="onPickFiles">

    <MediaInsertDialog
      v-model:open="mediaDialog" :run-id="props.runId || ''" :initial-tab="mediaDialogTab"
      @insert="onDialogInsert"
    />

    <Teleport to="body">
      <div v-if="aiOpen" ref="panelEl" class="fixed z-50" :style="{ top: `${aiPos.top}px`, left: `${aiPos.left}px` }">
        <AiEditPanel
          :html="aiHtml" :title="props.title"
          @apply="applyAi" @insert="insertAi" @close="closeAi" @resize="placePanel"
        />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
/* система отсчёта для плюс-меню: оно абсолютное и уходит левее колонки */
.article-editor { position: relative; }

.tb {
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  color: var(--muted-foreground);
  transition: background .12s, color .12s;
}
.tb:hover { background: var(--surface-hover); color: var(--foreground); }
.tb.on { background: var(--foreground); color: var(--background); }

/* «Магическая ручка» — единственная текстовая кнопка в ряду, ведёт тулбар */
.ai-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 8px;
  border-radius: 6px;
  font-size: 12.5px;
  color: var(--foreground);
  transition: background .12s;
}
.ai-btn:hover { background: var(--surface-hover); }

/* пока открыта панель агента, тулбар прячем: плагин bubble-menu ставит
   visibility инлайном, поэтому только !important его перебивает */
.bubble-off { visibility: hidden !important; }

/* подсветка фрагмента, пока открыта панель агента (нативное выделение снято).
   Токены темы — oklch, поэтому прозрачность через color-mix, а не hsl(var/α) */
.article-editor :deep(.ai-sel) {
  background: color-mix(in srgb, var(--brand-accent) 34%, transparent);
  border-radius: 2px;
}

/* типографика тела статьи — читаемая колонка, как в превью поста */
.article-editor :deep(.article-prose) {
  font-size: 15.5px;
  line-height: 1.75;
  color: color-mix(in srgb, var(--foreground) 92%, transparent);
}
.article-editor :deep(.article-prose > * + *) { margin-top: 1.1em; }
.article-editor :deep(.article-prose h1) { font-size: 27px; font-weight: 700; letter-spacing: -.02em; line-height: 1.2; margin-top: 1.4em; }
.article-editor :deep(.article-prose h2) { font-size: 20px; font-weight: 700; letter-spacing: -.01em; line-height: 1.3; margin-top: 1.6em; }
.article-editor :deep(.article-prose h3) { font-size: 17px; font-weight: 600; margin-top: 1.4em; }
.article-editor :deep(.article-prose ul) { list-style: disc; padding-left: 1.4em; }
.article-editor :deep(.article-prose ul li::marker) { color: var(--brand-accent); }
.article-editor :deep(.article-prose ol) { list-style: decimal; padding-left: 1.4em; }
.article-editor :deep(.article-prose ol li::marker) { color: var(--brand-accent); font-weight: 600; }
.article-editor :deep(.article-prose li) { margin-top: .35em; }
.article-editor :deep(.article-prose li > p) { margin: 0; }
.article-editor :deep(.article-prose a) { color: var(--brand-accent); text-decoration: underline; text-decoration-color: var(--brand-accent-soft); text-underline-offset: 2px; }
.article-editor :deep(.article-prose blockquote) { border-left: 3px solid var(--border); padding-left: 1em; color: var(--muted-foreground); font-style: italic; }
.article-editor :deep(.article-prose code) { font-family: ui-monospace, monospace; font-size: .9em; background: var(--surface-2); padding: .1em .35em; border-radius: 4px; }
/* блок кода и разделитель — оба доступны из плюс-меню, значит должны быть
   оформлены и в редакторе, а не только в опубликованной статье */
.article-editor :deep(.article-prose pre) {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: .85em 1em;
  overflow-x: auto;
  font-family: ui-monospace, monospace;
  font-size: 13px;
  line-height: 1.6;
}
.article-editor :deep(.article-prose pre code) { background: none; padding: 0; font-size: inherit; }
.article-editor :deep(.article-prose hr) { border: 0; border-top: 1px solid var(--border); margin: 2em 0; }
.article-editor :deep(.article-prose hr.ProseMirror-selectednode) { border-top-color: var(--brand-accent); }

/* Геометрия медиа-блоков живёт в media/media.css (общая с превью статьи);
   здесь — только то, что перебивает типографику колонки. Правило
   `.article-prose > * + *` иначе схлопывает отбивку figure до 1.1em. */
.article-editor :deep(.article-prose .bw-media) { margin-top: 1.7em; margin-bottom: 1.7em; }
.article-editor :deep(.article-prose .bw-media a) { text-decoration: none; }
/* курсор-щель перед/после медиа: без неё блок в конце статьи не обойти */
.article-editor :deep(.ProseMirror-gapcursor:after) { border-top-color: var(--foreground); }

.article-editor :deep(.article-prose p.is-editor-empty:first-child::before) {
  content: attr(data-placeholder);
  color: color-mix(in srgb, var(--muted-foreground) 50%, transparent);
  float: left;
  height: 0;
  pointer-events: none;
}
</style>
