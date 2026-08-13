<script setup lang="ts">
/** Градиент в стиле Figma: линейный/радиальный, много стопов (клик по полосе —
 *  добавить, тащи — двигать), у каждого свой цвет и позиция, угол отдельно. */
import { computed, onMounted, ref } from 'vue'
import { Trash2 } from 'lucide-vue-next'
import PreviewNumSlider from './PreviewNumSlider.vue'
import { ColorField } from '@/components/ui/color-picker'
import { useSceneStudio } from '@/composables/useSceneStudio'

const { scene, commit } = useSceneStudio()
const bg = computed(() => scene.bg)

onMounted(() => {
  if (!bg.value.stops || bg.value.stops.length < 2) {
    bg.value.stops = [{ color: bg.value.color, pos: 0 }, { color: bg.value.color2 || '#4267ff', pos: 100 }]
  }
  if (!bg.value.gradType) bg.value.gradType = 'linear'
})

const sel = ref(0)
const bar = ref<HTMLElement | null>(null)
const stops = computed(() => bg.value.stops || [])
// полоса всегда рисуется линейно слева-направо (это редактор), угол — отдельно
const barStyle = computed(() => {
  const s = [...stops.value].sort((a, b) => a.pos - b.pos).map((x) => `${x.color} ${x.pos}%`).join(', ')
  return `background:linear-gradient(90deg, ${s})`
})

function hexToRgb(h: string) { let x = h.replace('#', ''); if (x.length === 3) x = x.split('').map((c) => c + c).join(''); const n = parseInt(x, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
function rgbToHex(r: number, g: number, b: number) { return '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('') }
function colorAt(pos: number): string {
  const s = [...stops.value].sort((a, b) => a.pos - b.pos)
  if (pos <= s[0].pos) return s[0].color
  if (pos >= s[s.length - 1].pos) return s[s.length - 1].color
  for (let i = 0; i < s.length - 1; i++) {
    if (pos >= s[i].pos && pos <= s[i + 1].pos) {
      const t = (pos - s[i].pos) / ((s[i + 1].pos - s[i].pos) || 1)
      const a = hexToRgb(s[i].color), b = hexToRgb(s[i + 1].color)
      return rgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t)
    }
  }
  return s[0].color
}

let dragIdx = -1
function posFromX(clientX: number): number {
  const r = bar.value!.getBoundingClientRect()
  return Math.max(0, Math.min(100, ((clientX - r.left) / r.width) * 100))
}
function onStopDown(e: PointerEvent, i: number) {
  e.stopPropagation(); sel.value = i; dragIdx = i
  window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp)
}
function onMove(e: PointerEvent) { if (dragIdx < 0) return; stops.value[dragIdx].pos = Math.round(posFromX(e.clientX)) }
function onUp() { if (dragIdx >= 0) commit(); dragIdx = -1; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }

function addStopAt(e: PointerEvent) {
  const pos = Math.round(posFromX(e.clientX))
  stops.value.push({ color: colorAt(pos), pos })
  sel.value = stops.value.length - 1
  commit()
}
function delStop() {
  if (stops.value.length <= 2) return
  stops.value.splice(sel.value, 1)
  sel.value = Math.max(0, sel.value - 1)
  commit()
}
function setType(t: 'linear' | 'radial') { bg.value.gradType = t; commit() }
</script>

<template>
  <div class="space-y-2.5">
    <!-- полоса + стопы -->
    <div class="relative pt-3">
      <div ref="bar" class="grad-bar" :style="barStyle" @pointerdown="addStopAt"></div>
      <button
        v-for="(s, i) in stops" :key="i" type="button" class="grad-stop" :class="sel === i && 'sel'"
        :style="{ left: s.pos + '%', background: s.color }" @pointerdown="onStopDown($event, i)"
      ></button>
    </div>

    <div class="seg2">
      <button type="button" :class="bg.gradType !== 'radial' && 'on'" @click="setType('linear')">{{ $t('preview.gradient.linear') }}</button>
      <button type="button" :class="bg.gradType === 'radial' && 'on'" @click="setType('radial')">{{ $t('preview.gradient.radial') }}</button>
    </div>

    <div v-if="bg.gradType !== 'radial'" @change="commit">
      <PreviewNumSlider :model-value="bg.angle ?? 160" :min="0" :max="360" :label="$t('preview.field.angle')" @update:model-value="bg.angle = $event" />
    </div>

    <!-- выбранный стоп -->
    <div v-if="stops[sel]" class="flex items-center gap-2 border-t border-border pt-2.5" @change="commit">
      <ColorField v-model="stops[sel].color" :label="$t('preview.gradient.stop', { n: sel + 1 })" @change="commit" />
      <div class="ml-auto flex items-center gap-1">
        <input v-model.number="stops[sel].pos" type="number" min="0" max="100" class="posn">
        <span class="text-[11px] text-muted-foreground/60">%</span>
      </div>
      <button type="button" class="del" :disabled="stops.length <= 2" :title="$t('preview.gradient.removeStop')" @click="delStop"><Trash2 :size="13" /></button>
    </div>
    <p class="text-[10.5px] text-muted-foreground/60">{{ $t('preview.hint.gradient') }}</p>
  </div>
</template>

<style scoped>
.grad-bar { width: 100%; height: 26px; border-radius: var(--radius-md); border: 1px solid var(--border); cursor: copy; }
.grad-stop {
  position: absolute; top: 0; width: 16px; height: 32px; margin-left: -8px; border-radius: 5px;
  border: 2px solid #fff; box-shadow: 0 1px 4px rgba(0, 0, 0, .5); cursor: grab;
}
.grad-stop.sel { border-color: var(--brand-accent); box-shadow: 0 0 0 2px var(--brand-accent), 0 1px 4px rgba(0, 0, 0, .5); }
.grad-stop:active { cursor: grabbing; }
.seg2 { display: flex; gap: 2px; padding: 2px; background: var(--surface); border-radius: var(--radius-md); }
.seg2 button { padding: 5px 12px; border-radius: var(--radius-sm); font-size: 12px; font-weight: 500; color: var(--muted-foreground); }
.seg2 button:hover { color: var(--foreground); }
.seg2 .on { background: var(--brand-accent-soft); color: var(--brand-accent); }
.clr { width: 26px; height: 26px; border: 1px solid var(--border); border-radius: var(--radius-md); padding: 0; background: none; cursor: pointer; }
.posn {
  width: 48px; text-align: right; font-size: 12px; border: 1px solid var(--border); border-radius: var(--radius-md);
  padding: 2px 6px; outline: none; background: var(--surface); color: var(--foreground); -moz-appearance: textfield;
}
.posn::-webkit-outer-spin-button, .posn::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.del { display: inline-flex; width: 26px; height: 26px; align-items: center; justify-content: center; border-radius: var(--radius-md); color: var(--danger); }
.del:disabled { opacity: .35; }
</style>
