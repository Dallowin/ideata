/**
 * Image generation via kie.ai Nano Banana (google/nano-banana).
 * Async jobs API: createTask → poll recordInfo → resultJson.resultUrls[0].
 * ~4 credits (~$0.02) per image, ~15-20s. The kie key is separate from the chat provider.
 */
import { allSettings, getAppSettings } from './store'

const CREATE_URL = 'https://api.kie.ai/api/v1/jobs/createTask'
const INFO_URL = 'https://api.kie.ai/api/v1/jobs/recordInfo'

/** kie key independent of the active chat provider (images always go through kie).
 *  Blog writer override → shared Admin key (app_settings) → env. */
export async function kieKey(): Promise<string> {
  const db = await allSettings()
  const common = await getAppSettings(['KIE_API_KEY'])
  return db.kieApiKey || common.KIE_API_KEY || process.env.KIE_API_KEY || ''
}

export interface NanoOpts {
  aspectRatio?: string // 16:9 | 1:1 | 9:16 | 4:3 …
  outputFormat?: 'jpeg' | 'png'
  /** model slug for the kie jobs API (see imageCatalog); Nano Banana by default */
  model?: string
}

/** Generate an image, return a temporary result URL (kie tempfile). */
export async function generateImage(prompt: string, apiKey: string, opts: NanoOpts = {}): Promise<string> {
  if (!apiKey) throw new Error('no kie.ai key — images are only generated through kie')

  const create = await fetch(CREATE_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model || 'google/nano-banana',
      input: {
        prompt: prompt.slice(0, 5000),
        output_format: opts.outputFormat ?? 'jpeg',
        aspect_ratio: opts.aspectRatio ?? '16:9',
        nsfw_checker: false,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  })
  const cj: any = await create.json()
  const taskId = cj?.data?.taskId
  if (!taskId) {
    // kie responds with HTTP 200 and puts the real code in the body — the most
    // common cause of "didn't generate" is a 402: OUR kie account ran out of
    // balance (models are priced differently, a cheaper one might still work).
    const code = Number(cj?.code)
    const msg = String(cj?.msg || '').slice(0, 160)
    if (code === 402 || /credit/i.test(msg)) throw new Error(`KIE_NO_CREDITS: ${msg}`)
    throw new Error(`${opts.model || 'nano-banana'} createTask (code ${code || '?'}): ${msg || JSON.stringify(cj).slice(0, 160)}`)
  }

  // poll until ready (~90s)
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000))
    const info = await fetch(`${INFO_URL}?taskId=${taskId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
    const ij: any = await info.json()
    const state = ij?.data?.state
    if (state === 'success') {
      let url = ''
      try { url = JSON.parse(ij.data.resultJson || '{}')?.resultUrls?.[0] || '' } catch { /* ignore */ }
      if (!url) throw new Error('nano-banana: empty resultUrls')
      return url
    }
    if (state === 'fail') throw new Error(`nano-banana: ${ij?.data?.failMsg || 'generation failed'}`)
  }
  throw new Error('nano-banana: image wait timed out')
}

/** Cover prompt from the article's title/topic for the brand (no text in the image). */
export function coverPrompt(title: string, brand: string): string {
  return `Обложка для блог-статьи «${title}» бренда ${brand}. `
    + 'Тёмный неон-гейминг стиль, кинематографично, фиолетово-синее свечение, абстрактно, '
    + 'современно, атмосферно. БЕЗ текста, БЕЗ букв, БЕЗ надписей, без логотипов.'
}
