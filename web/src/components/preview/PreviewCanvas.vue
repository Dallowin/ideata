<script setup lang="ts">
/**
 * Интерактивный холст: объекты — реальный DOM, их тащат мышью (со смарт-гайдами
 * по центрам холста) и правят текст по дабл-клику. Сцена реактивна — мутируем
 * напрямую; @changed — точка коммита истории (конец перетаскивания/правки).
 *
 * Координаты в px холста, .stage масштабируется через transform: scale(fit) —
 * поэтому дельту мыши делим на scale, и холст совпадает с PNG пиксель-в-пиксель.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { Scene, SceneObject } from '@/lib/preview/scene'
import { bgCss, objStyle } from '@/lib/preview/scene'

const props = withDefaults(defineProps<{ scene: Scene; selectedId?: string; editable?: boolean }>(),
  { editable: true, selectedId: '' })
const emit = defineEmits<{ 'update:selectedId': [string]; changed: [] }>()

const wrap = ref<HTMLElement | null>(null)
const scale = ref(0.4)
let ro: ResizeObserver | null = null
function measure() { if (wrap.value) scale.value = wrap.value.clientWidth / props.scene.width }
onMounted(() => {
  measure()
  // ResizeObserver ловит смену ширины колонки, window resize — фолбэк
  ro = new ResizeObserver(measure); if (wrap.value) ro.observe(wrap.value)
  window.addEventListener('resize', measure)
})
onBeforeUnmount(() => { ro?.disconnect(); window.removeEventListener('resize', measure); stopDrag() })

const editingId = ref('')
const guideV = ref(false)
const guideH = ref(false)

const stageStyle = computed(() =>
  `position:absolute;top:0;left:0;width:${props.scene.width}px;height:${props.scene.height}px;`
  + `transform:scale(${scale.value});transform-origin:top left;overflow:hidden;`
  + `--s:${scale.value ? 1 / scale.value : 1};${bgCss(props.scene.bg)}`)

const SNAP = 11 // порог прилипания к центру, px холста
let drag: { id: string; sx: number; sy: number; ox: number; oy: number; w: number; h: number; moved: boolean } | null = null
function onDown(e: PointerEvent, o: SceneObject) {
  if (!props.editable || editingId.value === o.id) return
  emit('update:selectedId', o.id)
  const el = e.currentTarget as HTMLElement
  drag = { id: o.id, sx: e.clientX, sy: e.clientY, ox: o.x, oy: o.y, w: el.offsetWidth, h: el.offsetHeight, moved: false }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', stopDrag)
  e.preventDefault()
}
function onMove(e: PointerEvent) {
  if (!drag) return
  const o = props.scene.objects.find((x) => x.id === drag!.id); if (!o) return
  drag.moved = true
  let nx = Math.round(drag.ox + (e.clientX - drag.sx) / scale.value)
  let ny = Math.round(drag.oy + (e.clientY - drag.sy) / scale.value)
  const W = props.scene.width, H = props.scene.height
  if (Math.abs(nx + drag.w / 2 - W / 2) < SNAP) { nx = Math.round((W - drag.w) / 2); guideV.value = true } else guideV.value = false
  if (Math.abs(ny + drag.h / 2 - H / 2) < SNAP) { ny = Math.round((H - drag.h) / 2); guideH.value = true } else guideH.value = false
  o.x = nx; o.y = ny
}
function stopDrag() {
  const moved = drag?.moved
  drag = null; guideV.value = false; guideH.value = false
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', stopDrag)
  if (moved) emit('changed')
}

function onDbl(o: SceneObject) {
  if (!props.editable || o.type !== 'text') return
  editingId.value = o.id
  emit('update:selectedId', o.id)
  nextTick(() => {
    const el = wrap.value?.querySelector(`[data-id="${o.id}"]`) as HTMLElement | null
    if (el) { el.focus(); document.getSelection()?.selectAllChildren(el) }
  })
}
function onBlur(e: FocusEvent, o: SceneObject) {
  if (editingId.value !== o.id) return
  const t = (e.target as HTMLElement).innerText
  if (t !== o.text) { o.text = t; emit('changed') }
  editingId.value = ''
}
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') (e.target as HTMLElement).blur() }
function onStageDown(e: PointerEvent) { if (e.target === e.currentTarget && props.editable) emit('update:selectedId', '') }

/* ------------------------------------------------ ресайз (углы, картинки/фигуры) */
const selObj = computed(() => props.scene.objects.find((o) => o.id === props.selectedId))
const showHandles = computed(() => props.editable && !editingId.value && !!selObj.value && (selObj.value!.type === 'image' || selObj.value!.type === 'block'))
const CORNERS: [string, number, number][] = [['nw', 0, 0], ['ne', 1, 0], ['sw', 0, 1], ['se', 1, 1]]
let rz: { sx: number; sy: number; ox: number; oy: number; ow: number; oh: number; corner: string } | null = null
function onResizeDown(e: PointerEvent, corner: string) {
  e.stopPropagation()
  const o = selObj.value; if (!o) return
  rz = { sx: e.clientX, sy: e.clientY, ox: o.x, oy: o.y, ow: o.w, oh: o.h || 0, corner }
  window.addEventListener('pointermove', onResizeMove); window.addEventListener('pointerup', onResizeUp)
  e.preventDefault()
}
function onResizeMove(e: PointerEvent) {
  if (!rz) return; const o = selObj.value; if (!o) return
  const dx = (e.clientX - rz.sx) / scale.value, dy = (e.clientY - rz.sy) / scale.value
  let w = rz.ow, h = rz.oh
  if (rz.corner.includes('e')) w = rz.ow + dx
  if (rz.corner.includes('w')) w = rz.ow - dx
  if (rz.corner.includes('s')) h = rz.oh + dy
  if (rz.corner.includes('n')) h = rz.oh - dy
  w = Math.max(20, Math.round(w)); h = Math.max(20, Math.round(h))
  o.w = w; o.h = h
  o.x = rz.corner.includes('w') ? rz.ox + (rz.ow - w) : rz.ox
  o.y = rz.corner.includes('n') ? rz.oy + (rz.oh - h) : rz.oy
}
function onResizeUp() { if (rz) emit('changed'); rz = null; window.removeEventListener('pointermove', onResizeMove); window.removeEventListener('pointerup', onResizeUp) }
</script>

<template>
  <div ref="wrap" class="pc-wrap" :style="{ aspectRatio: `${scene.width} / ${scene.height}` }">
    <div class="pc-stage" :style="stageStyle" @pointerdown="onStageDown">
      <template v-for="o in scene.objects" :key="o.id">
        <img
          v-if="o.type === 'image'" :src="o.src" :style="objStyle(o)" :data-id="o.id" alt=""
          class="pc-obj" :class="{ sel: selectedId === o.id, ed: editable }" draggable="false"
          @pointerdown="onDown($event, o)"
        >
        <div
          v-else-if="o.type === 'block'" :style="objStyle(o)" :data-id="o.id"
          class="pc-obj" :class="{ sel: selectedId === o.id, ed: editable }"
          @pointerdown="onDown($event, o)"
        ></div>
        <div
          v-else :style="objStyle(o)" :data-id="o.id"
          class="pc-obj pc-text" :class="{ sel: selectedId === o.id, ed: editable, editing: editingId === o.id }"
          :contenteditable="editingId === o.id" spellcheck="false"
          @pointerdown="onDown($event, o)" @dblclick="onDbl(o)" @blur="onBlur($event, o)" @keydown="onKey"
        >{{ o.text }}</div>
      </template>

      <!-- ресайз по углам (картинки/фигуры) -->
      <template v-if="showHandles && selObj">
        <div
          v-for="c in CORNERS" :key="c[0]" class="pc-handle" :class="'h-' + c[0]"
          :style="{ left: (selObj.x + selObj.w * c[1]) + 'px', top: (selObj.y + (selObj.h || 0) * c[2]) + 'px' }"
          @pointerdown="onResizeDown($event, c[0])"
        ></div>
      </template>

      <!-- смарт-гайды по центрам холста -->
      <div v-show="guideV" class="pc-guide" :style="`left:${scene.width / 2}px;top:0;width:calc(1px * var(--s));height:100%`"></div>
      <div v-show="guideH" class="pc-guide" :style="`top:${scene.height / 2}px;left:0;height:calc(1px * var(--s));width:100%`"></div>
    </div>
  </div>
</template>

<style scoped>
.pc-wrap { position: relative; width: 100%; overflow: hidden; }
.pc-obj { outline: 0 solid transparent; }
.pc-obj.ed { cursor: move; }
.pc-obj.sel { outline: calc(2px * var(--s)) solid var(--brand-accent); outline-offset: calc(2px * var(--s)); }
.pc-text.editing { cursor: text; }
.pc-text:focus { outline: calc(2px * var(--s)) dashed var(--brand-accent); }
.pc-guide { position: absolute; background: var(--brand-accent); pointer-events: none; z-index: 9; }
.pc-handle { position: absolute; width: calc(11px * var(--s)); height: calc(11px * var(--s)); margin: calc(-6px * var(--s)) 0 0 calc(-6px * var(--s)); background: #fff; border: calc(1.5px * var(--s)) solid var(--brand-accent); border-radius: calc(2px * var(--s)); z-index: 11; }
.h-nw, .h-se { cursor: nwse-resize; }
.h-ne, .h-sw { cursor: nesw-resize; }
</style>
