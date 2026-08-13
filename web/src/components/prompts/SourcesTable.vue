<script setup lang="ts">
// Вкладка «Источники»: домены, которые ИИ цитирует по промптам бренда.
// Клик по строке раскрывает детализацию: конкретные URL с числом цитат
// и промпты, в ответах на которые хост цитировался (клик → модалка промпта).
// Только реальные данные прогона; пусто → «Нет данных».
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, ExternalLink, Link2, MessageSquareText, Search } from 'lucide-vue-next'
import { Input } from '@/components/ui/input'
import TableFooter from '@/components/prompts/TableFooter.vue'
import EmptyState from '@/components/EmptyState.vue'
import {
  ENGINE_I18N, PLATFORM_REGISTRY, faviconSrc,
  type Platform, type SourceRow,
} from '@/data/prompts'

const props = defineProps<{
  rows?: SourceRow[] | null
  platforms?: Platform[]
}>()
const emit = defineEmits<{ (e: 'open-prompt', text: string): void }>()

const { t } = useI18n()

const source = computed(() => props.rows ?? [])
const platMeta = (key: string): Platform =>
  props.platforms?.find((p) => p.key === key)
  ?? PLATFORM_REGISTRY.find((p) => p.key === key)
  ?? { key, label: key, icon: `/icons/ai/${key}.svg` }
const engineLabel = (p: Platform) => (ENGINE_I18N.has(p.key) ? t(`prompts.engine.${p.key}`) : p.label)

const q = ref('')
const sortKey = ref<'citations' | 'share' | 'delta'>('citations')
const sortDir = ref<1 | -1>(-1)
const page = ref(1)
const perPage = ref(10)
const expanded = ref<Set<number>>(new Set())
// выбранный URL внутри раскрытия (per-host): фильтрует промпты справа
const selectedUrls = ref<Map<number, string>>(new Map())

function toggleUrl(rowId: number, url: string) {
  const m = new Map(selectedUrls.value)
  if (m.get(rowId) === url) m.delete(rowId)
  else m.set(rowId, url)
  selectedUrls.value = m
}

function promptsFor(r: SourceRow): string[] {
  const sel = selectedUrls.value.get(r.id)
  if (!sel) return r.prompts
  return r.urls.find((u) => u.url === sel)?.prompts ?? []
}

const CAT_CLASS: Record<string, string> = {
  'СМИ': 'bg-sky-500/15 text-sky-300 border-sky-500/20',
  'Блог': 'bg-emerald-500/15 text-emerald-300 border-emerald-500/20',
  'Свой сайт': 'bg-violet-500/15 text-violet-300 border-violet-500/20',
  'Форум': 'bg-amber-500/15 text-amber-300 border-amber-500/20',
  'Каталог': 'bg-zinc-500/15 text-text-2 border-zinc-500/20',
}
// Категория хранится русским значением (SourceRow.category — контракт адаптера
// и экспорта), а на экран идёт подпись из словаря.
const CAT_KEY: Record<string, string> = {
  'СМИ': 'media', 'Блог': 'blog', 'Свой сайт': 'own', 'Форум': 'forum', 'Каталог': 'catalog',
}
const catLabel = (cat: string) => (CAT_KEY[cat] ? t(`prompts.sources.cat.${CAT_KEY[cat]}`) : cat)

const filtered = computed(() => {
  let r = source.value
  if (q.value.trim()) {
    const s = q.value.trim().toLowerCase()
    r = r.filter((x) => x.host.includes(s) || x.category.toLowerCase().includes(s))
  }
  const k = sortKey.value
  return [...r].sort((a, b) => (a[k] - b[k]) * sortDir.value)
})

const paged = computed(() => filtered.value.slice((page.value - 1) * perPage.value, page.value * perPage.value))
const maxCitations = computed(() => Math.max(1, ...source.value.map((r) => r.citations)))

function toggleSort(k: 'citations' | 'share' | 'delta') {
  if (sortKey.value === k) sortDir.value = sortDir.value === -1 ? 1 : -1
  else { sortKey.value = k; sortDir.value = -1 }
  page.value = 1
}

function toggleRow(id: number) {
  const s = new Set(expanded.value)
  if (s.has(id)) s.delete(id)
  else s.add(id)
  expanded.value = s
}

// незнакомый хост: локальной иконки нет → на google s2
function onFaviconError(e: Event, host: string) {
  const img = e.target as HTMLImageElement
  const fallback = `https://www.google.com/s2/favicons?domain=${host}&sz=64`
  if (img.src !== fallback) img.src = fallback
}

const pathOf = (url: string) => {
  const p = url.replace(/^https?:\/\/[^/]+/, '')
  return p || '/'
}
</script>

<template>
  <div class="space-y-3">
    <div class="relative">
      <Search :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <Input v-model="q" :placeholder="$t('prompts.sources.search')" class="h-8 w-64 border-border bg-surface pl-8 text-[12.5px]" @update:model-value="page = 1" />
    </div>

    <div class="overflow-x-auto rounded-xl border border-border bg-surface">
      <table class="w-full min-w-[780px] border-collapse text-left">
        <thead>
          <tr class="border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground/80">
            <th class="w-8 px-2 py-2.5"></th>
            <th class="px-2 py-2.5 font-medium">{{ $t('prompts.sources.host') }}</th>
            <th class="px-2 py-2.5 font-medium">{{ $t('prompts.sources.category') }}</th>
            <th class="px-2 py-2.5 font-medium">{{ $t('prompts.sources.engines') }}</th>
            <th class="cursor-pointer select-none px-2 py-2.5 font-medium" @click="toggleSort('citations')">
              <span class="inline-flex items-center gap-1">
                {{ $t('prompts.sources.citations') }}
                <component :is="sortKey === 'citations' ? (sortDir === -1 ? ArrowDown : ArrowUp) : ArrowUpDown" :size="12" :class="sortKey === 'citations' ? 'text-foreground' : 'opacity-40'" />
              </span>
            </th>
            <th class="cursor-pointer select-none px-2 py-2.5 font-medium" @click="toggleSort('share')">
              <span class="inline-flex items-center gap-1">
                {{ $t('prompts.sources.share') }}
                <component :is="sortKey === 'share' ? (sortDir === -1 ? ArrowDown : ArrowUp) : ArrowUpDown" :size="12" :class="sortKey === 'share' ? 'text-foreground' : 'opacity-40'" />
              </span>
            </th>
            <th class="cursor-pointer select-none px-2 py-2.5 font-medium" @click="toggleSort('delta')">
              <span class="inline-flex items-center gap-1">
                {{ $t('prompts.sources.trend') }}
                <component :is="sortKey === 'delta' ? (sortDir === -1 ? ArrowDown : ArrowUp) : ArrowUpDown" :size="12" :class="sortKey === 'delta' ? 'text-foreground' : 'opacity-40'" />
              </span>
            </th>
            <th class="px-2 py-2.5 font-medium">{{ $t('prompts.sources.lastSeen') }}</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-white/[0.04]">
          <template v-for="r in paged" :key="r.id">
            <tr
              class="cursor-pointer select-none transition-colors hover:bg-surface-2"
              :class="expanded.has(r.id) && 'bg-surface-2'"
              @click="toggleRow(r.id)"
            >
              <td class="px-2 py-2.5">
                <ChevronRight :size="14" class="text-muted-foreground transition-transform" :class="expanded.has(r.id) && 'rotate-90'" />
              </td>
              <td class="px-2 py-2.5">
                <div class="flex items-center gap-2.5">
                  <img :src="faviconSrc(r.host)" width="16" height="16" class="rounded-sm" loading="lazy" @error="onFaviconError($event, r.host)" />
                  <span class="text-[13px]" :class="r.own ? 'font-medium text-brand-soft' : 'text-foreground'">{{ r.host }}</span>
                  <span v-if="r.own" class="rounded border border-brand/30 bg-brand/15 px-1 text-[10px] font-medium text-brand-soft">{{ $t('prompts.sources.you') }}</span>
                </div>
              </td>
              <td class="px-2 py-2.5">
                <span class="rounded border px-1.5 py-0.5 text-[10.5px] font-medium" :class="CAT_CLASS[r.category]">{{ catLabel(r.category) }}</span>
              </td>
              <td class="px-2 py-2.5">
                <div class="flex -space-x-1.5">
                  <img
                    v-for="e in r.engines" :key="e" :src="platMeta(e).icon"
                    :alt="engineLabel(platMeta(e))" :title="engineLabel(platMeta(e))"
                    class="size-[18px] rounded-full bg-surface-2 p-0.5 ring-2 ring-background"
                  />
                </div>
              </td>
              <td class="w-28 px-2 py-2.5">
                <div class="flex items-center gap-2">
                  <span class="w-8 text-[12.5px] font-medium tabular-nums">{{ r.citations }}</span>
                  <span class="h-1 w-14 overflow-hidden rounded-full bg-surface-hover">
                    <span class="block h-full rounded-full" :class="r.own ? 'bg-gradient-to-r from-brand to-brand-soft' : 'bg-muted-foreground/35'" :style="{ width: (r.citations / maxCitations) * 100 + '%' }"></span>
                  </span>
                </div>
              </td>
              <td class="w-16 px-2 py-2.5 text-[12.5px] tabular-nums text-text-2">{{ r.share }}%</td>
              <td class="w-16 px-2 py-2.5">
                <span class="text-[12px] font-medium tabular-nums" :class="r.delta >= 0 ? 'text-emerald-400' : 'text-rose-400'">
                  {{ r.delta >= 0 ? '+' : '' }}{{ r.delta }}
                </span>
              </td>
              <td class="px-2 py-2.5 text-[12px] text-muted-foreground">{{ $t(`prompts.run.${r.lastSeen}`) }}</td>
            </tr>

            <!-- раскрытие: URL хоста + промпты -->
            <tr v-if="expanded.has(r.id)">
              <td colspan="8" class="bg-black/20 px-4 py-4">
                <div class="grid gap-4 lg:grid-cols-2">
                  <!-- ссылки -->
                  <div>
                    <div class="mb-2 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/70">
                      <Link2 :size="12" /> {{ $t('prompts.sources.links') }} · {{ r.urls.length }}
                    </div>
                    <div class="space-y-1">
                      <!-- клик по строке = выбрать URL (фильтр промптов справа); внешняя ссылка — отдельной иконкой -->
                      <div
                        v-for="u in r.urls" :key="u.url"
                        class="group flex cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors"
                        :class="selectedUrls.get(r.id) === u.url ? 'bg-brand/[0.12] ring-1 ring-brand/30' : 'hover:bg-surface-2'"
                        :title="selectedUrls.get(r.id) === u.url ? $t('prompts.sources.resetFilter') : $t('prompts.sources.showPrompts')"
                        @click.stop="toggleUrl(r.id, u.url)"
                      >
                        <img :src="faviconSrc(r.host)" width="14" height="14" class="shrink-0 rounded-sm" loading="lazy" @error="onFaviconError($event, r.host)" />
                        <span class="min-w-0 flex-1 truncate text-[12.5px] transition" :class="selectedUrls.get(r.id) === u.url ? 'text-brand-soft' : 'text-text-2 group-hover:text-foreground'">{{ pathOf(u.url) }}</span>
                        <span class="shrink-0 text-[10.5px] tabular-nums text-muted-foreground/70">{{ $t('prompts.sources.nPrompts', u.prompts.length) }}</span>
                        <span class="shrink-0 rounded-full bg-surface-hover px-1.5 py-0.5 text-[10.5px] font-medium tabular-nums text-text-2">× {{ u.n }}</span>
                        <a :href="u.url" target="_blank" rel="noopener" :title="$t('prompts.sources.openLink')" class="shrink-0 text-muted-foreground/50 transition hover:text-foreground" @click.stop>
                          <ExternalLink :size="12" />
                        </a>
                      </div>
                      <p v-if="!r.urls.length" class="px-2 py-1.5 text-[12px] text-muted-foreground">{{ $t('prompts.sources.noUrls') }}</p>
                    </div>
                  </div>

                  <!-- промпты -->
                  <div>
                    <div class="mb-2 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/70">
                      <MessageSquareText :size="12" /> {{ $t('prompts.sources.citedIn') }} · {{ promptsFor(r).length }}
                      <template v-if="selectedUrls.get(r.id)">
                        <span class="max-w-[180px] truncate rounded bg-brand/[0.12] px-1.5 py-0.5 normal-case tracking-normal text-brand-soft">{{ pathOf(selectedUrls.get(r.id)!) }}</span>
                        <button type="button" class="text-muted-foreground transition hover:text-foreground" :title="$t('prompts.sources.resetFilter')" @click.stop="toggleUrl(r.id, selectedUrls.get(r.id)!)">✕</button>
                      </template>
                    </div>
                    <div class="space-y-1">
                      <button
                        v-for="p in promptsFor(r)" :key="p" type="button"
                        class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
                        :title="$t('prompts.sources.openPrompt')"
                        @click.stop="emit('open-prompt', p)"
                      >
                        <span class="size-1 shrink-0 rounded-full bg-brand-soft/60"></span>
                        <span class="min-w-0 flex-1 truncate text-[12.5px] text-text-2">{{ p }}</span>
                        <ChevronRight :size="12" class="shrink-0 text-muted-foreground/50" />
                      </button>
                      <p v-if="!promptsFor(r).length" class="px-2 py-1.5 text-[12px] text-muted-foreground">{{ $t('prompts.sources.noPrompts') }}</p>
                    </div>
                  </div>
                </div>
              </td>
            </tr>
          </template>
          <tr v-if="!paged.length">
            <td colspan="8">
              <EmptyState
                v-if="!source.length"
                :hint="$t('prompts.sources.emptyHint')"
              />
              <p v-else class="px-4 py-12 text-center text-[13px] text-muted-foreground">{{ $t('prompts.sources.noMatch') }}</p>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="border-t border-border">
        <TableFooter v-model:page="page" v-model:per-page="perPage" :total="filtered.length" />
      </div>
    </div>
  </div>
</template>
