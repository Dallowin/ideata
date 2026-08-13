<script setup lang="ts">
// Единый хедер страниц Blog Writer: «h1 + сабтайтл слева, главный контрол
// справа» (канон взят с «Интеграции»). Крошки «Blog Writer ›» тут нет —
// раздел уже назван в шапке шелла и в сайдбаре, дубль только шумит.
defineProps<{ title: string; subtitle?: string }>()
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
    <div class="min-w-0">
      <h1 class="text-[22px] font-bold tracking-[-0.025em]">{{ title }}</h1>
      <p v-if="subtitle" class="mt-1 text-[13px] text-muted-foreground">{{ subtitle }}</p>
    </div>
    <!-- главный контрол страницы (поиск / генерация / табы) -->
    <div v-if="$slots.actions" class="flex flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
