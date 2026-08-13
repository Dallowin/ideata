<script setup lang="ts">
// Единый пустой стейт: «Нет данных» + опциональная подсказка.
// Заголовок по умолчанию берём из словаря: в withDefaults константу не подставить
// — она бы застыла на языке первого рендера.
import { computed, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { Inbox } from 'lucide-vue-next'

const props = withDefaults(defineProps<{
  title?: string
  hint?: string
  compact?: boolean
  /** своя иконка раздела (по умолчанию — общий Inbox) */
  icon?: Component
}>(), { title: '', icon: undefined })

const { t } = useI18n()
const heading = computed(() => props.title || t('state.noData'))
</script>

<template>
  <div class="flex flex-col items-center justify-center gap-1.5 text-center" :class="compact ? 'py-6' : 'py-10'">
    <component :is="icon || Inbox" :size="compact ? 16 : 20" class="text-muted-foreground/50" />
    <p class="text-[13px] font-medium text-muted-foreground">{{ heading }}</p>
    <p v-if="hint" class="max-w-sm text-[12px] leading-snug text-muted-foreground/70">{{ hint }}</p>
    <!-- действие пустого состояния (напр. «Начать новую тему») -->
    <div v-if="$slots.action" class="mt-2"><slot name="action" /></div>
  </div>
</template>
