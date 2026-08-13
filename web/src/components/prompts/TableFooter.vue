<script setup lang="ts">
// Футер data-table в каноне shadcn: счётчик выбранных · rows per page ·
// Page X of Y · кнопки «« ‹ › »».
import { computed } from 'vue'
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const props = defineProps<{
  total: number
  selected?: number
}>()

const page = defineModel<number>('page', { default: 1 })
const perPage = defineModel<number>('perPage', { default: 10 })

const pages = computed(() => Math.max(1, Math.ceil(props.total / perPage.value)))

function go(p: number) {
  page.value = Math.min(pages.value, Math.max(1, p))
}
function setPerPage(v: unknown) {
  perPage.value = Number(v)
  page.value = 1
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3">
    <div class="mr-auto text-[12.5px] text-muted-foreground">
      {{ $t('prompts.footer.selectedOf', { selected: selected ?? 0, total }) }}
    </div>

    <div class="flex items-center gap-2">
      <span class="text-[12.5px] font-medium">{{ $t('prompts.footer.perPage') }}</span>
      <Select :model-value="String(perPage)" @update:model-value="setPerPage">
        <SelectTrigger class="h-8 w-[70px] border-border bg-surface text-[12.5px]" size="sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent side="top">
          <SelectItem v-for="n in ['10', '20', '50']" :key="n" :value="n">{{ n }}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div class="text-[12.5px] font-medium tabular-nums">
      {{ $t('prompts.footer.pageOf', { page, pages }) }}
    </div>

    <div class="flex items-center gap-1.5">
      <Button variant="outline" size="icon" class="size-8 border-border bg-surface" :disabled="page <= 1" :aria-label="$t('prompts.footer.first')" @click="go(1)">
        <ChevronsLeft :size="14" />
      </Button>
      <Button variant="outline" size="icon" class="size-8 border-border bg-surface" :disabled="page <= 1" :aria-label="$t('prompts.footer.prev')" @click="go(page - 1)">
        <ChevronLeft :size="14" />
      </Button>
      <Button variant="outline" size="icon" class="size-8 border-border bg-surface" :disabled="page >= pages" :aria-label="$t('prompts.footer.next')" @click="go(page + 1)">
        <ChevronRight :size="14" />
      </Button>
      <Button variant="outline" size="icon" class="size-8 border-border bg-surface" :disabled="page >= pages" :aria-label="$t('prompts.footer.last')" @click="go(pages)">
        <ChevronsRight :size="14" />
      </Button>
    </div>
  </div>
</template>
