<script setup lang="ts">
/**
 * Кто попадает в сравнение мониторинга.
 *
 * Разбор сайта конкурентов УЖЕ находит и складывает в facts.competitors, но в
 * трекер они не попадали: онбординг нового кабинета создаёт бренд без них, а
 * поправить потом было нечем. Отсюда вся ложь на дашборде — «доля голоса 100%»
 * и «позиция 1» означали не победу, а сравнение ни с кем.
 *
 * Подставляем найденных разбором, но НЕ добавляем молча: автоподбор ошибается
 * (в списке легко оказывается агрегатор или собственный поддомен), а выбор
 * определяет, с кем человека сравнивают во всём кабинете.
 *
 * Дополнительных прогонов это не стоит: бренды конкурентов вытаскиваются из тех
 * же ответов ИИ, что уже собраны.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, Plus, X } from 'lucide-vue-next'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { faviconSrc } from '@/data/prompts'
import { api } from '@/lib/api'
import { useBrands } from '@/composables/useBrands'
import { useSiteAnalytic } from '@/composables/useSiteAnalytic'

const props = defineProps<{
  open: boolean
  /** трекер мониторинга — именно из него прогон берёт список сравнения */
  trackerId?: number | null
  /** что сейчас сравнивается: у трекера свой список, он и есть правда */
  current?: string[]
}>()
const emit = defineEmits<{ 'update:open': [boolean]; saved: [string[]] }>()

const { t } = useI18n()
const { active, load: loadBrands } = useBrands()
const { facts, load: loadFacts } = useSiteAnalytic()

const chosen = ref<string[]>([])
const draft = ref('')
const saving = ref(false)
const error = ref('')

// Домен в сравнимый вид: без схемы, www и хвоста пути. Иначе «https://x.ru/»
// и «x.ru» станут двумя разными конкурентами.
function norm(v: string): string {
  return String(v || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '')
}

// Кандидаты из разбора: только те, кого ещё не выбрали, и не мы сами.
// Разбор кладёт в competitors и голые названия («GetBlogger»), а трекер ищет
// упоминания по домену — без точки это не домен, и подставлять его нельзя.
const suggestions = computed(() => {
  const self = norm(active.value?.domain || '')
  const taken = new Set(chosen.value.map(norm))
  return (facts.value?.competitors || [])
    .map((c) => ({ domain: norm(c.domain), source: c.source, mentions: c.mentions }))
    .filter((c) => c.domain.includes('.') && c.domain !== self && !taken.has(c.domain))
    .slice(0, 10)
})

// Бэк сравнивает бренд максимум с четырьмя соперниками — больше просто
// отбрасывается на стороне прогона, поэтому честнее не давать выбрать лишних.
const LIMIT = 4
const full = computed(() => chosen.value.length >= LIMIT)

function add(domain: string) {
  const d = norm(domain)
  if (!d || full.value) return
  if (d === norm(active.value?.domain || '')) { error.value = t('monitoring.competitors.errSelf'); return }
  if (chosen.value.some((c) => norm(c) === d)) return
  chosen.value = [...chosen.value, d]
  error.value = ''
}
function remove(domain: string) {
  chosen.value = chosen.value.filter((c) => c !== domain)
}
function addDraft() {
  if (!draft.value.trim()) return
  add(draft.value)
  draft.value = ''
}

// Открытие: подтягиваем текущий список бренда и разбор (за кандидатами).
watch(() => props.open, (open) => {
  if (!open) return
  error.value = ''
  // Показываем список ТРЕКЕРА: он определяет сравнение. Бренд может расходиться
  // с ним (например, трекер завёлся раньше правки бренда).
  chosen.value = [...(props.current || active.value?.competitors || [])].map(norm)
  loadFacts()
})

async function save() {
  saving.value = true
  error.value = ''
  try {
    // Трекер — обязательная часть: из него прогон читает соперников. Бренд —
    // на будущее (новые трекеры наследуют список), поэтому его сбой не должен
    // отменять уже применённую правку мониторинга.
    if (props.trackerId) await api.aeoSetCompetitors(props.trackerId, chosen.value)
    const id = active.value?.id
    if (id) {
      try {
        await api.updateBrand({ id, competitors: chosen.value })
        await loadBrands(true)
      } catch { /* мониторинг уже обновлён — молча расходимся с брендом */ }
    }
    emit('saved', chosen.value)
    emit('update:open', false)
  } catch (e: any) {
    // текст ошибки с бэкенда показываем как есть — переводим только свой фолбэк
    error.value = e?.message || t('monitoring.competitors.errSave')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-[520px]">
      <DialogHeader>
        <DialogTitle>{{ $t('monitoring.competitors.title') }}</DialogTitle>
        <DialogDescription>
          {{ $t('monitoring.competitors.desc') }}
        </DialogDescription>
      </DialogHeader>

      <div class="space-y-4">
        <div>
          <p class="mb-1.5 text-[11.5px] text-muted-foreground">
            {{ $t('monitoring.competitors.chosen', { n: chosen.length, max: LIMIT }) }}
          </p>
          <div v-if="chosen.length" class="flex flex-wrap gap-1.5">
            <span
              v-for="c in chosen" :key="c"
              class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2 py-1 pl-2 pr-1 text-[12px]"
            >
              <img :src="faviconSrc(c)" width="14" height="14" class="rounded-sm" loading="lazy" />
              {{ c }}
              <button
                type="button" class="rounded-full p-0.5 text-muted-foreground transition hover:text-foreground"
                :aria-label="$t('monitoring.competitors.remove', { domain: c })" @click="remove(c)"
              ><X :size="12" /></button>
            </span>
          </div>
          <p v-else class="text-[12.5px] text-muted-foreground/70">{{ $t('monitoring.competitors.none') }}</p>
        </div>

        <div>
          <label class="mb-1.5 block text-[11.5px] text-muted-foreground">{{ $t('monitoring.competitors.addLabel') }}</label>
          <div class="flex gap-2">
            <Input
              v-model="draft" placeholder="example.com" :disabled="full"
              @keydown.enter.prevent="addDraft"
            />
            <Button type="button" variant="outline" :disabled="full || !draft.trim()" @click="addDraft">
              <Plus :size="14" /> {{ $t('action.add') }}
            </Button>
          </div>
        </div>

        <!-- Разбор предлагает кандидатов не всегда: у старых прогонов их нет
             вовсе. Молчаливо пустой блок читается как «система не нашла
             никого», хотя она просто не искала. -->
        <p v-if="!suggestions.length && !chosen.length" class="text-[11.5px] text-muted-foreground/70">
          {{ $t('monitoring.competitors.noSuggestions') }}
        </p>
        <div v-if="suggestions.length && !full">
          <p class="mb-1.5 text-[11.5px] text-muted-foreground">{{ $t('monitoring.competitors.suggested') }}</p>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="s in suggestions" :key="s.domain" type="button"
              class="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-1 text-[12px] text-text-2 transition hover:bg-surface-hover hover:text-foreground"
              @click="add(s.domain)"
            >
              <img :src="faviconSrc(s.domain)" width="14" height="14" class="rounded-sm" loading="lazy" />
              {{ s.domain }}
              <span v-if="s.source === 'ai'" class="text-[10px] text-violet-300">{{ $t('monitoring.competitors.aiNames') }}</span>
            </button>
          </div>
        </div>

        <p v-if="error" class="text-[12.5px] text-danger">{{ error }}</p>
      </div>

      <DialogFooter>
        <Button variant="ghost" @click="emit('update:open', false)">{{ $t('action.cancel') }}</Button>
        <Button :disabled="saving" @click="save">
          <Loader2 v-if="saving" :size="14" class="animate-spin" />
          {{ $t('action.save') }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
