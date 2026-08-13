<script setup lang="ts">
/**
 * Состояние загрузки панели.
 *
 * `EmptyState` в кабинете один на всех (27 файлов), а загрузка была разной:
 * двенадцать мест писали инлайновое «Загрузка…» с тремя разными паддингами,
 * где-то крутился Loader2, где-то собирались скелетоны руками, а готовый
 * `ui/skeleton` не использовался нигде. Одинаковый ритм с EmptyState — чтобы
 * панель не «прыгала» при появлении данных.
 */
import { cn } from '@/lib/utils'

withDefaults(defineProps<{
  /** сколько строк-скелетонов рисовать; 0 — просто подпись */
  rows?: number
  label?: string
  compact?: boolean
  class?: string
}>(), { rows: 3, label: 'Загрузка…', compact: false })
</script>

<template>
  <div :class="cn('flex flex-col items-stretch justify-center', compact ? 'py-6' : 'py-12', $props.class)">
    <template v-if="rows > 0">
      <div class="space-y-2.5" aria-hidden="true">
        <div
          v-for="i in rows" :key="i"
          class="h-3 animate-pulse rounded bg-surface-hover"
          :style="{ width: `${100 - (i - 1) * 12}%` }"
        ></div>
      </div>
    </template>
    <p class="mt-4 text-center text-[12.5px] text-muted-foreground">{{ label }}</p>
  </div>
</template>
