<script setup lang="ts">
/**
 * Пикер цвета в духе shadcn.io: плоскость насыщенность/яркость, полоса тона,
 * полоса прозрачности, пипетка (EyeDropper API) и поле вывода с переключателем
 * формата (HEX / RGB / CSS / HSL).
 *
 * Внутри — HSVA (иначе плоскость и полосы не сходятся), наружу v-model отдаёт
 * CSS-строку: hex при alpha=1, иначе rgba().
 */
import { computed, ref, watch } from 'vue'
import { Pipette } from 'lucide-vue-next'
import { formatColor, hsvToHex, parseColor, toCss, type ColorFormat, type Hsva } from '@/lib/color'

const props = withDefaults(defineProps<{ modelValue: string; alpha?: boolean }>(), { alpha: true })
// update:modelValue летит на каждое движение (живое превью), change — только в
// конце жеста: на нём вызывающий коммитит историю, иначе один drag = 50 шагов undo
const emit = defineEmits<{ 'update:modelValue': [string]; change: [] }>()

const hsva = ref<Hsva>(parseColor(props.modelValue))
let self = false // защита от эха: наш же emit не должен пересобирать hsva

watch(() => props.modelValue, (v) => {
  if (self) { self = false; return }
  hsva.value = parseColor(v)
})

function push() {
  self = true
  emit('update:modelValue', toCss(hsva.value))
}
function patch(p: Partial<Hsva>) { hsva.value = { ...hsva.value, ...p }; push() }

const hueColor = computed(() => hsvToHex({ h: hsva.value.h, s: 1, v: 1 }))
const solid = computed(() => hsvToHex(hsva.value))
const thumbStyle = computed(() => ({ left: `${hsva.value.s * 100}%`, top: `${(1 - hsva.value.v) * 100}%` }))

/* ------------------------------------------------------------ перетаскивание */
type Track = (rx: number, ry: number) => void
function startDrag(e: PointerEvent, el: HTMLElement, apply: Track) {
  const move = (ev: PointerEvent) => {
    const r = el.getBoundingClientRect()
    apply(
      Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)),
      Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)),
    )
  }
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up)
    emit('change')
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  move(e)
  e.preventDefault()
}
const area = ref<HTMLElement>()
const hueBar = ref<HTMLElement>()
const alphaBar = ref<HTMLElement>()
const onAreaDown = (e: PointerEvent) => area.value && startDrag(e, area.value, (x, y) => patch({ s: x, v: 1 - y }))
const onHueDown = (e: PointerEvent) => hueBar.value && startDrag(e, hueBar.value, (x) => patch({ h: x * 360 }))
const onAlphaDown = (e: PointerEvent) => alphaBar.value && startDrag(e, alphaBar.value, (x) => patch({ a: x }))

/* ------------------------------------------------------------------- пипетка */
const hasEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window
async function pickFromScreen() {
  try {
    const res = await new (window as any).EyeDropper().open()
    if (res?.sRGBHex) { hsva.value = { ...parseColor(res.sRGBHex), a: hsva.value.a }; push(); emit('change') }
  } catch { /* пользователь отменил */ }
}

/* -------------------------------------------------------------------- вывод */
const FORMATS: ColorFormat[] = ['hex', 'rgb', 'css', 'hsl']
const format = ref<ColorFormat>('hex')
const text = computed(() => formatColor(hsva.value, format.value))

/** Ручной ввод: принимаем всё, что парсится; иначе поле откатится на blur. */
const draft = ref('')
const editing = ref(false)
function onInput(e: Event) {
  draft.value = (e.target as HTMLInputElement).value
  const raw = draft.value.trim()
  const val = format.value === 'rgb' && /^[\d\s,]+$/.test(raw) ? `rgb(${raw})` : raw
  const parsed = parseColor(val)
  // parseColor не умеет «не смог» — считаем удачей всё, что не пустая строка вида #zz
  if (val && (val.startsWith('#') ? /^#([0-9a-f]{3,8})$/i.test(val) : true)) {
    hsva.value = props.alpha ? parsed : { ...parsed, a: 1 }
    push()
  }
}
</script>

<template>
  <div class="flex w-full flex-col gap-3">
    <!-- насыщенность / яркость -->
    <div
      ref="area" class="relative h-36 w-full cursor-crosshair rounded-md"
      :style="{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent), ${hueColor}` }"
      @pointerdown="onAreaDown"
    >
      <div
        class="pointer-events-none absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_0_1px_rgba(0,0,0,.45)]"
        :style="{ ...thumbStyle, background: solid }"
      ></div>
    </div>

    <div class="flex items-center gap-3">
      <button
        v-if="hasEyeDropper" type="button" title="Взять цвет с экрана"
        class="grid size-8 shrink-0 place-items-center rounded-md border border-border text-muted-foreground transition hover:text-foreground"
        @click="pickFromScreen"
      >
        <Pipette :size="15" />
      </button>

      <div class="grid w-full gap-2">
        <!-- тон -->
        <div ref="hueBar" class="hue-bar" @pointerdown="onHueDown">
          <div class="cp-thumb" :style="{ left: `${(hsva.h / 360) * 100}%`, background: hueColor }"></div>
        </div>
        <!-- прозрачность -->
        <div v-if="alpha" ref="alphaBar" class="alpha-bar" @pointerdown="onAlphaDown">
          <div class="absolute inset-0 rounded-full" :style="{ background: `linear-gradient(to right, transparent, ${solid})` }"></div>
          <div class="cp-thumb" :style="{ left: `${hsva.a * 100}%`, background: solid }"></div>
        </div>
      </div>
    </div>

    <!-- вывод -->
    <div class="flex items-center gap-2">
      <select v-model="format" class="cp-select">
        <option v-for="f in FORMATS" :key="f" :value="f">{{ f.toUpperCase() }}</option>
      </select>
      <input
        class="cp-input" spellcheck="false"
        :value="editing ? draft : text"
        @focus="editing = true; draft = text"
        @blur="editing = false; emit('change')"
        @input="onInput"
        @keydown.enter="($event.target as HTMLInputElement).blur()"
      >
      <span v-if="alpha" class="w-11 shrink-0 text-right text-[11.5px] tabular-nums text-muted-foreground">{{ Math.round(hsva.a * 100) }}%</span>
    </div>
  </div>
</template>

<style scoped>
.hue-bar {
  position: relative; height: 12px; border-radius: 99px; cursor: pointer;
  background: linear-gradient(to right, #f00 0%, #ff0 17%, #0f0 33%, #0ff 50%, #00f 67%, #f0f 83%, #f00 100%);
}
.alpha-bar {
  position: relative; height: 12px; border-radius: 99px; cursor: pointer;
  background-color: #fff;
  background-image:
    linear-gradient(45deg, #c8c8c8 25%, transparent 25%), linear-gradient(-45deg, #c8c8c8 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #c8c8c8 75%), linear-gradient(-45deg, transparent 75%, #c8c8c8 75%);
  background-size: 8px 8px;
  background-position: 0 0, 0 4px, 4px -4px, -4px 0;
}
.cp-thumb {
  position: absolute; top: 50%; width: 14px; height: 14px; margin-left: -7px;
  transform: translateY(-50%); border-radius: 50%; border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, .45); pointer-events: none;
}
.cp-select {
  height: 28px; border: 1px solid var(--border); border-radius: 7px; padding: 0 4px;
  font-size: 11px; font-weight: 600; letter-spacing: .02em;
  background: rgba(255, 255, 255, .02); color: var(--muted-foreground); outline: none;
}
.cp-input {
  flex: 1; min-width: 0; height: 28px; border: 1px solid var(--border); border-radius: 7px; padding: 0 8px;
  font-size: 12px; font-variant-numeric: tabular-nums;
  background: rgba(255, 255, 255, .02); color: var(--foreground); outline: none;
}
.cp-input:focus { border-color: var(--ring); }
</style>
