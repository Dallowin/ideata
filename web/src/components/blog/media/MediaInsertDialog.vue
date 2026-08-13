<script setup lang="ts">
/**
 * Вставка медиа не из файла: ссылка/встраивание и повторная вставка того, что
 * уже загружено в эту статью. Две вкладки в одной модалке, а не два разных
 * диалога, — пользователь редко знает заранее, лежит ли нужная картинка в
 * библиотеке или её проще притащить ссылкой.
 *
 * Предпросмотр рисуем теми же классами .bw-*, что и тело статьи (media.css),
 * чтобы «что вижу — то и вставится» было буквальным.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { FileText, ImageOff, Link2, Loader2, Trash2 } from 'lucide-vue-next'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { api, type MediaAsset, type MediaEmbed } from '@/lib/api'
import { formatSize } from '@/composables/useMediaUpload'
import './media.css'

const props = defineProps<{ open: boolean; runId: string; initialTab?: 'link' | 'library' }>()
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'insert', attrs: Record<string, unknown>): void
}>()

const { t } = useI18n()
const tab = ref<'link' | 'library'>('link')

// --- ссылка / встраивание -----------------------------------------------------
const url = ref('')
const resolving = ref(false)
const resolved = ref<MediaEmbed | null>(null)
const linkError = ref('')

async function resolve() {
  const u = url.value.trim()
  if (!u || resolving.value) return
  resolving.value = true
  linkError.value = ''
  resolved.value = null
  try {
    resolved.value = await api.blogMediaEmbed(u)
  } catch (e: any) {
    // сообщение бэка приходит готовым — его не переводим
    linkError.value = e?.serverMessage
      || (e?.status === 402 ? t('blog.editor.mediaDialog.errorPlan') : t('blog.editor.media.errorResolve'))
  } finally {
    resolving.value = false
  }
}

const KINDS = ['embed', 'image', 'video', 'audio', 'file', 'link']
/** подпись вида блока; неизвестный вид с бэка показываем как есть */
const kindLabel = (k: string) => (KINDS.includes(k) ? t(`blog.editor.kind.${k}`) : k)
const previewRatio = computed(() => `${Number(resolved.value?.ratio) || 56.25}%`)

function insertResolved() {
  const r = resolved.value
  if (!r) return
  emit('insert', {
    kind: r.kind,
    src: r.src || '',
    href: r.href || url.value.trim(),
    provider: r.provider || '',
    title: r.title || '',
    desc: r.desc || '',
    thumb: r.thumb || '',
    site: r.site || '',
    ratio: r.ratio ?? null,
  })
  close()
}

/** карточкой вместо встраивания — когда встраивание есть, но не к месту */
function insertAsCard() {
  const r = resolved.value
  if (!r) return
  emit('insert', {
    kind: 'link',
    href: r.href || url.value.trim(),
    title: r.title || '',
    desc: r.desc || '',
    thumb: r.thumb || '',
    site: r.site || '',
  })
  close()
}

// --- библиотека статьи ---------------------------------------------------------
const items = ref<MediaAsset[]>([])
const libLoading = ref(false)
const libError = ref('')
/** ошибка удаления — отдельно от ошибки загрузки: список при ней остаётся виден */
const removeError = ref('')
const picked = ref<MediaAsset | null>(null)

async function loadLibrary() {
  if (!props.runId) return
  libLoading.value = true
  libError.value = ''
  try {
    const r = await api.blogMediaList(props.runId)
    items.value = r?.items || []
  } catch {
    libError.value = t('blog.editor.mediaDialog.libraryError')
  } finally {
    libLoading.value = false
  }
}

async function removeItem(it: MediaAsset) {
  // Файл может быть уже вставлен в текст — предупреждаем честно, иначе
  // «удалил из библиотеки» и «в статье битая картинка» никак не связаны.
  if (!window.confirm(t('blog.editor.mediaDialog.confirmDelete', { name: it.name || it.url }))) return
  removeError.value = ''
  try {
    await api.blogMediaDelete(it.id)
    items.value = items.value.filter((x) => x.id !== it.id)
    if (picked.value?.id === it.id) picked.value = null
  } catch (e: any) {
    // молча оставленный в списке файл читается как «кнопка не работает»
    removeError.value = e?.serverMessage || t('blog.editor.mediaDialog.removeError')
  }
}

function insertAsset(it: MediaAsset) {
  emit('insert', {
    kind: it.kind,
    src: it.url,
    mime: it.mime || '',
    name: it.name || '',
    size: it.size ?? null,
    width: it.width ?? null,
    height: it.height ?? null,
  })
  close()
}

function close() { emit('update:open', false) }

// открытие: сбрасываем прошлый результат и подтягиваем библиотеку
watch(() => props.open, (v) => {
  if (!v) return
  tab.value = props.initialTab || 'link'
  resolved.value = null
  linkError.value = ''
  picked.value = null
  loadLibrary()
})
</script>

<template>
  <Dialog :open="props.open" @update:open="emit('update:open', $event)">
    <DialogContent class="max-h-[88dvh] w-[94vw] overflow-y-auto sm:max-w-[720px]">
      <DialogHeader><DialogTitle>{{ $t('blog.editor.mediaDialog.title') }}</DialogTitle></DialogHeader>

      <Tabs v-model="tab" class="gap-4">
        <TabsList class="w-full">
          <TabsTrigger value="link"><Link2 :size="13" /> {{ $t('blog.editor.plus.embed') }}</TabsTrigger>
          <TabsTrigger value="library">{{ $t('blog.editor.mediaDialog.library') }}<span v-if="items.length" class="ml-1 opacity-60">{{ items.length }}</span></TabsTrigger>
        </TabsList>

        <!-- ссылка / встраивание -->
        <TabsContent value="link" class="space-y-3">
          <div class="flex items-center gap-2">
            <input
              v-model="url" :placeholder="$t('blog.editor.mediaDialog.urlPlaceholder')"
              class="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-[13px] outline-none focus:border-ring"
              @keydown.enter.prevent="resolve"
            >
            <button
              type="button"
              class="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-border px-3 text-[12.5px] transition hover:bg-surface-hover disabled:opacity-50"
              :disabled="resolving || !url.trim()" @click="resolve"
            >
              <Loader2 v-if="resolving" :size="13" class="animate-spin" /> {{ $t('blog.editor.mediaDialog.check') }}
            </button>
          </div>
          <p class="text-[11.5px] leading-relaxed text-muted-foreground/70">
            {{ $t('blog.editor.mediaDialog.providers') }}
          </p>

          <p v-if="linkError" class="rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{{ linkError }}</p>

          <!-- предпросмотр -->
          <div v-if="resolved" class="space-y-3 rounded-xl border border-border bg-surface p-3">
            <div class="flex items-center gap-2 text-[12px] text-muted-foreground">
              <span class="rounded-md border border-border px-1.5 py-0.5">{{ kindLabel(resolved.kind) }}</span>
              <span v-if="resolved.provider" class="rounded-md border border-border px-1.5 py-0.5">{{ resolved.provider }}</span>
              <span class="truncate">{{ resolved.title || resolved.href }}</span>
            </div>

            <div class="preview-pane text-foreground">
              <figure v-if="resolved.kind === 'embed'" class="bw-media bw-media--embed !my-0">
                <div class="bw-embed" :style="{ paddingBottom: previewRatio }">
                  <iframe :src="resolved.src" loading="lazy" frameborder="0" allowfullscreen></iframe>
                </div>
              </figure>
              <figure v-else-if="resolved.kind === 'image'" class="bw-media bw-media--image !my-0">
                <img :src="resolved.src" alt="">
              </figure>
              <figure v-else-if="resolved.kind === 'video'" class="bw-media bw-media--video !my-0">
                <video :src="resolved.src" controls preload="metadata" playsinline></video>
              </figure>
              <figure v-else-if="resolved.kind === 'audio'" class="bw-media bw-media--audio !my-0">
                <audio :src="resolved.src" controls preload="metadata"></audio>
              </figure>
              <figure v-else class="bw-media bw-media--link !my-0">
                <span class="bw-linkcard">
                  <img v-if="resolved.thumb" class="bw-linkcard__thumb" :src="resolved.thumb" alt="">
                  <span class="bw-linkcard__body">
                    <span class="bw-linkcard__title">{{ resolved.title || resolved.site || resolved.href }}</span>
                    <span v-if="resolved.desc" class="bw-linkcard__desc">{{ resolved.desc }}</span>
                    <span v-if="resolved.site" class="bw-linkcard__site">{{ resolved.site }}</span>
                  </span>
                </span>
              </figure>
            </div>

            <div class="flex items-center gap-2">
              <button
                v-if="resolved.kind !== 'link'" type="button"
                class="h-8 rounded-lg border border-border px-3 text-[12.5px] text-muted-foreground transition hover:text-foreground"
                @click="insertAsCard"
              >
                {{ $t('blog.editor.mediaDialog.insertAsCard') }}
              </button>
              <button type="button" class="ml-auto h-8 rounded-lg bg-foreground px-3.5 text-[12.5px] font-medium text-background" @click="insertResolved">
                {{ $t('blog.editor.mediaDialog.insert') }}
              </button>
            </div>
          </div>
        </TabsContent>

        <!-- библиотека статьи -->
        <TabsContent value="library" class="space-y-3">
          <div v-if="libLoading" class="flex items-center gap-2 py-10 text-[13px] text-muted-foreground">
            <Loader2 :size="15" class="animate-spin" /> {{ $t('blog.editor.mediaDialog.loading') }}
          </div>
          <p v-else-if="libError" class="rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{{ libError }}</p>
          <div v-else-if="!items.length" class="flex flex-col items-center gap-2 py-12 text-muted-foreground">
            <ImageOff :size="22" class="opacity-60" />
            <p class="text-[13px]">{{ $t('blog.editor.mediaDialog.libraryEmpty') }}</p>
          </div>

          <p v-if="removeError" class="rounded-lg border border-danger/20 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{{ removeError }}</p>

          <div v-if="items.length" class="grid grid-cols-1 gap-2.5 sm:grid-cols-2 md:grid-cols-3">
            <div
              v-for="it in items" :key="it.id"
              class="group relative overflow-hidden rounded-xl border border-border transition hover:border-hairline"
            >
              <button type="button" class="block w-full text-left" @click="insertAsset(it)">
                <div class="grid aspect-video place-items-center bg-surface-2">
                  <img v-if="it.kind === 'image'" :src="it.url" alt="" class="size-full object-cover" loading="lazy">
                  <video v-else-if="it.kind === 'video'" :src="it.url" preload="metadata" class="size-full object-cover"></video>
                  <FileText v-else :size="20" class="text-muted-foreground/60" />
                </div>
                <div class="space-y-0.5 px-2.5 py-2">
                  <p class="truncate text-[12px]" :title="it.name || it.url">{{ it.name || it.url }}</p>
                  <p class="text-[10.5px] text-muted-foreground/60">{{ kindLabel(it.kind) }} · {{ formatSize(it.size || 0) || '—' }}</p>
                </div>
              </button>
              <button
                type="button" :title="$t('blog.editor.mediaDialog.removeTitle')"
                class="absolute right-1.5 top-1.5 grid size-8 place-items-center rounded-md bg-background/80 text-muted-foreground opacity-0 transition max-sm:opacity-100 group-hover:opacity-100 hover:text-danger"
                @click.stop="removeItem(it)"
              >
                <Trash2 :size="12" />
              </button>
            </div>
          </div>
        </TabsContent>
      </Tabs>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
/* предпросмотр компактнее, чем в статье: модалка не должна прыгать по высоте */
.preview-pane :deep(.bw-media > img),
.preview-pane :deep(.bw-media > video) { max-height: 320px; }
</style>
