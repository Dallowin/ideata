<script setup lang="ts">
/**
 * Метка демо-режима. Режим включается один раз по ?demo=1 и живёт в
 * sessionStorage до конца вкладки — при этом трекер и список брендов
 * подменяются фикстурой. Без видимой метки это неотличимо от «кабинет
 * показывает вымышленные данные», поэтому она обязательна, пока флаг стоит.
 */
import { FlaskConical, X } from 'lucide-vue-next'
import { exitDemoMode, isDemoMode } from '@/lib/api'

const demo = isDemoMode()
</script>

<template>
  <button
    v-if="demo" type="button"
    class="flex w-full items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2 py-1.5 text-[11px] font-medium text-amber-200 transition hover:bg-amber-400/15"
    :title="$t('demo.exit')"
    @click="exitDemoMode()"
  >
    <FlaskConical :size="12" class="shrink-0" />
    <span class="truncate">{{ $t('demo.badge') }}</span>
    <X :size="12" class="ml-auto shrink-0 opacity-70" />
  </button>
</template>
