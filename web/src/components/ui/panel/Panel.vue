<script setup lang="ts">
/**
 * Панель — базовая карточка кабинета.
 *
 * Связка `rounded-xl border border-border bg-surface` повторялась 86
 * раз, а шапка «заголовок слева, действие справа» — 31 раз дословно. Одинаковые
 * по смыслу блоки при этом отличались на глаз: то радиус другой, то паддинг, то
 * градация фона. Здесь один источник правды; поверхность берётся из токена
 * (--color-surface), а не из захардкоженной прозрачности.
 *
 * Заголовок и описание можно передать пропсами, действие справа — слотом
 * `action`. Если шапка не нужна (панель целиком своя) — просто не передавайте
 * title, и останется одна рамка с содержимым.
 */
import { cn } from '@/lib/utils'

withDefaults(defineProps<{
  title?: string
  description?: string
  /** убрать внутренние отступы у содержимого — для таблиц во всю ширину */
  flush?: boolean
  class?: string
}>(), { flush: false })
</script>

<template>
  <section :class="cn('overflow-hidden rounded-xl border border-border bg-surface', $props.class)">
    <header
      v-if="title || $slots.action || $slots.header"
      class="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3"
    >
      <slot name="header">
        <div class="min-w-0">
          <h2 class="text-[13px] font-medium">{{ title }}</h2>
          <p v-if="description" class="mt-0.5 text-[11.5px] text-muted-foreground">{{ description }}</p>
        </div>
      </slot>
      <div v-if="$slots.action" class="flex shrink-0 items-center gap-2">
        <slot name="action" />
      </div>
    </header>

    <div :class="flush ? '' : 'p-4'">
      <slot />
    </div>
  </section>
</template>
