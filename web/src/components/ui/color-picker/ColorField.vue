<script setup lang="ts">
/** Свотч + подпись: клик открывает пикер в поповере. Замена нативного
 *  <input type="color"> — тот не умеет ни альфу, ни пипетку, ни форматы. */
import { computed } from 'vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import ColorPicker from './ColorPicker.vue'

const props = withDefaults(defineProps<{ modelValue: string; label?: string; alpha?: boolean }>(), { alpha: true })
// change прокидываем как есть: пикер шлёт его в конце жеста — это точка коммита
const emit = defineEmits<{ 'update:modelValue': [string]; change: [] }>()

// свотч: сам цвет поверх шахматки, чтобы прозрачный не сливался с фоном панели
const swatch = computed(() => props.modelValue || 'transparent')
</script>

<template>
  <div class="flex items-center gap-2">
    <Popover>
      <PopoverTrigger as-child>
        <button type="button" class="cf-swatch" :aria-label="label || 'Цвет'">
          <span class="cf-fill" :style="{ background: swatch }"></span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" class="w-64 p-3">
        <ColorPicker
          :model-value="modelValue" :alpha="alpha"
          @update:model-value="emit('update:modelValue', $event)" @change="emit('change')"
        />
      </PopoverContent>
    </Popover>
    <span v-if="label" class="text-[11px] text-muted-foreground">{{ label }}</span>
  </div>
</template>

<style scoped>
.cf-swatch {
  position: relative; width: 26px; height: 26px; border-radius: 6px; overflow: hidden;
  border: 1px solid var(--border); cursor: pointer;
  background-color: #fff;
  background-image:
    linear-gradient(45deg, #c8c8c8 25%, transparent 25%), linear-gradient(-45deg, #c8c8c8 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #c8c8c8 75%), linear-gradient(-45deg, transparent 75%, #c8c8c8 75%);
  background-size: 10px 10px;
  background-position: 0 0, 0 5px, 5px -5px, -5px 0;
}
.cf-swatch:hover { border-color: color-mix(in srgb, var(--foreground) 35%, transparent); }
.cf-fill { position: absolute; inset: 0; }
</style>
