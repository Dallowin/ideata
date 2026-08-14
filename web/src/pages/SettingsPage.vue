<script setup lang="ts">
// «Настройки»: интеграции данных (переехали из «AI-трафика») + аккаунт.
// Названия и описания коннекторов приходят из useConnectors (там же живут
// статусы с бэка) — здесь переводится только обвязка вокруг них.
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, Cpu, ExternalLink, KeyRound, Pencil, Plug, RefreshCw, Settings2, Trash2, Unplug, UserRound, X } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { LOCALES, LOCALE_NAMES, setLocale, type Locale } from '@/i18n'
import { useAuth } from '@/composables/useAuth'
import { useConnectors } from '@/composables/useConnectors'
import { useBrands } from '@/composables/useBrands'
import { api } from '@/lib/api'

const { t, locale } = useI18n()
const { auth, check } = useAuth()

// Язык — настройка, а не переключатель в углу: сюда человек идёт, когда ищет
// его осознанно. Кука общая с лендингом, поэтому выбор действует и там.
function pickLocale(code: unknown) {
  if (code && code !== locale.value) setLocale(code as Locale)
}
const { connectors, load, disconnect } = useConnectors()
const { active } = useBrands()

// Кнопки коннекторов раньше были декоративными: ни одного обработчика, хотя
// ручки на бэке существовали. busy держит ключ коннектора, по которому идёт
// запрос, чтобы не дать нажать дважды.
const busy = ref('')
const connErr = ref('')

// e.serverMessage — текст ошибки с бэка, показываем как есть; переводим фолбэки
async function refresh(key: string) {
  busy.value = key; connErr.value = ''
  try { await load(true) } catch (e: any) { connErr.value = e?.serverMessage || t('settings.error.refresh') }
  finally { busy.value = '' }
}

async function unplug(key: string, title: string) {
  if (!window.confirm(t('settings.integrations.disconnectConfirm', { title }))) return
  busy.value = key; connErr.value = ''
  try { await disconnect(key as any) }
  catch (e: any) { connErr.value = e?.serverMessage || t('settings.error.disconnect') }
  finally { busy.value = '' }
}

async function connectWithToken(key: string, title: string) {
  const id = active.value?.id
  if (!id) { connErr.value = t('settings.error.noBrand'); return }
  const token = window.prompt(t('settings.integrations.tokenPrompt', { title }))
  if (!token?.trim()) return
  busy.value = key; connErr.value = ''
  try {
    await api.cloudflareConnect(id, token.trim())
    await load(true)
  } catch (e: any) {
    connErr.value = e?.serverMessage || t('settings.error.token')
  } finally { busy.value = '' }
}
// ── API-ключи инстанса (только владелец) ──────────────────────────────────────
interface KeyRow {
  key: string; label: string; group: string; hint: string | null; help: string | null
  required: boolean; configured: boolean; source: string; preview: string; updatedAt: string | null
}
const keyRows = ref<KeyRow[]>([])
const keyInputs = ref<Record<string, string>>({})
const keysBusy = ref(false)
const keysMsg = ref('')

// Провайдеры/сервисы — группируем ключи в таблицу (как «Провайдеры моделей»),
// с офф-фавиконкой (public/providers/<icon>). help — где взять ключ.
interface KeyProviderSpec { slug: string; label: string; icon: string; help: string; keys: string[] }
const KEY_PROVIDERS: KeyProviderSpec[] = [
  { slug: 'openrouter', label: 'OpenRouter', icon: 'openrouter.png', help: 'https://openrouter.ai/keys', keys: ['OPENROUTER_API_KEY'] },
  { slug: 'dataforseo', label: 'DataForSEO', icon: 'dataforseo.png', help: 'https://app.dataforseo.com/api-access', keys: ['DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD'] },
  { slug: 'keysso', label: 'KeysSo', icon: 'keysso.png', help: 'https://keys.so/dashboard/api', keys: ['KEYSSO_API_KEY'] },
  { slug: 'resend', label: 'Email (Resend)', icon: 'resend.png', help: 'https://resend.com/api-keys', keys: ['RESEND_API_KEY', 'SMTP_FROM'] },
  { slug: 'metrika', label: 'Яндекс.Метрика', icon: 'metrika.png', help: 'https://oauth.yandex.ru/client/new', keys: ['YANDEX_CLIENT_ID', 'YANDEX_CLIENT_SECRET', 'YANDEX_REDIRECT_URI'] },
  { slug: 'gsc', label: 'Google Search Console', icon: 'gsc.png', help: 'https://console.cloud.google.com/apis/credentials', keys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GSC_REDIRECT_URI'] },
  { slug: 'x', label: 'X (Twitter)', icon: 'x.png', help: 'https://developer.x.com/en/portal/dashboard', keys: ['X_CLIENT_ID', 'X_CLIENT_SECRET', 'X_REDIRECT_URI'] },
  { slug: 'linkedin', label: 'LinkedIn', icon: 'linkedin.png', help: 'https://www.linkedin.com/developers/apps', keys: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'LINKEDIN_REDIRECT_URI'] },
  { slug: 'threads', label: 'Threads', icon: 'threads.png', help: 'https://developers.facebook.com/apps', keys: ['THREADS_APP_ID', 'THREADS_APP_SECRET', 'THREADS_REDIRECT_URI'] },
]
interface KeyProviderRow extends KeyProviderSpec { rows: KeyRow[]; configured: boolean; updatedAt: string | null }
const keyProviders = computed<KeyProviderRow[]>(() => {
  const byKey = new Map(keyRows.value.map((r) => [r.key, r]))
  return KEY_PROVIDERS.map((p) => {
    const rows = p.keys.map((k) => byKey.get(k)).filter(Boolean) as KeyRow[]
    const configured = rows.length > 0 && rows.every((r) => r.configured)
    const ts = rows.map((r) => r.updatedAt).filter(Boolean).map((d) => +new Date(d as string))
    const updatedAt = ts.length ? new Date(Math.max(...ts)).toISOString() : null
    return { ...p, rows, configured, updatedAt }
  }).filter((p) => p.rows.length)
})

// модалка настройки провайдера-ключей
const editingKp = ref<KeyProviderRow | null>(null)
function openKp(p: KeyProviderRow) { editingKp.value = p; keysMsg.value = '' }
function closeKp() { editingKp.value = null }

async function loadKeys() {
  try {
    const r = await fetch('/api/settings/keys', { credentials: 'include' })
    if (!r.ok) return
    const data = await r.json()
    keyRows.value = data.keys || []
  } catch { /* бэк недоступен — секция просто пустая */ }
}

async function saveKeys() {
  keysBusy.value = true; keysMsg.value = ''
  try {
    const body: Record<string, string> = {}
    for (const [k, v] of Object.entries(keyInputs.value)) {
      if (v != null && String(v).trim() !== '') body[k] = String(v).trim()
    }
    if (!Object.keys(body).length) { keysMsg.value = 'Нечего сохранять'; return }
    const r = await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    })
    if (!r.ok) { keysMsg.value = `Ошибка (${r.status})`; return }
    keyInputs.value = {}
    await loadKeys()
    editingKp.value = null // успех — закрываем модалку, ряд обновится
  } catch {
    keysMsg.value = 'Сеть недоступна — бэкенд не отвечает'
  } finally {
    keysBusy.value = false
  }
}

// ── Движки: модель и маршрут каждого движка (только владелец) ─────────────────
interface NativeKeyRow { key: string; configured: boolean; preview: string }
interface EngineRow {
  slug: string; label: string; key: string; vendor: string; default: string
  openrouter: boolean; presetModels: string[]; help: string
  model: string; configured: boolean; source: string
  native: NativeKeyRow[]; nativeReady: boolean; route: 'native' | 'openrouter'
  updatedAt: string | null
}
interface ModelRow { id: string; label: string }
const engines = ref<EngineRow[]>([])
const models = ref<ModelRow[]>([])
const engineModels = ref<Record<string, string>>({})
const nativeInputs = ref<Record<string, string>>({})
const enginesBusy = ref(false)
const enginesMsg = ref('')

// Engine models: OpenRouter catalog by vendor, or presets (native GigaChat/Yandex).
function modelsForEngine(e: EngineRow): ModelRow[] {
  let list: ModelRow[] = e.openrouter
    ? models.value.filter((m) => m.id.startsWith(e.vendor))
    : (e.presetModels || []).map((id) => ({ id, label: id }))
  if (!list.length && e.openrouter) list = models.value
  // текущее значение всегда доступно как опция (иначе select пустой)
  const cur = engineModels.value[e.key] || e.model
  if (cur && !list.some((m) => m.id === cur)) list = [{ id: cur, label: cur }, ...list]
  return list
}

// официальные иконки провайдеров (public/providers/<slug>.svg); gigachat — монограмма
const ICON_SLUGS = new Set(['chatgpt', 'claude', 'gemini', 'deepseek', 'grok', 'perplexity', 'yandex', 'gigachat'])
function hasIcon(slug: string): boolean { return ICON_SLUGS.has(slug) }
function iconSrc(slug: string): string { return `/providers/${slug}.png` }

function fmtUpdated(iso: string | null): string {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  } catch { return '' }
}

// Ключ OpenRouter один на все движки — без него запасного маршрута нет.
const openrouterReady = computed(() => !!keyRows.value.find((r) => r.key === 'OPENROUTER_API_KEY')?.configured)

// Движок поедет, если задан его собственный ключ или доступен маршрут OpenRouter.
function engineOk(e: EngineRow): boolean {
  return e.nativeReady || (e.openrouter && openrouterReady.value)
}
// Маршрут решает ключ: свой ключ провайдера — официальный API, иначе OpenRouter.
function routeLabel(e: EngineRow): string {
  return e.route === 'native' ? 'Официальный API' : 'OpenRouter'
}
function routeClass(e: EngineRow): string {
  return e.route === 'native' ? 'bg-success-soft text-success' : 'bg-surface-hover text-muted-foreground'
}
// Подпись под названием: модель и ключ, которым движок реально ходит.
function engineSub(e: EngineRow): string {
  const model = engineModels.value[e.key] || e.model
  const key = e.route === 'native' ? (e.native[0]?.key || e.key) : 'OPENROUTER_API_KEY'
  return `${model} · ${key}`
}
// Своё, что можно сбросить: выбранная модель или ключ(и) провайдера.
function engineCustom(e: EngineRow): boolean {
  return e.configured || e.native.some((n) => n.configured)
}
// «корзина»: сбросить модель + native-ключи движка к дефолту
async function clearEngine(e: EngineRow) {
  const body: Record<string, string> = { [e.key]: '' }
  for (const n of e.native) body[n.key] = ''
  try {
    await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    })
    await loadEngines()
  } catch { /* бэк недоступен */ }
}

// модалка редактирования движка
const editing = ref<EngineRow | null>(null)
function openEdit(e: EngineRow) {
  editing.value = e
  enginesMsg.value = ''
}
function closeEdit() { editing.value = null }

async function loadEngines() {
  try {
    const [er, mr] = await Promise.all([
      fetch('/api/settings/engines', { credentials: 'include' }),
      fetch('/api/settings/models', { credentials: 'include' }),
    ])
    if (er.ok) {
      const d = await er.json()
      engines.value = d.engines || []
      const init: Record<string, string> = {}
      for (const e of engines.value) init[e.key] = e.model
      engineModels.value = init
      nativeInputs.value = {}
    }
    if (mr.ok) { const d = await mr.json(); models.value = d.models || [] }
  } catch { /* бэк недоступен — секция пустая */ }
}

async function saveEngines() {
  enginesBusy.value = true; enginesMsg.value = ''
  try {
    const body: Record<string, string> = {}
    for (const e of engines.value) {
      const v = engineModels.value[e.key]
      if (v && v !== e.model) body[e.key] = v
      // native-ключ(и) провайдера — сохраняем те, что введены
      for (const n of e.native) {
        const nv = nativeInputs.value[n.key]
        if (nv != null && String(nv).trim() !== '') body[n.key] = String(nv).trim()
      }
    }
    if (!Object.keys(body).length) { enginesMsg.value = 'Без изменений'; return }
    const r = await fetch('/api/settings/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    })
    if (!r.ok) { enginesMsg.value = `Ошибка (${r.status})`; return }
    await loadEngines()
    editing.value = null // успех — закрываем модалку, ряд обновится
  } catch {
    enginesMsg.value = 'Сеть недоступна'
  } finally {
    enginesBusy.value = false
  }
}

// ── саб-навбар настроек (Langdock-стиль: группы + пункты) ─────────────────────
const activeTab = ref<string>('providers')
const navGroups = computed(() => {
  const groups = [
    { label: 'Инстанс', items: [
      { id: 'providers', label: 'Провайдеры', icon: KeyRound, owner: true },
      { id: 'engines', label: 'Движки', icon: Cpu, owner: true },
    ] },
    { label: 'Аккаунт', items: [
      { id: 'integrations', label: 'Интеграции', icon: Plug, owner: false },
      { id: 'account', label: 'Профиль', icon: UserRound, owner: false },
    ] },
  ]
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.owner || auth.isAdmin) }))
    .filter((g) => g.items.length)
})

onMounted(async () => {
  await check()
  activeTab.value = auth.isAdmin ? 'providers' : 'integrations'
  load()
  if (auth.isAdmin) { loadKeys(); loadEngines() }
})
</script>

<template>
  <div class="p-5 lg:p-6">
    <div class="mb-6">
      <h1 class="text-lg font-semibold tracking-tight">{{ $t('nav.settings') }}</h1>
      <p class="mt-0.5 text-[12.5px] text-muted-foreground">{{ $t('settings.subtitle') }}</p>
    </div>

    <div class="flex flex-col gap-6 lg:flex-row lg:gap-10">
      <!-- ── саб-навбар настроек ── -->
      <nav class="shrink-0 lg:w-52">
        <div class="flex gap-1 overflow-x-auto pb-1 lg:block lg:space-y-5 lg:overflow-visible lg:pb-0">
          <div v-for="grp in navGroups" :key="grp.label" class="flex gap-1 lg:block lg:space-y-0.5">
            <div class="hidden px-3 pb-1 text-[10.5px] font-medium uppercase tracking-wide text-muted-foreground/70 lg:block">{{ grp.label }}</div>
            <button
              v-for="tb in grp.items" :key="tb.id" type="button"
              class="flex w-full items-center gap-2 whitespace-nowrap rounded-lg px-3 py-1.5 text-left text-[13px] font-medium transition"
              :class="activeTab === tb.id ? 'bg-surface-hover text-foreground' : 'text-muted-foreground hover:bg-surface hover:text-foreground'"
              @click="activeTab = tb.id"
            >
              <component :is="tb.icon" :size="15" class="shrink-0 opacity-80" /> {{ tb.label }}
            </button>
          </div>
        </div>
      </nav>

      <!-- ── контент активной секции (контейнер ~1180px) ── -->
      <div class="min-w-0 flex-1 max-w-[1180px]">
        <!-- ПРОВАЙДЕРЫ -->
        <section v-if="activeTab === 'providers' && auth.isAdmin">
          <h2 class="text-[17px] font-semibold tracking-tight">Провайдеры и ключи</h2>
          <p class="mt-0.5 mb-4 text-[12.5px] text-muted-foreground">
            Ключи и креды интеграций для этого инстанса. Хранятся на сервере, перекрывают <code>.env</code>.
          </p>

          <!-- заголовки таблицы -->
          <div class="flex items-center gap-6 border-b border-border pb-2.5 text-[12.5px] font-medium text-muted-foreground">
            <div class="min-w-0 flex-1">Название</div>
            <div class="w-52 shrink-0">Статус</div>
            <div class="w-44 shrink-0">Обновлено</div>
            <div class="w-16 shrink-0"></div>
          </div>
          <!-- строки -->
          <div
            v-for="p in keyProviders" :key="p.slug"
            class="group flex items-center gap-6 border-b border-border py-4"
          >
            <div class="flex min-w-0 flex-1 items-center gap-3.5">
              <img :src="'/providers/' + p.icon" :alt="p.label" class="size-10 shrink-0 rounded-lg object-contain" />
              <div class="min-w-0">
                <div class="text-[14.5px] font-medium">{{ p.label }}</div>
                <div class="truncate font-mono text-[12px] text-muted-foreground">
                  {{ p.rows[0].key }}<template v-if="p.rows.length > 1"> +{{ p.rows.length - 1 }}</template>
                </div>
              </div>
            </div>
            <div class="w-52 shrink-0 text-[13.5px]">
              <span v-if="p.configured" class="inline-flex items-center gap-1 text-success"><Check :size="14" /> Настроено</span>
              <span v-else class="text-muted-foreground">Не настроено</span>
            </div>
            <div class="w-44 shrink-0 text-[13.5px] text-muted-foreground">{{ p.updatedAt ? fmtUpdated(p.updatedAt) : '—' }}</div>
            <div class="flex w-16 shrink-0 items-center justify-end gap-1">
              <button type="button" class="rounded-md p-1.5 text-muted-foreground transition hover:bg-surface-hover hover:text-foreground" title="Изменить" @click="openKp(p)">
                <Pencil :size="14" />
              </button>
              <span class="block size-[26px] shrink-0"></span>
            </div>
          </div>
    </section>

        <!-- ДВИЖКИ (Langdock Models) -->
        <section v-else-if="activeTab === 'engines' && auth.isAdmin">
          <h2 class="text-[17px] font-semibold tracking-tight">Движки и модели</h2>
          <p class="mt-0.5 mb-4 text-[12.5px] text-muted-foreground">
            Модель и маршрут каждого движка: задан свой ключ провайдера — идём в его официальный API,
            иначе через OpenRouter. Выбор у каждого движка свой.
          </p>

          <!-- заголовки таблицы -->
          <div class="flex items-center gap-6 border-b border-border pb-2.5 text-[12.5px] font-medium text-muted-foreground">
            <div class="min-w-0 flex-1">Название</div>
            <div class="w-44 shrink-0">Маршрут</div>
            <div class="w-40 shrink-0">Статус</div>
            <div class="w-40 shrink-0">Обновлено</div>
            <div class="w-16 shrink-0"></div>
          </div>
          <!-- строки -->
          <div
            v-for="e in engines" :key="e.key"
            class="group flex items-center gap-6 border-b border-border py-4"
          >
            <!-- Название: иконка + провайдер + модель с ключом маршрута -->
            <div class="flex min-w-0 flex-1 items-center gap-3.5">
              <img v-if="hasIcon(e.slug)" :src="iconSrc(e.slug)" :alt="e.label" class="size-10 shrink-0 rounded-lg object-contain" />
              <span v-else class="grid size-10 shrink-0 place-items-center text-[18px] font-bold text-muted-foreground">{{ e.label.charAt(0) }}</span>
              <div class="min-w-0">
                <div class="text-[14.5px] font-medium">{{ e.label }}</div>
                <div class="truncate font-mono text-[12px] text-muted-foreground">{{ engineSub(e) }}</div>
              </div>
            </div>
            <!-- Маршрут -->
            <div class="w-44 shrink-0">
              <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium" :class="routeClass(e)">
                {{ routeLabel(e) }}
              </span>
            </div>
            <!-- Статус -->
            <div class="w-40 shrink-0 text-[13.5px]">
              <span v-if="engineOk(e)" class="inline-flex items-center gap-1 text-success">
                <Check :size="14" /> Готов
              </span>
              <span v-else class="text-muted-foreground">Нет ключа</span>
            </div>
            <!-- Обновлено -->
            <div class="w-40 shrink-0 text-[13.5px] text-muted-foreground">
              {{ e.updatedAt ? fmtUpdated(e.updatedAt) : '—' }}
            </div>
            <!-- Действия -->
            <div class="flex w-16 shrink-0 items-center justify-end gap-1">
              <button type="button" class="rounded-md p-1.5 text-muted-foreground transition hover:bg-surface-hover hover:text-foreground" title="Изменить" @click="openEdit(e)">
                <Pencil :size="14" />
              </button>
              <button v-if="engineCustom(e)" type="button" class="rounded-md p-1.5 text-muted-foreground transition hover:bg-surface-hover hover:text-destructive" title="Очистить" @click="clearEngine(e)">
                <Trash2 :size="14" />
              </button>
              <span v-else class="block size-[26px] shrink-0"></span>
            </div>
          </div>
    </section>

        <!-- ИНТЕГРАЦИИ -->
        <section v-else-if="activeTab === 'integrations'">
          <h2 class="mb-3 text-[17px] font-semibold tracking-tight">{{ $t('settings.integrations.title') }}</h2>
      <div class="space-y-3">
        <div
          v-for="c in connectors" :key="c.key"
          class="flex items-start gap-3 rounded-xl border border-border bg-surface p-4"
        >
          <img :src="c.icon" :alt="c.title" class="mt-0.5 size-8 rounded-lg bg-surface-2 p-1" />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="text-[13.5px] font-semibold">{{ c.title }}</span>
              <span
                class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                :class="c.connected ? 'bg-success-soft text-success' : c.connected === false ? 'bg-surface-hover text-muted-foreground' : 'bg-warning-soft text-warning'"
              >
                <span class="size-1 rounded-full bg-current"></span>
                {{ c.connected
                  ? $t('settings.integrations.connected')
                  : c.connected === false
                    ? $t('settings.integrations.notConnected')
                    : $t('settings.integrations.unknown') }}
              </span>
              <span class="ml-auto truncate text-[11px] text-muted-foreground/70">{{ c.detail }}</span>
            </div>
            <p class="mt-1 text-[12px] leading-snug text-muted-foreground">{{ c.desc }}</p>
            <div class="mt-2.5 flex items-center gap-2">
              <template v-if="c.connected">
                <Button
                  v-if="c.connectHref" as-child variant="outline" size="sm"
                  class="h-7 border-border bg-surface text-[11.5px]"
                >
                  <a :href="c.connectHref"><Settings2 :size="12" /> {{ $t('settings.integrations.configure') }}</a>
                </Button>
                <Button
                  variant="ghost" size="sm" :disabled="busy === c.key"
                  class="h-7 text-[11.5px] text-muted-foreground" @click="refresh(c.key)"
                >
                  <RefreshCw :size="12" :class="busy === c.key ? 'animate-spin' : ''" /> {{ $t('action.refresh') }}
                </Button>
                <Button
                  variant="ghost" size="sm" :disabled="busy === c.key"
                  class="h-7 text-[11.5px] text-destructive/80 hover:text-destructive"
                  @click="unplug(c.key, c.title)"
                >
                  <Unplug :size="12" /> {{ $t('settings.integrations.disconnect') }}
                </Button>
              </template>
              <template v-else>
                <Button v-if="c.connectHref" as-child size="sm" class="h-7 text-[11.5px]">
                  <a :href="c.connectHref">{{ $t('settings.integrations.connect') }} <ExternalLink :size="11" /></a>
                </Button>
                <!-- Cloudflare подключается токеном, а не OAuth: спрашиваем его тут же -->
                <Button v-else size="sm" class="h-7 text-[11.5px]" @click="connectWithToken(c.key, c.title)">
                  {{ $t('settings.integrations.connect') }}
                </Button>
              </template>
            </div>
          </div>
        </div>
      </div>
      <p v-if="connErr" class="mt-2 text-[12px] text-destructive">{{ connErr }}</p>
    </section>

        <!-- ПРОФИЛЬ + ИНТЕРФЕЙС -->
        <div v-else-if="activeTab === 'account'" class="space-y-6">
        <section>
          <h2 class="mb-3 text-[17px] font-semibold tracking-tight">{{ $t('settings.appearance.title') }}</h2>
      <div class="rounded-xl border border-border bg-surface p-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="text-[13px] font-medium">{{ $t('settings.appearance.langLabel') }}</div>
            <p class="mt-0.5 text-[12px] leading-snug text-muted-foreground">{{ $t('settings.appearance.langHint') }}</p>
          </div>
          <Select :model-value="locale" @update:model-value="pickLocale">
            <SelectTrigger class="h-8 w-[150px] border-border bg-surface text-[12.5px]">
              <!-- содержимое задано явно: SelectValue запоминает подпись пункта
                   при монтировании и после смены языка показывал бы старую -->
              <SelectValue>{{ LOCALE_NAMES[locale as Locale] }}</SelectValue>
            </SelectTrigger>
            <SelectContent class="border-border bg-popover">
              <SelectItem v-for="code in LOCALES" :key="code" :value="code" class="text-[12.5px]">
                {{ LOCALE_NAMES[code] }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
    </section>

        <section>
          <h2 class="mb-3 text-[17px] font-semibold tracking-tight">{{ $t('nav.account') }}</h2>
      <div class="rounded-xl border border-border bg-surface p-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <div>
            <div class="text-[11px] uppercase tracking-wide text-muted-foreground/70">{{ $t('settings.account.name') }}</div>
            <!-- auth.name — имя из профиля, не переводится -->
            <div class="mt-0.5 text-[13px] font-medium">{{ auth.authed ? (auth.name || '—') : $t('user.guest') }}</div>
          </div>
          <div>
            <div class="text-[11px] uppercase tracking-wide text-muted-foreground/70">{{ $t('settings.account.status') }}</div>
            <div class="mt-0.5 text-[13px] font-medium">
              {{ auth.authed
                ? (auth.isAdmin ? $t('settings.account.admin') : $t('settings.account.user'))
                : $t('settings.account.anonymous') }}
            </div>
          </div>
        </div>
      </div>
        </section>
        </div>
      </div>
    </div>

    <!-- Модалка настройки движка (стиль Braintrust: правые лейблы + строки) -->
    <div
      v-if="editing"
      class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4"
      @click.self="closeEdit"
    >
      <div class="w-full max-w-xl rounded-2xl border border-border bg-background p-6 shadow-2xl">
        <div class="mb-6 flex items-start justify-between">
          <h3 class="text-[18px] font-semibold tracking-tight">Настроить {{ editing.label }}</h3>
          <button type="button" class="-mr-1 rounded-lg p-1 text-muted-foreground transition hover:bg-surface-hover hover:text-foreground" @click="closeEdit">
            <X :size="18" />
          </button>
        </div>

        <div class="space-y-5">
          <!-- Провайдер -->
          <div class="grid grid-cols-[110px_1fr] items-start gap-4">
            <label class="pt-1 text-right text-[13.5px] text-muted-foreground">Провайдер</label>
            <div>
              <div class="flex items-center gap-2">
                <img v-if="hasIcon(editing.slug)" :src="iconSrc(editing.slug)" :alt="editing.label" class="size-7 shrink-0 rounded-md object-contain" />
                <span v-else class="grid size-7 shrink-0 place-items-center text-[13px] font-bold text-muted-foreground">{{ editing.label.charAt(0) }}</span>
                <span class="text-[14px] font-medium">{{ editing.label }}</span>
                <span class="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium" :class="routeClass(editing)">
                  {{ routeLabel(editing) }}
                </span>
              </div>
              <a :href="editing.help" target="_blank" rel="noopener" class="mt-1.5 inline-flex items-center gap-1 text-[13px] text-primary hover:underline">
                Документация {{ editing.label }} <ExternalLink :size="11" />
              </a>
            </div>
          </div>

          <!-- Модель -->
          <div class="grid grid-cols-[110px_1fr] items-center gap-4">
            <label class="text-right text-[13.5px] text-muted-foreground">Модель</label>
            <select
              v-model="engineModels[editing.key]"
              class="h-9 w-full rounded-lg border border-border bg-surface px-3 text-[13px] text-foreground outline-none focus:border-muted-foreground"
            >
              <option v-for="m in modelsForEngine(editing)" :key="m.id" :value="m.id">{{ m.label }}</option>
            </select>
          </div>

          <!-- Ключ провайдера: задан — движок идёт в официальный API, пусто — через OpenRouter -->
          <div v-for="n in editing.native" :key="n.key" class="grid grid-cols-[110px_1fr] items-start gap-4">
            <label class="pt-2 break-all text-right font-mono text-[12px] text-muted-foreground">{{ n.key }}</label>
            <div>
              <input
                v-model="nativeInputs[n.key]"
                type="password" autocomplete="off"
                :placeholder="n.configured ? 'заменить ключ…' : 'вставить ключ'"
                class="h-9 w-full rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-muted-foreground"
              />
              <p class="mt-1.5 text-[12.5px] leading-snug text-muted-foreground">
                Хранится на сервере (app_settings), в ответах не показывается{{ n.configured ? ` · сейчас ${n.preview}` : '' }}.
              </p>
              <p v-if="!n.configured && editing.openrouter" class="mt-1 text-[12.5px] leading-snug text-muted-foreground">
                Без ключа движок работает через OpenRouter.
              </p>
            </div>
          </div>
        </div>

        <div class="mt-7 flex items-center gap-3">
          <span v-if="enginesMsg" class="text-[12.5px] text-destructive">{{ enginesMsg }}</span>
          <div class="ml-auto flex gap-2">
            <Button variant="outline" size="sm" class="h-9 text-[13px]" @click="closeEdit">Отмена</Button>
            <Button size="sm" class="h-9 text-[13px]" :disabled="enginesBusy" @click="saveEngines">
              {{ enginesBusy ? '…' : 'Сохранить' }}
            </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- Модалка настройки провайдера-ключей (стиль Braintrust) -->
    <div v-if="editingKp" class="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" @click.self="closeKp">
      <div class="w-full max-w-xl rounded-2xl border border-border bg-background p-6 shadow-2xl">
        <div class="mb-4 flex items-start justify-between">
          <div class="flex items-center gap-2.5">
            <img :src="'/providers/' + editingKp.icon" :alt="editingKp.label" class="size-8 shrink-0 rounded-md object-contain" />
            <h3 class="text-[18px] font-semibold tracking-tight">{{ editingKp.label }}</h3>
          </div>
          <button type="button" class="-mr-1 rounded-lg p-1 text-muted-foreground transition hover:bg-surface-hover hover:text-foreground" @click="closeKp"><X :size="18" /></button>
        </div>

        <a :href="editingKp.help" target="_blank" rel="noopener" class="mb-5 inline-flex items-center gap-1 text-[13px] text-primary hover:underline">
          Документация / получить ключ <ExternalLink :size="11" />
        </a>

        <div class="space-y-5">
          <div v-for="row in editingKp.rows" :key="row.key" class="grid grid-cols-[160px_1fr] items-start gap-4">
            <label class="pt-2 break-all text-right font-mono text-[11.5px] text-muted-foreground">{{ row.key }}</label>
            <div>
              <input
                v-model="keyInputs[row.key]"
                type="password" autocomplete="off"
                :placeholder="row.configured ? 'заменить…' : 'вставить значение'"
                class="h-9 w-full rounded-lg border border-border bg-surface px-3 text-[13px] outline-none focus:border-muted-foreground"
              />
              <p class="mt-1.5 text-[12px] leading-snug text-muted-foreground">
                {{ row.hint || row.label }}<template v-if="row.configured"> · сейчас {{ row.preview }}</template>
              </p>
            </div>
          </div>
        </div>

        <div class="mt-7 flex items-center gap-3">
          <span v-if="keysMsg" class="text-[12.5px] text-destructive">{{ keysMsg }}</span>
          <div class="ml-auto flex gap-2">
            <Button variant="outline" size="sm" class="h-9 text-[13px]" @click="closeKp">Отмена</Button>
            <Button size="sm" class="h-9 text-[13px]" :disabled="keysBusy" @click="saveKeys">{{ keysBusy ? '…' : 'Сохранить' }}</Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
