<script setup lang="ts">
/**
 * Переключатель темы кабинета. Форма та же, что у переключателя языка рядом —
 * два состояния в одной пилюле, а не иконка-загадка: рядом стоящие контролы
 * должны выглядеть одинаково.
 */
import { Moon, Sun } from 'lucide-vue-next'
import { useTheme } from '@/composables/useTheme'

const { theme, set } = useTheme()
</script>

<template>
  <div class="flex items-center gap-0.5 rounded-full border border-border/60 p-0.5" role="group" :aria-label="$t('theme.label')">
    <button
      v-for="opt in (['light', 'dark'] as const)" :key="opt"
      type="button"
      class="grid size-6 place-items-center rounded-full text-[11px] transition"
      :class="theme === opt ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'"
      :aria-pressed="theme === opt"
      :title="$t(`theme.${opt}`)"
      @click="set(opt)"
    >
      <component :is="opt === 'light' ? Sun : Moon" :size="13" />
    </button>
  </div>
</template>
