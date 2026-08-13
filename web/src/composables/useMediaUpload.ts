// Загрузка медиа в тело статьи. Валидация тут дублирует серверную намеренно:
// отдать 100-мегабайтное видео на сервер и через минуту получить 400 — худший
// из возможных фидбэков, поэтому неподходящий файл отсекаем до отправки и
// объясняем причину на языке интерфейса.
import { ref } from 'vue'
import { api, type MediaAsset } from '@/lib/api'
import { i18n, intlLocale } from '@/i18n'

// Файл — не компонент: словарь дёргаем через глобальный инстанс, а не useI18n().
// Ключи пишем целиком — так их проверяет npm run check:i18n.
const t = (k: string, named?: Record<string, unknown>) =>
  named ? i18n.global.t(k, named) : i18n.global.t(k)

export type MediaKind = 'image' | 'video' | 'audio' | 'file'

/**
 * Белый список MIME → kind. Ровно раздел 2 контракта; image/svg+xml намеренно
 * отсутствует — SVG это исполняемый документ, в теле статьи он даёт XSS.
 */
const MIME_KIND: Record<string, MediaKind> = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'image/avif': 'image',

  'video/mp4': 'video',
  'video/webm': 'video',
  'video/quicktime': 'video',

  'audio/mpeg': 'audio',
  'audio/ogg': 'audio',
  'audio/wav': 'audio',
  'audio/x-wav': 'audio',
  'audio/mp4': 'audio',
  'audio/webm': 'audio',
  'audio/aac': 'audio',

  'application/pdf': 'file',
  'application/zip': 'file',
  'text/plain': 'file',
  'text/csv': 'file',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'file',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'file',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'file',
}

const MB = 1024 * 1024
const LIMITS: Record<MediaKind, number> = { image: 20 * MB, audio: 40 * MB, video: 100 * MB, file: 100 * MB }

/** accept для <input type="file"> по видам; 'any' — всё разрешённое разом */
export const MEDIA_ACCEPT: Record<MediaKind | 'any', string> = {
  image: 'image/jpeg,image/png,image/webp,image/gif,image/avif',
  video: 'video/mp4,video/webm,video/quicktime',
  audio: 'audio/mpeg,audio/ogg,audio/wav,audio/mp4,audio/webm,audio/aac',
  file: 'application/pdf,application/zip,text/plain,text/csv,.docx,.xlsx,.pptx',
  any: '',
}

/** kind по MIME (браузер иногда даёт пустой type — тогда добираем по расширению) */
export function kindOfFile(file: File): MediaKind | null {
  const byMime = MIME_KIND[(file.type || '').toLowerCase()]
  if (byMime) return byMime
  const ext = (file.name || '').toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || ''
  if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'].includes(ext)) return 'image'
  if (['mp4', 'webm', 'mov'].includes(ext)) return 'video'
  if (['mp3', 'ogg', 'wav', 'm4a', 'aac'].includes(ext)) return 'audio'
  if (['pdf', 'zip', 'txt', 'csv', 'docx', 'xlsx', 'pptx'].includes(ext)) return 'file'
  return null
}

/** человекочитаемый размер — им же подписываем карточку файла */
export function formatSize(bytes: number): string {
  if (!bytes || bytes < 0) return ''
  // дробная часть по локали: «2,3 МБ» против «2.3 MB»
  const dec = (v: number, digits: number) =>
    new Intl.NumberFormat(intlLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v)
  if (bytes < 1024) return t('blog.editor.size.b', { n: bytes })
  if (bytes < MB) return t('blog.editor.size.kb', { n: Math.round(bytes / 1024) })
  return t('blog.editor.size.mb', { n: dec(bytes / MB, bytes < 10 * MB ? 1 : 0) })
}

/** null — файл подходит; строка — готовый текст ошибки для интерфейса */
export function validateFile(file: File): string | null {
  if ((file.type || '').toLowerCase() === 'image/svg+xml') return t('blog.editor.upload.svg')
  const kind = kindOfFile(file)
  if (!kind) return t('blog.editor.upload.badFormat', { name: file.name })
  const limit = LIMITS[kind]
  if (file.size > limit)
    return t('blog.editor.upload.tooBig', { kind: t(`blog.editor.kind.${kind}`), size: formatSize(file.size), limit: formatSize(limit) })
  return null
}

export interface UploadTask {
  /** локальный blob-URL для превью, пока файл летит на сервер */
  preview: string
  kind: MediaKind
  promise: Promise<MediaAsset>
  abort: () => void
}

/**
 * Старт загрузки без реактивной обвязки — им пользуются места, которые сами
 * держат состояние (нода редактора хранит прогресс в своих атрибутах).
 * Бросает Error с готовым текстом, если файл не прошёл валидацию.
 */
export function startUpload(runId: string, file: File, onProgress?: (pct: number) => void): UploadTask {
  const bad = validateFile(file)
  if (bad) throw new Error(bad)
  const kind = kindOfFile(file) as MediaKind
  // blob-URL живёт до подмены на серверный src; освобождает его вызывающий
  const preview = kind === 'file' ? '' : URL.createObjectURL(file)
  const req = api.blogMediaUpload(runId, file, onProgress)
  return { preview, kind, promise: req, abort: req.abort }
}

/** текст ошибки загрузки: сначала сообщение бэка, потом общая причина по статусу */
export function uploadErrorText(e: any): string {
  if (e?.aborted) return t('blog.editor.upload.aborted')
  // сообщение бэка приходит готовым — его не переводим
  if (e?.serverMessage) return String(e.serverMessage)
  if (e?.status === 402) return t('blog.editor.upload.plan')
  if (e?.status === 403) return t('blog.editor.upload.forbidden')
  if (e?.status === 413) return t('blog.editor.upload.tooLarge')
  if (e?.status === 0) return t('blog.editor.upload.offline')
  return t('blog.editor.upload.failed')
}

/**
 * Реактивная обёртка для «одна загрузка за раз» (кнопка «Заменить» в ноде,
 * загрузка из диалога). Для пачки файлов проще звать startUpload напрямую.
 */
export function useMediaUpload() {
  const busy = ref(false)
  const progress = ref(0)
  const error = ref('')
  let task: UploadTask | null = null

  async function upload(runId: string, file: File): Promise<MediaAsset | null> {
    error.value = ''
    progress.value = 0
    let started: UploadTask
    try {
      started = startUpload(runId, file, (p) => { progress.value = p })
    } catch (e: any) {
      error.value = e?.message || t('blog.editor.upload.badFile')
      return null
    }
    task = started
    busy.value = true
    try {
      return await started.promise
    } catch (e: any) {
      error.value = uploadErrorText(e)
      return null
    } finally {
      busy.value = false
      if (started.preview) URL.revokeObjectURL(started.preview)
      task = null
    }
  }

  function cancel() { task?.abort() }

  return { busy, progress, error, upload, cancel }
}
