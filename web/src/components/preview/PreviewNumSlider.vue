<script setup lang="ts">
/** Ползунок + числовой инпут: значение можно тащить или ввести руками.
 *  Нативный change инпутов всплывает наружу → внешний @change="commit". */
import { computed } from 'vue'

const props = withDefaults(defineProps<{ modelValue: number; min?: number; max?: number; step?: number; label?: string }>(),
  { min: 0, max: 100, step: 1 })
const emit = defineEmits<{ 'update:modelValue': [number] }>()

function set(v: number) {
  let n = Number(v)
  if (Number.isNaN(n)) return
  n = Math.min(props.max, Math.max(props.min, n))
  emit('update:modelValue', n)
}
const pct = computed(() => Math.max(0, Math.min(100, ((props.modelValue - props.min) / (props.max - props.min || 1)) * 100)))
</script>

<template>
  <div>
    <div class="mb-1.5 flex items-center justify-between">
      <span class="text-[11px] text-muted-foreground">{{ label }}</span>
      <input
        class="ns-num" type="number" :min="min" :max="max" :step="step" :value="modelValue"
        @input="set(($event.target as HTMLInputElement).valueAsNumber)"
      >
    </div>
    <input
      class="ns-range" type="range" :min="min" :max="max" :step="step" :value="modelValue"
      :style="{ '--p': pct + '%' }"
      @input="set(($event.target as HTMLInputElement).valueAsNumber)"
    >
  </div>
</template>

<style scoped>
.ns-num {
  width: 60px; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums;
  border: 1px solid var(--border); border-radius: var(--radius-md); padding: 3px 7px;
  background: var(--surface); color: var(--foreground); outline: none; -moz-appearance: textfield;
}
.ns-num::-webkit-outer-spin-button, .ns-num::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.ns-num:focus { border-color: var(--ring); }
.ns-range {
  -webkit-appearance: none; appearance: none; width: 100%; height: 5px; border-radius: 99px; outline: none; cursor: pointer;
  background: linear-gradient(var(--brand-accent), var(--brand-accent)) 0 / var(--p) 100% no-repeat, var(--surface-2);
}
.ns-range::-webkit-slider-thumb {
  -webkit-appearance: none; width: 15px; height: 15px; border-radius: 50%;
  background: var(--foreground); border: 2px solid var(--brand-accent); cursor: grab;
}
.ns-range::-webkit-slider-thumb:active { cursor: grabbing; }
.ns-range::-moz-range-thumb { width: 15px; height: 15px; border-radius: 50%; background: var(--foreground); border: 2px solid var(--brand-accent); }
</style>
