/**
 * Генерация картинок для конструктора обложек. Количество НЕ ограничено —
 * платит баланс кредитов: цена зависит от выбранной модели (каталог text→image
 * приходит с бэка вместе с ценой в кредитах за картинку).
 *
 * Свой ключ kie.ai (BYO) — генерация бесплатна для нас, кредиты не списываются.
 * Статус и каталог общие на приложение: их показывает инспектор.
 */
import { computed, ref } from 'vue'
import { api } from '@/lib/api'
// не компонент — переводчик берём напрямую из инстанса
import { i18n } from '@/i18n'

export interface ImageModelOption {
  id: string
  label: string
  usdPerImage: number | null
  /** цена в наших кредитах за одну картинку */
  credits: number | null
}

export interface GeneratedImage {
  id: number
  url: string
  model: string | null
  prompt: string | null
  credits: number | null
  createdAt: string
}

const status = ref({ balance: 0, pool: 0, spent: 0, plan: '', degraded: false, hasOwnKey: false, loaded: false })
const models = ref<ImageModelOption[]>([])
// уже сгенерированные фоны: поставить готовый заново — бесплатно, платим
// только за новую генерацию
const history = ref<GeneratedImage[]>([])
const model = ref('') // '' до загрузки каталога → подставим defaultModel

/**
 * Запасной список моделей — копия снапшота из api/imageCatalog. Нужен, когда
 * каталог не отдался (бэкенд старее фронта / сеть): пустой селект выглядит как
 * поломка, а генерация с дефолтной моделью на бэке всё равно работает.
 */
// Цены в кредитах здесь ДУБЛИРУЮТ бэк (creditsForImageUsd = закуп × 3 × 90):
// это фолбэк на случай, если каталог не ответил. Меняешь наценку — правь оба.
const FALLBACK_MODELS: ImageModelOption[] = [
  { id: 'z-image', label: 'Z-Image', usdPerImage: 0.004, credits: 2 },
  { id: 'google/nano-banana', label: 'Nano Banana', usdPerImage: 0.02, credits: 6 },
  { id: 'google/imagen4-fast', label: 'Imagen 4 Fast', usdPerImage: 0.02, credits: 6 },
  { id: 'qwen/text-to-image', label: 'Qwen Image', usdPerImage: 0.02, credits: 6 },
  { id: 'gpt-image/1.5-text-to-image', label: 'GPT Image 1.5', usdPerImage: 0.02, credits: 6 },
  { id: 'flux-2/pro-text-to-image', label: 'FLUX.2 Pro', usdPerImage: 0.025, credits: 7 },
  { id: 'seedream/4.5-text-to-image', label: 'Seedream 4.5', usdPerImage: 0.032, credits: 9 },
  { id: 'google/imagen4', label: 'Imagen 4', usdPerImage: 0.04, credits: 11 },
  { id: 'google/imagen4-ultra', label: 'Imagen 4 Ultra', usdPerImage: 0.06, credits: 17 },
  { id: 'flux-2/flex-text-to-image', label: 'FLUX.2 Flex', usdPerImage: 0.07, credits: 19 },
  { id: 'nano-banana-pro', label: 'Nano Banana Pro', usdPerImage: 0.09, credits: 25 },
]
const DEFAULT_MODEL = 'google/nano-banana'

function aspectFor(w: number, h: number): string {
  const r = w / h
  if (Math.abs(r - 1) < 0.1) return '1:1'
  if (r < 0.8) return '9:16'
  if (r > 1.5) return '16:9'
  return '3:2'
}

export function useAiBackground() {
  const generating = ref(false)
  const error = ref('')

  const current = computed<ImageModelOption | null>(() => models.value.find((m) => m.id === model.value) || null)
  /** цена следующей генерации по прайсу модели; со своим ключом платим не мы */
  const price = computed(() => (status.value.hasOwnKey ? 0 : (current.value?.credits ?? 0)))
  const enough = computed(() => status.value.degraded || status.value.hasOwnKey || status.value.balance >= price.value)

  async function loadStatus() {
    try {
      const r = await api.previewBgStatus()
      // старый бэкенд отвечает почасовым лимитом без balance — считаем, что учёта
      // кредитов ещё нет: не показываем «0 кр.» и ничего не блокируем
      const hasCredits = typeof r?.balance === 'number'
      status.value = {
        balance: Number(r?.balance || 0), pool: Number(r?.pool || 0), spent: Number(r?.spent || 0),
        plan: r?.plan || '', degraded: !hasCredits || !!r?.degraded, hasOwnKey: !!r?.hasOwnKey, loaded: true,
      }
    } catch {
      // не залогинен / бэк недоступен — тихо, без блокировки генерации
      status.value = { ...status.value, degraded: true, loaded: true }
    }
  }

  /** Ранее сгенерированные фоны этого пользователя (из БД). */
  async function loadHistory() {
    try { history.value = (await api.previewImages('bg'))?.images || [] } catch { /* не залогинен — пусто */ }
  }

  async function loadModels() {
    if (models.value.length) return
    try {
      const r = await api.previewImageModels()
      models.value = r?.models?.length ? r.models : FALLBACK_MODELS
      if (!model.value) model.value = r?.defaultModel || DEFAULT_MODEL
    } catch {
      models.value = FALLBACK_MODELS // каталога нет — селект не должен быть пустым
      if (!model.value) model.value = DEFAULT_MODEL
    }
  }

  async function saveKey(key: string) {
    const r = await api.previewBgKey(key)
    status.value.hasOwnKey = !!r?.hasOwnKey
    return r
  }

  /** Сгенерировать фон под текущий формат; возвращает URL картинки. */
  async function generate(prompt: string, w: number, h: number): Promise<string> {
    generating.value = true; error.value = ''
    try {
      const r = await api.previewBackground(prompt, aspectFor(w, h), model.value || undefined)
      if (typeof r?.balance === 'number' && Number.isFinite(r.balance)) status.value.balance = r.balance
      // свежая картинка сразу в начало списка — не дожидаясь перезагрузки страницы
      if (r?.url) {
        history.value.unshift({
          id: Number(r.imageId || 0), url: String(r.url).split('?')[0],
          model: model.value || null, prompt, credits: r.credits ?? null,
          createdAt: new Date().toISOString(),
        })
      }
      return r.url as string
    } catch (e: any) {
      // сообщение бэка точнее любого нашего домысла (кончился баланс kie,
      // модель не приняла запрос, не хватает кредитов) — показываем его
      error.value = e?.serverMessage
        || (e?.status === 402
          ? i18n.global.t('preview.ai.notEnough')
          : i18n.global.t('preview.ai.genFailed'))
      throw e
    } finally { generating.value = false }
  }

  return { status, models, model, current, price, enough, history, loadStatus, loadModels, loadHistory, saveKey, generate, generating, error }
}
