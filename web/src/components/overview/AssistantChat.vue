<script setup lang="ts">
// Чат-ассистент. Раскладка — LobeHub + Notion AI (Mobbin): крупная карточка
// ввода (чип агента и «+» слева, источник данных и круглая кнопка отправки
// справа), приклеенная снизу полоса-подсказка, ряд чипов быстрых вопросов.
// Своего приветствия у чата НЕТ — здороваемся один раз в сводке выше.
//
// Два уровня: (1) интент-роутер (lib/assistant) отвечает типовые вопросы
// детерминированно из агрегатов — мгновенно, без модели и без списаний;
// (2) свободные формулировки уходят в модель через /assistant/chat со снимком
// бренда (дешёвая модель по офф-прайсу kie). Ответ печатается с эффектом стрима.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  ArrowUp, Lightbulb, Link2, Loader2, Plus, Sparkles,
  Swords, TrendingDown, X,
} from 'lucide-vue-next'
import ModelSelect from '@/components/ModelSelect.vue'
import { USD_RUB, messagePriceText } from '@/data/credits'
import type { TrackerAggregates } from '@/composables/useTracker'
import { buildSnapshot, routeQuestion, type AssistantCtx } from '@/lib/assistant'
import { api } from '@/lib/api'

const { t, tm, rt } = useI18n()

const props = defineProps<{
  agg: TrackerAggregates | null
  /** контекст для интент-роутера: те же данные, что рисуют панели */
  ctx: AssistantCtx
  /** незаполненные интеграции — для полосы-подсказки под инпутом */
  missingConnectors?: { key: string; title: string; icon: string }[]
}>()

interface Msg {
  id: number
  role: 'user' | 'bot'
  text: string
  /** ответ собран из данных (не моделью) — показываем ссылку в раздел */
  link?: { label: string; to: string }
  /** вопрос не распознан: показываем, что умеем */
  skills?: boolean
  /** ответ собран роутером из данных — модели не было, кредиты не тратились */
  local?: boolean
  /** сколько кредитов списал бэк за этот ответ (для ответов модели) */
  spent?: number
}

const messages = ref<Msg[]>([])
const draft = ref('')
const thinking = ref(false)
const hintClosed = ref(false)
const listEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLTextAreaElement | null>(null)
let seq = 0

// выбор модели ответа — широкий каталог OpenRouter (deepseek, qwen, llama…),
// юзер сам выбирает, на чём гнать. Список и дефолт приходят с бэка.
type ModelOpt = {
  id: string; label: string; format: string
  inUsd: number | null; outUsd: number | null
  desc?: string; context?: number | null // для карточки модели по наведению
}
const models = ref<ModelOpt[]>([])
const modelId = ref('')
onMounted(async () => {
  const m = await api.assistantModels().catch(() => null)
  models.value = m?.models || []
  if (!modelId.value) modelId.value = m?.default || models.value[0]?.id || ''
})
// Пункты единого селектора (иконки вендоров, группировка и вид — в ModelSelect).
// Справа — цена ОДНОГО вопроса в кредитах, прайс за 1М токенов и контекст
// уезжают в карточку по наведению: в списке сравнивают цену действия.
const price1M = (usd: number | null) =>
  usd == null ? '—' : t('overview.assistant.price.per1M', { n: Math.round(usd * USD_RUB) })
const contextText = (n?: number | null) =>
  !n ? null
    : n >= 1e6
      ? t('overview.assistant.price.mTokens', { n: (n / 1e6).toFixed(n % 1e6 ? 1 : 0) })
      : t('overview.assistant.price.kTokens', { n: Math.round(n / 1000) })
const modelOptions = computed(() =>
  models.value.map((m) => ({
    id: m.id,
    label: m.label,
    hint: messagePriceText(m),
    card: {
      desc: m.desc || null,
      rows: [
        { label: t('overview.assistant.card.message'), value: messagePriceText(m) || '—' },
        { label: t('overview.assistant.card.input'), value: price1M(m.inUsd) },
        { label: t('overview.assistant.card.output'), value: price1M(m.outUsd) },
        ...(contextText(m.context) ? [{ label: t('overview.assistant.card.context'), value: contextText(m.context)! }] : []),
      ],
    },
  })))

const SUGGESTS = computed(() => [
  { icon: TrendingDown, text: t('overview.assistant.suggest.visDrop') },
  { icon: Swords, text: t('overview.assistant.suggest.rivals') },
  { icon: Lightbulb, text: t('overview.assistant.suggest.topics') },
  { icon: Link2, text: t('overview.assistant.suggest.sources') },
])

// умения ассистента — список из словаря (показываем, когда вопрос не распознан)
const SKILLS = computed(() => (tm('overview.skills') as any[]).map((s) => rt(s)))

const showHint = computed(() => !hintClosed.value && (props.missingConnectors?.length ?? 0) > 0)

// сколько символов ответа уже показано (эффект печати у последнего бота)
const streamId = ref<number | null>(null)
const shown = ref(0)
let streamTimer: number | null = null

function streamIn(msg: Msg) {
  streamId.value = msg.id
  shown.value = 0
  if (streamTimer) clearInterval(streamTimer)
  streamTimer = window.setInterval(() => {
    // печатаем пачками — по словам, живее посимвольного
    shown.value = Math.min(msg.text.length, shown.value + 4)
    scrollDown()
    if (shown.value >= msg.text.length) {
      clearInterval(streamTimer!)
      streamTimer = null
      streamId.value = null
    }
  }, 12)
}

async function send(text?: string) {
  const q = (text ?? draft.value).trim()
  if (!q || thinking.value) return
  messages.value.push({ id: ++seq, role: 'user', text: q })
  draft.value = ''
  autoGrow()
  thinking.value = true
  await scrollDown()

  // 1) Роутер — типовые вопросы, мгновенно, без модели и без списаний.
  const routed = routeQuestion(q, props.ctx)
  if (routed) {
    await sleep(380)
    thinking.value = false
    const msg: Msg = { id: ++seq, role: 'bot', text: routed.text.join('\n\n'), link: routed.link, local: true }
    messages.value.push(msg)
    streamIn(msg)
    return
  }

  // 2) Не распознали → свободная формулировка идёт в модель по снимку бренда.
  try {
    const history = messages.value.slice(-6).map((m) => ({ role: m.role, text: m.text }))
    const r = await api.assistantChat(q, buildSnapshot(props.ctx), history, modelId.value || undefined)
    thinking.value = false
    const msg: Msg = {
      id: ++seq, role: 'bot',
      text: (r.answer || '').trim() || t('overview.assistant.emptyAnswer'),
      spent: Number(r.spent || 0),
    }
    messages.value.push(msg)
    streamIn(msg)
  } catch {
    thinking.value = false
    const msg: Msg = {
      id: ++seq, role: 'bot', skills: true,
      text: t('overview.assistant.modelFailed'),
    }
    messages.value.push(msg)
    streamIn(msg)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** видимая часть сообщения (во время печати — обрезка) */
function visible(m: Msg): string {
  return m.id === streamId.value ? m.text.slice(0, shown.value) : m.text
}
const streaming = (m: Msg) => m.id === streamId.value

// мини-markdown: **жирный** и строки-буллеты «• »
function parseMd(text: string) {
  return text.split('\n\n').filter(Boolean).map((para) => {
    const li = para.startsWith('• ')
    const body = li ? para.slice(2) : para
    const parts = body.split(/(\*\*[^*]+\*\*)/g).filter(Boolean).map((seg) =>
      seg.startsWith('**') && seg.endsWith('**')
        ? { b: true, t: seg.slice(2, -2) }
        : { b: false, t: seg },
    )
    return { li, parts }
  })
}

function reset() {
  if (streamTimer) { clearInterval(streamTimer); streamTimer = null }
  streamId.value = null
  messages.value = []
  draft.value = ''
  thinking.value = false
}
onBeforeUnmount(() => { if (streamTimer) clearInterval(streamTimer) })

async function scrollDown() {
  await nextTick()
  listEl.value?.scrollTo({ top: listEl.value.scrollHeight, behavior: 'smooth' })
}

function autoGrow() {
  const el = inputEl.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 180) + 'px'
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

const canSend = computed(() => !!draft.value.trim() && !thinking.value)
</script>

<template>
  <section class="space-y-4">
    <!-- ═══ переписка ═══ -->
    <div v-if="messages.length">
      <div class="mb-3 flex items-center justify-end">
        <button type="button" class="text-[12px] text-muted-foreground transition hover:text-foreground" @click="reset">
          {{ $t('overview.assistant.newChat') }}
        </button>
      </div>

      <div ref="listEl" class="max-h-[400px] space-y-4 overflow-y-auto pr-1">
        <div v-for="m in messages" :key="m.id">
          <div v-if="m.role === 'user'" class="flex justify-end">
            <div class="max-w-[80%] rounded-2xl bg-surface-hover px-3.5 py-2 text-[13.5px] leading-relaxed">
              {{ m.text }}
            </div>
          </div>
          <div v-else class="flex gap-2.5">
            <span class="mt-0.5 grid size-6 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-brand/80 to-violet-500/70">
              <Sparkles :size="12" class="text-white" />
            </span>
            <div class="min-w-0 flex-1">
              <template v-for="(blk, i) in parseMd(visible(m))" :key="i">
                <p
                  v-if="!blk.li" class="text-[13.5px] leading-relaxed text-foreground"
                  :class="i ? 'mt-2.5' : ''"
                ><span v-for="(pt, j) in blk.parts" :key="j" :class="pt.b ? 'font-semibold text-white' : ''">{{ pt.t }}</span></p>
                <p v-else class="mt-1.5 flex gap-2 text-[13.5px] leading-relaxed text-foreground">
                  <span class="mt-[7px] size-1 shrink-0 rounded-full bg-brand-soft"></span>
                  <span><span v-for="(pt, j) in blk.parts" :key="j" :class="pt.b ? 'font-semibold text-white' : ''">{{ pt.t }}</span></span>
                </p>
              </template>
              <span v-if="streaming(m)" class="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-brand-soft align-middle"></span>

              <ul v-if="m.skills && !streaming(m)" class="mt-2.5 space-y-1.5">
                <li v-for="sk in SKILLS" :key="sk" class="flex items-start gap-2 text-[13px] text-muted-foreground">
                  <span class="mt-[7px] size-1 shrink-0 rounded-full bg-muted-foreground/40"></span>{{ sk }}
                </li>
              </ul>

              <RouterLink
                v-if="m.link && !streaming(m)" :to="m.link.to"
                class="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2 px-2.5 py-1.5 text-[12.5px] font-medium text-brand-soft transition hover:bg-surface-hover"
              >{{ m.link.label }} <ArrowUp :size="12" class="rotate-45" /></RouterLink>

              <!-- расход под ответом: у роутера его нет, у модели — списанные кредиты -->
              <p v-if="m.role === 'bot' && !streaming(m)" class="mt-2 text-[11px] text-muted-foreground/60">
                <template v-if="m.local">{{ $t('overview.assistant.cost.local') }}</template>
                <template v-else-if="m.spent">{{ $t('overview.assistant.cost.spent', { n: m.spent }) }}</template>
                <template v-else>{{ $t('overview.assistant.cost.model') }}</template>
              </p>
            </div>
          </div>
        </div>
        <div v-if="thinking" class="flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <Loader2 :size="13" class="animate-spin" /> {{ $t('overview.assistant.thinking') }}
        </div>
      </div>
    </div>

    <!-- ═══ карточка ввода + приклеенная полоса-подсказка ═══ -->
    <div class="overflow-hidden rounded-[18px] border border-border bg-surface-2 transition focus-within:border-white/20">
      <div class="px-3.5 pt-3.5 pb-2.5">
        <textarea
          ref="inputEl" v-model="draft" rows="2"
          :placeholder="$t('overview.assistant.placeholder')"
          class="max-h-[180px] min-h-[52px] w-full resize-none bg-transparent text-[14px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/55"
          @input="autoGrow" @keydown="onKeydown"
        ></textarea>

        <div class="mt-2 flex items-center gap-2">
          <button
            type="button" :title="$t('overview.assistant.attach')"
            class="grid size-7 shrink-0 place-items-center rounded-full border border-border text-muted-foreground/70 transition hover:text-foreground"
          >
            <Plus :size="14" />
          </button>

          <!-- выбор модели ответа — общий список с Blog Writer -->
          <div class="ml-auto min-w-0">
            <ModelSelect
              v-model="modelId" :models="modelOptions" size="pill"
              :placeholder="$t('overview.assistant.modelPlaceholder')"
              :note="$t('overview.assistant.modelNote')"
            />
          </div>
          <button
            type="button"
            class="grid size-8 shrink-0 place-items-center rounded-full transition"
            :class="canSend ? 'bg-foreground text-background hover:opacity-90' : 'bg-surface-hover text-muted-foreground/50'"
            :disabled="!canSend"
            @click="send()"
          >
            <ArrowUp :size="15" />
          </button>
        </div>
      </div>

      <!-- полоса-подсказка снизу карточки (канон Lobe/Notion) -->
      <div v-if="showHint" class="flex items-center gap-2 border-t border-border bg-surface px-3.5 py-2">
        <span class="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">
          {{ $t('overview.assistant.hint') }}
        </span>
        <span class="flex shrink-0 -space-x-1.5">
          <img
            v-for="c in missingConnectors" :key="c.key" :src="c.icon" :alt="c.title" :title="c.title"
            class="size-5 rounded-full bg-surface-2 p-0.5 ring-2 ring-background"
          />
        </span>
        <RouterLink to="/settings" class="shrink-0 text-[12px] font-medium text-foreground hover:underline">{{ $t('overview.recs.action.connect') }}</RouterLink>
        <button type="button" class="shrink-0 text-muted-foreground/60 transition hover:text-foreground" @click="hintClosed = true">
          <X :size="13" />
        </button>
      </div>
    </div>

    <!-- ═══ чипы быстрых вопросов ═══ -->
    <div v-if="!messages.length" class="flex flex-wrap items-center gap-1.5">
      <span class="rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">{{ $t('overview.assistant.askChip') }}</span>
      <button
        v-for="s in SUGGESTS" :key="s.text" type="button"
        class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-[12.5px] text-text-2 transition hover:border-white/20 hover:bg-surface-hover"
        @click="send(s.text)"
      >
        <component :is="s.icon" :size="12.5" class="text-muted-foreground/70" />
        {{ s.text }}
      </button>
    </div>
    <!-- Раньше здесь стояло «без модели и без списания кредитов» под ЛЮБЫМ
         ответом, включая платный вызов. Расход теперь подписан у каждого
         ответа отдельно, а тут — только про типовые вопросы. -->
    <p v-else class="text-[11px] text-muted-foreground/60">
      {{ $t('overview.assistant.footer') }}
    </p>
  </section>
</template>
