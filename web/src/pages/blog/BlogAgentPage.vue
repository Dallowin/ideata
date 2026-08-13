<script setup lang="ts">
// «Профиль агента» Blog Writer: хедер раздела (аватар + заголовок + сабтайтл),
// карточка «Модель и параметры» (выбор модели + числовые гейты) и единое большое
// поле профиля (markdown-разбивка Role/Context/… внутри самого текста).
// Реальные настройки GET/PATCH /blogwriter/settings, скоуп активного бренда.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { Check, Loader2, TriangleAlert } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import EmptyState from '@/components/EmptyState.vue'
import RichEditor from '@/components/editor/RichEditor.vue'
import { api } from '@/lib/api'

const { t } = useI18n()

const settings = ref<any | null>(null)
const loading = ref(true)
const saving = ref(false)
const saved = ref(false)
const saveError = ref('')
// бэк принял не всё: модель и числовые гейты — account-wide и правятся только
// админом (settings.controller → globalIgnored). Показываем ТОЛЬКО по флагу
const globalIgnored = ref(false)

// ── единый документ-профиль ────────────────────────────────────────────────
// persona = ОСНОВНОЙ промпт агента: пиши свободно, любые markdown-разделы
// (# Role, # Context, # Workflow, # Quality Bar, # E-E-A-T…). Он идёт в system
// каждого шага пайплайна. Ниже — СПЕЦ-разделы, которые пайплайн применяет
// точечно (tone/delivery/requirements/brandFacts). Числовые гейты (мин. ссылок
// E-E-A-T, объём) — отдельные контролы рядом с моделью, не текст: из секции
// документа извлекалось ПЕРВОЕ число, и всё написанное вокруг него молча
// пропадало при следующем сохранении.
//
// Границы заголовков через ЮНИКОД-класс \P{L}: обычный \b в JS ASCII-only и
// не ловит кириллицу («Тон» мимо /\bтон\b/); суффиксы через [\p{L}]* не \w*.
const bound = (alt: string) => new RegExp(`(?:^|\\P{L})(?:${alt})(?:\\P{L}|$)`, 'iu')
// СПЕЦ-разделы, которые пайплайн читает отдельно (persona — это всё остальное).
// title() — КОРОТКИЙ заголовок из словаря (функция, а не строка: язык меняется
// на лету) и без чужих ключей (пояснения в hint под полем): напр. «E-E-A-T» в
// заголовке ловился бы requirements-регэкспом раньше своей секции. Регэкспы
// ловят и русские, и английские заголовки — документ, набранный на одном языке,
// разбирается и после переключения интерфейса на другой.
const SPECIAL = [
  { key: 'tone', title: () => t('blog.pages.agent.sections.tone'), re: bound('тон|tone') },
  { key: 'delivery', title: () => t('blog.pages.agent.sections.delivery'), re: bound('подач[\\p{L}]*|уникальн[\\p{L}]*|delivery|стиль|style') },
  { key: 'requirements', title: () => t('blog.pages.agent.sections.requirements'), re: bound('требован[\\p{L}]*|обязательн[\\p{L}]*|жёстк[\\p{L}]*|жестк[\\p{L}]*|гардрейл[\\p{L}]*|eeat|e-e-a-t|цитиров[\\p{L}]*|фактчек[\\p{L}]*|faq|requirements|guardrails') },
  { key: 'brandFacts', title: () => t('blog.pages.agent.sections.brandFacts'), re: bound('факт[\\p{L}]*|опыт[\\p{L}]*|brand ?facts?|facts?') },
  { key: 'author', title: () => t('blog.pages.agent.sections.author'), re: bound('автор[\\p{L}]*|author') },
  { key: 'categories', title: () => t('blog.pages.agent.sections.categories'), re: bound('рубрик[\\p{L}]*|категори[\\p{L}]*|categor[\\p{L}]*|topics') },
] as const

const normTitle = (t: string) => t.replace(/[*_`#]/g, '').trim()

// настройки → единый документ: свободная persona сверху + все спец-разделы снизу
function composeDoc(s: any): string {
  const persona = String(s?.persona ?? '').trim()
  const special = SPECIAL.map((sec) => `# ${sec.title()}\n\n${String(s?.[sec.key] ?? '').trim()}`.trimEnd()).join('\n\n')
  return `${persona}\n\n${special}`.trim()
}

// документ → значения: всё до первого СПЕЦ-заголовка (+ нераспознанные
// заголовки) = persona; спец-разделы вытягиваются в свои ключи.
function parseDoc(md: string): Record<string, string> {
  const keys = ['persona', ...SPECIAL.map((s) => s.key)]
  const buf: Record<string, string[]> = Object.fromEntries(keys.map((k) => [k, []]))
  let cur = 'persona'
  for (const line of md.split('\n')) {
    const h = /^#{1,4}\s+(.+?)\s*$/.exec(line)
    if (h) {
      const sec = SPECIAL.find((x) => x.re.test(normTitle(h[1]!)))
      if (sec) { cur = sec.key; continue } // спец-заголовок → своя секция, заголовок не пишем
      // любой другой заголовок (Role/Context/Workflow/…) остаётся в тексте
    }
    buf[cur]!.push(line)
  }
  const out: Record<string, string> = {}
  for (const k of keys) out[k] = buf[k]!.join('\n').trim()
  return out
}

// список всех ключей настроек, что живут в поле профиля
const ALL_KEYS = ['persona', ...SPECIAL.map((s) => s.key)] as const

// document + numeric gates (article length and minimum sources). The model is
// picked per-article in the composer, so it lives there. Content language is
// set per-brand at onboarding (brand.language), not here.
const form = ref<{ profile: string; targetWords: string; minCitations: string }>({
  profile: '', targetWords: '', minCitations: '',
})

const editorRef = ref<InstanceType<typeof RichEditor> | null>(null)

function fillForm(s: any) {
  form.value = {
    profile: composeDoc(s),
    targetWords: String(s?.targetWords ?? ''),
    minCitations: String(s?.minCitations ?? ''),
  }
}

async function loadAll() {
  loading.value = true
  try {
    const s = await api.blogSettings()
    settings.value = s
    fillForm(s)
  } catch { settings.value = null }
  finally { loading.value = false }
}
onMounted(loadAll)

const dirty = computed(() => {
  if (!settings.value) return false
  const s = settings.value
  return form.value.profile !== composeDoc(s)
    || form.value.targetWords !== String(s.targetWords ?? '')
    || form.value.minCitations !== String(s.minCitations ?? '')
})

// AI-правка выделения в документе-профиле: шлём в /blogwriter/ai-edit
const aiBusy = ref(false)
const aiError = ref('')

// Ручка исторически отдавала HTML. Просим markdown (format), но если бэк
// старый — мягко разворачиваем теги: в markdown-поле они видны как текст.
function toMarkdown(s: string): string {
  if (!/<[a-z][^>]*>/i.test(s)) return s
  return s
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|ul|ol)>/gi, '\n')
    .replace(/<\/?(strong|b)>/gi, '**')
    .replace(/<\/?(em|i)>/gi, '_')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, '\'').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function onAskAi(instruction: string, selection: string) {
  const src = (selection || form.value.profile).trim()
  if (!src || aiBusy.value) return
  aiBusy.value = true
  aiError.value = ''
  try {
    const r = await api.blogAiEdit(src, instruction, { format: 'markdown' })
    const edited = toMarkdown(String(r?.html ?? '').trim())
    // mock-режим возвращает фрагмент как есть — вставлять нечего
    if (r?.mock) return
    if (edited !== src) editorRef.value?.applyAiEdit(edited)
  } catch (e: any) {
    aiError.value = e?.serverMessage || t('blog.pages.agent.aiFailed')
  } finally { aiBusy.value = false }
}

// ── «Голос с сайта» ────────────────────────────────────────────────────────
// save:false — бэк ничего не пишет: результат кладём в форму на ревью, автор
// правит, и автосейв сохраняет уже проверенный вариант.
const voiceBusy = ref(false)
const voiceNote = ref('')
async function analyzeVoice() {
  if (voiceBusy.value || !settings.value) return
  voiceBusy.value = true
  voiceNote.value = ''
  saveError.value = ''
  try {
    const v = await api.blogVoiceAnalyze(false)
    form.value.profile = composeDoc({
      ...settings.value,
      persona: v?.persona,
      tone: v?.tone,
      requirements: v?.requirements,
      categories: v?.categories,
    })
    voiceNote.value = t('blog.pages.agent.voiceReady', { domain: v?.domain ?? '', n: v?.pagesCrawled ?? 0 })
  } catch (e: any) {
    saveError.value = e?.serverMessage || t('blog.pages.agent.voiceFailed')
  } finally { voiceBusy.value = false }
}

// ── hot save: тихое автосохранение с дебаунсом (без кнопки) ───────────────
async function flush() {
  if (!dirty.value || saving.value || !settings.value) return
  const s = settings.value
  const patch: Record<string, unknown> = {}
  // документ → все ключи настроек (persona + спец-разделы)
  const parsed = parseDoc(form.value.profile)
  for (const key of ALL_KEYS) {
    if (parsed[key] !== String(s[key] ?? '').trim()) patch[key] = parsed[key]
  }
  const nums: Record<string, string> = { targetWords: form.value.targetWords, minCitations: form.value.minCitations }
  for (const [key, v] of Object.entries(nums)) {
    if (v !== String(s[key] ?? '') && v.trim() !== '' && Number.isFinite(Number(v))) patch[key] = Number(v)
  }
  saving.value = true
  saveError.value = ''
  try {
    const r = await api.blogPatchSettings(patch)
    globalIgnored.value = !!r?.globalIgnored
    // merge the saved values into the baseline (no loadAll — don't disturb the editor/cursor)
    Object.assign(settings.value, {
      ...parsed,
      targetWords: form.value.targetWords,
      minCitations: form.value.minCitations,
    })
    saved.value = true
    setTimeout(() => (saved.value = false), 1600)
  } catch (e: any) {
    // молчать тут нельзя: автор видит «Есть изменения» и уходит со страницы,
    // считая, что всё сохранилось само
    saveError.value = e?.serverMessage || t('blog.pages.agent.saveFailed')
  } finally { saving.value = false }
}

let debounce: ReturnType<typeof setTimeout> | null = null
watch(form, () => {
  if (loading.value) return
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(flush, 900)
}, { deep: true })
// не потерять несохранённое при уходе со страницы
onBeforeUnmount(() => { if (debounce) clearTimeout(debounce); flush() })
onBeforeRouteLeave(async () => {
  if (!dirty.value) return true
  if (debounce) { clearTimeout(debounce); debounce = null }
  await flush()
  // сохранить не удалось — спрашиваем, а не теряем правки молча
  return !dirty.value || window.confirm(t('blog.pages.agent.leaveUnsaved'))
})

// индикатор состояния автосейва в хедере раздела
const saveStatus = computed(() =>
  saveError.value ? 'error' : saving.value ? 'saving' : saved.value ? 'saved' : dirty.value ? 'dirty' : 'idle')
</script>

<template>
  <div class="space-y-6 p-5 lg:p-8">
    <p v-if="loading" class="py-16 text-center text-[13px] text-muted-foreground">{{ $t('state.loading') }}</p>
    <EmptyState v-else-if="!settings" :hint="$t('blog.pages.agent.unavailable')" />

    <template v-else>
      <!-- хедер раздела: аватар + заголовок слева, состояние автосейва справа -->
      <div class="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div class="flex min-w-0 items-center gap-3">
          <img src="/icons/blog-writer.webp" alt="Blog Writer" class="size-8 shrink-0 rounded-lg border border-border object-cover" />
          <div class="min-w-0">
            <h1 class="text-[22px] font-bold tracking-[-0.025em]">{{ $t('blog.pages.agent.profileTitle') }}</h1>
            <p class="mt-1 text-[13px] text-muted-foreground">{{ $t('blog.pages.agent.subtitle') }}</p>
          </div>
        </div>

        <div v-if="saveStatus !== 'idle'" class="flex items-center gap-2">
          <span
            class="inline-flex max-w-[360px] items-center gap-1.5 truncate rounded-full border border-border bg-surface px-2.5 py-1 text-[11.5px] font-medium"
            :class="saveStatus === 'saved' ? 'text-success' : saveStatus === 'error' ? 'text-danger' : 'text-muted-foreground'"
          >
            <Loader2 v-if="saveStatus === 'saving'" :size="12" class="animate-spin" />
            <Check v-else-if="saveStatus === 'saved'" :size="12" />
            <TriangleAlert v-else-if="saveStatus === 'error'" :size="12" />
            <span v-else class="size-1.5 rounded-full bg-warning"></span>
            {{ saveStatus === 'saving' ? $t('blog.pages.agent.saving')
              : saveStatus === 'saved' ? $t('blog.pages.agent.saved')
                : saveStatus === 'error' ? saveError : $t('blog.pages.agent.dirty') }}
          </span>
          <Button v-if="saveStatus === 'error'" size="sm" variant="outline" class="h-7 border-border bg-surface" @click="flush">{{ $t('action.retry') }}</Button>
        </div>
      </div>

      <!-- backend didn't accept everything: show strictly per the response flag, not "just in case" -->
      <p v-if="globalIgnored" class="rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-[12.5px] text-warning">
        {{ $t('blog.pages.agent.globalIgnored') }}
      </p>

      <!-- Run parameters: label on top, control below; control bottoms aligned
           on one line (items-end). Model is chosen per-article in the composer. -->
      <section class="rounded-2xl border border-border bg-background p-5">
        <div class="flex flex-wrap items-end gap-4">
          <!-- Pipeline numeric gates: previously lived as document sections,
               where only the first number was parsed and the rest was lost -->
          <label class="block">
            <span class="mb-1 block text-[12px] text-muted-foreground">{{ $t('blog.pages.agent.sections.targetWords') }}</span>
            <input
              v-model="form.targetWords" type="number" min="300" max="8000" step="100" inputmode="numeric"
              class="h-9 w-[130px] rounded-lg border border-border bg-surface px-3 text-[13px] tabular-nums outline-none focus:border-ring"
            >
          </label>
          <label class="block">
            <span class="mb-1 block text-[12px] text-muted-foreground">{{ $t('blog.pages.agent.sections.minCitations') }}</span>
            <input
              v-model="form.minCitations" type="number" min="0" max="20" step="1" inputmode="numeric"
              class="h-9 w-[130px] rounded-lg border border-border bg-surface px-3 text-[13px] tabular-nums outline-none focus:border-ring"
            >
          </label>
        </div>

        <!-- "Agent tools" / "Skills" hidden until real functionality exists -->
      </section>

      <!-- Профиль агента: одно большое поле с markdown-разбивкой -->
      <section>
        <div class="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 class="text-[17px] font-bold tracking-[-0.02em]">{{ $t('blog.pages.agent.profileTitle') }}</h2>
          <i18n-t keypath="blog.pages.agent.profileHint" scope="global" tag="p" class="text-[12px] text-muted-foreground/80">
            <template #main><b class="font-medium text-foreground/80">{{ $t('blog.pages.agent.profileHintMain') }}</b></template>
          </i18n-t>
        </div>
        <div class="mt-2.5 flex flex-wrap gap-1.5">
          <span
            v-for="sec in SPECIAL" :key="sec.key"
            class="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-[11px] font-medium text-muted-foreground"
          >
            <span class="text-foreground/70">#</span>{{ sec.title() }}
          </span>
        </div>

        <!-- своего голоса ещё нет: даём собрать его с сайта прямо тут -->
        <div v-if="!settings.hasOwnVoice" class="mt-2 flex flex-wrap items-center gap-2">
          <p class="text-[11.5px] text-warning">{{ $t('blog.pages.agent.voicePending') }}</p>
          <Button size="sm" variant="outline" class="h-7 border-border bg-surface" :disabled="voiceBusy" @click="analyzeVoice">
            <Loader2 v-if="voiceBusy" :size="13" class="animate-spin" />
            {{ $t('blog.pages.agent.voiceAnalyze') }}
          </Button>
        </div>
        <p v-if="voiceNote" class="mt-2 rounded-lg border border-border bg-surface px-3 py-2 text-[12px] text-muted-foreground">{{ voiceNote }}</p>
        <p v-if="aiError" class="mt-2 rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-[12.5px] text-danger">{{ aiError }}</p>

        <div class="relative mt-3">
          <RichEditor
            ref="editorRef"
            v-model="form.profile"
            :min-height="360"
            :placeholder="$t('blog.pages.agent.editorPlaceholder')"
            @ask-ai="onAskAi"
          />
          <div v-if="aiBusy" class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl bg-black/40">
            <span class="rounded-full border border-border bg-popover px-3 py-1.5 text-[12px] text-muted-foreground">{{ $t('blog.pages.agent.aiBusy') }}</span>
          </div>
        </div>
        <p class="mt-1.5 text-[11px] text-muted-foreground/70">{{ $t('blog.pages.agent.editorHint') }}</p>
      </section>
    </template>
  </div>
</template>
