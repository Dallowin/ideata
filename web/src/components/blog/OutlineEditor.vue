<script setup lang="ts">
// Шаг «Структура» (awaiting_outline): агент собрал план — правишь секции
// (заголовок, интент, тезисы, объём), двигаешь/удаляешь/добавляешь. → approve.
import { computed, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, Check, LayoutList, Loader2, Plus, Trash2 } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'

interface EditSection { heading: string; intent: string; pointsText: string; estWords: number }
const props = defineProps<{
  outline: any
  perspectives?: { name: string; rationale?: string }[]
  submitting?: boolean
  reviewOnly?: boolean
  /** ошибка шага «утвердить» — иначе кнопка просто «не срабатывает» */
  error?: string
}>()
const emit = defineEmits<{ approve: [any] }>()

const title = ref('')
const angle = ref('')
const audience = ref('')
const sections = ref<EditSection[]>([])

watch(() => props.outline, (o) => {
  if (!o) return
  title.value = o.title || ''
  angle.value = o.angle || ''
  audience.value = o.audience || ''
  sections.value = (o.sections || []).map((s: any) => ({
    heading: s.heading || '',
    intent: s.intent || '',
    pointsText: (s.points || []).join('\n'),
    estWords: s.estWords || 200,
  }))
}, { immediate: true })

function move(i: number, dir: -1 | 1) {
  const j = i + dir
  if (j < 0 || j >= sections.value.length) return
  const arr = [...sections.value]
  ;[arr[i], arr[j]] = [arr[j]!, arr[i]!]
  sections.value = arr
}
function remove(i: number) { sections.value = sections.value.filter((_, k) => k !== i) }
function add() { sections.value = [...sections.value, { heading: '', intent: '', pointsText: '', estWords: 200 }] }

const totalWords = computed(() => sections.value.reduce((s, x) => s + (Number(x.estWords) || 0), 0))
const valid = computed(() => sections.value.some((s) => s.heading.trim()))

function approve() {
  emit('approve', {
    title: title.value.trim(),
    angle: angle.value.trim(),
    audience: audience.value.trim(),
    sections: sections.value
      .filter((s) => s.heading.trim())
      .map((s) => ({
        heading: s.heading.trim(),
        intent: s.intent.trim(),
        points: s.pointsText.split('\n').map((p) => p.trim()).filter(Boolean),
        estWords: Math.min(1500, Math.max(60, Number(s.estWords) || 200)),
      })),
  })
}
</script>

<template>
  <div class="w-full px-4 py-6 sm:px-6 sm:py-8">
    <div class="mb-1 flex items-center gap-2">
      <LayoutList :size="16" class="text-brand-accent" />
      <h2 class="text-[16px] font-semibold">{{ $t('blog.pages.run.outlineEditor.title') }}</h2>
    </div>
    <p class="mb-4 text-[13px] text-muted-foreground">{{ $t('blog.pages.run.outlineEditor.hint') }}</p>

    <!-- мета -->
    <div class="mb-4 space-y-2 rounded-xl border border-border bg-surface p-3.5">
      <input v-model="title" :placeholder="$t('blog.pages.run.outlineEditor.titlePlaceholder')" class="w-full bg-transparent text-[15px] font-semibold outline-none placeholder:text-muted-foreground/40">
      <input v-model="angle" :placeholder="$t('blog.pages.run.outlineEditor.anglePlaceholder')" class="w-full bg-transparent text-[12.5px] text-muted-foreground outline-none placeholder:text-muted-foreground/40">
      <input v-model="audience" :placeholder="$t('blog.pages.run.outlineEditor.audiencePlaceholder')" class="w-full bg-transparent text-[12.5px] text-muted-foreground outline-none placeholder:text-muted-foreground/40">
    </div>

    <!-- перспективы (подсказка) -->
    <div v-if="perspectives?.length" class="mb-4 flex flex-wrap gap-1.5">
      <span v-for="p in perspectives" :key="p.name" class="rounded-full border border-border px-2 py-0.5 text-[11.5px] text-muted-foreground" :title="p.rationale">{{ p.name }}</span>
    </div>

    <!-- секции -->
    <div class="space-y-2.5">
      <div v-for="(s, i) in sections" :key="i" class="rounded-xl border border-border bg-surface p-3">
        <div class="flex items-center gap-2">
          <span class="grid size-6 shrink-0 place-items-center rounded-md bg-surface-hover font-mono text-[11px] text-muted-foreground">{{ i + 1 }}</span>
          <input v-model="s.heading" :placeholder="$t('blog.pages.run.outlineEditor.sectionHeading')" class="min-w-0 flex-1 bg-transparent text-[14px] font-medium outline-none placeholder:text-muted-foreground/40">
          <div class="flex shrink-0 items-center gap-0.5">
            <button type="button" class="grid size-7 place-items-center rounded-md text-muted-foreground/60 transition hover:text-foreground disabled:opacity-30" :disabled="i === 0" @click="move(i, -1)"><ArrowUp :size="14" /></button>
            <button type="button" class="grid size-7 place-items-center rounded-md text-muted-foreground/60 transition hover:text-foreground disabled:opacity-30" :disabled="i === sections.length - 1" @click="move(i, 1)"><ArrowDown :size="14" /></button>
            <button type="button" class="grid size-7 place-items-center rounded-md text-muted-foreground/60 transition hover:text-danger" @click="remove(i)"><Trash2 :size="14" /></button>
          </div>
        </div>
        <input v-model="s.intent" :placeholder="$t('blog.pages.run.outlineEditor.sectionIntent')" class="mt-1.5 w-full bg-transparent pl-8 text-[12px] text-muted-foreground outline-none placeholder:text-muted-foreground/40">
        <textarea v-model="s.pointsText" rows="3" :placeholder="$t('blog.pages.run.outlineEditor.sectionPoints')" class="mt-1.5 w-full resize-none rounded-lg border border-border bg-background px-2.5 py-2 text-[12.5px] outline-none focus:border-ring"></textarea>
        <div class="mt-1.5 flex items-center gap-2 pl-8">
          <span class="text-[11px] text-muted-foreground/60">{{ $t('blog.pages.run.outlineEditor.sectionWords') }}</span>
          <input v-model.number="s.estWords" type="number" min="60" max="1500" step="20" class="h-7 w-20 rounded-md border border-border bg-background px-2 text-[12px] outline-none focus:border-ring">
        </div>
      </div>
    </div>

    <button type="button" class="mt-2.5 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2.5 text-[12.5px] text-muted-foreground transition hover:border-solid hover:text-foreground" @click="add">
      <Plus :size="14" /> {{ $t('blog.pages.run.outlineEditor.addSection') }}
    </button>

    <p v-if="error" class="mt-4 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{{ error }}</p>

    <!-- утвердить -->
    <div class="mt-5 flex items-center gap-3">
      <span class="text-[12.5px] text-muted-foreground">{{ $t('blog.pages.run.outlineEditor.summary', { sections: sections.length, words: totalWords }) }}</span>
      <Button class="ml-auto" :disabled="submitting || reviewOnly || !valid" @click="approve">
        <Loader2 v-if="submitting" :size="14" class="animate-spin" /><Check v-else :size="14" /> {{ $t('blog.pages.run.outlineEditor.submit') }}
      </Button>
    </div>
  </div>
</template>
