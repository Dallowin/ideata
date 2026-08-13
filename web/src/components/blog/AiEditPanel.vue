<script setup lang="ts">
// «Магическая ручка» — диалог о ВЫДЕЛЕННОМ фрагменте статьи.
// Открывается из bubble-меню редактора: выделенный HTML уходит в контекст
// (POST /blogwriter/ai-edit), автор пишет что с ним сделать, ответ показывается
// превью — и применяется ТОЛЬКО к выделенной части («Заменить»/«Вставить ниже»).
// Диалог многошаговый: следующее указание правит уже последний вариант, прошлые
// указания едут в history. Модель выбирается из каталога, расход (токены + ₽)
// показывается по факту вызова, а не обещанием.
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowUp, ChevronDown, CornerDownLeft, Eraser, Expand,
  Feather, Loader2, PenLine, PenTool, Scissors, Type, X,
} from 'lucide-vue-next'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import ModelSelect from '@/components/ModelSelect.vue'
import { USD_RUB, messagePriceText } from '@/data/credits'
import { api } from '@/lib/api'

const { t, tm, rt } = useI18n()

const props = defineProps<{
  /** выделенный фрагмент как HTML — контекст диалога */
  html: string
  /** заголовок статьи, чтобы агент понимал, о чём текст */
  title?: string
}>()
const emit = defineEmits<{
  (e: 'apply', html: string): void
  (e: 'insert', html: string): void
  (e: 'close'): void
  /** высота панели изменилась — родителю пора пересчитать её положение */
  (e: 'resize'): void
}>()

interface Usage { model: string; tokensIn: number | null; tokensOut: number | null; costRub: number | null }
interface Turn { instruction: string; html: string; usage: Usage | null }

// Действия живут МЕНЮ, а не рядом пилюль: пилюли расползались по ширине и в них
// некуда добавить шестое действие. Тон — подменю (как «Adjust tone» у Strut):
// вариантов тона всегда несколько, и в один ряд они не влезают.
// Указание уходит агенту НА ЯЗЫКЕ ИНТЕРФЕЙСА и им же показывается в истории
// диалога, поэтому и подпись, и промпт лежат в словаре; иконки — здесь.
const QUICK_ICONS = [PenLine, Scissors, Expand, Feather, Eraser]
const QUICK = computed(() =>
  (tm('blog.editor.ai.quick') as unknown[]).map((row: any, i) => ({
    l: rt(row.label), p: rt(row.prompt), icon: QUICK_ICONS[i],
  })))
const TONES = computed(() =>
  (tm('blog.editor.ai.tones') as unknown[]).map((row: any) => ({ l: rt(row.label), p: rt(row.prompt) })))

const models = ref<{
  id: string; label: string
  inUsd: number | null; outUsd: number | null
  desc?: string; context?: number | null // для карточки модели по наведению
}[]>([])
const model = ref('') // '' = модель из настроек бренда
const input = ref('')
const turns = ref<Turn[]>([])
const busy = ref(false)
const error = ref('')
const mock = ref(false)
const box = ref<HTMLElement>()
const field = ref<HTMLTextAreaElement>()

const draft = computed(() => (turns.value.length ? turns.value[turns.value.length - 1].html : ''))
const hasResult = computed(() => turns.value.length > 0)

// Что именно правим — показываем в самой панели. Раньше было только «Что сделать
// с выделенным?»: при длинном выделении автор не видел его границ и гадал,
// зацепил ли лишний абзац.
const selectedText = computed(() => {
  const el = document.createElement('div')
  el.innerHTML = props.html
  return (el.textContent || '').replace(/\s+/g, ' ').trim()
})
// Режем строкой, а не line-clamp: стили редактора перебивают клэмп, и обрезка
// вставала посреди строки — обрубок выглядел как баг вёрстки.
const selectedPreview = computed(() =>
  selectedText.value.length > 150 ? `${selectedText.value.slice(0, 149).trimEnd()}…` : selectedText.value)
/**
 * Пункты селектора — только конкретные модели: пункта «как в настройках» нет,
 * по нему не понять, чем реально правят. Стартовое значение = сильная модель
 * бренда (её отдаёт каталог полем default). Справа — примерная цена одной
 * правки, прайс и контекст — в карточке по наведению.
 */
const price1M = (usd: number | null) =>
  (usd == null ? '—' : t('blog.editor.ai.per1m', { n: Math.round(usd * USD_RUB) }))
const contextText = (n?: number | null) =>
  !n ? null
    : n >= 1e6 ? t('blog.editor.ai.contextM', { n: (n / 1e6).toFixed(n % 1e6 ? 1 : 0) })
      : t('blog.editor.ai.contextK', { n: Math.round(n / 1000) })
const modelOptions = computed(() => models.value.map((m) => ({
  id: m.id,
  label: m.label,
  hint: messagePriceText(m),
  card: {
    desc: m.desc || null,
    rows: [
      { label: t('blog.editor.ai.priceEdit'), value: messagePriceText(m) || '—' },
      { label: t('blog.editor.ai.priceIn'), value: price1M(m.inUsd) },
      { label: t('blog.editor.ai.priceOut'), value: price1M(m.outUsd) },
      ...(contextText(m.context) ? [{ label: t('blog.editor.ai.context'), value: contextText(m.context)! }] : []),
    ],
  },
})))
const totalRub = computed(() =>
  turns.value.reduce((sum, t) => sum + (t.usage?.costRub ?? 0), 0),
)

/** «1 240 токенов»; бэк иногда не считает токены — тогда прочерк вместо числа */
function tokensText(u: Usage): string {
  const n = (u.tokensIn ?? 0) + (u.tokensOut ?? 0)
  return n ? t('blog.editor.ai.tokens', { n }, n) : t('blog.editor.ai.tokensUnknown')
}

// Бэк отдаёт себестоимость вызова в рублях (llm_usage), а витрина кабинета
// живёт в долларах — переводим по тому же курсу, что в учёте затрат.
function rub(v: number | null | undefined): string {
  if (v == null) return '—'
  const usd = v / USD_RUB
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

// панель растёт по ходу диалога (ответ, ошибка, кнопки применения) — родитель
// держит её у выделения и должен пересчитать положение после каждого изменения
watch([busy, error, mock, () => turns.value.length], () => {
  nextTick(() => emit('resize'))
})

// Каталог моделей грузим один раз при первом открытии панели; вместе с ним
// приходит default — модель, на которой правка поедет без явного выбора.
async function loadModels() {
  if (models.value.length) return
  try {
    const r = await api.blogModels()
    models.value = r?.models || []
    const dflt = String(r?.default || '')
    if (!model.value && models.value.some((m) => m.id === dflt)) model.value = dflt
  } catch { /* каталог необязателен */ }
}

// новое выделение → новый диалог
watch(() => props.html, () => {
  turns.value = []
  input.value = ''
  error.value = ''
  mock.value = false
  loadModels()
  nextTick(() => field.value?.focus())
}, { immediate: true })

async function send(instruction?: string) {
  const q = (instruction ?? input.value).trim()
  if (!q || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const r = await api.blogAiEdit(draft.value || props.html, q, {
      model: model.value || undefined,
      history: turns.value.map((t) => t.instruction),
      title: props.title,
    })
    mock.value = !!r?.mock
    turns.value.push({ instruction: q, html: String(r?.html ?? ''), usage: r?.usage ?? null })
    input.value = ''
    nextTick(() => box.value?.scrollTo({ top: box.value.scrollHeight }))
  } catch (e: any) {
    error.value = e?.status === 402 || e?.status === 429
      ? t('blog.editor.ai.errorLimit')
      : t('blog.editor.ai.errorFailed')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="w-[460px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-popover shadow-2xl shadow-black/40">
    <!-- шапка: имя инструмента и закрыть — настройки уехали вниз, цвет монохром -->
    <div class="flex items-center gap-2 px-3 py-2">
      <PenTool :size="14" class="text-muted-foreground" />
      <span class="text-[12.5px] font-medium">{{ $t('blog.editor.ai.title') }}</span>

      <button type="button" class="ml-auto grid size-8 place-items-center rounded-md text-muted-foreground transition hover:bg-surface-hover hover:text-foreground" @click="emit('close')">
        <X :size="13" />
      </button>
    </div>

    <!-- что именно правим: видно границы выделения, пока нет результата -->
    <p v-if="selectedText && !hasResult && !busy" class="border-t border-border px-3 py-2 text-[12px] leading-relaxed text-muted-foreground/70">
      {{ selectedPreview }}
    </p>

    <!-- диалог -->
    <div v-if="hasResult || error || busy" ref="box" class="max-h-[46vh] space-y-2.5 overflow-y-auto border-t border-border px-3 py-2.5">
      <div v-for="(turn, i) in turns" :key="i" class="space-y-1.5">
        <p class="text-[12px] text-muted-foreground">
          <CornerDownLeft :size="11" class="mr-1 inline -translate-y-px" />{{ turn.instruction }}
        </p>
        <!-- ответ агента — контент, не переводим -->
        <div v-if="turn.html" class="ai-preview rounded-lg border border-border bg-surface px-2.5 py-2 text-[13px] leading-relaxed" v-html="turn.html" />
        <p v-else class="rounded-lg border border-dashed border-border px-2.5 py-2 text-[12.5px] text-muted-foreground">
          {{ $t('blog.editor.ai.suggestDelete') }}
        </p>
        <!-- имя модели приходит с бэка — не переводим -->
        <p v-if="turn.usage" class="text-[11px] tabular-nums text-muted-foreground/70">
          {{ turn.usage.model }} · {{ tokensText(turn.usage) }} · {{ rub(turn.usage.costRub) }}
        </p>
      </div>

      <p v-if="busy" class="flex items-center gap-2 text-[12.5px] text-muted-foreground">
        <Loader2 :size="13" class="animate-spin" /> {{ $t('blog.editor.ai.working') }}
      </p>
      <p v-if="mock" class="text-[12px] text-warning/80">{{ $t('blog.editor.ai.mock') }}</p>
      <p v-if="error" class="text-[12.5px] text-danger">{{ error }}</p>
    </div>

    <!-- применение результата -->
    <div v-if="hasResult && !busy" class="flex items-center gap-1.5 border-t border-border px-3 py-2">
      <button type="button" class="h-7 rounded-lg bg-foreground px-2.5 text-[12px] font-medium text-background transition hover:opacity-90" @click="emit('apply', draft)">
        {{ $t('blog.editor.ai.replace') }}
      </button>
      <button type="button" class="h-7 rounded-lg border border-border px-2.5 text-[12px] text-muted-foreground transition hover:text-foreground" @click="emit('insert', draft)">
        {{ $t('blog.editor.ai.insertBelow') }}
      </button>
      <span v-if="totalRub > 0" class="ml-auto text-[11px] tabular-nums text-muted-foreground/70">{{ $t('blog.editor.ai.totalCost', { cost: rub(totalRub) }) }}</span>
    </div>

    <!-- ввод -->
    <div class="border-t border-border p-2.5">
      <textarea
        ref="field" v-model="input" rows="1" maxlength="500"
        :placeholder="hasResult ? $t('blog.editor.ai.askMore') : $t('blog.editor.ai.ask')"
        class="max-h-24 min-h-[28px] w-full resize-none bg-transparent text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/50"
        @keydown.enter.exact.prevent="send()"
      ></textarea>
      <!-- нижний ряд: готовые действия меню + модель пилюлей (как в композере) -->
      <div class="mt-2 flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button
              type="button" :disabled="busy"
              class="inline-flex h-8 items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2.5 text-[12px] font-medium text-muted-foreground transition hover:text-foreground data-[state=open]:text-foreground disabled:opacity-50"
            >
              <PenLine :size="13" /> {{ $t('blog.editor.ai.actions') }} <ChevronDown :size="12" class="opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" :side-offset="6" class="w-56">
            <DropdownMenuItem v-for="q in QUICK" :key="q.l" class="gap-2" @click="send(q.p)">
              <component :is="q.icon" :size="14" class="shrink-0 text-muted-foreground" />
              {{ q.l }}
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger class="gap-2">
                <Type :size="14" class="shrink-0 text-muted-foreground" /> {{ $t('blog.editor.ai.tone') }}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent class="w-44">
                <DropdownMenuItem v-for="tone in TONES" :key="tone.l" @click="send(tone.p)">{{ tone.l }}</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>

        <div class="ml-auto flex min-w-0 items-center gap-2">
          <ModelSelect
            v-model="model" :models="modelOptions" size="pill" :placeholder="$t('blog.editor.ai.model')"
            :note="$t('blog.editor.ai.modelNote')"
          />
          <button
            type="button" :aria-label="$t('blog.editor.ai.send')"
            class="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background transition disabled:bg-surface-hover disabled:text-muted-foreground"
            :disabled="!input.trim() || busy" @click="send()"
          >
            <Loader2 v-if="busy" :size="14" class="animate-spin" /><ArrowUp v-else :size="15" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* превью ответа: та же типографика, что в теле статьи, но компактнее */
.ai-preview :deep(> * + *) { margin-top: .6em; }
.ai-preview :deep(h2), .ai-preview :deep(h3) { font-size: 14px; font-weight: 600; }
.ai-preview :deep(ul) { list-style: disc; padding-left: 1.2em; }
.ai-preview :deep(ol) { list-style: decimal; padding-left: 1.2em; }
.ai-preview :deep(blockquote) { border-left: 2px solid var(--border); padding-left: .7em; color: var(--muted-foreground); }
</style>
