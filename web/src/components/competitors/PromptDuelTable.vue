<script setup lang="ts">
/**
 * Промпт × бренды: в каком вопросе кого называют движки.
 *
 * Сводная видимость отвечает «кто впереди вообще», а работать можно только с
 * конкретным вопросом: тут видно, что по «CRM для отдела продаж» нас называет
 * один движок из восьми, а соперника — шесть. Лидер строки подсвечен, колонка
 * «отрыв» сортируется, и по умолчанию сверху лежат проигранные промпты — с них
 * и начинают.
 *
 * Числа — из ответов ПОСЛЕДНЕГО прогона (доля движков, назвавших бренд), у всех
 * брендов по одному правилу. С окном «Мониторинга» они не обязаны совпадать —
 * об этом говорит подпись панели.
 */
import { computed, ref, watch } from 'vue'
import { ArrowDown, ArrowUp, ArrowUpDown, Search, X } from 'lucide-vue-next'
import { Input } from '@/components/ui/input'
import BrandMark from '@/components/dashboard/BrandMark.vue'
import EmptyState from '@/components/EmptyState.vue'
import TableFooter from '@/components/prompts/TableFooter.vue'
import { brandLabel } from '@/data/dashboard'
import type { PromptDuel, RivalRow } from '@/data/competitors'

const props = defineProps<{
  duels: PromptDuel[]
  brands: RivalRow[]
  loading?: boolean
}>()
const emit = defineEmits<{ 'open-prompt': [string] }>()

const q = ref('')
const onlyLost = ref(false)
type SortKey = 'gap' | 'self'
const sortKey = ref<SortKey>('gap')
const sortDir = ref<1 | -1>(1) // проигранные сверху: gap по возрастанию
const page = ref(1)
const perPage = ref(10)

const filtered = computed(() => {
  let r = props.duels
  const s = q.value.trim().toLowerCase()
  if (s) r = r.filter((d) => d.text.toLowerCase().includes(s) || d.topic.toLowerCase().includes(s))
  if (onlyLost.value) r = r.filter((d) => d.gap < 0)
  const k = sortKey.value
  return [...r].sort((a, b) => ((k === 'gap' ? a.gap - b.gap : a.selfVis - b.selfVis) * sortDir.value))
})

watch([q, onlyLost, perPage], () => { page.value = 1 })

const paged = computed(() => filtered.value.slice((page.value - 1) * perPage.value, page.value * perPage.value))

const lost = computed(() => props.duels.filter((d) => d.gap < 0).length)

function toggleSort(k: SortKey) {
  if (sortKey.value === k) sortDir.value = sortDir.value === 1 ? -1 : 1
  else { sortKey.value = k; sortDir.value = k === 'gap' ? 1 : -1 }
  page.value = 1
}
const sortIcon = (k: SortKey) => (sortKey.value === k ? (sortDir.value === -1 ? ArrowDown : ArrowUp) : ArrowUpDown)
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
      <div class="mr-auto min-w-0">
        <h2 class="text-[13px] font-medium">{{ $t('competitors.prompts.title') }}</h2>
        <p class="mt-0.5 text-[11.5px] text-muted-foreground">{{ $t('competitors.prompts.subtitle') }}</p>
      </div>
      <div class="relative">
        <Search :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="q" :placeholder="$t('competitors.prompts.search')" class="h-8 w-56 border-border bg-surface-2 pl-8 text-[12.5px]" />
      </div>
      <button
        type="button"
        class="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition"
        :class="onlyLost ? 'border-rose-500/30 bg-rose-500/10 text-rose-200' : 'border-border bg-surface-2 text-muted-foreground hover:text-foreground'"
        @click="onlyLost = !onlyLost"
      >
        {{ $t('competitors.prompts.onlyLost') }}
        <span class="tabular-nums opacity-70">{{ lost }}</span>
      </button>
      <button
        v-if="q || onlyLost" type="button"
        class="inline-flex items-center gap-1 text-[12px] text-muted-foreground transition hover:text-foreground"
        @click="q = ''; onlyLost = false"
      ><X :size="12" /> {{ $t('prompts.filters.reset') }}</button>
    </div>

    <p v-if="loading" class="px-4 py-14 text-center text-[13px] text-muted-foreground">{{ $t('state.loading') }}</p>
    <EmptyState v-else-if="!duels.length" :title="$t('state.noData')" :hint="$t('competitors.prompts.empty')" />
    <p v-else-if="!filtered.length" class="px-4 py-14 text-center text-[13px] text-muted-foreground">{{ $t('prompts.table.noMatch') }}</p>

    <template v-else>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[760px] border-collapse text-left">
          <thead>
            <tr class="border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground/80">
              <th class="px-4 py-2.5 font-medium">{{ $t('prompts.table.prompt') }}</th>
              <th v-for="b in brands" :key="b.brand" class="w-[112px] px-2 py-2.5 font-medium">
                <span class="flex items-center gap-1.5">
                  <BrandMark :brand="b.brand" :color="b.color" :size="12" />
                  <span class="truncate normal-case" :class="b.self ? 'text-foreground' : ''">{{ brandLabel(b.brand) }}</span>
                </span>
              </th>
              <th class="w-[92px] cursor-pointer select-none px-4 py-2.5 text-right font-medium" @click="toggleSort('gap')">
                <span class="inline-flex items-center gap-1">
                  {{ $t('competitors.prompts.gap') }}
                  <component :is="sortIcon('gap')" :size="12" :class="sortKey === 'gap' ? 'text-foreground' : 'opacity-40'" />
                </span>
              </th>
            </tr>
          </thead>
          <tbody class="divide-y divide-white/[0.04]">
            <tr
              v-for="d in paged" :key="d.id"
              class="cursor-pointer transition-colors hover:bg-surface-2"
              @click="emit('open-prompt', d.text)"
            >
              <td class="max-w-[380px] px-4 py-2.5">
                <div class="truncate text-[13px] text-foreground">{{ d.text }}</div>
                <div class="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground/70">
                  <span v-if="d.topic" class="truncate">{{ d.topic }}</span>
                  <span v-if="d.topic">·</span>
                  <span>{{ $t('competitors.prompts.engines', d.engines) }}</span>
                </div>
              </td>
              <!-- Ячейка бренда: доля движков + полоса. Лидер строки подсвечен —
                   иначе в шести колонках процентов глазу не за что зацепиться. -->
              <td
                v-for="b in brands" :key="b.brand" class="px-2 py-2.5"
                :class="d.leader === b.brand ? (b.self ? 'bg-brand/[0.10]' : 'bg-surface-2') : ''"
              >
                <div class="flex items-center gap-1.5">
                  <span
                    class="w-8 shrink-0 text-[12.5px] tabular-nums"
                    :class="(d.vis[b.brand] ?? 0) === 0 ? 'text-muted-foreground/40'
                      : d.leader === b.brand ? 'font-semibold text-foreground' : 'text-text-2'"
                  >{{ d.vis[b.brand] ?? 0 }}%</span>
                  <span class="h-1 flex-1 overflow-hidden rounded-full bg-surface-hover">
                    <span class="block h-full rounded-full" :style="{ width: (d.vis[b.brand] ?? 0) + '%', background: b.color }"></span>
                  </span>
                  <span
                    v-if="d.pos[b.brand]" class="w-5 shrink-0 text-right text-[10.5px] tabular-nums text-muted-foreground/70"
                    :title="$t('competitors.prompts.posHint', { n: d.pos[b.brand] })"
                  >#{{ d.pos[b.brand] }}</span>
                  <span v-else class="w-5 shrink-0"></span>
                </div>
              </td>
              <td
                class="px-4 py-2.5 text-right text-[12.5px] font-medium tabular-nums"
                :class="d.gap > 0 ? 'text-emerald-400' : d.gap < 0 ? 'text-rose-400' : 'text-muted-foreground/50'"
              >{{ d.gap > 0 ? '+' : '' }}{{ d.gap || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="border-t border-border">
        <TableFooter v-model:page="page" v-model:per-page="perPage" :total="filtered.length" />
      </div>
    </template>
  </section>
</template>
