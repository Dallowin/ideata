<script setup lang="ts">
// Мастер первого бренда для нового кабинета. Пять состояний: start → gather →
// locale → topics → final; финал ветвится по тарифу (платный сразу запускает
// разбор, free предлагает разовый) и по ошибкам (лимит брендов, сбой создания,
// неподтверждённая почта).
//
// Бэкенд ЖИВОЙ (composables/useOnboardingApi): createBrand в GraphQL, site_peek
// и запуск разбора в scrapper. Мок остался под dev-флагом VITE_ONBOARDING_MOCK=1
// — ветки финала иначе не прокликать (лимит тарифа, сбой создания, код из
// письма). Контракт у обеих реализаций один, поэтому экраны не знают, какая
// из них подключена.
//
// Вёрстка — язык нового кабинета (тёмный шелл, border-border, карточки
// bg-surface-2), а не порт светлого pf-дизайна из web/.
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  ArrowLeft, ArrowRight, ArrowUp, Check, CreditCard, Loader2, Lock,
  Plus, X,
} from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { useAuth } from '@/composables/useAuth'
import { OnboardingError, onboardingApi, scenario, useMock } from '@/composables/useOnboardingApi'
import { useBrands } from '@/composables/useBrands'
import OnboardingScenarioPanel from '@/components/OnboardingScenarioPanel.vue'

const router = useRouter()
const { t, tm, rt } = useI18n()
const { auth } = useAuth()
const brands = useBrands()

type Screen = 'start' | 'gather' | 'locale' | 'topics' | 'final'
const screen = ref<Screen>('start')
// Точки прогресса: gather своей не занимает — это пауза между вводом и регионом.
const DOTS: Screen[] = ['start', 'locale', 'topics', 'final']
const dotIndex = computed(() => DOTS.indexOf(screen.value))

// Дефолт — англоязычный рынок. Жёсткий 'ru' в первом селекте показывал
// «Россия/Русский» даже для зарубежного домена с английским сайтом: юзер
// открывал мастер и первым делом видел неверную страну.
const form = reactive({ domain: '', description: '', geo: 'us', language: 'en' })

// Списки подписей идут за языком интерфейса — отсюда computed, а не константа.
const REGIONS = computed(() => [
  { value: 'kz', label: t('onboarding.locale.regions.kz') },
  { value: 'ru', label: t('onboarding.locale.regions.ru') },
  { value: 'us', label: t('onboarding.locale.regions.us') },
  { value: 'gb', label: t('onboarding.locale.regions.gb') },
  { value: 'de', label: t('onboarding.locale.regions.de') },
  { value: 'global', label: t('onboarding.locale.regions.global') },
])
// Язык контента бренда — эндонимами в обоих интерфейсах: так его выбирают везде.
// Только ru/en: других языков конвейер не умеет — промпты генерятся на русском
// или английском (scrapper aeo.generate_prompts), письма написаны на тех же
// двух. Казахский тут был, но давал английские промпты и русское письмо.
const LANGS = computed(() => [
  { value: 'ru', label: t('onboarding.locale.languages.ru') },
  { value: 'en', label: t('onboarding.locale.languages.en') },
])
// Русский предлагаем только рынкам СНГ, остальному миру — английский.
const CIS_REGIONS = ['ru', 'kz', 'by', 'ua', 'uz', 'kg', 'am', 'az', 'ge', 'md']
const langForGeo = (geo: string) => (CIS_REGIONS.includes(geo) ? 'ru' : 'en')
// Откуда взялся язык. Приоритет: ручной выбор → язык сайта (site_peek) → регион.
// Раньше язык молча оставался русским, если peek не ответил, — а он не отвечает
// каждый раз, когда сайт закрыт от нашего IP (larkandberry.com отдаёт 429).
const langTouched = ref(false)
const langFromSite = ref('')
// Регион тоже уточняем сами, пока юзер не выбрал его руками.
const geoTouched = ref(false)
// Зона домена — самый честный сигнал рынка: .ru → Россия, .kz → Казахстан.
// Нейтральные зоны (.com/.io/.ai) ничего не говорят — оставляем дефолт.
const TLD_GEO: Record<string, string> = {
  ru: 'ru', su: 'ru', рф: 'ru', kz: 'kz', de: 'de', uk: 'gb',
}
function geoFromDomain(domain: string): string {
  const tld = domain.split('.').pop() || ''
  return TLD_GEO[tld] || ''
}
// Ручной выбор ловим сеттером модели, а не watch на form.language: watch не
// отличает выбор юзера от программной подстановки и залипал бы на первой же.
const languageModel = computed({
  get: () => form.language,
  set: (v: string) => { langTouched.value = true; form.language = v },
})
const geoModel = computed({
  get: () => form.geo,
  set: (v: string) => { geoTouched.value = true; form.geo = v },
})
watch(() => form.geo, (geo) => {
  if (langTouched.value || langFromSite.value) return
  form.language = langForGeo(geo)
})
const regionLabel = computed(() => REGIONS.value.find((r) => r.value === form.geo)?.label || '')
const langLabel = computed(() => LANGS.value.find((l) => l.value === form.language)?.label || '')

function normDomain(raw: string): string {
  return String(raw || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0]
}
const cleanDomain = computed(() => normDomain(form.domain))
const domainOk = computed(() => !!cleanDomain.value && cleanDomain.value.includes('.'))
const brandName = computed(() => {
  const base = cleanDomain.value.split('.')[0] || ''
  return base ? base.charAt(0).toUpperCase() + base.slice(1) : t('onboarding.brandFallback')
})
const faviconUrl = computed(() =>
  cleanDomain.value ? `https://www.google.com/s2/favicons?domain=${cleanDomain.value}&sz=64` : '')
const faviconFailed = ref(false)

const greeting = computed(() => {
  const name = auth.authed ? (auth.name || '').split(' ')[0] : ''
  return name ? t('onboarding.greetingName', { name }) : t('onboarding.greeting')
})

// ── навигация ───────────────────────────────────────────────────────────────
const err = ref('')
function go(s: Screen) {
  screen.value = s
  if (s === 'topics') seedTopics()
}
function back() {
  err.value = ''
  if (screen.value === 'locale') go('start')
  else if (screen.value === 'topics') go('locale')
}
function submitStart() {
  err.value = ''
  if (!domainOk.value) { err.value = t('onboarding.start.invalidDomain'); return }
  faviconFailed.value = false
  go('gather')
  startGather()
}

// ── сбор информации о сайте ─────────────────────────────────────────────────
// Держим экран минимум MIN_GATHER, чтобы переход не мигал; найденное описание
// показываем ещё DESC_HOLD перед уходом на выбор региона.
const MIN_GATHER = 2400
const DESC_HOLD = 1600
const gatherDesc = ref('')
let timers: ReturnType<typeof setTimeout>[] = []
function clearTimers() { timers.forEach(clearTimeout); timers = [] }
onBeforeUnmount(clearTimers)

async function startGather() {
  clearTimers()
  gatherDesc.value = ''
  const startedAt = Date.now()
  let peek: Awaited<ReturnType<typeof onboardingApi.sitePeek>> | null = null
  try { peek = await onboardingApi.sitePeek(cleanDomain.value) } catch { peek = null }
  // Язык сайта (<html lang>) сильнее регионального дефолта, но слабее ручного
  // выбора. Сайт не ответил → остаётся язык по региону, а не русский молча.
  const peekLang = (peek?.lang || '').toLowerCase()
  if (peekLang.startsWith('ru') || peekLang.startsWith('en')) {
    langFromSite.value = peekLang.startsWith('ru') ? 'ru' : 'en'
    if (!langTouched.value) form.language = langFromSite.value
  }
  // Регион: зона домена сильнее языка сайта (.ru с английской версией — всё
  // равно рынок РФ), язык сайта — слабее, ручной выбор перебивает оба.
  if (!geoTouched.value) {
    const byTld = geoFromDomain(cleanDomain.value)
    if (byTld) form.geo = byTld
    else if (langFromSite.value === 'ru') form.geo = 'ru'
  }
  const desc = peek?.found ? peek.description.trim() : ''
  const wait = Math.max(0, MIN_GATHER - (Date.now() - startedAt))
  if (desc) {
    timers.push(setTimeout(() => {
      if (screen.value !== 'gather') return
      form.description = desc
      gatherDesc.value = desc
      timers.push(setTimeout(() => { if (screen.value === 'gather') go('locale') }, DESC_HOLD))
    }, wait))
  } else {
    timers.push(setTimeout(() => { if (screen.value === 'gather') go('locale') }, wait))
  }
}

// ── темы ────────────────────────────────────────────────────────────────────
const MAX_TOPICS = 10
const topics = ref<{ label: string; checked: boolean }[]>([])
const customTopic = ref('')
const topicNote = ref('')
const checkedCount = computed(() => topics.value.filter((t) => t.checked).length)
const selectedTopics = computed(() => topics.value.filter((t) => t.checked).map((t) => t.label))

function seedTopics() {
  if (topics.value.length) return
  const brand = brandName.value
  // Заготовки — массив в словаре: tm отдаёт сырые сообщения, rt подставляет бренд.
  const seed = tm('onboarding.topics.seed') as unknown as string[]
  topics.value = seed.map((tpl, i) => ({ label: rt(tpl, { brand }), checked: i < 5 }))
}
function toggleTopic(i: number) {
  // локальная переменная переименована из `t`: имя занято переводчиком useI18n
  const topic = topics.value[i]
  if (!topic) return
  if (!topic.checked && checkedCount.value >= MAX_TOPICS) {
    topicNote.value = t('onboarding.topics.limit', { n: MAX_TOPICS }, MAX_TOPICS)
    return
  }
  topicNote.value = ''
  topic.checked = !topic.checked
}
function addCustomTopic() {
  const label = customTopic.value.trim()
  if (!label) return
  if (topics.value.some((t) => t.label.toLowerCase() === label.toLowerCase())) { customTopic.value = ''; return }
  if (checkedCount.value >= MAX_TOPICS) { topicNote.value = t('onboarding.topics.limitShort', { n: MAX_TOPICS }, MAX_TOPICS); return }
  topics.value.push({ label, checked: true })
  customTopic.value = ''
}

// ── финал ───────────────────────────────────────────────────────────────────
const finalizing = ref(false)
const finalized = ref(false)
const finalErr = ref('')
const brandLimit = ref('')
const isPaid = ref(false)
const freeRunAvailable = ref(false)
const freeRunStarted = ref(false)

// OSS: без LLM-ключа разбор не запустится — гейтим кнопку «Запустить разбор».
const keysReady = ref(false)
async function checkKeys() {
  try {
    const r = await fetch('/api/settings/keys', { credentials: 'include' })
    if (!r.ok) return
    const data = await r.json()
    keysReady.value = (data.keys || []).some(
      (k: any) => (k.key === 'OPENROUTER_API_KEY' || k.key === 'KIE_API_KEY') && k.configured,
    )
  } catch { /* бэк недоступен — гейт останется закрытым */ }
}

async function finalize() {
  screen.value = 'final'
  if (finalized.value || finalizing.value) return
  finalizing.value = true; finalErr.value = ''; brandLimit.value = ''
  try {
    // OSS: тарифов нет — просто создаём бренд и не запускаем разбор сами.
    await onboardingApi.createBrand({
      domain: cleanDomain.value,
      name: brandName.value,
      description: form.description.trim() || undefined,
      geo: form.geo,
      language: form.language,
      topics: selectedTopics.value,
    })
    // Свитчер и дашборд читают список брендов из синглтона — без принудительного
    // перезапроса новый бренд появится только после перезагрузки страницы.
    await brands.load(true)
    finalized.value = true
    checkKeys() // статус LLM-ключа для гейта кнопки «Запустить разбор»
  } catch (e) {
    const code = e instanceof OnboardingError ? e.code : ''
    if (code === 'PLAN_LIMIT_BRANDS') {
      brandLimit.value = (e as Error).message
      finalized.value = true
    } else {
      // сообщение приходит с бэкенда как есть — переводим только свой фолбэк
      finalErr.value = (e as Error)?.message || t('onboarding.final.error.fallback')
    }
  } finally {
    finalizing.value = false
  }
}

// Разовый бесплатный разбор на free-тарифе.
const freeRunning = ref(false)
const showVerify = ref(false)
async function runFreeAnalysis() {
  if (freeRunning.value) return
  freeRunning.value = true
  try {
    await onboardingApi.startAnalysis(cleanDomain.value, form.geo)
    freeRunStarted.value = true
  } catch (e) {
    if (e instanceof OnboardingError && e.code === 'EMAIL_NOT_VERIFIED') showVerify.value = true
    else freeRunAvailable.value = false
  } finally {
    freeRunning.value = false
  }
}

// ── подтверждение почты (6 ячеек) ───────────────────────────────────────────
const codeCells = ref<string[]>(Array(6).fill(''))
const codeErr = ref('')
const codeChecking = ref(false)
const cellRefs = ref<HTMLInputElement[]>([])
const codeValue = computed(() => codeCells.value.join(''))

function onCellInput(i: number, e: Event) {
  const digits = (e.target as HTMLInputElement).value.replace(/\D/g, '')
  if (!digits) { codeCells.value[i] = ''; return }
  // вставка целого кода из буфера растекается по ячейкам
  digits.split('').forEach((d, k) => { if (i + k < 6) codeCells.value[i + k] = d })
  const next = Math.min(i + digits.length, 5)
  cellRefs.value[next]?.focus()
}
function onCellBackspace(i: number) {
  if (codeCells.value[i]) { codeCells.value[i] = ''; return }
  if (i > 0) { codeCells.value[i - 1] = ''; cellRefs.value[i - 1]?.focus() }
}
async function submitCode() {
  if (codeChecking.value) return
  codeErr.value = ''
  codeChecking.value = true
  try {
    const ok = await onboardingApi.verifyCode(codeValue.value)
    if (!ok) { codeErr.value = t('onboarding.verify.invalid'); return }
    showVerify.value = false
    codeCells.value = Array(6).fill('')
    await runFreeAnalysis()
  } finally {
    codeChecking.value = false
  }
}

// Не router.push: кабинет держит данные бренда в модульных синглтонах
// (трекер, разбор сайта, коннекторы), и мягкий переход открывал новый бренд
// с цифрами предыдущего. Свитчер брендов по той же причине перезагружает
// страницу — новый бренд входит тем же путём.
function goToDashboard() { window.location.assign('/') }
function goToSettings() { router.push('/settings') }

// пульт имеет смысл только когда подключён мок
const showScenarioPanel = useMock

// Пульт сценариев сбросил флоу — начинаем с чистого листа.
function resetFlow() {
  clearTimers()
  screen.value = 'start'
  form.domain = ''; form.description = ''; form.geo = 'us'; form.language = langForGeo('us')
  geoTouched.value = false; langTouched.value = false; langFromSite.value = ''
  langTouched.value = false; langFromSite.value = ''   // новый бренд — новый резолв языка
  topics.value = []; customTopic.value = ''; topicNote.value = ''
  gatherDesc.value = ''; err.value = ''
  finalizing.value = false; finalized.value = false; finalErr.value = ''
  brandLimit.value = ''; freeRunStarted.value = false; freeRunning.value = false
  showVerify.value = false; codeCells.value = Array(6).fill(''); codeErr.value = ''
}
</script>

<template>
  <div class="relative flex min-h-dvh flex-col">
    <!-- свечение сверху — как на «Обзоре» и «Мониторинге» -->
    <div class="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[380px] overflow-hidden" aria-hidden="true">
      <div class="absolute left-1/2 top-[-240px] h-[480px] w-[820px] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgba(66,103,255,0.16),rgba(124,58,237,0.08),transparent)] blur-2xl"></div>
    </div>

    <header class="flex shrink-0 items-center justify-center py-7">
      <span class="inline-flex items-center gap-1.5 text-[15px] font-semibold tracking-tight">
        Ideata<span class="mb-0.5 size-1.5 rounded-full bg-brand"></span>
      </span>
    </header>

    <main class="flex flex-1 flex-col px-5">
      <div class="flex w-full flex-1 flex-col items-center justify-center">

        <!-- START — адрес сайта (композер: ввод + пилюли + круглая ↑) -->
        <section v-if="screen === 'start'" class="flex w-full flex-col items-center">
          <p class="text-[13px] text-muted-foreground">{{ greeting }}</p>
          <h1 class="mt-2 text-center text-[26px] font-medium tracking-tight">{{ $t('onboarding.start.title') }}</h1>

          <form class="mt-8 w-full max-w-[720px]" @submit.prevent="submitStart">
            <div class="overflow-hidden rounded-[18px] border border-border bg-surface-2 transition focus-within:border-white/20">
              <div class="px-3.5 pb-2.5 pt-3.5">
                <input
                  v-model="form.domain" autofocus :placeholder="$t('onboarding.start.domainPlaceholder')"
                  class="h-9 w-full bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground/55"
                />
                <div class="mt-2 flex items-center gap-2">
                  <span
                    v-if="domainOk"
                    class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-[12px] text-muted-foreground"
                  >
                    <img
                      v-if="!faviconFailed" :src="faviconUrl" alt=""
                      class="size-3.5 rounded-sm" @error="faviconFailed = true"
                    />
                    {{ cleanDomain }}
                  </span>
                  <button
                    type="submit" :disabled="!domainOk"
                    class="ml-auto grid size-8 shrink-0 place-items-center rounded-full transition"
                    :class="domainOk ? 'bg-foreground text-background hover:opacity-90' : 'bg-surface-hover text-muted-foreground/50'"
                  >
                    <ArrowUp :size="15" />
                  </button>
                </div>
              </div>
            </div>
          </form>
          <p v-if="err" class="mt-3 text-[12.5px] text-destructive">{{ err }}</p>
        </section>

        <!-- GATHER — сбор информации о сайте -->
        <section v-else-if="screen === 'gather'" class="flex flex-col items-center">
          <div class="grid size-11 place-items-center overflow-hidden rounded-[10px] border border-border bg-surface-2">
            <img v-if="!faviconFailed" :src="faviconUrl" alt="" class="size-6" @error="faviconFailed = true" />
            <span v-else class="text-[15px] font-semibold">{{ brandName.charAt(0) }}</span>
          </div>
          <div class="mt-5 inline-flex items-center gap-2 text-[19px] font-medium">
            <Loader2 :size="17" class="animate-spin text-muted-foreground" />
            {{ $t('onboarding.gather.title') }}
          </div>
          <div class="mt-2 flex min-h-[3.6em] max-w-[560px] items-start justify-center">
            <Transition name="fade">
              <p v-if="gatherDesc" class="text-center text-[14px] leading-relaxed text-muted-foreground">{{ gatherDesc }}</p>
            </Transition>
          </div>
        </section>

        <!-- LOCALE — регион и язык -->
        <section v-else-if="screen === 'locale'" class="flex w-full flex-col items-center">
          <h1 class="text-center text-[26px] font-medium tracking-tight">{{ $t('onboarding.locale.title') }}</h1>
          <p class="mt-2.5 max-w-[440px] text-center text-[13.5px] leading-relaxed text-muted-foreground">
            {{ $t('onboarding.locale.subtitle') }}
          </p>
          <div class="mt-7 w-full max-w-[440px] space-y-4 rounded-[18px] border border-border bg-surface-2 p-6">
            <div>
              <label class="mb-1.5 block text-[12px] font-medium text-muted-foreground">{{ $t('onboarding.locale.regionLabel') }}</label>
              <Select v-model="geoModel">
                <SelectTrigger class="h-11 w-full border-border bg-surface-2 text-[13.5px]">
                  <SelectValue>{{ regionLabel }}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="r in REGIONS" :key="r.value" :value="r.value">{{ r.label }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label class="mb-1.5 block text-[12px] font-medium text-muted-foreground">{{ $t('onboarding.locale.languageLabel') }}</label>
              <Select v-model="languageModel">
                <SelectTrigger class="h-11 w-full border-border bg-surface-2 text-[13.5px]">
                  <SelectValue>{{ langLabel }}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="l in LANGS" :key="l.value" :value="l.value">{{ l.label }}</SelectItem>
                </SelectContent>
              </Select>
              <p v-if="!langTouched" class="mt-1.5 text-[12px] text-muted-foreground">
                {{ langFromSite ? $t('onboarding.locale.languageFromSite') : $t('onboarding.locale.languageFromRegion') }}
              </p>
            </div>
            <Button class="h-11 w-full text-[13.5px]" @click="go('topics')">{{ $t('onboarding.locale.continue') }}</Button>
          </div>
        </section>

        <!-- TOPICS — темы -->
        <section v-else-if="screen === 'topics'" class="flex w-full flex-col items-center">
          <h1 class="text-center text-[26px] font-medium tracking-tight">{{ $t('onboarding.topics.title') }}</h1>
          <div class="mt-7 w-full max-w-[560px] rounded-[18px] border border-border bg-surface-2 p-6">
            <div class="mb-3">
              <div class="flex items-center justify-between text-[12px]">
                <span class="font-medium text-muted-foreground">{{ $t('onboarding.topics.pick', { n: MAX_TOPICS }, MAX_TOPICS) }}</span>
                <span class="tabular-nums text-muted-foreground/70">{{ checkedCount }} / {{ MAX_TOPICS }}</span>
              </div>
              <div class="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-hover">
                <div
                  class="h-full bg-foreground transition-[width] duration-200"
                  :style="{ width: (checkedCount / MAX_TOPICS * 100) + '%' }"
                ></div>
              </div>
            </div>

            <div class="-mx-1 max-h-[38vh] space-y-1.5 overflow-y-auto px-1">
              <button
                v-for="(t, i) in topics" :key="t.label" type="button"
                class="flex w-full items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left transition"
                :class="t.checked ? 'border-white/25 bg-surface-hover' : 'border-border bg-transparent hover:bg-surface-2'"
                @click="toggleTopic(i)"
              >
                <span
                  class="grid size-4 shrink-0 place-items-center rounded-[5px] border transition"
                  :class="t.checked ? 'border-foreground bg-foreground' : 'border-white/25'"
                >
                  <Check v-if="t.checked" :size="12" class="text-background" />
                </span>
                <span class="text-[13px] text-text-2">{{ t.label }}</span>
              </button>
            </div>

            <div class="mt-2.5 flex items-center gap-2">
              <input
                v-model="customTopic" :placeholder="$t('onboarding.topics.addPlaceholder')"
                class="h-9 min-w-0 flex-1 rounded-[10px] border border-border bg-surface px-3 text-[13px] outline-none transition placeholder:text-muted-foreground/55 focus:border-white/20"
                @keydown.enter.prevent="addCustomTopic"
              />
              <Button variant="outline" size="sm" class="shrink-0" @click="addCustomTopic">
                <Plus :size="14" /> {{ $t('action.add') }}
              </Button>
            </div>
            <p v-if="topicNote" class="mt-2 text-[12px] text-amber-400/90">{{ topicNote }}</p>

            <Button class="mt-5 h-11 w-full text-[13.5px]" :disabled="checkedCount === 0" @click="finalize">
              {{ $t('onboarding.topics.submit') }}
            </Button>
          </div>
        </section>

        <!-- FINAL — успех / апселл / лимит / ошибка -->
        <section v-else class="flex w-full flex-col items-center text-center">
          <!-- бренд создан → шапкой фавиконка сайта, а не дежурная иконка:
               на этих экранах речь про конкретный домен, он и должен быть виден -->
          <div
            v-if="finalized && !brandLimit && !finalErr"
            class="grid size-11 place-items-center overflow-hidden rounded-[10px] border border-border bg-surface-2"
          >
            <img v-if="!faviconFailed" :src="faviconUrl" alt="" class="size-6" @error="faviconFailed = true" />
            <span v-else class="text-[15px] font-semibold">{{ brandName.charAt(0) }}</span>
          </div>

          <template v-if="finalErr">
            <div class="grid size-11 place-items-center rounded-full bg-destructive/15"><X :size="20" class="text-destructive" /></div>
            <h1 class="mt-5 text-[24px] font-semibold tracking-tight">{{ $t('state.error') }}</h1>
            <!-- текст ошибки приходит с бэкенда — не переводим -->
            <p class="mt-2 max-w-[360px] text-[13.5px] text-muted-foreground">{{ finalErr }}</p>
            <div class="mt-7 flex w-full max-w-[360px] items-center gap-2">
              <Button variant="outline" class="h-11" @click="go('topics')">{{ $t('action.back') }}</Button>
              <Button class="h-11 flex-1" @click="finalize">
                <Loader2 v-if="finalizing" :size="15" class="animate-spin" /> {{ $t('action.retry') }}
              </Button>
            </div>
          </template>

          <template v-else-if="brandLimit">
            <div class="grid size-11 place-items-center rounded-full bg-brand/15"><Lock :size="19" class="text-brand" /></div>
            <h1 class="mt-5 text-[26px] font-semibold leading-[1.15] tracking-tight">{{ $t('onboarding.final.limit.title') }}</h1>
            <!-- формулировка лимита приходит с бэкенда — не переводим -->
            <p class="mt-2.5 max-w-[400px] text-[13.5px] leading-relaxed text-muted-foreground">{{ brandLimit }}</p>
            <Button class="mt-7 h-11 w-full max-w-[360px]" @click="goToDashboard">{{ $t('onboarding.final.later') }} <ArrowRight :size="15" /></Button>
          </template>

          <!-- OSS: разбор запущен -->
          <template v-else-if="finalized && freeRunStarted">
            <h1 class="mt-5 text-[26px] font-semibold leading-[1.15] tracking-tight">{{ $t('onboarding.final.ready.title', { brand: brandName }) }}</h1>
            <p class="mt-2.5 max-w-[400px] text-[13.5px] leading-relaxed text-muted-foreground">{{ $t('onboarding.final.ready.text') }}</p>
            <Button class="mt-7 h-11 w-full max-w-[360px]" @click="goToDashboard">{{ $t('onboarding.final.toDashboard') }} <ArrowRight :size="15" /></Button>
          </template>

          <!-- OSS: бренд создан → запуск разбора (гейт по ключу) / настройки / дашборд -->
          <template v-else-if="finalized">
            <h1 class="mt-5 text-[26px] font-semibold leading-[1.15] tracking-tight">{{ $t('onboarding.final.created', { brand: brandName }) }}</h1>
            <p class="mt-2.5 max-w-[400px] text-[13.5px] leading-relaxed text-muted-foreground">
              {{ keysReady
                ? 'Всё готово — можно запустить первый разбор.'
                : 'Бренд создан. Разбор не запустится без API-ключа провайдера — добавьте его в настройках.' }}
            </p>
            <Button
              class="mt-7 h-11 w-full max-w-[360px]"
              :disabled="!keysReady || freeRunning" @click="runFreeAnalysis"
            >
              <Loader2 v-if="freeRunning" :size="15" class="animate-spin" /> Запустить разбор
            </Button>
            <Button
              v-if="!keysReady" variant="outline"
              class="mt-2 h-11 w-full max-w-[360px]" @click="goToSettings"
            >
              Перейти в настройки <ArrowRight :size="15" />
            </Button>
            <Button variant="ghost" class="mt-2 h-10 w-full max-w-[360px] text-muted-foreground" @click="goToDashboard">
              {{ $t('onboarding.final.later') }}
            </Button>
          </template>

          <template v-else>
            <div class="grid size-11 place-items-center rounded-full bg-surface-hover"><Loader2 :size="20" class="animate-spin text-muted-foreground" /></div>
            <h1 class="mt-5 text-[24px] font-semibold tracking-tight">{{ $t('onboarding.final.running.title') }}</h1>
            <p class="mt-2 inline-flex items-center gap-1.5 text-[13.5px] text-muted-foreground">
              <Loader2 :size="14" class="animate-spin text-muted-foreground" /> {{ $t('onboarding.final.running.text') }}
            </p>
          </template>
        </section>
      </div>

      <!-- низ: назад + точки прогресса -->
      <div class="flex shrink-0 flex-col items-center gap-4 pb-10 pt-6">
        <button
          v-if="screen === 'locale' || screen === 'topics'" type="button"
          class="inline-flex items-center gap-1 text-[13px] text-muted-foreground transition hover:text-foreground"
          @click="back"
        ><ArrowLeft :size="15" /> {{ $t('action.back') }}</button>
        <div v-if="screen !== 'start' && screen !== 'gather'" class="flex items-center gap-1.5">
          <span
            v-for="(s, i) in DOTS" :key="s" class="h-1.5 rounded-full transition-all"
            :class="i === dotIndex ? 'w-5 bg-foreground' : (i < dotIndex ? 'w-1.5 bg-foreground' : 'w-1.5 bg-white/20')"
          ></span>
        </div>
      </div>
    </main>

    <!-- подтверждение почты: 403 EMAIL_NOT_VERIFIED на запуске разбора -->
    <div v-if="showVerify" class="fixed inset-0 z-50 grid place-items-center bg-black/70 p-5" @click.self="showVerify = false">
      <div class="w-full max-w-[420px] rounded-[18px] border border-border bg-background p-6">
        <h2 class="text-[17px] font-semibold">{{ $t('onboarding.verify.title') }}</h2>
        <p class="mt-1.5 text-[13px] text-muted-foreground">
          {{ $t('onboarding.verify.sent', {
            target: auth.authed ? $t('onboarding.verify.targetOwn') : $t('onboarding.verify.targetAccount'),
          }) }}
        </p>
        <div class="mt-5 flex gap-2">
          <input
            v-for="(c, i) in codeCells" :key="i" :ref="(el) => { if (el) cellRefs[i] = el as HTMLInputElement }"
            :value="c" inputmode="numeric" maxlength="6"
            class="h-12 w-full rounded-[10px] border border-border bg-surface-2 text-center text-[17px] outline-none transition focus:border-white/30"
            @input="onCellInput(i, $event)"
            @keydown.backspace="onCellBackspace(i)"
            @keydown.enter.prevent="submitCode"
          />
        </div>
        <p v-if="codeErr" class="mt-2.5 text-[12.5px] text-destructive">{{ codeErr }}</p>
        <Button class="mt-5 h-11 w-full" :disabled="codeValue.length < 6 || codeChecking" @click="submitCode">
          <Loader2 v-if="codeChecking" :size="15" class="animate-spin" /> {{ $t('onboarding.verify.submit') }}
        </Button>
      </div>
    </div>

    <!-- пульт — только в dev-сборке: в проде он бы светил юзеру внутренности мока -->
    <OnboardingScenarioPanel v-if="showScenarioPanel" v-model:scenario="scenario" :screen="screen" @reset="resetFlow" />
  </div>
</template>

<style scoped>
.fade-enter-active, .fade-leave-active { transition: opacity .4s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
