<script setup lang="ts">
// Студия обложек: холст с объектами (тащи мышью, дабл-клик по тексту), шаблоны,
// фон/градиент/AI-фон, экспорт PNG и сохранение обложкой статьи
// (POST /blogwriter/runs/:id/cover-save, JPEG собирается в браузере).
//
// Один и тот же компонент работает страницей (/blog/preview) и модалкой внутри
// статьи: из статьи уводить в отдельный раздел нельзя — автор теряет контекст
// правки. В модалке статья-цель задана пропом runId, поэтому её выбор скрыт.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  Bookmark, Check, ChevronDown, Download, Image as ImageIcon, ImagePlus, LayoutGrid,
  Loader2, Redo2, Square, Type, Undo2,
} from 'lucide-vue-next'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import PreviewCanvas from '@/components/preview/PreviewCanvas.vue'
import PreviewInspector from '@/components/preview/PreviewInspector.vue'
import PreviewSceneGallery from '@/components/preview/PreviewSceneGallery.vue'
import { SIZES } from '@/lib/preview/sizes'
import { sceneFontsHref, type SceneTemplate } from '@/lib/preview/scenes'
import { useSceneStudio, type SavedScene } from '@/composables/useSceneStudio'
import { useBlogRuns } from '@/composables/useBlogRuns'
import { api } from '@/lib/api'

const props = defineProps<{
  /** статья-цель задана снаружи (модалка из статьи) — выбор статьи прячем */
  runId?: string
  /** заголовок для подстановки в самый крупный текст сцены */
  title?: string
  /** режим модалки: без крупной шапки раздела (её рисует диалог) */
  embedded?: boolean
}>()
const emit = defineEmits<{ (e: 'saved', coverUrl: string): void }>()

const { t } = useI18n()
const route = useRoute()
const { state: runsState, load: loadRuns } = useBlogRuns()
const {
  scene, selectedId, templates, activeTplId, myScenes, rendering, commit,
  loadTemplate, loadScene, deleteScene, saveScene,
  addText, addBlock, addImage, fillHeadline, setSize, downloadPng, toJpegBlob,
  undo, redo, canUndo, canRedo, removeSelected, duplicate, nudge, forward, backward,
} = useSceneStudio()

// шрифты шаблонов — <link> в head (в SPA нет useHead; чистим при уходе)
let fontLink: HTMLLinkElement | null = null
onMounted(() => {
  fontLink = document.createElement('link')
  fontLink.rel = 'stylesheet'
  fontLink.href = sceneFontsHref()
  document.head.appendChild(fontLink)
  // цель: проп (модалка из статьи) → ?run=<id> (пришли из статьи ссылкой)
  if (props.runId) pickTarget(props.runId, props.title || '')
  const rid = props.runId || String(route.query.run || '')
  loadRuns().then(() => {
    if (!rid) return
    const r = runsState.runs.find((x) => x.id === rid)
    if (r) pickTarget(r.id, props.title || r.title || r.topic)
  }).catch(() => {})
})
onBeforeUnmount(() => { fontLink?.remove(); window.removeEventListener('keydown', onHotkey) })

/* ---------------------------------------------------------- статья-цель */
const targetId = ref('')
const target = computed(() => runsState.runs.find((r) => r.id === targetId.value) || null)
const saving = ref(false)
const savedCover = ref(false)
const coverError = ref('')

function pickTarget(id: string, title: string) {
  targetId.value = id
  savedCover.value = false
  coverError.value = ''
  fillHeadline(title)
}

// Сцена и её история — модульный синглтон (одна студия на приложение), поэтому
// при открытии модалки из ДРУГОЙ статьи на холсте оставалась чужая обложка и
// чужой undo-стек. Смена статьи-цели = чистый дефолтный шаблон.
watch(() => props.runId, (id) => {
  if (!id) return
  loadTemplate(templates[0]!)
  pickTarget(id, props.title || '')
})

/** Собрать JPEG в браузере и положить его обложкой статьи. */
async function saveAsCover() {
  if (!targetId.value || saving.value) return
  saving.value = true
  coverError.value = ''
  try {
    const { coverUrl } = await api.blogSaveCover(targetId.value, await toJpegBlob())
    const run = runsState.runs.find((r) => r.id === targetId.value)
    if (run) run.coverUrl = coverUrl
    savedCover.value = true
    emit('saved', coverUrl)
    setTimeout(() => (savedCover.value = false), 2200)
  } catch (e: any) {
    coverError.value = e?.status === 402 || e?.status === 403
      ? t('preview.cover.errorForbidden')
      : t('preview.cover.error')
  } finally {
    saving.value = false
  }
}

/* ---------------------------------------------------------- шаблоны/файлы */
const galleryOpen = ref(false)
function onPick(tpl: SceneTemplate) { galleryOpen.value = false; loadTemplate(tpl); if (target.value) fillHeadline(target.value.title || target.value.topic) }
function onPickMy(tpl: SavedScene) { galleryOpen.value = false; loadScene(tpl) }

// у встроенного шаблона в данных лежит ключ, у «моего» — имя, которое дал автор
const activeName = computed(() => {
  const tpl = templates.find((x) => x.id === activeTplId.value)
  if (tpl) return t(tpl.nameKey)
  return myScenes.value.find((x) => x.id === activeTplId.value)?.name || t('preview.customDesign')
})

const imgInput = ref<HTMLInputElement | null>(null)
function onImageFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return
  const fr = new FileReader(); fr.onload = () => addImage(fr.result as string); fr.readAsDataURL(f)
  ;(e.target as HTMLInputElement).value = ''
}

const savedFlash = ref(false)
const saveError = ref('')
let flashT: any = null
/** Шаблон уходит на сервер — «Сохранено» показываем только по факту записи. */
async function onSaveTemplate() {
  saveError.value = ''
  const saved = await saveScene()
  if (!saved) { saveError.value = t('preview.template.saveError'); return }
  savedFlash.value = true
  clearTimeout(flashT); flashT = setTimeout(() => (savedFlash.value = false), 1600)
}

/* ---------------------------------------------------------- хоткеи */
function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}
function onHotkey(e: KeyboardEvent) {
  if (isTyping(e.target)) return
  const meta = e.metaKey || e.ctrlKey
  if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return }
  if (meta && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicate(); return }
  if (meta && e.key === ']') { e.preventDefault(); forward(); return }
  if (meta && e.key === '[') { e.preventDefault(); backward(); return }
  if (e.key === 'Delete' || e.key === 'Backspace') { if (selectedId.value) { e.preventDefault(); removeSelected() } return }
  if (e.key === 'Escape') { selectedId.value = ''; return }
  if (e.key.startsWith('Arrow') && selectedId.value) {
    e.preventDefault()
    const d = e.shiftKey ? 10 : 1
    nudge(e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0)
    commit()
  }
}
onMounted(() => window.addEventListener('keydown', onHotkey))
</script>

<template>
  <!-- @container: раскладка считается по ширине КОНТЕЙНЕРА, иначе в модалке
       колонки берут брейкпоинт экрана и наезжают друг на друга -->
  <div class="@container" :class="embedded ? '' : 'p-5 lg:p-6'">
    <!-- шапка -->
    <div class="mb-4 flex flex-wrap items-center gap-2.5">
      <div v-if="!embedded" class="min-w-0">
        <h1 class="flex items-center gap-2 text-[21px] font-semibold tracking-tight">
          <ImageIcon :size="19" class="text-muted-foreground" /> {{ $t('preview.title') }}
        </h1>
        <p class="mt-0.5 text-[12.5px] text-muted-foreground">
          {{ activeName }} · {{ scene.width }}×{{ scene.height }} · {{ $t('preview.hint.header') }}
        </p>
      </div>

      <div class="ml-auto flex flex-wrap items-center gap-2">
        <div class="mr-1 flex items-center gap-0.5">
          <button type="button" class="btn-icon" :title="$t('preview.toolbar.undo')" :disabled="!canUndo" @click="undo"><Undo2 :size="15" /></button>
          <button type="button" class="btn-icon" :title="$t('preview.toolbar.redo')" :disabled="!canRedo" @click="redo"><Redo2 :size="15" /></button>
        </div>

        <!-- формат холста -->
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button type="button" class="btn-ghost">{{ scene.width }}×{{ scene.height }} <ChevronDown :size="14" class="opacity-60" /></button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-60">
            <DropdownMenuItem v-for="s in SIZES" :key="s.id" class="justify-between gap-3" :title="$t(s.hintKey)" @click="setSize(s.w, s.h)">
              <span class="text-[12.5px]">{{ $t(s.labelKey) }}</span>
              <span class="text-[11px] tabular-nums text-muted-foreground">{{ s.w }}×{{ s.h }}</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <button type="button" class="btn-ghost" @click="onSaveTemplate">
          <!-- «Сохранить» рядом с «Сохранить обложкой» читалось как сохранение
               статьи — подписываем явно, что уедет в шаблоны -->
          <component :is="savedFlash ? Check : Bookmark" :size="15" /> {{ savedFlash ? $t('preview.toolbar.saved') : $t('preview.toolbar.saveTemplate') }}
        </button>
        <button type="button" class="btn-ghost" @click="galleryOpen = true"><LayoutGrid :size="15" /> {{ $t('preview.toolbar.templates') }}</button>
        <button type="button" class="btn-ghost" :disabled="rendering" @click="downloadPng">
          <component :is="rendering ? Loader2 : Download" :size="15" :class="rendering && 'animate-spin'" /> PNG
        </button>

        <!-- обложка статьи -->
        <DropdownMenu v-if="!runId">
          <DropdownMenuTrigger as-child>
            <button type="button" class="btn-ghost max-w-[230px]">
              <span class="truncate">{{ target ? (target.title || target.topic) : $t('preview.target.pick') }}</span>
              <ChevronDown :size="14" class="shrink-0 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="max-h-80 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto">
            <DropdownMenuLabel class="text-[11px] uppercase tracking-wide text-muted-foreground">{{ $t('preview.target.groupLabel') }}</DropdownMenuLabel>
            <DropdownMenuItem v-if="!runsState.runs.length" disabled class="text-[12.5px] text-muted-foreground">{{ $t('preview.target.empty') }}</DropdownMenuItem>
            <DropdownMenuItem
              v-for="r in runsState.runs" :key="r.id" class="justify-between gap-2"
              @click="pickTarget(r.id, r.title || r.topic)"
            >
              <span class="truncate text-[12.5px]">{{ r.title || r.topic }}</span>
              <Check v-if="targetId === r.id" :size="13" class="shrink-0" />
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button" class="btn-dark" :disabled="!targetId || saving || rendering"
          :title="targetId ? $t('preview.cover.hint') : $t('preview.cover.hintNoRun')"
          @click="saveAsCover"
        >
          <component :is="saving ? Loader2 : savedCover ? Check : ImageIcon" :size="15" :class="saving && 'animate-spin'" />
          {{ saving ? $t('preview.cover.saving') : savedCover ? $t('action.done') : $t('preview.cover.action') }}
        </button>
      </div>
    </div>

    <p v-if="coverError || saveError" class="mb-3 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{{ coverError || saveError }}</p>

    <!-- студия: холст | инспектор -->
    <div class="grid items-start gap-4 @4xl:grid-cols-[1fr_320px]">
      <div class="min-w-0">
        <div class="mb-2 flex flex-wrap items-center gap-1.5">
          <button type="button" class="tool" @click="addText"><Type :size="14" /> {{ $t('preview.tool.text') }}</button>
          <button type="button" class="tool" @click="addBlock"><Square :size="14" /> {{ $t('preview.tool.shape') }}</button>
          <button type="button" class="tool" @click="imgInput?.click()"><ImagePlus :size="14" /> {{ $t('preview.tool.image') }}</button>
          <input ref="imgInput" type="file" accept="image/*" class="hidden" @change="onImageFile">
          <span class="ml-2 hidden text-[11.5px] text-muted-foreground/60 @2xl:inline">
            {{ $t('preview.hint.canvas') }}
          </span>
        </div>

        <div class="grid place-items-center rounded-2xl border border-border bg-surface p-4 sm:p-6">
          <div class="w-full select-none overflow-hidden rounded-md shadow-2xl shadow-black/40" :style="{ maxWidth: scene.height > scene.width ? '340px' : '100%' }">
            <PreviewCanvas v-model:selected-id="selectedId" :scene="scene" @changed="commit" />
          </div>
        </div>
      </div>

      <div class="rounded-2xl border border-border bg-surface p-4 @4xl:sticky @4xl:top-4 @4xl:max-h-[calc(100dvh-2rem)] @4xl:overflow-y-auto">
        <PreviewInspector />
      </div>
    </div>

    <PreviewSceneGallery
      v-if="galleryOpen" :active-id="activeTplId" :my-scenes="myScenes"
      @pick="onPick" @pick-my="onPickMy" @delete-my="deleteScene" @close="galleryOpen = false"
    />
  </div>
</template>

<style scoped>
.btn-dark { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 13px; border-radius: var(--radius-lg); font-size: 13px; font-weight: 600; background: var(--foreground); color: var(--background); transition: .15s; }
.btn-dark:hover:not(:disabled) { opacity: .9; }
.btn-dark:disabled { opacity: .45; }
.btn-ghost { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 11px; border-radius: var(--radius-lg); font-size: 13px; font-weight: 500; color: var(--muted-foreground); border: 1px solid var(--border); transition: .15s; }
.btn-ghost:hover:not(:disabled) { color: var(--foreground); background: var(--surface-hover); }
.btn-ghost:disabled { opacity: .5; }
.btn-icon { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 34px; border-radius: var(--radius-md); color: var(--muted-foreground); border: 1px solid var(--border); }
.btn-icon:hover:not(:disabled) { color: var(--foreground); background: var(--surface-hover); }
.btn-icon:disabled { opacity: .4; }
.tool { display: inline-flex; align-items: center; gap: 5px; padding: 6px 11px; border-radius: var(--radius-md); font-size: 12.5px; font-weight: 600; background: var(--surface); color: var(--foreground); }
.tool:hover { background: var(--surface-hover); }
</style>
