<script setup lang="ts">
/**
 * Источники × бренды: на что ссылается движок, когда называет нас — и когда
 * называет конкурента.
 *
 * Счётчик в ячейке — это цитаты хоста в ответах, где назван бренд. Не «сайт
 * пишет про бренд», а соседство в одном ответе: именно из таких площадок ИИ
 * собирает картину, и туда имеет смысл идти за упоминанием. Формулировка в
 * подписи панели ровно такая же — иначе число читается как чужой рейтинг.
 */
import { computed, ref, watch } from 'vue'
import { Search, X } from 'lucide-vue-next'
import { Input } from '@/components/ui/input'
import BrandMark from '@/components/dashboard/BrandMark.vue'
import EmptyState from '@/components/EmptyState.vue'
import TableFooter from '@/components/prompts/TableFooter.vue'
import { brandLabel } from '@/data/dashboard'
import { faviconSrc } from '@/data/prompts'
import type { RivalRow, SourceDuel } from '@/data/competitors'

const props = defineProps<{
  sources: SourceDuel[]
  brands: RivalRow[]
  loading?: boolean
}>()

const q = ref('')
/** только площадки, где конкурент собирает больше цитат, чем мы */
const onlyRival = ref(false)
const page = ref(1)
const perPage = ref(10)

const selfBrand = computed(() => props.brands.find((b) => b.self)?.brand || '')

const filtered = computed(() => {
  let r = props.sources
  const s = q.value.trim().toLowerCase()
  if (s) r = r.filter((x) => x.host.includes(s))
  if (onlyRival.value) r = r.filter((x) => !!x.leader && x.leader !== selfBrand.value)
  return r
})

watch([q, onlyRival, perPage], () => { page.value = 1 })

const paged = computed(() => filtered.value.slice((page.value - 1) * perPage.value, page.value * perPage.value))
const rivalHeld = computed(() => props.sources.filter((x) => !!x.leader && x.leader !== selfBrand.value).length)
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
      <div class="mr-auto min-w-0">
        <h2 class="text-[13px] font-medium">{{ $t('competitors.sources.title') }}</h2>
        <p class="mt-0.5 text-[11.5px] text-muted-foreground">{{ $t('competitors.sources.subtitle') }}</p>
      </div>
      <div class="relative">
        <Search :size="14" class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="q" :placeholder="$t('competitors.sources.search')" class="h-8 w-56 border-border bg-surface-2 pl-8 text-[12.5px]" />
      </div>
      <button
        type="button"
        class="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition"
        :class="onlyRival ? 'border-rose-500/30 bg-rose-500/10 text-rose-200' : 'border-border bg-surface-2 text-muted-foreground hover:text-foreground'"
        @click="onlyRival = !onlyRival"
      >
        {{ $t('competitors.sources.onlyRival') }}
        <span class="tabular-nums opacity-70">{{ rivalHeld }}</span>
      </button>
      <button
        v-if="q || onlyRival" type="button"
        class="inline-flex items-center gap-1 text-[12px] text-muted-foreground transition hover:text-foreground"
        @click="q = ''; onlyRival = false"
      ><X :size="12" /> {{ $t('prompts.filters.reset') }}</button>
    </div>

    <p v-if="loading" class="px-4 py-14 text-center text-[13px] text-muted-foreground">{{ $t('state.loading') }}</p>
    <EmptyState v-else-if="!sources.length" :title="$t('state.noData')" :hint="$t('competitors.sources.empty')" />
    <p v-else-if="!filtered.length" class="px-4 py-14 text-center text-[13px] text-muted-foreground">{{ $t('prompts.table.noMatch') }}</p>

    <template v-else>
      <div class="overflow-x-auto">
        <table class="w-full min-w-[720px] border-collapse text-left">
          <thead>
            <tr class="border-b border-border text-[11px] uppercase tracking-wider text-muted-foreground/80">
              <th class="px-4 py-2.5 font-medium">{{ $t('competitors.sources.host') }}</th>
              <th v-for="b in brands" :key="b.brand" class="w-[104px] px-2 py-2.5 text-right font-medium">
                <span class="flex items-center justify-end gap-1.5">
                  <BrandMark :brand="b.brand" :color="b.color" :size="12" />
                  <span class="truncate normal-case">{{ brandLabel(b.brand) }}</span>
                </span>
              </th>
              <th class="w-[76px] px-4 py-2.5 text-right font-medium">{{ $t('competitors.sources.total') }}</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-white/[0.04]">
            <tr v-for="s in paged" :key="s.host" class="transition-colors hover:bg-surface-2">
              <td class="px-4 py-2.5">
                <div class="flex min-w-0 items-center gap-2">
                  <img :src="faviconSrc(s.host)" alt="" width="14" height="14" class="shrink-0 rounded-[3px]" loading="lazy" />
                  <span class="truncate text-[12.5px] text-foreground">{{ s.host }}</span>
                  <!-- домен участника сравнения: «свой сайт» и «сайт конкурента»
                       читаются иначе, чем сторонняя площадка -->
                  <span
                    v-if="s.brandOwner"
                    class="shrink-0 rounded border px-1.5 py-px text-[10px] font-medium"
                    :class="s.own ? 'border-brand/30 bg-brand/10 text-brand-soft' : 'border-border text-muted-foreground'"
                  >{{ s.own ? $t('competitors.sources.ownSite') : $t('competitors.sources.rivalSite') }}</span>
                  <span class="shrink-0 text-[11px] text-muted-foreground/60">{{ $t('competitors.sources.prompts', s.prompts) }}</span>
                </div>
              </td>
              <td
                v-for="b in brands" :key="b.brand"
                class="px-2 py-2.5 text-right text-[12.5px] tabular-nums"
                :class="[
                  s.leader === b.brand ? (b.self ? 'bg-brand/[0.10] font-semibold text-foreground' : 'bg-surface-2 font-semibold text-foreground') : 'text-text-2',
                  !(s.byBrand[b.brand] ?? 0) && 'text-muted-foreground/40',
                ]"
              >{{ s.byBrand[b.brand] || '—' }}</td>
              <td class="px-4 py-2.5 text-right text-[12.5px] tabular-nums text-text-2">{{ s.total }}</td>
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
