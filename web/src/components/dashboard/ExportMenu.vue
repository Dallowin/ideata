<script setup lang="ts">
// Экспорт данных мониторинга. Форматы гейтятся тарифом (limits.export с бэка:
// free — ничего, Старт — csv, Бестселлер и выше — csv + xlsx). Философия
// fail-open: пока тариф неизвестен, кнопки не лочим — гейт всё равно на бэке.
import { computed, onMounted } from 'vue'
import { Download, FileSpreadsheet, FileText, Lock } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { usePlan } from '@/composables/usePlan'
import { exportAnswersXls, exportPromptsCsv, exportSourcesCsv } from '@/lib/export'
import type { Platform, PromptRow, SourceRow } from '@/data/prompts'

const props = defineProps<{
  rows: PromptRow[]
  platforms: Platform[]
  sources: SourceRow[]
  domain: string
}>()

const { check, limits, known } = usePlan()
onMounted(() => check())

const formats = computed(() => limits.value.export)
const canCsv = computed(() => !known.value || !formats.value || formats.value.includes('csv'))
const canXls = computed(() => !known.value || !formats.value || formats.value.includes('xlsx'))
const hasData = computed(() => props.rows.length > 0)
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button
        variant="outline" size="sm"
        class="h-8 border-border bg-surface text-[12.5px]"
        :disabled="!hasData"
      >
        <Download :size="13" /> {{ $t('action.export') }}
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="w-64 border-border bg-popover">
      <DropdownMenuLabel class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {{ $t('monitoring.export.label') }}
      </DropdownMenuLabel>

      <DropdownMenuItem :disabled="!canCsv" class="gap-2" @click="exportPromptsCsv(rows, platforms, domain)">
        <FileText :size="14" />
        <span class="flex-1">
          {{ $t('monitoring.export.promptsCsv') }}
          <span class="block text-[11px] text-muted-foreground">{{ $t('monitoring.export.promptsCsvHint') }}</span>
        </span>
        <Lock v-if="!canCsv" :size="12" class="text-muted-foreground/60" />
      </DropdownMenuItem>

      <DropdownMenuItem :disabled="!canCsv" class="gap-2" @click="exportSourcesCsv(sources, domain)">
        <FileText :size="14" />
        <span class="flex-1">
          {{ $t('monitoring.export.sourcesCsv') }}
          <span class="block text-[11px] text-muted-foreground">{{ $t('monitoring.export.sourcesCsvHint') }}</span>
        </span>
        <Lock v-if="!canCsv" :size="12" class="text-muted-foreground/60" />
      </DropdownMenuItem>

      <DropdownMenuSeparator />

      <DropdownMenuItem :disabled="!canXls" class="gap-2" @click="exportAnswersXls(rows, platforms, domain)">
        <FileSpreadsheet :size="14" />
        <span class="flex-1">
          {{ $t('monitoring.export.answersXls') }}
          <span class="block text-[11px] text-muted-foreground">{{ $t('monitoring.export.answersXlsHint') }}</span>
        </span>
        <Lock v-if="!canXls" :size="12" class="text-muted-foreground/60" />
      </DropdownMenuItem>

      <template v-if="!canXls">
        <DropdownMenuSeparator />
        <DropdownMenuItem as-child class="text-[12px] text-muted-foreground">
          <RouterLink to="/subscription">{{ $t('monitoring.export.upsell') }}</RouterLink>
        </DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
