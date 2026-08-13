<script setup lang="ts">
/**
 * Библиотека сгенерированных картинок — модалка выбора фона.
 * Паттерн из Mobbin (Squarespace My Library, Shopify «Select image», Kit Media
 * Gallery): шапка с поиском, ровная сетка плиток, выбранная помечается, снизу
 * действие. Метаданные под плиткой — как в истории генераций ElevenLabs:
 * модель, формат, цена, дата.
 */
import { computed, ref } from 'vue'
import { Check, ImageOff, Search, X } from 'lucide-vue-next'
import { intlLocale } from '@/i18n'
import type { GeneratedImage } from '@/composables/useAiBackground'

const props = defineProps<{ images: GeneratedImage[]; current?: string }>()
const emit = defineEmits<{ pick: [GeneratedImage]; close: [] }>()

const q = ref('')
const selected = ref<GeneratedImage | null>(null)

const list = computed(() => {
  const s = q.value.trim().toLowerCase()
  if (!s) return props.images
  return props.images.filter((i) =>
    (i.prompt || '').toLowerCase().includes(s) || (i.model || '').toLowerCase().includes(s))
})

const modelLabel = (id: string | null) => (id || '').split('/').pop() || '—'
const dateLabel = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short' })
}

function apply() {
  const img = selected.value || list.value[0]
  if (img) emit('pick', img)
}
</script>

<template>
  <!-- В body: инспектор лежит внутри своего стек-контекста, и модалка иначе
       уезжает ПОД сайдбар кабинета. -->
  <Teleport to="body">
    <div class="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/60 p-4 backdrop-blur-sm sm:p-8" @click.self="emit('close')">
    <div class="my-auto flex max-h-[86dvh] w-full max-w-[900px] flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl shadow-black/40">
      <!-- шапка: поиск + закрыть -->
      <div class="flex items-center gap-3 border-b border-border px-5 py-3.5">
        <div class="shrink-0 text-[15px] font-semibold">{{ $t('preview.library.title') }}</div>
        <span class="shrink-0 text-[12px] text-muted-foreground">{{ images.length }}</span>
        <label class="relative ml-2 flex min-w-0 flex-1 items-center">
          <Search :size="14" class="pointer-events-none absolute left-2.5 text-muted-foreground/60" />
          <input
            v-model="q" :placeholder="$t('preview.library.search')"
            class="h-8 w-full rounded-lg border border-border bg-surface pl-8 pr-2.5 text-[12.5px] outline-none focus:border-ring"
          >
        </label>
        <button type="button" class="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-surface-hover hover:text-foreground" @click="emit('close')">
          <X :size="15" />
        </button>
      </div>

      <!-- сетка -->
      <div class="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
        <div v-if="!list.length" class="flex flex-col items-center gap-2 py-16 text-muted-foreground">
          <ImageOff :size="22" class="opacity-60" />
          <p class="text-[13px]">{{ images.length ? $t('preview.library.notFound') : $t('preview.library.empty') }}</p>
        </div>

        <div v-else class="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <button
            v-for="img in list" :key="img.id || img.url" type="button"
            class="group overflow-hidden rounded-xl border text-left transition"
            :class="(selected?.url || current) === img.url ? 'border-brand-accent' : 'border-border hover:border-muted-foreground/40'"
            @click="selected = img" @dblclick="emit('pick', img)"
          >
            <div class="relative aspect-video">
              <img :src="img.url" alt="" class="size-full object-cover" loading="lazy">
              <span
                v-if="(selected?.url || current) === img.url"
                class="absolute right-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-foreground text-background"
              ><Check :size="12" /></span>
            </div>
            <div class="space-y-1 px-2.5 py-2">
              <p class="truncate text-[12px] text-muted-foreground" :title="img.prompt || ''">{{ img.prompt || $t('preview.library.noPrompt') }}</p>
              <div class="flex items-center gap-1.5 text-[10.5px] text-muted-foreground/60">
                <span class="rounded border border-border px-1.5 py-0.5">{{ modelLabel(img.model) }}</span>
                <span v-if="img.credits != null" class="tabular-nums">{{ $t('preview.ai.credits', { n: img.credits }) }}</span>
                <span class="ml-auto tabular-nums">{{ dateLabel(img.createdAt) }}</span>
              </div>
            </div>
          </button>
        </div>
      </div>

      <!-- действие -->
      <div class="flex items-center gap-2 border-t border-border px-5 py-3">
        <span class="text-[11.5px] text-muted-foreground/70">{{ $t('preview.library.note') }}</span>
        <button type="button" class="ml-auto h-8 rounded-lg border border-border px-3 text-[12.5px] text-muted-foreground transition hover:text-foreground" @click="emit('close')">
          {{ $t('action.cancel') }}
        </button>
        <button
          type="button" class="h-8 rounded-lg bg-foreground px-3 text-[12.5px] font-medium text-background transition disabled:opacity-45"
          :disabled="!selected && !list.length" @click="apply"
        >
          {{ $t('preview.library.apply') }}
        </button>
      </div>
      </div>
    </div>
  </Teleport>
</template>
