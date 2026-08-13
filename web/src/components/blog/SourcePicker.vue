<script setup lang="ts">
// Шаг «Источники» (awaiting_sources): агент нашёл статьи по теме — выбираешь,
// на каких строить структуру, можно докинуть свои URL. → continue.
import { computed, ref, watch } from 'vue'
import { ArrowRight, Check, ExternalLink, Loader2, Search } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'

interface Src { url: string; title: string; text?: string; keyPoints?: string[]; query?: string; snippet?: string; fetched?: boolean }
const props = defineProps<{
  sources: Src[]
  searchQueries?: { query: string; angle?: string }[]
  submitting?: boolean
  reviewOnly?: boolean
  /** ошибка шага «продолжить» — иначе кнопка просто «не срабатывает» */
  error?: string
}>()
const emit = defineEmits<{ continue: [{ selectedUrls: string[]; extraUrls: string[] }] }>()

const fetched = computed(() => props.sources.filter((s) => s.fetched !== false))
const selected = ref<Set<string>>(new Set(fetched.value.map((s) => s.url)))
watch(() => props.sources, () => { selected.value = new Set(fetched.value.map((s) => s.url)) })

const activeQuery = ref<string | null>(null)
const shown = computed(() => activeQuery.value ? props.sources.filter((s) => s.query === activeQuery.value) : props.sources)

const extraText = ref('')
const extraUrls = computed(() => extraText.value.split('\n').map((s) => s.trim()).filter((u) => /^https?:\/\//.test(u)))

function toggle(url: string) {
  const s = new Set(selected.value)
  s.has(url) ? s.delete(url) : s.add(url)
  selected.value = s
}
const domain = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return u } }
function submit() {
  emit('continue', { selectedUrls: [...selected.value], extraUrls: extraUrls.value })
}
</script>

<template>
  <div class="w-full px-4 py-6 sm:px-6 sm:py-8">
    <div class="mb-1 flex items-center gap-2">
      <Search :size="16" class="text-brand-accent" />
      <h2 class="text-[16px] font-semibold">{{ $t('blog.pages.run.sourcePicker.title') }}</h2>
    </div>
    <p class="mb-4 text-[13px] text-muted-foreground">{{ $t('blog.pages.run.sourcePicker.hint') }}</p>

    <!-- фильтр по запросам -->
    <div v-if="searchQueries?.length" class="mb-3 flex flex-wrap gap-1.5">
      <button
        v-for="q in searchQueries" :key="q.query" type="button"
        class="rounded-full border px-2.5 py-1 text-[12px] transition"
        :class="activeQuery === q.query ? 'border-transparent bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground'"
        @click="activeQuery = activeQuery === q.query ? null : q.query"
      >{{ q.query }}</button>
    </div>

    <!-- Список источников. На широком экране в две колонки: карточка источника
         низкая, и в одну колонку на 1180px это была лента из воздуха. -->
    <div class="grid gap-2 xl:grid-cols-2">
      <button
        v-for="s in shown" :key="s.url" type="button"
        class="flex w-full items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition"
        :class="selected.has(s.url) ? 'border-brand-accent/40 bg-brand-accent-soft' : 'border-border bg-surface hover:bg-surface-2'"
        @click="toggle(s.url)"
      >
        <span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border" :class="selected.has(s.url) ? 'border-transparent bg-foreground text-background' : 'border-border'">
          <Check v-if="selected.has(s.url)" :size="13" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="flex items-center gap-1.5">
            <span class="min-w-0 flex-1 truncate text-[13.5px] font-medium">{{ s.title || domain(s.url) }}</span>
            <a :href="s.url" target="_blank" rel="noopener" class="shrink-0 text-muted-foreground/50 hover:text-foreground" @click.stop><ExternalLink :size="13" /></a>
          </span>
          <span class="mt-0.5 block truncate text-[11.5px] text-muted-foreground">{{ domain(s.url) }}</span>
          <span v-if="s.snippet || s.keyPoints?.length" class="mt-1 block line-clamp-2 text-[12px] text-muted-foreground/80">{{ s.snippet || s.keyPoints?.join(' · ') }}</span>
        </span>
      </button>
      <p v-if="!shown.length" class="rounded-xl border border-border bg-surface px-4 py-6 text-center text-[13px] text-muted-foreground xl:col-span-2">{{ $t('blog.pages.run.sourcePicker.empty') }}</p>
    </div>

    <!-- свои URL -->
    <div class="mt-4">
      <label class="mb-1 block text-[12px] text-muted-foreground">{{ $t('blog.pages.run.sourcePicker.ownLinks') }}</label>
      <textarea v-model="extraText" rows="2" placeholder="https://…" class="w-full resize-none rounded-lg border border-border bg-surface px-3 py-2 text-[12.5px] outline-none focus:border-ring"></textarea>
      <p v-if="extraUrls.length" class="mt-1 text-[11.5px] text-success">{{ $t('blog.pages.run.sourcePicker.extraCount', { n: extraUrls.length }) }}</p>
    </div>

    <p v-if="error" class="mt-4 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{{ error }}</p>

    <!-- продолжить -->
    <div class="mt-5 flex items-center gap-3">
      <span class="text-[12.5px] text-muted-foreground">{{ $t('blog.pages.run.sourcePicker.next', { n: selected.size + extraUrls.length }) }}</span>
      <Button class="ml-auto" :disabled="submitting || reviewOnly || (selected.size + extraUrls.length === 0)" @click="submit">
        <Loader2 v-if="submitting" :size="14" class="animate-spin" /><ArrowRight v-else :size="14" /> {{ $t('blog.pages.run.sourcePicker.submit') }}
      </Button>
    </div>
  </div>
</template>
