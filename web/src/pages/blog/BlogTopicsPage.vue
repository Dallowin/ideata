<script setup lang="ts">
// «Темы» Blog Writer: реальные статьи бренда, фильтры-чипы по статусу,
// поиск, грид/лист, сортировка (референс — LobeHub topics).
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import {
  Eye, FileText, Languages, LayoutGrid, List, Loader2, MessagesSquare, MoreHorizontal,
  Search, SquarePen, Trash2, TriangleAlert,
} from 'lucide-vue-next'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import BlogPageHeader from '@/components/blog/BlogPageHeader.vue'
import EmptyState from '@/components/EmptyState.vue'
import IdeataLoader from '@/components/IdeataLoader.vue'
import { api } from '@/lib/api'
import { useBlogRuns, runPhase, groupByLocale, type RunPhase, type BlogGroup } from '@/composables/useBlogRuns'
import { intlLocale } from '@/i18n'

const route = useRoute()
const { t } = useI18n()
const { state, load } = useBlogRuns()
onMounted(() => load())

const q = ref('')
const view = ref<'grid' | 'list'>('grid')
const sort = ref<'updated' | 'created' | 'views'>('updated')
const phase = ref<RunPhase | 'all'>('all')

const PHASES = computed<{ key: RunPhase | 'all'; label: string }[]>(() => [
  { key: 'all', label: t('blog.pages.topics.filters.all') },
  { key: 'running', label: t('blog.pages.topics.filters.running') },
  { key: 'awaiting', label: t('blog.pages.topics.filters.awaiting') },
  { key: 'draft', label: t('blog.pages.topics.filters.draft') },
  { key: 'ready', label: t('blog.pages.topics.filters.ready') },
  { key: 'published', label: t('blog.pages.topics.filters.published') },
  { key: 'error', label: t('blog.pages.topics.filters.error') },
])

// схлопываем переводы: одна статья = одна тема (представитель + бейдж локалей)
const groups = computed(() => groupByLocale(state.runs))

const counts = computed(() => {
  const c: Record<string, number> = { all: groups.value.length }
  for (const p of ['running', 'awaiting', 'draft', 'ready', 'published', 'error']) c[p] = 0
  for (const r of groups.value) c[runPhase(r)] = (c[runPhase(r)] ?? 0) + 1
  return c
})

const visiblePhases = computed(() => PHASES.value.filter((p) => p.key === 'all' || (counts.value[p.key] ?? 0) > 0))

const filtered = computed(() => {
  let r = groups.value
  if (phase.value !== 'all') r = r.filter((x) => runPhase(x) === phase.value)
  if (q.value.trim()) {
    const s = q.value.trim().toLowerCase()
    r = r.filter((x) => (x.title || '').toLowerCase().includes(s) || (x.topic || '').toLowerCase().includes(s))
  }
  return [...r].sort((a, b) => {
    // темы, которые ждут решения автора, — всегда сверху: пока их не тронешь,
    // они не сдвинутся, а по дате обновления они тонут в общем списке
    const wa = runPhase(a) === 'awaiting' ? 0 : 1
    const wb = runPhase(b) === 'awaiting' ? 0 : 1
    if (wa !== wb) return wa - wb
    if (sort.value === 'views') return (b.views ?? 0) - (a.views ?? 0)
    const ka = sort.value === 'created' ? a.createdAt : a.updatedAt
    const kb = sort.value === 'created' ? b.createdAt : b.updatedAt
    return new Date(kb).getTime() - new Date(ka).getTime()
  })
})

const PHASE_BADGE = computed<Record<RunPhase, { label: string; cls: string }>>(() => ({
  running: { label: t('blog.pages.topics.phase.running'), cls: 'bg-info-soft text-info border-info/20' },
  awaiting: { label: t('blog.pages.topics.phase.awaiting'), cls: 'bg-warning-soft text-warning border-warning/20' },
  draft: { label: t('blog.pages.topics.phase.draft'), cls: 'bg-surface-2 text-2 border-border' },
  ready: { label: t('blog.pages.topics.phase.ready'), cls: 'bg-success-soft text-success border-success/20' },
  published: { label: t('blog.pages.topics.phase.published'), cls: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/20' },
  error: { label: t('blog.pages.topics.phase.error'), cls: 'bg-danger-soft text-danger border-danger/20' },
}))

const fmtDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short' })
  } catch { return '' }
}

// количество слов с разделителями разрядов по языку интерфейса
const words = (n: number) => t('blog.pages.units.words', { n: n.toLocaleString(intlLocale()) }, n)

// подпись бейджа локалей: список кодов версий + сколько всего
const localeTitle = (r: { locales: string[]; variantCount: number }) =>
  `${t('blog.pages.topics.versions', { n: r.variantCount })}${r.locales.length ? ` (${r.locales.map((l) => l.toUpperCase()).join(', ')})` : ''}`

function resetFilters() { phase.value = 'all'; q.value = '' }

const highlight = computed(() => String(route.query.run ?? ''))

// --- удаление темы из списка -------------------------------------------------
// Удаляем представителя группы: у переводов свой id, но бэк сносит ран целиком,
// поэтому в подтверждении честно пишем, сколько версий уедет вместе с ним.
const toDelete = ref<BlogGroup | null>(null)
const deleting = ref(false)
const deleteError = ref('')
// цель держим и вне ref: AlertDialogAction закрывает диалог своим обработчиком,
// и к моменту нашего клика reka уже успевает обнулить toDelete
let pending: BlogGroup | null = null

function askDelete(r: BlogGroup) { pending = r; toDelete.value = r; deleteError.value = '' }

async function confirmDelete() {
  const r = pending
  if (!r || deleting.value) return
  deleting.value = true
  deleteError.value = ''
  try {
    await api.blogDeleteRun(r.id)
    toDelete.value = null
    await load(true)
  } catch (e: any) {
    deleteError.value = e?.serverMessage || t('blog.pages.topics.delete.failed')
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div class="space-y-4 p-5 lg:p-6">
    <BlogPageHeader :title="$t('blog.pages.topics.title')" :subtitle="$t('blog.pages.topics.subtitle')">
      <template #actions>
        <div class="relative w-full sm:w-72">
          <Search :size="14" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input v-model="q" :placeholder="$t('blog.pages.topics.searchPlaceholder')" class="h-9 border-border bg-surface-2 pl-9 text-[13px]" :autofocus="route.query.focus === 'search'" />
        </div>
      </template>
    </BlogPageHeader>

    <p v-if="deleteError" class="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{{ deleteError }}</p>

    <!-- фильтры-чипы + вид + сортировка -->
    <div class="flex flex-wrap items-center gap-2">
      <div class="flex overflow-x-auto rounded-lg border border-border bg-surface p-0.5">
        <button
          v-for="p in visiblePhases" :key="p.key"
          class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors"
          :class="phase === p.key ? 'bg-surface-hover text-foreground' : 'text-muted-foreground hover:text-foreground'"
          @click="phase = p.key"
        >
          {{ p.label }}
          <span class="tabular-nums text-muted-foreground/70">{{ counts[p.key] ?? 0 }}</span>
        </button>
      </div>

      <div class="ml-auto flex items-center gap-2">
        <div class="flex rounded-lg border border-border bg-surface p-0.5">
          <button
            class="rounded-md p-1.5 transition-colors" :class="view === 'grid' ? 'bg-surface-hover text-foreground' : 'text-muted-foreground hover:text-foreground'"
            :title="$t('blog.pages.topics.viewGrid')" @click="view = 'grid'"
          ><LayoutGrid :size="14" /></button>
          <button
            class="rounded-md p-1.5 transition-colors" :class="view === 'list' ? 'bg-surface-hover text-foreground' : 'text-muted-foreground hover:text-foreground'"
            :title="$t('blog.pages.topics.viewList')" @click="view = 'list'"
          ><List :size="14" /></button>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="text-[12px] text-muted-foreground">{{ $t('blog.pages.topics.sortLabel') }}</span>
          <Select v-model="sort">
            <SelectTrigger class="h-8 w-[170px] border-border bg-surface text-[12.5px]">
              <SelectValue>{{ $t(`blog.pages.topics.sort.${sort}`) }}</SelectValue>
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="updated">{{ $t('blog.pages.topics.sort.updated') }}</SelectItem>
              <SelectItem value="created">{{ $t('blog.pages.topics.sort.created') }}</SelectItem>
              <SelectItem value="views">{{ $t('blog.pages.topics.sort.views') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </div>

    <!-- контент -->
    <div v-if="state.status === 'loading'" class="relative min-h-[60vh]"><IdeataLoader variant="solid" /></div>

    <!-- сбой запроса — это не «статей нет»: предлагаем повторить, а не заводить тему -->
    <div v-else-if="state.status === 'error'" class="flex flex-col items-center gap-3 py-16 text-center">
      <TriangleAlert :size="26" class="text-danger/70" />
      <p class="text-[13px] text-muted-foreground">{{ $t('blog.pages.topics.loadFailed') }}</p>
      <Button variant="outline" size="sm" class="border-border bg-surface" @click="load(true)">{{ $t('action.retry') }}</Button>
    </div>

    <EmptyState
      v-else-if="!state.runs.length"
      :icon="MessagesSquare"
      :hint="$t('blog.pages.topics.emptyHint')"
    >
      <template #action>
        <Button size="sm" @click="$router.push('/blog/new')"><SquarePen :size="13" /> {{ $t('blog.pages.nav.newTopic') }}</Button>
      </template>
    </EmptyState>

    <div v-else-if="!filtered.length" class="flex flex-col items-center gap-3 py-16 text-center">
      <MessagesSquare :size="28" class="text-muted-foreground/40" />
      <div>
        <p class="text-[14px] font-semibold">{{ $t('blog.pages.topics.noMatch.title') }}</p>
        <p class="mt-1 text-[12.5px] text-muted-foreground">{{ $t('blog.pages.topics.noMatch.hint') }}</p>
      </div>
      <Button variant="outline" size="sm" class="border-border bg-surface" @click="resetFilters">{{ $t('blog.pages.topics.noMatch.reset') }}</Button>
    </div>

    <!-- грид -->
    <div v-else-if="view === 'grid'" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      <RouterLink
        v-for="r in filtered" :key="r.id" :to="`/blog/run/${r.id}`"
        class="group block overflow-hidden rounded-xl border border-border bg-surface transition-colors hover:bg-surface-2"
        :class="highlight === r.id && 'ring-1 ring-brand-accent/50'"
      >
        <div class="relative h-32 overflow-hidden bg-surface-2">
          <img v-if="r.coverUrl" :src="r.coverUrl" :alt="r.title || r.topic" class="size-full object-cover transition group-hover:scale-[1.02]" loading="lazy" />
          <FileText v-else :size="24" class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-muted-foreground/30" />
          <span class="absolute left-2.5 top-2.5 rounded border px-1.5 py-0.5 text-[10px] font-medium backdrop-blur" :class="PHASE_BADGE[runPhase(r)].cls">
            {{ PHASE_BADGE[runPhase(r)].label }}
          </span>
          <!-- меню карточки: клик по нему не должен уводить в статью -->
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button
                type="button" :aria-label="$t('blog.pages.topics.rowMenu')"
                class="absolute right-2 top-2 grid size-7 place-items-center rounded-lg border border-border bg-background/80 text-muted-foreground backdrop-blur transition hover:text-foreground focus-visible:opacity-100"
                @click.stop.prevent
              ><MoreHorizontal :size="14" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem class="text-danger focus:text-danger" @click="askDelete(r)">
                <Trash2 :size="13" /> {{ $t('action.delete') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div class="p-3.5">
          <h3 class="line-clamp-2 text-[13.5px] font-medium leading-snug">{{ r.title || r.topic }}</h3>
          <div class="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
            <span v-if="r.wordCount" class="tabular-nums">{{ words(r.wordCount) }}</span>
            <span v-if="r.views" class="inline-flex items-center gap-1 tabular-nums"><Eye :size="11" /> {{ r.views }}</span>
            <span v-if="r.variantCount > 1" class="inline-flex items-center gap-1 tabular-nums" :title="localeTitle(r)"><Languages :size="11" /> {{ r.variantCount }}</span>
            <span class="ml-auto tabular-nums">{{ fmtDate(r.updatedAt) }}</span>
          </div>
        </div>
      </RouterLink>
    </div>

    <!-- список -->
    <div v-else class="overflow-hidden rounded-xl border border-border bg-surface">
      <div class="overflow-x-auto">
      <div class="min-w-[640px] divide-y divide-hairline sm:min-w-0">
        <RouterLink
          v-for="r in filtered" :key="r.id" :to="`/blog/run/${r.id}`"
          class="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-2"
          :class="highlight === r.id && 'bg-brand-accent-soft'"
        >
          <span class="rounded border px-1.5 py-0.5 text-[10px] font-medium" :class="PHASE_BADGE[runPhase(r)].cls">{{ PHASE_BADGE[runPhase(r)].label }}</span>
          <span class="min-w-0 flex-1 truncate text-[13px] text-foreground">{{ r.title || r.topic }}</span>
          <span v-if="r.variantCount > 1" class="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground" :title="localeTitle(r)"><Languages :size="10" /> {{ r.variantCount }}</span>
          <span v-if="r.wordCount" class="w-20 shrink-0 text-right text-[11.5px] tabular-nums text-muted-foreground">{{ words(r.wordCount) }}</span>
          <span class="w-14 shrink-0 text-right text-[11.5px] tabular-nums text-muted-foreground"><Eye :size="10" class="mr-0.5 inline" />{{ r.views ?? 0 }}</span>
          <span class="w-14 shrink-0 text-right text-[11.5px] tabular-nums text-muted-foreground">{{ fmtDate(r.updatedAt) }}</span>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button
                type="button" :aria-label="$t('blog.pages.topics.rowMenu')"
                class="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-surface-hover hover:text-foreground"
                @click.stop.prevent
              ><MoreHorizontal :size="14" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem class="text-danger focus:text-danger" @click="askDelete(r)">
                <Trash2 :size="13" /> {{ $t('action.delete') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </RouterLink>
      </div>
      </div>
    </div>

    <!-- удаление темы -->
    <AlertDialog :open="!!toDelete" @update:open="(v: boolean) => { if (!v) toDelete = null }">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ $t('blog.pages.topics.delete.title') }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{ $t('blog.pages.topics.delete.body', { title: toDelete?.title || toDelete?.topic, n: toDelete?.variantCount ?? 1 }) }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ $t('action.cancel') }}</AlertDialogCancel>
          <AlertDialogAction class="bg-destructive text-destructive-foreground hover:bg-destructive/90" :disabled="deleting" @click.prevent="confirmDelete">
            <Loader2 v-if="deleting" :size="14" class="animate-spin" /> {{ $t('action.delete') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
