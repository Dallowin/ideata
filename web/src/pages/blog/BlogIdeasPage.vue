<script setup lang="ts">
// «Идеи тем»: агент предлагает заголовки статей под бренд (угол, интент, ключ,
// AEO-запросы, score). Клик «Написать статью» уносит в /blog/new с готовой темой.
// Данные: content.controller /topics/ideas (кэш бренда) + /topics/competitors.
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { Check, Copy, EyeOff, Lightbulb, Loader2, PenLine, Radar, TriangleAlert } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import BlogPageHeader from '@/components/blog/BlogPageHeader.vue'
import EmptyState from '@/components/EmptyState.vue'
import IdeataLoader from '@/components/IdeataLoader.vue'
import { api } from '@/lib/api'
import { useBlogIdeas, type Idea } from '@/composables/useBlogIdeas'

const router = useRouter()
const { t } = useI18n()

const INTENT_LABELS = computed<Record<string, string>>(() => ({
  informational: t('blog.pages.ideas.intent.informational'),
  commercial: t('blog.pages.ideas.intent.commercial'),
  transactional: t('blog.pages.ideas.intent.transactional'),
  navigational: t('blog.pages.ideas.intent.navigational'),
}))

// кэш-синглтон: возврат на страницу отдаёт данные мгновенно, без перезагрузки
const { state, load } = useBlogIdeas()
const ideas = computed<Idea[]>({ get: () => state.brand, set: (v) => { state.brand = v } })
const compIdeas = computed<Idea[]>({ get: () => state.competitors, set: (v) => { state.competitors = v } })
const loading = computed(() => state.loading)

const tab = ref<'brand' | 'competitors'>('brand')
const seed = ref('')
const busy = ref<'' | 'gen' | 'more' | 'comp'>('')
const copied = ref('')
const error = ref('')

const list = computed(() => (tab.value === 'brand' ? ideas.value : compIdeas.value))

onMounted(() => { load() })

async function generate(append = false) {
  if (busy.value) return
  busy.value = append ? 'more' : 'gen'
  error.value = ''
  try {
    const r = await api.blogGenTopicIdeas(seed.value.trim() || undefined, append)
    ideas.value = r?.topics || []
  } catch (e: any) {
    error.value = e?.status === 402 ? t('blog.pages.ideas.errors.ideasTariff') : t('blog.pages.ideas.errors.ideasFailed')
  } finally {
    busy.value = ''
  }
}

async function generateCompetitors() {
  if (busy.value) return
  busy.value = 'comp'
  error.value = ''
  try {
    const r = await api.blogGenCompetitorIdeas()
    compIdeas.value = r?.topics || []
  } catch (e: any) {
    error.value = e?.status === 402 ? t('blog.pages.ideas.errors.competitorsTariff') : t('blog.pages.ideas.errors.competitorsFailed')
  } finally {
    busy.value = ''
  }
}

function write(t: Idea) {
  router.push({ path: '/blog/new', query: { topic: t.title, q: (t.queries || []).join('|') } })
}

// «Скрыть» есть только у идей под бренд: у конкурентов бэк ничего не помнит,
// и скрытая карточка возвращалась при первом же обновлении списка
async function hide(t: Idea) {
  ideas.value = ideas.value.filter((x) => x.title !== t.title)
  try {
    await api.blogHideTopicIdea(t.title)
  } catch { /* локально уже убрали */ }
}

async function copy(t: Idea) {
  const text = [t.title, t.angle, ...(t.queries || []).map((q) => `— ${q}`)].filter(Boolean).join('\n')
  try {
    await navigator.clipboard.writeText(text)
    copied.value = t.title
    setTimeout(() => { if (copied.value === t.title) copied.value = '' }, 1500)
  } catch { /* clipboard недоступен */ }
}
</script>

<template>
  <div class="space-y-4 p-5 lg:p-6">
    <BlogPageHeader :title="$t('blog.pages.ideas.title')" :subtitle="$t('blog.pages.ideas.subtitle')">
      <template #actions>
        <div class="flex rounded-lg border border-border bg-surface p-0.5">
          <button class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors" :class="tab === 'brand' ? 'bg-surface-hover text-foreground' : 'text-muted-foreground hover:text-foreground'" @click="tab = 'brand'"><Lightbulb :size="13" /> {{ $t('blog.pages.ideas.tabs.brand') }}</button>
          <button class="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors" :class="tab === 'competitors' ? 'bg-surface-hover text-foreground' : 'text-muted-foreground hover:text-foreground'" @click="tab = 'competitors'"><Radar :size="13" /> {{ $t('blog.pages.ideas.tabs.competitors') }}</button>
        </div>
      </template>
    </BlogPageHeader>

    <!-- генерация под бренд -->
    <div v-if="tab === 'brand'" class="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface p-3">
      <input v-model="seed" :placeholder="$t('blog.pages.ideas.seedPlaceholder')" class="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-ring" @keydown.enter="generate()">
      <Button :disabled="!!busy" @click="generate(false)"><Loader2 v-if="busy === 'gen'" :size="14" class="animate-spin" /> {{ $t('blog.pages.ideas.generate') }}</Button>
      <Button v-if="ideas.length" variant="outline" class="border-border bg-surface" :disabled="!!busy" @click="generate(true)"><Loader2 v-if="busy === 'more'" :size="14" class="animate-spin" /><span v-else>{{ $t('blog.pages.ideas.more') }}</span></Button>
    </div>
    <div v-else class="flex items-center justify-between gap-2 rounded-xl border border-border bg-surface p-3">
      <p class="text-[12.5px] text-muted-foreground">{{ $t('blog.pages.ideas.competitorsHint') }}</p>
      <Button :disabled="!!busy" @click="generateCompetitors"><Loader2 v-if="busy === 'comp'" :size="14" class="animate-spin" /><Radar v-else :size="14" /> {{ $t('action.refresh') }}</Button>
    </div>

    <p v-if="error" class="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{{ error }}</p>

    <!-- загрузка кэша идей -->
    <div v-if="loading" class="relative min-h-[55vh]"><IdeataLoader variant="solid" /></div>

    <!-- оба запроса упали — это не «идей нет» -->
    <div v-else-if="state.failed && !list.length" class="flex flex-col items-center gap-3 py-16 text-center">
      <TriangleAlert :size="26" class="text-danger/70" />
      <p class="text-[13px] text-muted-foreground">{{ $t('blog.pages.ideas.loadFailed') }}</p>
      <Button variant="outline" size="sm" class="border-border bg-surface" @click="load(true)">{{ $t('action.retry') }}</Button>
    </div>

    <!-- пусто -->
    <EmptyState v-else-if="!list.length" :icon="Lightbulb" :title="$t('blog.pages.ideas.empty.title')" :hint="tab === 'brand' ? $t('blog.pages.ideas.empty.brand') : $t('blog.pages.ideas.empty.competitors')" />

    <!-- карточки идей: заголовок не уникален (модель повторяется), ключ — с индексом -->
    <div v-else class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      <article v-for="(t, i) in list" :key="`${i}-${t.title}`" class="flex flex-col rounded-xl border border-border bg-surface p-4 transition-colors hover:bg-surface-2">
        <div class="mb-1.5 flex items-start gap-2">
          <h3 class="min-w-0 flex-1 text-[14.5px] font-semibold leading-snug">{{ t.title }}</h3>
          <span v-if="t.intent" class="shrink-0 rounded-md bg-surface-hover px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{{ INTENT_LABELS[t.intent] || t.intent }}</span>

        </div>
        <p v-if="t.angle" class="text-[12.5px] leading-relaxed text-muted-foreground">{{ t.angle }}</p>

        <div v-if="t.queries?.length" class="mt-2.5 flex flex-wrap gap-1">
          <span v-for="(q, i) in t.queries.slice(0, 4)" :key="i" class="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">{{ q }}</span>
        </div>

        <div class="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
          <span v-if="t.score != null" class="tabular-nums" :title="$t('blog.pages.ideas.aeoTitle')">{{ $t('blog.pages.ideas.aeo', { n: Math.round(t.score) }) }}</span>
          <a v-if="t.source?.url" :href="t.source.url" target="_blank" rel="noopener" class="truncate text-brand-accent hover:underline">{{ t.source.domain || $t('blog.pages.ideas.source') }}</a>
        </div>

        <div class="mt-3 flex items-center gap-1.5 border-t border-border/60 pt-3">
          <Button size="sm" class="flex-1" @click="write(t)"><PenLine :size="13" /> {{ $t('blog.pages.ideas.write') }}</Button>
          <button type="button" class="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-surface-hover hover:text-foreground" :title="copied === t.title ? $t('action.copied') : $t('action.copy')" @click="copy(t)"><Check v-if="copied === t.title" :size="15" /><Copy v-else :size="15" /></button>
          <button v-if="tab === 'brand'" type="button" class="grid size-8 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-surface-hover hover:text-foreground" :title="$t('blog.pages.ideas.hide')" @click="hide(t)"><EyeOff :size="15" /></button>
        </div>
      </article>
    </div>
  </div>
</template>
