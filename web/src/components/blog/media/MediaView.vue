<script setup lang="ts">
/**
 * NodeView медиа-блока. Рисует ровно тот же <figure class="bw-media …">, что
 * уходит в body_html (стили общие, media.css), плюс редакторскую обвязку:
 * тулбар по ховеру, редактируемую подпись и состояние загрузки.
 *
 * Тулбар и подпись живут ВНУТРИ figure, но с contenteditable="false" — иначе
 * ProseMirror считает их частью документа и они попадают в getHTML().
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NodeViewWrapper, nodeViewProps } from '@tiptap/vue-3'
import {
  ExternalLink, FileText, GripVertical, Link2, Loader2, Maximize, RefreshCw, Trash2,
  TriangleAlert, Type,
} from 'lucide-vue-next'
import { api } from '@/lib/api'
import { MEDIA_ACCEPT, formatSize, useMediaUpload } from '@/composables/useMediaUpload'
import type { MediaAlign } from './MediaNode'

const props = defineProps(nodeViewProps)

const { t } = useI18n()
const a = computed<any>(() => props.node.attrs)
const kind = computed<string>(() => a.value.kind || 'image')
const uploading = computed(() => !!a.value.uploading)

// runId лежит в storage расширения: редактор один на все локали статьи, и при
// смене :id опции ноды уже не переписать — storage переписывается свободно
const runId = computed<string>(() => String((props.editor.storage as any)?.media?.runId || ''))

const ALIGN_VALUES: MediaAlign[] = ['center', 'wide', 'full']
const ALIGNS = computed(() => ALIGN_VALUES.map((v) => ({ v, label: t(`blog.editor.align.${v}`) })))
function setAlign(v: MediaAlign) { props.updateAttributes({ align: v }) }

// --- подпись -----------------------------------------------------------------
const capOpen = ref(false)
const showCaption = computed(() => capOpen.value || !!String(a.value.caption || '').trim())
function onCaption(e: Event) {
  props.updateAttributes({ caption: (e.target as HTMLInputElement).value })
}

// --- замена загруженного файла ------------------------------------------------
const fileEl = ref<HTMLInputElement>()
const { busy: replBusy, progress: replProgress, error: replError, upload } = useMediaUpload()
const acceptFor = computed(() => (MEDIA_ACCEPT as any)[kind.value] || '')

function pickReplacement() {
  if (!runId.value) return
  fileEl.value?.click()
}
async function onPick(e: Event) {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // чтобы повторный выбор того же файла снова сработал
  if (!file) return
  const res = await upload(runId.value, file)
  if (!res) return
  props.updateAttributes({
    kind: res.kind, src: res.url, mime: res.mime || '', name: res.name || '',
    size: res.size ?? null, width: res.width ?? null, height: res.height ?? null,
    href: '', provider: '', ratio: null,
  })
}

// --- замена ссылки/встраивания -------------------------------------------------
// Для embed/link «Заменить» — это другая ссылка, а не файл: поле раскрывается
// прямо в блоке, чтобы не тащить пользователя в модалку ради одной правки.
const urlOpen = ref(false)
const urlValue = ref('')
const urlBusy = ref(false)
const urlError = ref('')
async function applyUrl() {
  const u = urlValue.value.trim()
  if (!u || urlBusy.value) return
  urlBusy.value = true
  urlError.value = ''
  try {
    const r = await api.blogMediaEmbed(u)
    props.updateAttributes({
      kind: r.kind, src: r.src || '', href: r.href || u, provider: r.provider || '',
      title: r.title || '', desc: r.desc || '', thumb: r.thumb || '', site: r.site || '',
      ratio: r.ratio ?? null,
    })
    urlOpen.value = false
    urlValue.value = ''
  } catch (e: any) {
    // сообщение бэка приходит готовым — его не переводим
    urlError.value = e?.serverMessage || t('blog.editor.media.errorResolve')
  } finally {
    urlBusy.value = false
  }
}

const canReplaceFile = computed(() => ['image', 'video', 'audio', 'file'].includes(kind.value) && !!runId.value)
const embedStyle = computed(() => ({ paddingBottom: `${Number(a.value.ratio) || 56.25}%` }))
const fileMeta = computed(() => {
  const ext = String(a.value.name || a.value.src || '').toLowerCase().match(/\.([a-z0-9]{1,6})(?:$|\?)/)?.[1] || ''
  return [ext.toUpperCase(), formatSize(Number(a.value.size) || 0)].filter(Boolean).join(' · ')
})
</script>

<template>
  <NodeViewWrapper
    as="figure"
    class="bw-media bw-node"
    :class="[`bw-media--${kind}`, { 'is-selected': props.selected }]"
    :data-kind="kind"
    :data-align="a.align && a.align !== 'center' ? a.align : null"
  >
    <!-- превью по виду ------------------------------------------------------->
    <img v-if="kind === 'image'" :src="a.src" :alt="a.alt || a.caption || ''" draggable="false">

    <video v-else-if="kind === 'video'" :src="a.src" controls preload="metadata" playsinline></video>

    <audio v-else-if="kind === 'audio'" :src="a.src" controls preload="metadata"></audio>

    <div v-else-if="kind === 'embed'" class="bw-embed" :style="embedStyle">
      <iframe :src="a.src" :title="a.title || ''" loading="lazy" frameborder="0" allowfullscreen></iframe>
      <!-- пока блок не выделен, щит перехватывает клик: иначе по видео нельзя
           попасть курсором, чтобы его выделить, перетащить или удалить -->
      <span v-if="!props.selected" class="shield" contenteditable="false"></span>
    </div>

    <div v-else-if="kind === 'file'" class="bw-file" contenteditable="false">
      <span class="bw-file__name"><FileText :size="14" class="inline align-[-2px] mr-1.5 opacity-60" />{{ a.name || $t('blog.editor.media.file') }}</span>
      <span class="bw-file__meta">{{ fileMeta || $t('blog.editor.media.file') }}</span>
    </div>

    <div v-else class="bw-linkcard" contenteditable="false">
      <img v-if="a.thumb" class="bw-linkcard__thumb" :src="a.thumb" alt="" loading="lazy">
      <span class="bw-linkcard__body">
        <span class="bw-linkcard__title">{{ a.title || a.site || a.href }}</span>
        <span v-if="a.desc" class="bw-linkcard__desc">{{ a.desc }}</span>
        <span v-if="a.site" class="bw-linkcard__site">{{ a.site }}</span>
      </span>
      <a v-if="a.href" class="card-open" :href="a.href" target="_blank" rel="noopener nofollow" :title="$t('blog.editor.media.openLink')" @click.stop>
        <ExternalLink :size="13" />
      </a>
    </div>

    <!-- загрузка --------------------------------------------------------------->
    <div v-if="uploading || replBusy" class="veil" contenteditable="false">
      <Loader2 :size="16" class="animate-spin" />
      <span class="veil__txt">{{ $t('blog.editor.media.uploading', { n: replBusy ? replProgress : (a.progress || 0) }) }}</span>
      <span class="veil__bar"><i :style="{ width: `${replBusy ? replProgress : (a.progress || 0)}%` }"></i></span>
    </div>

    <p v-if="a.uploadError || replError" class="err" contenteditable="false">
      <TriangleAlert :size="13" class="shrink-0" /> {{ a.uploadError || replError }}
    </p>

    <!-- подпись --------------------------------------------------------------->
    <figcaption v-if="showCaption" contenteditable="false">
      <input
        :value="a.caption" :placeholder="$t('blog.editor.media.captionPlaceholder')" class="cap-input"
        @input="onCaption" @keydown.stop @paste.stop @mousedown.stop
      >
    </figcaption>

    <!-- тулбар ---------------------------------------------------------------->
    <!-- mousedown только .stop, без .prevent: preventDefault убил бы dragstart,
         а перетаскивание блока живёт на ручке ниже -->
    <div class="tools" contenteditable="false" @mousedown.stop>
      <!-- TipTap разрешает drag только от элемента с data-drag-handle -->
      <span class="t grip" data-drag-handle :title="$t('blog.editor.media.drag')"><GripVertical :size="13" /></span>
      <span class="sep"></span>
      <button
        v-for="al in ALIGNS" :key="al.v" type="button" class="t" :class="{ on: (a.align || 'center') === al.v }"
        :title="al.label" @click="setAlign(al.v)"
      >
        <span v-if="al.v === 'center'" class="ico-align ico-align--c"></span>
        <span v-else-if="al.v === 'wide'" class="ico-align ico-align--w"></span>
        <Maximize v-else :size="12" />
      </button>
      <span class="sep"></span>
      <button type="button" class="t" :class="{ on: showCaption }" :title="$t('blog.editor.media.caption')" @click="capOpen = !capOpen"><Type :size="13" /></button>
      <button v-if="canReplaceFile" type="button" class="t" :title="$t('blog.editor.media.replaceFile')" @click="pickReplacement"><RefreshCw :size="13" /></button>
      <button v-else type="button" class="t" :class="{ on: urlOpen }" :title="$t('blog.editor.media.otherLink')" @click="urlOpen = !urlOpen"><Link2 :size="13" /></button>
      <span class="sep"></span>
      <button type="button" class="t t--danger" :title="$t('action.delete')" @click="props.deleteNode()"><Trash2 :size="13" /></button>
    </div>

    <!-- поле «другая ссылка» ---------------------------------------------------->
    <div v-if="urlOpen" class="urlbar" contenteditable="false" @mousedown.stop>
      <input
        v-model="urlValue" placeholder="https://…" class="urlbar__in"
        @keydown.stop.enter="applyUrl" @paste.stop
      >
      <button type="button" class="urlbar__go" :disabled="urlBusy || !urlValue.trim()" @click="applyUrl">
        <Loader2 v-if="urlBusy" :size="12" class="animate-spin" /> {{ $t('blog.editor.media.apply') }}
      </button>
      <span v-if="urlError" class="urlbar__err">{{ urlError }}</span>
    </div>

    <input ref="fileEl" type="file" class="hidden" :accept="acceptFor" @change="onPick">
  </NodeViewWrapper>
</template>

<style scoped>
/* Базовая геометрия блока приходит из media.css (глобально) — тут только то,
   что существует исключительно в редакторе. */
.bw-node { outline: 2px solid transparent; outline-offset: 3px; border-radius: 12px; transition: outline-color .12s; }
.bw-node.is-selected { outline-color: color-mix(in srgb, var(--brand-accent) 70%, transparent); }

.shield { position: absolute; inset: 0; cursor: grab; }

/* тулбар: показываем по ховеру и когда блок выделен */
.tools {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--popover);
  box-shadow: 0 8px 24px rgb(0 0 0 / .28);
  opacity: 0;
  pointer-events: none;
  transition: opacity .12s;
}
.bw-node:hover .tools,
.bw-node.is-selected .tools { opacity: 1; pointer-events: auto; }

.t {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 5px;
  color: var(--muted-foreground);
  transition: background .12s, color .12s;
}
.t:hover { background: var(--surface-hover); color: var(--foreground); }
.t.on { background: var(--foreground); color: var(--background); }
.t--danger:hover { background: var(--danger-soft); color: var(--danger); }
.grip { cursor: grab; }
.grip:active { cursor: grabbing; }
.sep { width: 1px; height: 14px; background: var(--border); margin: 0 1px; }

/* пиктограммы выравнивания рисуем сами: в наборе нет «обычная/широкая» */
.ico-align { display: block; height: 11px; border-radius: 2px; background: currentColor; }
.ico-align--c { width: 8px; }
.ico-align--w { width: 13px; }

/* подпись — инпут без рамки, визуально это тот же figcaption */
.cap-input {
  width: 100%;
  background: transparent;
  border: 0;
  outline: none;
  text-align: center;
  font: inherit;
  color: inherit;
}
.cap-input::placeholder { color: color-mix(in srgb, currentColor 45%, transparent); }

/* прогресс поверх превью */
.veil {
  position: absolute;
  inset: 0;
  z-index: 3;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-radius: 12px;
  background: color-mix(in srgb, var(--background) 72%, transparent);
  backdrop-filter: blur(2px);
  color: var(--muted-foreground);
  font-size: 12.5px;
}
.veil__bar { width: min(220px, 60%); height: 3px; border-radius: 3px; background: var(--surface-hover); overflow: hidden; }
.veil__bar > i { display: block; height: 100%; background: var(--foreground); transition: width .18s; }

.err {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--danger);
}

.urlbar {
  position: relative;
  z-index: 2;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--popover);
}
.urlbar__in {
  flex: 1 1 220px;
  height: 28px;
  min-width: 0;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--background);
  font-size: 12.5px;
  color: var(--foreground);
  outline: none;
}
.urlbar__in:focus { border-color: var(--ring); }
.urlbar__go {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 10px;
  border-radius: 7px;
  background: var(--foreground);
  color: var(--background);
  font-size: 12.5px;
  font-weight: 500;
}
.urlbar__go:disabled { opacity: .45; }
.urlbar__err { flex: 1 0 100%; font-size: 11.5px; color: var(--danger); }

/* «открыть» на карточке ссылки: в редакторе сама карточка не кликабельна */
.card-open {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--muted-foreground);
  background: color-mix(in srgb, var(--background) 70%, transparent);
}
.card-open:hover { color: var(--foreground); }
</style>
