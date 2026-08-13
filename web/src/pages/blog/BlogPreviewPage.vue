<script setup lang="ts">
// Раздел «Обложки» — та же студия, что открывается модалкой внутри статьи
// (components/preview/CoverStudio.vue). Страница нужна для работы со всеми
// статьями сразу: цель выбирается дропдауном в шапке студии.
import CoverStudio from '@/components/preview/CoverStudio.vue'
</script>

<template>
  <CoverStudio />
</template>
