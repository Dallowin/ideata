<script setup lang="ts">
/** Инспектор: свойства выбранного объекта либо настройка фона (цвет/градиент/картинка+AI). */
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AlignCenter, AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignHorizontalJustifyStart,
  AlignLeft, AlignRight, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart,
  ChevronDown, ChevronUp, Copy, ImagePlus, Loader2, Trash2, Upload, X,
} from 'lucide-vue-next'
import PreviewNumSlider from './PreviewNumSlider.vue'
import PreviewGradientEditor from './PreviewGradientEditor.vue'
import PreviewImageLibrary from './PreviewImageLibrary.vue'
import { ColorField } from '@/components/ui/color-picker'
import ModelSelect from '@/components/ModelSelect.vue'
import { SF } from '@/lib/preview/scenes'
import { useSceneStudio } from '@/composables/useSceneStudio'
import { useAiBackground } from '@/composables/useAiBackground'

const { t } = useI18n()
const { scene, selected, addText, addBlock, removeSelected, duplicate, forward, backward,
  setBgImage, clearBgImage, bgToLayer, alignSelected, commit } = useSceneStudio()
const ai = useAiBackground()
const { status: aiStatus, models: aiModels, model: aiModel, price: aiPrice, enough: aiEnough,
  history: aiHistory, generating: aiGenerating, error: aiError } = ai

const FONTS = [
  { l: 'Grotesk', v: SF.grotesk }, { l: 'Archivo', v: SF.archivo }, { l: 'Serif', v: SF.serif },
  { l: 'Serif Display', v: SF.serif2 }, { l: 'Mono', v: SF.mono }, { l: 'Sans', v: SF.sans },
]
const ALIGNS = [
  { k: 'left', i: AlignHorizontalJustifyStart }, { k: 'hcenter', i: AlignHorizontalJustifyCenter }, { k: 'right', i: AlignHorizontalJustifyEnd },
  { k: 'top', i: AlignVerticalJustifyStart }, { k: 'vmiddle', i: AlignVerticalJustifyCenter }, { k: 'bottom', i: AlignVerticalJustifyEnd },
]

// размеры меряем по реальному DOM объекта: у текста высота авто
function alignObj(kind: string) {
  const o = selected.value; if (!o) return
  const el = document.querySelector(`[data-id="${o.id}"]`) as HTMLElement | null
  alignSelected(kind, el?.offsetWidth ?? o.w, el?.offsetHeight ?? (o.h ?? 40))
}

/* ---- фон: цвет / градиент / картинка ---- */
const imageTab = ref(false)
const activeBg = computed(() => (scene.bg.image || imageTab.value) ? 'image' : scene.bg.type)
function setSolid() { scene.bg.type = 'solid'; scene.bg.image = ''; imageTab.value = false; commit() }
function setGradient() {
  scene.bg.type = 'gradient'; scene.bg.image = ''; imageTab.value = false
  // видимый дефолт: от текущего цвета к акценту, а не color→тот же color
  if (!scene.bg.stops || scene.bg.stops.length < 2) scene.bg.stops = [{ color: scene.bg.color, pos: 0 }, { color: '#4267ff', pos: 100 }]
  commit()
}
function onUpload(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return
  const fr = new FileReader(); fr.onload = () => { setBgImage(fr.result as string); imageTab.value = true }; fr.readAsDataURL(f)
}

/* ---- AI-фон ---- */
const bgPrompt = ref('')
async function genBg() {
  if (!bgPrompt.value.trim() || aiGenerating.value) return
  try { setBgImage(await ai.generate(bgPrompt.value, scene.width, scene.height)); imageTab.value = true } catch { /* aiError */ }
}
/** Пункты селектора: подпись справа — цена в наших кредитах за картинку. */
const modelOptions = computed(() => aiModels.value.map((m) => ({
  id: m.id,
  label: m.label,
  hint: m.credits != null ? t('preview.ai.credits', { n: m.credits }) : null,
})))

/** Библиотека всех картинок — модалка выбора (сетка + поиск). */
const libraryOpen = ref(false)
function pickFromLibrary(img: { url: string }) {
  setBgImage(img.url)
  imageTab.value = true
  libraryOpen.value = false
}

onMounted(() => { ai.loadStatus(); ai.loadModels(); ai.loadHistory() })
</script>

<template>
  <!-- ВЫБРАН ОБЪЕКТ -->
  <div v-if="selected" class="space-y-3.5" @change="commit">
    <div class="flex items-center gap-1.5">
      <span class="flex-1 text-[12px] font-semibold">{{ selected.type === 'text' ? $t('preview.tool.text') : selected.type === 'block' ? $t('preview.tool.shape') : $t('preview.tool.image') }}</span>
      <button type="button" class="ib" :title="$t('preview.inspector.forward')" @click="forward"><ChevronUp :size="15" /></button>
      <button type="button" class="ib" :title="$t('preview.inspector.backward')" @click="backward"><ChevronDown :size="15" /></button>
      <button type="button" class="ib" :title="$t('preview.inspector.duplicate')" @click="duplicate"><Copy :size="14" /></button>
      <button type="button" class="ib text-danger" :title="$t('preview.inspector.remove')" @click="removeSelected"><Trash2 :size="14" /></button>
    </div>

    <div>
      <div class="mb-1.5 text-[11px] text-muted-foreground">{{ $t('preview.inspector.alignCanvas') }}</div>
      <div class="flex gap-1">
        <button v-for="a in ALIGNS" :key="a.k" type="button" class="ib flex-1" @click="alignObj(a.k)"><component :is="a.i" :size="15" /></button>
      </div>
    </div>

    <p v-if="selected.type === 'text'" class="text-[11px] text-muted-foreground/60">{{ $t('preview.hint.textObject') }}</p>

    <!-- текст -->
    <template v-if="selected.type === 'text'">
      <label class="fld">
        <span>{{ $t('preview.field.font') }}</span>
        <select v-model="selected.font" class="inp"><option v-for="f in FONTS" :key="f.l" :value="f.v">{{ f.l }}</option></select>
      </label>
      <PreviewNumSlider :model-value="selected.size ?? 40" :min="12" :max="260" :label="$t('preview.field.size')" @update:model-value="selected.size = $event" />
      <PreviewNumSlider :model-value="selected.weight ?? 600" :min="300" :max="800" :step="100" :label="$t('preview.field.weight')" @update:model-value="selected.weight = $event" />
      <div class="flex items-center gap-3">
        <ColorField :model-value="selected.color ?? '#111111'" :label="$t('preview.field.color')" @update:model-value="selected.color = $event" @change="commit" />
        <div class="ml-auto flex gap-0.5">
          <button type="button" class="ib" :class="selected.align === 'left' && 'ib-on'" @click="selected.align = 'left'; commit()"><AlignLeft :size="14" /></button>
          <button type="button" class="ib" :class="selected.align === 'center' && 'ib-on'" @click="selected.align = 'center'; commit()"><AlignCenter :size="14" /></button>
          <button type="button" class="ib" :class="selected.align === 'right' && 'ib-on'" @click="selected.align = 'right'; commit()"><AlignRight :size="14" /></button>
        </div>
      </div>
      <PreviewNumSlider :model-value="selected.ls ?? 0" :min="-4" :max="16" :step="0.5" :label="$t('preview.field.tracking')" @update:model-value="selected.ls = $event" />
      <PreviewNumSlider :model-value="selected.lh ?? 1.1" :min="0.85" :max="1.8" :step="0.02" :label="$t('preview.field.leading')" @update:model-value="selected.lh = $event" />
      <div class="flex items-center gap-3 text-[12px]">
        <label class="flex cursor-pointer items-center gap-1.5"><input v-model="selected.caps" type="checkbox"> {{ $t('preview.field.caps') }}</label>
        <label class="flex cursor-pointer items-center gap-1.5"><input v-model="selected.italic" type="checkbox"> {{ $t('preview.field.italic') }}</label>
        <label class="ml-auto flex cursor-pointer items-center gap-1.5">
          {{ $t('preview.field.pill') }}<input type="checkbox" :checked="!!selected.fill" @change="selected.fill = ($event.target as HTMLInputElement).checked ? '#111111' : ''">
        </label>
      </div>
      <ColorField v-if="selected.fill" v-model="selected.fill" :label="$t('preview.field.pillBg')" @change="commit" />
      <PreviewNumSlider v-model="selected.w" :min="80" :max="scene.width" :label="$t('preview.field.boxWidth')" />
    </template>

    <!-- фигура -->
    <template v-else-if="selected.type === 'block'">
      <ColorField :model-value="selected.fill ?? '#111111'" :label="$t('preview.field.fill')" @update:model-value="selected.fill = $event" @change="commit" />
      <PreviewNumSlider v-model="selected.w" :min="4" :max="scene.width" :label="$t('preview.field.width')" />
      <PreviewNumSlider :model-value="selected.h ?? 8" :min="2" :max="scene.height" :label="$t('preview.field.height')" @update:model-value="selected.h = $event" />
      <PreviewNumSlider :model-value="selected.radius ?? 0" :min="0" :max="200" :label="$t('preview.field.radius')" @update:model-value="selected.radius = $event" />
    </template>

    <!-- картинка-слой -->
    <template v-else-if="selected.type === 'image'">
      <PreviewNumSlider v-model="selected.w" :min="20" :max="scene.width" :label="$t('preview.field.width')" />
      <PreviewNumSlider :model-value="selected.h ?? 200" :min="20" :max="scene.height" :label="$t('preview.field.height')" @update:model-value="selected.h = $event" />
      <PreviewNumSlider :model-value="selected.radius ?? 0" :min="0" :max="300" :label="$t('preview.field.radius')" @update:model-value="selected.radius = $event" />
      <label class="fld">
        <span>{{ $t('preview.field.fit') }}</span>
        <select v-model="selected.fit" class="inp"><option value="cover">{{ $t('preview.fit.cover') }}</option><option value="contain">{{ $t('preview.fit.contain') }}</option></select>
      </label>
      <p class="text-[11px] text-muted-foreground/60">{{ $t('preview.hint.imageObject') }}</p>
    </template>

    <PreviewNumSlider :model-value="selected.opacity ?? 1" :min="0.1" :max="1" :step="0.05" :label="$t('preview.field.opacity')" @update:model-value="selected.opacity = $event" />
  </div>

  <!-- НИЧЕГО НЕ ВЫБРАНО → добавить объект + фон -->
  <div v-else class="space-y-3.5">
    <div class="flex gap-1.5">
      <button type="button" class="add" @click="addText">{{ $t('preview.inspector.addText') }}</button>
      <button type="button" class="add" @click="addBlock">{{ $t('preview.inspector.addShape') }}</button>
    </div>
    <p class="text-[11px] text-muted-foreground/60">{{ $t('preview.hint.empty') }}</p>

    <div class="border-t border-border pt-3">
      <div class="mb-2 text-[12px] font-semibold">{{ $t('preview.bg.title') }}</div>
      <div class="seg mb-2.5">
        <button type="button" :class="activeBg === 'solid' && 'seg-on'" @click="setSolid">{{ $t('preview.bg.solid') }}</button>
        <button type="button" :class="activeBg === 'gradient' && 'seg-on'" @click="setGradient">{{ $t('preview.bg.gradient') }}</button>
        <button type="button" :class="activeBg === 'image' && 'seg-on'" @click="imageTab = true">{{ $t('preview.bg.image') }}</button>
      </div>

      <ColorField v-if="activeBg === 'solid'" v-model="scene.bg.color" :label="$t('preview.field.bgColor')" :alpha="false" @change="commit" />

      <PreviewGradientEditor v-else-if="activeBg === 'gradient'" />

      <div v-else class="space-y-2.5">
        <div v-if="scene.bg.image" class="relative aspect-video overflow-hidden rounded-lg border border-border">
          <img :src="scene.bg.image" alt="" class="size-full object-cover">
          <button type="button" class="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-md bg-black/55 text-white hover:bg-black/75" @click="clearBgImage(); imageTab = true"><X :size="13" /></button>
        </div>
        <div v-if="scene.bg.image" class="space-y-2">
          <PreviewNumSlider :model-value="scene.bg.imgX ?? 50" :min="0" :max="100" :label="$t('preview.field.offsetX')" @update:model-value="scene.bg.imgX = $event; commit()" />
          <PreviewNumSlider :model-value="scene.bg.imgY ?? 50" :min="0" :max="100" :label="$t('preview.field.offsetY')" @update:model-value="scene.bg.imgY = $event; commit()" />
          <PreviewNumSlider :model-value="scene.bg.imgZoom ?? 100" :min="100" :max="300" :label="$t('preview.field.zoom')" @update:model-value="scene.bg.imgZoom = $event; commit()" />
          <button type="button" class="w-full rounded-lg border border-border py-2 text-[12px] font-medium text-muted-foreground transition hover:border-muted-foreground/40 hover:text-foreground" @click="bgToLayer">
            {{ $t('preview.bg.toLayer') }}
          </button>
        </div>

        <label class="upl">
          <Upload :size="14" /> {{ $t('preview.bg.upload') }}
          <input type="file" accept="image/*" class="hidden" @change="onUpload">
        </label>

        <div class="flex items-center justify-between">
          <span class="text-[11px] text-muted-foreground">{{ $t('preview.ai.or') }}</span>
          <span v-if="aiStatus.loaded && aiStatus.hasOwnKey" class="text-[11px] text-muted-foreground/60">{{ $t('preview.ai.ownKey') }}</span>
          <span v-else-if="aiStatus.loaded && !aiStatus.degraded" class="text-[11px] tabular-nums text-muted-foreground/60">{{ $t('preview.ai.balance', { n: aiStatus.balance }) }}</span>
        </div>

        <div class="fld">
          <span>{{ $t('preview.field.model') }}</span>
          <ModelSelect v-model="aiModel" :models="modelOptions" size="sm" />
        </div>

        <textarea v-model="bgPrompt" rows="2" class="inp resize-none" :placeholder="$t('preview.ai.promptPlaceholder')"></textarea>
        <button
          type="button" class="flex w-full items-center justify-center gap-1.5 rounded-lg bg-foreground py-2 text-[12.5px] font-medium text-background transition disabled:opacity-50"
          :disabled="aiGenerating || !bgPrompt.trim() || !aiEnough" @click="genBg"
        >
          <component :is="aiGenerating ? Loader2 : ImagePlus" :size="14" :class="aiGenerating && 'animate-spin'" />
          {{ aiGenerating ? $t('preview.ai.generating') : aiPrice ? $t('preview.ai.generateWithPrice', { n: aiPrice }) : $t('preview.ai.generate') }}
        </button>
        <p v-if="!aiEnough" class="text-[11.5px] text-warning">{{ $t('preview.ai.notEnough') }}</p>
        <p v-if="aiError" class="text-[11.5px] text-danger">{{ aiError }}</p>

        <!-- уже сгенерированные: плотная полоса + вход в библиотеку -->
        <div v-if="aiHistory.length" class="space-y-1.5 border-t border-border pt-2.5">
          <div class="flex items-center justify-between">
            <span class="text-[11px] text-muted-foreground">{{ $t('preview.ai.historyTitle') }}</span>
            <button type="button" class="text-[11px] text-muted-foreground transition hover:text-foreground" @click="libraryOpen = true">
              {{ $t('preview.ai.allCount', { n: aiHistory.length }) }}
            </button>
          </div>
          <div class="grid grid-cols-4 gap-1">
            <button
              v-for="img in aiHistory.slice(0, 8)" :key="img.id || img.url" type="button"
              class="aspect-square overflow-hidden rounded-md border transition"
              :class="scene.bg.image === img.url ? 'border-brand-accent' : 'border-border hover:border-muted-foreground/40'"
              :title="img.prompt || ''"
              @click="setBgImage(img.url); imageTab = true"
            >
              <img :src="img.url" alt="" class="size-full object-cover" loading="lazy">
            </button>
          </div>
          <p class="text-[10.5px] text-muted-foreground/60">{{ $t('preview.ai.reuseFree') }}</p>
        </div>

        <PreviewNumSlider v-if="scene.bg.image" :model-value="scene.bg.scrim ?? 0.35" :min="0" :max="0.85" :step="0.05" :label="$t('preview.field.scrim')" @update:model-value="scene.bg.scrim = $event; commit()" />
      </div>
    </div>

    <PreviewImageLibrary
      v-if="libraryOpen" :images="aiHistory" :current="scene.bg.image"
      @pick="pickFromLibrary" @close="libraryOpen = false"
    />
  </div>
</template>

<style scoped>
.ib { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 26px; border-radius: var(--radius-md); color: var(--muted-foreground); background: var(--surface); }
.ib:hover { color: var(--foreground); background: var(--surface-hover); }
.ib-on { background: var(--foreground); color: var(--background); }
.add { flex: 1; padding: 8px; border-radius: var(--radius-lg); font-size: 12.5px; font-weight: 600; background: var(--surface); color: var(--foreground); }
.add:hover { background: var(--surface-hover); }
.fld { display: flex; flex-direction: column; gap: 4px; }
.fld > span { font-size: 11px; color: var(--muted-foreground); font-weight: 500; }
.inp { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 7px 9px; font-size: 12.5px; background: var(--surface); color: var(--foreground); outline: none; }
.inp:focus { border-color: var(--ring); }
.clr { width: 26px; height: 26px; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 0; background: none; cursor: pointer; }
input[type=checkbox] { accent-color: var(--brand-accent); }
.seg { display: flex; gap: 2px; padding: 2px; background: var(--surface); border-radius: var(--radius-md); }
.seg button { flex: 1; padding: 6px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 500; color: var(--muted-foreground); }
.seg button:hover { color: var(--foreground); }
.seg .seg-on { background: var(--brand-accent-soft); color: var(--brand-accent); }
.upl { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; padding: 8px; border: 1px dashed var(--border); border-radius: var(--radius-lg); font-size: 12.5px; color: var(--muted-foreground); cursor: pointer; }
.upl:hover { border-color: var(--ring); color: var(--foreground); }
</style>
