<script setup lang="ts">
/**
 * Шапка страницы: заголовок, подпись под ним и действия справа.
 *
 * Паттерн совпадал на семи страницах до пикселя (`h1 text-lg font-semibold
 * tracking-tight` + `p mt-0.5 text-[12.5px] text-muted-foreground`), но был
 * собран заново в каждой — поэтому любая правка вроде «подвинуть экспорт
 * вправо» превращалась в точечную операцию по всем файлам.
 *
 * Слот `meta` — то, что стоит рядом с заголовком (индикатор идущего прогона).
 * Слот `actions` — правый край: кнопки и подписи вроде свежести данных.
 */
import { cn } from '@/lib/utils'

defineProps<{
  title: string
  description?: string
  class?: string
}>()
</script>

<template>
  <div :class="cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-3', $props.class)">
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <h1 class="text-lg font-semibold tracking-tight">{{ title }}</h1>
        <slot name="meta" />
      </div>
      <p v-if="description || $slots.description" class="mt-0.5 truncate text-[12.5px] text-muted-foreground">
        <slot name="description">{{ description }}</slot>
      </p>
    </div>

    <div v-if="$slots.actions" class="ml-auto flex shrink-0 items-center gap-3">
      <slot name="actions" />
    </div>
  </div>
</template>
