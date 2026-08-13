<script setup lang="ts">
/**
 * Баннер ошибки.
 *
 * В коде было четыре рецепта одного и того же красного блока — отличались
 * прозрачностью фона и границы (`rose-500/25 + /10`, `/20 + /[0.08]`,
 * `/25 + /[0.07]`, `/20 + /10`). Теперь один компонент на семантическом токене.
 */
import { TriangleAlert } from 'lucide-vue-next'
import { cn } from '@/lib/utils'

defineProps<{
  message?: string
  class?: string
}>()
</script>

<template>
  <div
    role="alert"
    :class="cn('flex items-start gap-2 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[12.5px] text-danger', $props.class)"
  >
    <TriangleAlert :size="14" class="mt-0.5 shrink-0" />
    <span class="min-w-0"><slot>{{ message }}</slot></span>
  </div>
</template>
