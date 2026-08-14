/**
 * Image generation via the official Google Gemini API.
 * One synchronous call: the picture comes back inline as base64, no job polling.
 * Two endpoint families (see imageCatalog): gemini-*-image models answer on
 * :generateContent, imagen-* ones on :predict. The Gemini key is separate from
 * the chat provider.
 */
import { DEFAULT_IMAGE_MODEL } from './imageCatalog'
import { allSettings, getAppSettings } from './store'

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

/** Gemini key independent of the active chat provider (images always go through Google).
 *  Blog writer override → shared Admin key (app_settings) → env. */
export async function geminiKey(): Promise<string> {
  const db = await allSettings()
  const common = await getAppSettings(['GEMINI_API_KEY'])
  return db.geminiApiKey || common.GEMINI_API_KEY || process.env.GEMINI_API_KEY || ''
}

export interface ImageOpts {
  aspectRatio?: string // 16:9 | 1:1 | 9:16 | 4:3 …
  /** model slug for the API URL (see imageCatalog); Nano Banana by default */
  model?: string
}

/** Generated image: raw bytes plus the mime the API reported for them. */
export interface ImageResult {
  bytes: Buffer
  mime: string
}

/** Generate an image and return its bytes. */
export async function generateImage(prompt: string, apiKey: string, opts: ImageOpts = {}): Promise<ImageResult> {
  if (!apiKey) throw new Error('no Gemini key — images are only generated through the Google API')

  const model = opts.model || DEFAULT_IMAGE_MODEL
  const aspectRatio = opts.aspectRatio ?? '16:9'
  const text = prompt.slice(0, 5000)
  // Imagen lives on the predict endpoint, the gemini-*-image family on generateContent
  const predict = model.startsWith('imagen-')

  const res = await fetch(`${API_BASE}/${model}:${predict ? 'predict' : 'generateContent'}`, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(
      predict
        ? { instances: [{ prompt: text }], parameters: { sampleCount: 1, aspectRatio } }
        : {
            contents: [{ role: 'user', parts: [{ text }] }],
            generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio } },
          },
    ),
    signal: AbortSignal.timeout(120_000),
  })

  const json: any = await res.json().catch(() => null)
  if (!res.ok || json?.error) {
    const msg = String(json?.error?.message || res.statusText || '').slice(0, 160)
    // The account ran out of quota/balance — the most common cause of "didn't
    // generate". Retrying is pointless, so callers get their own marker for it
    // (models are priced differently, a cheaper one might still work).
    if (res.status === 402 || json?.error?.status === 'RESOURCE_EXHAUSTED') throw new Error(`GEMINI_NO_CREDITS: ${msg}`)
    throw new Error(`${model} (${res.status}): ${msg || JSON.stringify(json).slice(0, 160)}`)
  }

  if (predict) {
    const pred = json?.predictions?.[0]
    const b64 = pred?.bytesBase64Encoded
    if (!b64) throw new Error(`${model}: empty predictions`)
    return { bytes: Buffer.from(String(b64), 'base64'), mime: pred?.mimeType || 'image/png' }
  }

  const parts: any[] = json?.candidates?.[0]?.content?.parts ?? []
  const inline = parts.map((p) => p?.inlineData).find((d) => d?.data)
  if (!inline) {
    // a refusal comes back as a normal 200 with a text part or a block reason
    const why = json?.promptFeedback?.blockReason || json?.candidates?.[0]?.finishReason || ''
    throw new Error(`${model}: no image in the response${why ? ` (${why})` : ''}`)
  }
  return { bytes: Buffer.from(String(inline.data), 'base64'), mime: inline.mimeType || 'image/png' }
}

/** Cover prompt from the article's title/topic for the brand (no text in the image). */
export function coverPrompt(title: string, brand: string): string {
  return `Обложка для блог-статьи «${title}» бренда ${brand}. `
    + 'Тёмный неон-гейминг стиль, кинематографично, фиолетово-синее свечение, абстрактно, '
    + 'современно, атмосферно. БЕЗ текста, БЕЗ букв, БЕЗ надписей, без логотипов.'
}
