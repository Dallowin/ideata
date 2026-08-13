<script setup lang="ts">
// «Начать новую тему» = создать статью: POST /blogwriter/runs {topic, mode, targetQueries, model}.
// Настройки: режим (Автопилот/Пошагово), модель статьи с ценой, целевые AEO-запросы
// (вручную + подбор под тему), баланс кредитов и цена статьи. Префилл темы/запросов
// из «Идей» (?topic,?q).
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ArrowUp, Bot, Check, ChevronDown, Footprints, Loader2, Plus, Target, X } from 'lucide-vue-next'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import ModelSelect from '@/components/ModelSelect.vue'
import { POST_TOKENS_MAX, POST_TOKENS_MIN, creditsRange } from '@/data/credits'
import { articleModelOptions, type CatalogModel } from '@/lib/modelOptions'
import { makeDefaultCover } from '@/lib/preview/autoCover'
import { api } from '@/lib/api'
import { useBlogRuns } from '@/composables/useBlogRuns'

const route = useRoute()
const router = useRouter()
const { t, tm, rt } = useI18n()
const { load } = useBlogRuns()

// префилл из «Идей тем» (?topic, ?q — через | )
const topic = ref(String(route.query.topic || '').slice(0, 300))
const queries = ref<string[]>(
  String(route.query.q || '').split('|').map((s) => s.trim()).filter(Boolean),
)
const mode = ref<'auto' | 'interactive'>('auto')
const busy = ref(false)
const error = ref('')
/** ошибка именно про кредиты — рядом с ней нужна ссылка «Пополнить» */
const payWall = ref(false)

// целевые запросы
const queryInput = ref('')
const suggestions = ref<string[]>([])
const suggesting = ref(false)
const showQueries = ref(false)

// Модель ЭТОЙ статьи: '' — сильная модель из настроек бренда. Дорогую модель
// теперь можно взять разово, не переключая её всему аккаунту в настройках.
const model = ref('')
const models = ref<CatalogModel[]>([])

// Статья оплачивается кредитами, а не дневной квотой: показываем баланс и
// во сколько обойдётся прогон на ВЫБРАННОЙ модели. credits.model — модель, на
// которой ран реально поедет (после Opus-гейта тарифа).
const credits = ref<{ balance: number; perPost: number; degraded: boolean; model: string } | null>(null)
const notEnough = computed(() =>
  !!credits.value && !credits.value.degraded && credits.value.balance < credits.value.perPost)

/**
 * Пункты селектора — только конкретные модели: пункт «как в настройках» убран,
 * в композере всегда видно, чем именно пишем. Вид пункта общий с «Профилем
 * агента» (articleModelOptions): справа вилка цены СТАТЬИ в кредитах, прайс за
 * 1М и контекст — в карточке ховера.
 */
const modelOptions = computed(() => articleModelOptions(models.value))

/**
 * Вилка цены статьи на выбранной модели — пересчитывается сразу при смене
 * модели, до всякого запроса. Одним числом тут врать нельзя: разброс между
 * заметкой и лонгридом с большим ресёрчем — в разы.
 */
const postPrice = computed(() => {
  const id = model.value || credits.value?.model || ''
  const m = models.value.find((x) => x.id === id)
  const range = m ? creditsRange(m, POST_TOKENS_MIN, POST_TOKENS_MAX) : null
  if (range) return t('blog.pages.new.creditsRange', { from: range[0], to: range[1] })
  return credits.value?.perPost ? t('blog.pages.new.credits', { n: credits.value.perPost }) : ''
})

async function loadCredits() {
  try {
    const c = await api.blogCredits(model.value || undefined)
    credits.value = {
      balance: Number(c?.balance || 0),
      perPost: Number(c?.perPost || 0),
      degraded: !!c?.degraded,
      model: String(c?.model || ''),
    }
  } catch { /* не залогинен — бейдж просто не покажем */ }
}

onMounted(async () => {
  await Promise.all([
    loadCredits(),
    api.blogModels().then((r) => { models.value = r?.models || [] }).catch(() => {}),
  ])
  // Стартовое значение — модель бренда из настроек (её же вернул /credits).
  // Пункта «как в настройках» в списке нет: юзер должен видеть конкретную
  // модель. Если её нет в каталоге — оставляем пусто, бэк возьмёт настроечную.
  const brandModel = credits.value?.model || ''
  if (!model.value && models.value.some((m) => m.id === brandModel)) model.value = brandModel
})

// цена статьи считается на бэке (там же Opus-гейт тарифа) — пересчитываем её,
// а не показываем оценку с фронта, чтобы цифра совпадала со списанием
watch(model, () => { loadCredits() })

const MODES = computed(() => [
  { v: 'auto', l: t('blog.pages.new.modes.auto.label'), icon: Bot, hint: t('blog.pages.new.modes.auto.hint') },
  { v: 'interactive', l: t('blog.pages.new.modes.interactive.label'), icon: Footprints, hint: t('blog.pages.new.modes.interactive.hint') },
] as const)
const activeMode = computed(() => MODES.value.find((m) => m.v === mode.value) || MODES.value[0])

// примеры тем — массив словаря: tm() + rt(), иначе на промахе экран падает
const EXAMPLES = computed(() => (tm('blog.pages.new.examples') as unknown[]).map((e) => rt(e as string)))

function addQuery(q?: string) {
  const val = (q ?? queryInput.value).trim()
  if (!val) return
  if (!queries.value.includes(val) && queries.value.length < 20) queries.value.push(val)
  queryInput.value = ''
}
function removeQuery(q: string) { queries.value = queries.value.filter((x) => x !== q) }

async function suggest() {
  // не «t»: это имя занято переводчиком useI18n
  const title = topic.value.trim()
  if (!title || suggesting.value) return
  suggesting.value = true
  try {
    const r = await api.blogGenKeywords(title)
    const kws: string[] = (r?.keywords || []).map((k: any) => (typeof k === 'string' ? k : k?.query)).filter(Boolean)
    suggestions.value = kws.filter((q) => !queries.value.includes(q)).slice(0, 12)
  } catch { /* ignore */ } finally {
    suggesting.value = false
  }
}

async function start() {
  // не «t»: это имя занято переводчиком useI18n
  const title = topic.value.trim()
  // кредитов не хватает — бэк всё равно ответит 402, не отправляем впустую
  if (!title || busy.value || notEnough.value) return
  busy.value = true
  error.value = ''
  payWall.value = false
  try {
    const { runId } = await api.blogStartRun(title, mode.value, queries.value, model.value)
    // Обложку делаем СРАЗУ по шаблону по умолчанию, не дожидаясь текста: пока
    // агент пишет, у статьи уже есть картинка. Фоном и молча — генерация темы
    // не должна падать из-за обложки; заменить её можно в студии.
    if (runId) makeDefaultCover(runId, title).catch(() => {})
    load(true).catch(() => {})
    router.push(runId ? `/blog/run/${runId}` : '/blog')
  } catch (e: any) {
    payWall.value = e?.status === 402
    // текст бэка точнее: там и «не хватает кредитов», и лимит очереди
    error.value = e?.serverMessage
      || (e?.status === 402
        ? t('blog.pages.new.errors.noCredits')
        : e?.status === 429
          ? t('blog.pages.new.errors.tooOften')
          : t('blog.pages.new.errors.generic'))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="mx-auto flex min-h-[78dvh] w-full max-w-[720px] flex-col justify-center gap-3.5 p-5 lg:p-6">
    <h1 class="text-center text-[26px] font-medium tracking-tight">{{ $t('blog.pages.new.title') }}</h1>

    <!-- composer -->
    <div class="rounded-2xl border border-border bg-surface transition focus-within:border-ring">
      <textarea
        v-model="topic" rows="2" maxlength="300"
        :placeholder="$t('blog.pages.new.topicPlaceholder')"
        class="w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed outline-none placeholder:text-muted-foreground/50"
        @keydown.meta.enter="start"
      ></textarea>

      <!-- target queries (AEO) — expanded from the pill below -->
      <div v-show="showQueries" class="mx-2.5 mt-1 space-y-2.5 rounded-xl bg-surface p-3">
        <p class="text-[12px] leading-relaxed text-muted-foreground/70">{{ $t('blog.pages.new.queriesHint') }}</p>

        <div v-if="queries.length" class="flex flex-wrap gap-1.5">
          <span v-for="q in queries" :key="q" class="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-1 text-[12px]">
            {{ q }}
            <button type="button" class="text-muted-foreground/60 transition hover:text-danger" @click="removeQuery(q)"><X :size="12" /></button>
          </span>
        </div>

        <div class="flex gap-2">
          <input
            v-model="queryInput" :placeholder="$t('blog.pages.new.queryPlaceholder')"
            class="h-8 min-w-0 flex-1 rounded-lg border border-border bg-transparent px-2.5 text-[12.5px] outline-none focus:border-ring"
            @keydown.enter.prevent="addQuery()"
          >
          <button type="button" class="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[12px] text-muted-foreground transition hover:text-foreground disabled:opacity-50" :disabled="!topic.trim() || suggesting" @click="suggest">
            <Loader2 v-if="suggesting" :size="13" class="animate-spin" /> {{ $t('blog.pages.new.suggest') }}
          </button>
        </div>

        <div v-if="suggestions.length" class="flex flex-wrap gap-1.5">
          <button
            v-for="s in suggestions" :key="s" type="button"
            class="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-[11.5px] text-muted-foreground transition hover:border-solid hover:text-foreground"
            @click="addQuery(s); suggestions = suggestions.filter((x) => x !== s)"
          ><Plus :size="10" /> {{ s }}</button>
        </div>
      </div>

      <!-- control row inside the composer -->
      <div class="flex flex-wrap items-center gap-1.5 gap-y-2 p-2.5">
        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <button type="button" class="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border px-2 text-[12px] text-muted-foreground transition hover:text-foreground data-[state=open]:text-foreground">
              <component :is="activeMode.icon" :size="13" /> {{ activeMode.l }} <ChevronDown :size="12" class="opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" :side-offset="6" class="w-72">
            <DropdownMenuItem v-for="m in MODES" :key="m.v" class="items-start gap-2.5 p-2.5" @click="mode = m.v">
              <component :is="m.icon" :size="15" class="mt-0.5 shrink-0" />
              <div class="min-w-0 flex-1">
                <div class="text-[13px] font-medium">{{ m.l }}</div>
                <div class="text-[12px] leading-snug text-muted-foreground">{{ m.hint }}</div>
              </div>
              <Check v-if="mode === m.v" :size="14" class="mt-0.5 shrink-0" />
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          class="inline-flex h-7 items-center gap-1.5 rounded-lg border px-2 text-[12px] transition"
          :class="showQueries || queries.length ? 'border-brand-accent text-foreground' : 'border-border text-muted-foreground hover:text-foreground'"
          @click="showQueries = !showQueries"
        >
          <Target :size="13" /> {{ $t('blog.pages.new.queriesPill') }}
          <span v-if="queries.length" class="tabular-nums text-brand-accent">{{ queries.length }}</span>
        </button>

        <!-- справа: счётчик, модель статьи с ценой и отправка (как в чате ассистента) -->
        <div class="ml-auto flex min-w-0 items-center gap-2">
          <span v-if="topic.length > 240" class="text-[11px] tabular-nums text-muted-foreground">{{ topic.length }}/300</span>
          <ModelSelect
            v-model="model" :models="modelOptions" size="pill"
            :placeholder="$t('blog.pages.new.modelPlaceholder')"
            :note="$t('blog.modelPick.modelNote')"
          />
          <button
            type="button" :aria-label="$t('blog.pages.new.submit')"
            class="grid size-8 shrink-0 place-items-center rounded-full bg-brand-accent text-brand-accent-foreground transition hover:opacity-90 disabled:bg-surface-hover disabled:text-muted-foreground disabled:hover:opacity-100"
            :disabled="!topic.trim() || busy || notEnough" @click="start"
          >
            <Loader2 v-if="busy" :size="15" class="animate-spin" /><ArrowUp v-else :size="16" />
          </button>
        </div>
      </div>
    </div>

    <!-- quick start -->
    <div v-if="!topic.trim()" class="flex flex-wrap justify-center gap-1.5">
      <button
        v-for="e in EXAMPLES" :key="e" type="button"
        class="rounded-full border border-border px-3 py-1.5 text-[12.5px] text-muted-foreground transition hover:border-brand-accent hover:text-foreground"
        @click="topic = e"
      >{{ e }}</button>
    </div>

    <p v-if="error" class="rounded-lg border border-danger/25 bg-danger-soft px-3 py-2 text-center text-[12.5px] text-danger">
      {{ error }}
      <RouterLink v-if="payWall" to="/settings" class="ml-1 underline underline-offset-2 hover:text-foreground">{{ $t('blog.pages.new.topUp') }}</RouterLink>
    </p>

    <p v-if="credits && !credits.degraded" class="text-center text-[11.5px]" :class="notEnough ? 'text-warning' : 'text-muted-foreground/60'">
      {{ notEnough ? $t('blog.pages.new.notEnough', { n: credits.balance }) : $t('blog.pages.new.balance', { n: credits.balance }) }}
      <template v-if="postPrice"> · {{ $t('blog.pages.new.articleApprox', { price: postPrice }) }}</template>
      <RouterLink v-if="notEnough" to="/settings" class="ml-1 underline underline-offset-2 hover:text-foreground">{{ $t('blog.pages.new.topUp') }}</RouterLink>
    </p>
  </div>
</template>
