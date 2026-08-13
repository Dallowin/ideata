<script setup lang="ts">
/** Галерея шаблонов + «Мои». Клик → загрузить сцену в холст.
 *  Миниатюры — тот же PreviewCanvas в режиме editable=false. */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trash2, X } from 'lucide-vue-next'
import PreviewCanvas from './PreviewCanvas.vue'
import { SCENE_TEMPLATES, sceneTags, type SceneTemplate } from '@/lib/preview/scenes'
import type { SavedScene } from '@/composables/useSceneStudio'

const props = defineProps<{ activeId?: string; myScenes?: SavedScene[] }>()
const emit = defineEmits<{ pick: [SceneTemplate]; pickMy: [SavedScene]; deleteMy: [string]; close: [] }>()

const { t } = useI18n()

// Фильтр держит КЛЮЧ тега (в данных шаблона тоже ключ), подпись считаем при
// отрисовке — иначе выбранный фильтр слетал бы при смене языка.
const MY = '@my'
const ALL = '@all'
const tag = ref(props.myScenes?.length ? MY : ALL)
const tags = computed(() => [...(props.myScenes?.length ? [MY] : []), ALL, ...sceneTags()])
const list = computed(() => tag.value === ALL ? SCENE_TEMPLATES : SCENE_TEMPLATES.filter((x) => x.tagKeys.includes(tag.value)))
const showMy = computed(() => tag.value === MY)

function tagLabel(key: string): string {
  if (key === MY) return t('preview.gallery.mine')
  if (key === ALL) return t('preview.gallery.all')
  return t(`preview.template.tag.${key}`)
}
</script>

<template>
  <div class="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:p-8" @click.self="emit('close')">
    <div class="my-auto w-full max-w-[1080px] overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl shadow-black/40">
      <div class="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-popover/95 px-5 py-3.5 backdrop-blur">
        <div class="shrink-0 text-[15px] font-semibold">{{ $t('preview.gallery.title') }}</div>
        <div class="no-scrollbar flex flex-1 gap-1.5 overflow-x-auto px-1">
          <button
            v-for="k in tags" :key="k" type="button"
            class="shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium transition"
            :class="tag === k ? 'bg-brand-accent text-brand-accent-foreground' : 'bg-surface-hover text-muted-foreground hover:text-foreground'"
            @click="tag = k"
          >{{ tagLabel(k) }}</button>
        </div>
        <button type="button" class="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-surface-hover hover:text-foreground" @click="emit('close')">
          <X :size="15" />
        </button>
      </div>

      <div v-if="showMy" class="p-4 sm:p-5">
        <div v-if="!myScenes?.length" class="py-14 text-center text-[13px] text-muted-foreground">
          {{ $t('preview.gallery.empty') }}
        </div>
        <div v-else class="grid grid-cols-2 gap-3.5 sm:grid-cols-3">
          <div
            v-for="my in myScenes" :key="my.id"
            class="group relative overflow-hidden rounded-xl border transition hover:-translate-y-0.5"
            :class="props.activeId === my.id ? 'border-brand-accent' : 'border-border hover:border-muted-foreground/40'"
          >
            <button type="button" class="block w-full" @click="emit('pickMy', my)"><PreviewCanvas :scene="my.scene" :editable="false" /></button>
            <div class="flex items-center justify-between gap-2 px-3 py-2">
              <!-- имя «моего» шаблона — данные автора, не переводим -->
              <span class="truncate text-[12.5px] font-medium">{{ my.name }}</span>
              <button type="button" class="shrink-0 text-muted-foreground/60 transition hover:text-danger" @click.stop="emit('deleteMy', my.id)"><Trash2 :size="14" /></button>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="grid grid-cols-2 gap-3.5 p-4 sm:grid-cols-3 sm:p-5">
        <button
          v-for="tpl in list" :key="tpl.id" type="button"
          class="overflow-hidden rounded-xl border text-left transition hover:-translate-y-0.5"
          :class="props.activeId === tpl.id ? 'border-brand-accent' : 'border-border hover:border-muted-foreground/40'"
          @click="emit('pick', tpl)"
        >
          <PreviewCanvas :scene="tpl.scene" :editable="false" />
          <div class="flex items-center justify-between gap-2 px-3 py-2">
            <span class="truncate text-[12.5px] font-medium">{{ $t(tpl.nameKey) }}</span>
            <span class="shrink-0 text-[10.5px] text-muted-foreground/60">{{ tagLabel(tpl.tagKeys[0]) }}</span>
          </div>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.no-scrollbar::-webkit-scrollbar { display: none; }
.no-scrollbar { scrollbar-width: none; }
</style>
