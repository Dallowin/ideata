<script setup lang="ts">
/**
 * Маркер бренда в списках мониторинга.
 *
 * Раньше рядом с доменом стоял цветной квадрат из палитры. На графике цвет
 * несёт смысл — он связывает линию с брендом. А в таблице он не сообщает
 * ничего: цвет назначается по порядку появления конкурента и меняется от
 * прогона к прогону. Домен опознаётся по фавиконке за долю секунды.
 *
 * Фавиконка не загрузилась (нет иконки, блокировщик, оффлайн) → возвращаем тот
 * же цветной квадрат, чтобы строка не съехала и маркер не пропал.
 */
import { ref } from 'vue'
import { brandFavicon } from '@/data/dashboard'
import { isDemoMode } from '@/lib/api'

const props = withDefaults(defineProps<{
  brand: string
  /** цвет из палитры — фолбэк, когда иконки нет */
  color?: string
  size?: number
}>(), { size: 14 })

// В демо домены вымышленные: сервис фавиконок на них отдаёт не ошибку, а
// одинаковый серый глобус — фолбэк не срабатывает, и весь список выглядит
// сломанным. Там сразу берём цветной квадрат.
const failed = ref(isDemoMode())
</script>

<template>
  <img
    v-if="!failed && brand"
    :src="brandFavicon(props.brand)" alt="" loading="lazy"
    class="shrink-0 rounded-[3px] object-contain"
    :style="{ width: `${props.size}px`, height: `${props.size}px` }"
    @error="failed = true"
  />
  <span
    v-else class="shrink-0 rounded-[3px]"
    :style="{
      width: `${Math.round(props.size * 0.6)}px`,
      height: `${Math.round(props.size * 0.6)}px`,
      background: props.color || 'var(--color-brand)',
    }"
  ></span>
</template>
