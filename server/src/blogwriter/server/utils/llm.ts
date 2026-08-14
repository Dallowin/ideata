/**
 * Thin wrapper over the LLM (port of blog_agent/llm.py).
 * Providers:
 *  - anthropic — api.anthropic.com, Messages format; slugs like claude-opus-4-8
 *    (our OpenRouter slugs are mapped automatically);
 *  - openrouter — OpenAI chat-completions format.
 * Plus: per-call model choice (strong/fast), mock mode without a key,
 * a json() helper with resilient parsing and repair of truncated JSON.
 */

import { costRubLive, estimateTokens, type LlmUsageContext, recordLlmUsage } from './llmUsage'
import { anthropicSlugFor, isAnthropicModel, providerForModel } from './modelCatalog'

export type LlmProvider = 'anthropic' | 'openrouter'

export interface LlmConfig {
  provider?: LlmProvider
  apiKey: string
  /** keys for both providers — for per-model routing (Claude goes to Anthropic,
   *  OpenRouter is everything else). If set, the provider is chosen BY MODEL,
   *  not by cfg.provider. If not set → previous behavior (a single apiKey/provider). */
  anthropicKey?: string
  openrouterKey?: string
  modelStrong: string
  modelFast: string
  modelResearch?: string // separate model for research (default — Gemini)
  mock?: boolean
  /** Run context for cost tracking (run_id/user_id/domain). Optional. */
  usage?: LlmUsageContext
}

/** Result of a single provider call: text + metadata for cost tracking. */
interface LlmCallResult {
  text: string
  tokensIn: number | null
  tokensOut: number | null
  requestId: string | null
  /** Response was cut off at max_tokens (finish_reason=length / stop_reason=max_tokens). */
  truncated?: boolean
  /** Tokens weren't returned by the provider and were estimated from text length. */
  estimated?: boolean
}

const numOrNull = (v: any): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null
const strOrNull = (v: any): string | null =>
  typeof v === 'string' && v ? v : null

/**
 * A provider failure, not a request failure: 5xx, network drop, timeout.
 * Providers answer with "Network error / Server exception, please try again
 * later" in these cases — on long prompts (translating a whole article) this
 * hits regularly. A retry fixes it.
 */
function isTransient(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return /\b5\d\d\b/.test(m)
    || /timeout|aborted|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up/i.test(m)
    || /try again later/i.test(m)
}

/**
 * The provider ran out of funds. Retrying against it is pointless — but if a
 * second provider is configured, the request happily goes there instead.
 * Without this, an empty Anthropic balance would stop the ENTIRE blog writer
 * even with a working OpenRouter key at hand.
 */
function isOutOfCredits(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return /\b402\b/.test(m) || /credits? insufficient|insufficient credits|top up|quota/i.test(m)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Response wait ceiling. Long responses (translating a whole article: 8000
 * output tokens) take a minute-plus — at 100s they were timing out for
 * no good reason.
 */
function callTimeoutMs(maxTokens: number): number {
  return maxTokens >= 4000 ? 240_000 : 100_000
}

/** Short error description for the error column (with status code/timeout). */
function errString(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || /abort/i.test(err.message))
      return `timeout: ${err.message}`.slice(0, 300)
    return err.message.slice(0, 300)
  }
  return String(err).slice(0, 300)
}

export interface CompleteOpts {
  system?: string
  strong?: boolean
  research?: boolean // route to modelResearch (overrides strong)
  maxTokens?: number
  temperature?: number
  /** explicit model for a single call (overrides strong/research) — model choice in the UI */
  model?: string
}

/** Response + call metadata: what to show the user about the spend. */
export interface CompleteResult {
  text: string
  model: string
  provider: LlmProvider | 'mock'
  tokensIn: number | null
  tokensOut: number | null
  /** RUB estimate of the call; null — no tokens returned or model not in the price list */
  costRub: number | null
}

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const ANTHROPIC_VERSION = '2023-06-01'

/**
 * The Messages API expects slugs WITHOUT a vendor prefix and with hyphens instead
 * of the version dot: `claude-opus-4-8`. Our settings store the OpenRouter style
 * (`anthropic/claude-opus-4.8`) — we map it automatically. Used as a fallback when
 * the model isn't in the catalog.
 */
export function toAnthropicModel(model: string): string {
  return model.replace(/^[\w.-]+\//, '').replace(/\.(?=\d)/g, '-')
}

/**
 * Current-date line for prompts. Without it the model lives in the past
 * (its training cutoff) and dates ideas/headlines with a past year ("... in 2025").
 */
export function todayLine(): string {
  const d = new Date()
  const y = d.getFullYear()
  return `Сегодня ${d.toISOString().slice(0, 10)}, актуальный год — ${y}. `
    + `В заголовках, запросах и примерах используй ${y}; прошлые годы (${y - 1} и старше) — `
    + 'только когда речь именно об исторических данных.'
}

export class LLM {
  private cfg: LlmConfig
  private mock: boolean
  private usage?: LlmUsageContext

  constructor(cfg: LlmConfig) {
    this.cfg = cfg
    // at least one key present (active apiKey / anthropic / openrouter) → not mock
    const anyKey = cfg.apiKey || cfg.anthropicKey || cfg.openrouterKey
    this.mock = !!cfg.mock || !anyKey
    this.usage = cfg.usage
  }

  get isMock(): boolean {
    return this.mock
  }

  /** keys for both providers: explicit anthropicKey/openrouterKey → use those; otherwise a single apiKey under cfg.provider */
  private keys(): { anthropicKey: string; orKey: string } {
    const prov = this.cfg.provider ?? 'anthropic'
    return {
      anthropicKey: this.cfg.anthropicKey || (prov === 'anthropic' ? this.cfg.apiKey : ''),
      orKey: this.cfg.openrouterKey || (prov === 'openrouter' ? this.cfg.apiKey : ''),
    }
  }

  /** route for a model: provider (Claude → Anthropic, the rest → OpenRouter) + its key */
  private route(model: string): { provider: LlmProvider; key: string } {
    const { anthropicKey, orKey } = this.keys()
    const provider = providerForModel(model, { anthropicKey, orKey })
    // Non-Claude models don't exist for the Messages API: it answers 404
    // "model not found". This used to reach the user as an "empty model
    // response" — say plainly what's wrong and what to do about it.
    if (provider === 'anthropic' && !isAnthropicModel(model)) {
      throw new Error(
        `Model ${model} is only available through OpenRouter, and no OpenRouter key is set. `
        + 'Add OPENROUTER_API_KEY in the Admin panel or choose a Claude model.',
      )
    }
    return { provider, key: provider === 'anthropic' ? anthropicKey : orKey }
  }

  async complete(prompt: string, opts: CompleteOpts = {}): Promise<string> {
    return (await this.completeEx(prompt, opts)).text
  }

  /**
   * Like complete(), but also returns call metadata (model, tokens, RUB). Needed
   * where the spend is shown to the user — e.g. AI edit of a selection in the editor.
   */
  async completeEx(prompt: string, opts: CompleteOpts = {}): Promise<CompleteResult> {
    const { system = '', strong = false, research = false, maxTokens = 2000, temperature = 0.7 } = opts
    if (this.mock) {
      return { text: mockComplete(prompt), model: 'mock', provider: 'mock', tokensIn: null, tokensOut: null, costRub: null }
    }

    // explicit model from the UI → use it; otherwise research → a separate model (Gemini by default), falling back to fast
    const model = opts.model
      || (research
        ? (this.cfg.modelResearch || this.cfg.modelFast)
        : (strong ? this.cfg.modelStrong : this.cfg.modelFast))
    // provider is chosen BY MODEL: Claude → Anthropic, everything else → OpenRouter
    const { provider, key } = this.route(model)

    // Accounting wrapper: measures latency, extracts usage tokens and request_id,
    // writes a row to llm_usage (ok/error). The log never breaks the call.
    const runOnce = async (mt: number, prov: LlmProvider, k: string): Promise<LlmCallResult> => {
      const started = Date.now()
      try {
        const r = prov === 'anthropic'
          ? await this.completeAnthropic(model, k, prompt, { system, maxTokens: mt, temperature })
          : await this.completeOpenRouter(model, k, prompt, { system, maxTokens: mt, temperature })
        void recordLlmUsage({
          provider: prov, model, status: 'ok',
          latencyMs: Date.now() - started,
          tokensIn: r.tokensIn, tokensOut: r.tokensOut, requestId: r.requestId,
          estimated: r.estimated,
          ...this.usage,
        })
        return r
      } catch (err) {
        void recordLlmUsage({
          provider: prov, model, status: 'error',
          error: errString(err),
          latencyMs: Date.now() - started,
          ...this.usage,
        })
        throw err
      }
    }

    // Backup provider in case Anthropic flaps: the same model through OpenRouter
    // (Claude's id is already in its format). The pipeline step gets through.
    const { orKey } = this.keys()
    const backup: { provider: LlmProvider; key: string } | null =
      provider === 'anthropic' && orKey && model.includes('/') ? { provider: 'openrouter', key: orKey } : null

    // Transient provider failure — up to two retries with a pause, the second one
    // already through the backup (if any). Without this a single 500 breaks
    // a whole pipeline step (locale translation, article section), and it flaps regularly.
    let usedProvider = provider
    const runWithRetry = async (mt: number): Promise<LlmCallResult> => {
      for (let attempt = 0; ; attempt++) {
        const route = attempt > 0 && backup ? backup : { provider, key }
        try {
          const r = await runOnce(mt, route.provider, route.key)
          usedProvider = route.provider
          return r
        } catch (err) {
          // An empty balance isn't a transient failure: retrying the same provider
          // is pointless, but the backup will succeed. Switch there immediately, no pause.
          const canSwitch = !!backup && route.provider !== backup.provider
          const switchNow = isOutOfCredits(err) && canSwitch
          if (attempt >= 2 || (!isTransient(err) && !switchNow)) throw err
          if (!switchNow) await sleep(2000 * (attempt + 1))
        }
      }
    }

    let r = await runWithRetry(maxTokens)
    // Response hit the token ceiling → text is cut off mid-word ("unfinished
    // paragraphs"). One retry with a doubled limit fixes silent truncation everywhere:
    // article sections, locale translations, antislop, ai-edit.
    if (r.truncated && maxTokens < 16000) {
      r = await runWithRetry(Math.min(maxTokens * 2, 16000))
    }
    return {
      text: r.text,
      model,
      provider: usedProvider,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      costRub: await costRubLive(model, r.tokensIn, r.tokensOut),
    }
  }

  /** OpenRouter (OpenAI chat-completions). usage.prompt_tokens/completion_tokens + id. */
  private async completeOpenRouter(
    model: string,
    key: string,
    prompt: string,
    o: { system: string, maxTokens: number, temperature: number },
  ): Promise<LlmCallResult> {
    const res = await fetch(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://ideata.io',
        'X-Title': 'Ideata Blog Writer',
      },
      body: JSON.stringify({
        model,
        max_tokens: o.maxTokens,
        temperature: o.temperature,
        messages: [
          { role: 'system', content: o.system || 'Ты — редактор и автор технического блога.' },
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(callTimeoutMs(o.maxTokens)),
    })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      throw new Error(`OpenRouter ${res.status} (${model}): ${body}`)
    }
    const data: any = await res.json()
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string') throw new Error('OpenRouter: empty model response')
    return {
      text: content,
      tokensIn: numOrNull(data?.usage?.prompt_tokens),
      tokensOut: numOrNull(data?.usage?.completion_tokens),
      requestId: strOrNull(data?.id),
      truncated: data?.choices?.[0]?.finish_reason === 'length',
    }
  }

  /**
   * Anthropic Messages API: response content[].text, usage.input_tokens/output_tokens.
   * Only Claude models come here — everything else goes through OpenRouter.
   */
  private async completeAnthropic(
    model: string,
    key: string,
    prompt: string,
    o: { system: string, maxTokens: number, temperature: number },
  ): Promise<LlmCallResult> {
    // slug comes from the catalog, and only as a fallback do we derive it from the id
    const slug = anthropicSlugFor(model) || toAnthropicModel(model)
    const system = o.system || 'Ты — редактор и автор технического блога.'

    const res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': ANTHROPIC_VERSION,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: slug,
        max_tokens: o.maxTokens,
        temperature: o.temperature,
        system,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(callTimeoutMs(o.maxTokens)),
    })
    if (!res.ok) {
      const errBody = (await res.text()).slice(0, 300)
      throw new Error(`Anthropic ${res.status} (${slug}): ${errBody}`)
    }
    const data: any = await res.json()
    // an error envelope can also arrive with HTTP 200
    if (data?.type === 'error') {
      throw new Error(`Anthropic (${slug}): ${data?.error?.message || 'provider error'}`)
    }
    const text = Array.isArray(data?.content)
      ? data.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('')
      : ''
    if (!text) throw new Error(`Anthropic: empty model response (${JSON.stringify(data).slice(0, 200)})`)
    const u = data?.usage || {}
    let tokensIn = numOrNull(u.input_tokens)
    let tokensOut = numOrNull(u.output_tokens)
    // A response without usage means NULL tokens = "price unknown" = zero credits
    // for the call, i.e. a free article. We estimate from length — approximate,
    // but not free (the estimated flag carries through to accounting).
    const estimated = tokensIn == null || tokensOut == null
    if (estimated) {
      if (tokensIn == null) tokensIn = estimateTokens(`${system}\n${prompt}`)
      if (tokensOut == null) tokensOut = estimateTokens(text)
    }
    return {
      text,
      tokensIn,
      tokensOut,
      estimated,
      requestId: strOrNull(data?.id),
      truncated: data?.stop_reason === 'max_tokens',
    }
  }

  async json(prompt: string, opts: CompleteOpts = {}): Promise<any> {
    const fullPrompt = prompt + '\n\nОтветь ТОЛЬКО валидным JSON без пояснений.'
    const raw = await this.complete(fullPrompt, { ...opts, temperature: 0.4, maxTokens: opts.maxTokens ?? 3000 })
    try {
      return extractJson(raw)
    } catch {
      // one retry: models sometimes truncate/break JSON
      const retry = await this.complete(
        fullPrompt + '\nВНИМАНИЕ: предыдущий ответ был невалидным JSON. Верни строго валидный, компактный JSON.',
        { ...opts, temperature: 0.2, maxTokens: opts.maxTokens ?? 3000 },
      )
      return extractJson(retry)
    }
  }
}

/**
 * Models often wrap the requested array in an object ({"key_points": [...]}).
 * Returns the array itself: as-is, or the object's first array-valued property.
 */
export function coerceArray(data: any): any[] {
  if (Array.isArray(data)) return data
  if (data && typeof data === 'object') {
    const arr = Object.values(data).find(v => Array.isArray(v))
    if (arr) return arr as any[]
  }
  return []
}

/** Pull the first balanced JSON out of a model response (port of _extract_json + repair of truncation). */
export function extractJson(raw: string): any {
  let s = raw.trim()
  const fence = s.match(/```(?:json)?\s*([\s\S]+?)```/)
  if (fence) s = fence[1].trim()
  const starts = [s.indexOf('{'), s.indexOf('[')].filter(i => i !== -1)
  if (!starts.length) throw new Error(`No JSON in the LLM response: ${s.slice(0, 200)}`)
  s = s.slice(Math.min(...starts))
  try {
    return JSON.parse(s)
  } catch {
    // trim trailing garbage down to the last closing bracket
    const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'))
    try {
      return JSON.parse(s.slice(0, end + 1))
    } catch {
      // response was cut off at max_tokens: repair it — trim to the last complete
      // top-level element and close the missing brackets
      return JSON.parse(repairTruncatedJson(s))
    }
  }
}

/**
 * Repair of JSON truncated at max_tokens: scan with a stack (tracking strings,
 * escaping, and "key vs value" context), remember the position of the last
 * COMPLETE value, cut off the broken tail, and close the open brackets.
 */
export function repairTruncatedJson(s: string): string {
  interface Frame { type: '{' | '[', expectingValue: boolean }
  const stack: Frame[] = []
  let inString = false
  let escaped = false
  let cutAt = -1 // index of the last character of a complete value
  let stackAtCut: Frame[] = []

  const isValueContext = () => {
    const top = stack[stack.length - 1]
    if (!top) return true // top level
    return top.type === '[' || top.expectingValue
  }
  const markValueEnd = (i: number) => {
    cutAt = i
    stackAtCut = stack.map(f => ({ ...f }))
    const top = stack[stack.length - 1]
    if (top?.type === '{') top.expectingValue = false
  }

  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') {
        inString = false
        if (isValueContext()) markValueEnd(i) // a complete string value
      }
      continue
    }
    switch (c) {
      case '"': inString = true; break
      case '{': stack.push({ type: '{', expectingValue: false }); break
      case '[': stack.push({ type: '[', expectingValue: false }); break
      case '}': case ']':
        stack.pop()
        markValueEnd(i) // a closed object/array is a complete value in its parent
        break
      case ':': {
        const top = stack[stack.length - 1]
        if (top?.type === '{') top.expectingValue = true
        break
      }
      default:
        // a primitive (number/true/false/null): complete only if followed by a separator
        if (/[\d\-tfn]/.test(c) && isValueContext()) {
          let j = i
          while (j < s.length && /[\w.+-]/.test(s[j])) j++
          if (j < s.length) markValueEnd(j - 1) // separator found → the primitive isn't truncated
          i = j - 1
        }
    }
  }

  if (cutAt === -1) throw new Error(`JSON cannot be repaired: ${s.slice(0, 120)}`)
  let out = s.slice(0, cutAt + 1)
  for (const frame of [...stackAtCut].reverse()) {
    out += frame.type === '{' ? '}' : ']'
  }
  return out
}

// --------------------------------------------------------------------------- //
// Mock: deterministic responses keyed off markers in the prompt (port of _mock_complete).
// Lets the whole pipeline run without a key (demo/CI).
// --------------------------------------------------------------------------- //
export function mockComplete(prompt: string): string {
  const low = prompt.toLowerCase()
  if (low.includes('контент-план')) {
    return JSON.stringify([
      { title: 'Что такое AI-видимость и почему она заменяет SEO-трафик', angle: 'ликбез с цифрами', intent: 'definition', keyword: 'ai видимость', queries: ['что такое ai видимость', 'как бренды попадают в ответы ChatGPT'], category: '' },
      { title: 'Как проверить упоминания бренда в ChatGPT и Perplexity', angle: 'пошаговый чеклист', intent: 'howto', keyword: 'упоминания бренда в ai', queries: ['как проверить упоминания бренда в chatgpt', 'мониторинг бренда в ai-выдаче'], category: '' },
      { title: 'AEO против SEO: что оптимизировать в 2026', angle: 'сравнение стратегий', intent: 'comparison', keyword: 'aeo против seo', queries: ['aeo или seo что важнее', 'чем aeo отличается от seo'], category: '' },
      { title: 'Лучшие инструменты мониторинга AI-выдачи', angle: 'подборка с критериями выбора', intent: 'best', keyword: 'инструменты мониторинга ai', queries: ['лучшие сервисы мониторинга ai-выдачи', 'как выбрать инструмент aeo'], category: '' },
    ])
  }
  if (low.includes('придумай') && low.includes('идей статей')) {
    return JSON.stringify([
      { title: 'Что такое анализ конкурентов и с чего начать', angle: 'разбор с нуля', intent: 'definition', keyword: 'анализ конкурентов', queries: ['что такое анализ конкурентов', 'как начать анализ конкурентов'] },
      { title: 'Как проверить трафик чужого сайта: пошаговый гайд', angle: 'пошаговая инструкция', intent: 'howto', keyword: 'проверить трафик сайта', queries: ['как узнать трафик чужого сайта', 'сервисы проверки трафика'] },
      { title: 'Ручной аудит или сервис аналитики: что выбрать', angle: 'сравнение подходов', intent: 'comparison', keyword: 'аудит сайта сервис', queries: ['аудит сайта вручную или сервисом', 'сравнение сервисов аналитики'] },
    ])
  }
  if (low.includes('составь поисковые запросы')) {
    return JSON.stringify([
      { query: 'анализ отзывов конкурентов', angle: 'что это' },
      { query: 'как анализировать отзывы конкурентов', angle: 'как делают' },
      { query: 'сервисы анализа отзывов saas', angle: 'инструменты' },
      { query: 'мониторинг отзывов конкурентов инструменты', angle: 'инструменты' },
      { query: 'ошибки при анализе отзывов', angle: 'ошибки' },
    ])
  }
  if (low.includes('сгенерируй запросы')) {
    return JSON.stringify([
      { query: 'как выбрать инструмент анализа отзывов конкурентов?', intent: 'howto', cluster: 'выбор инструмента' },
      { query: 'анализ отзывов вручную или через сервис — что лучше?', intent: 'comparison', cluster: 'выбор инструмента' },
      { query: 'лучшие сервисы анализа отзывов для малого SaaS', intent: 'best', cluster: 'инструменты' },
      { query: 'что такое анализ отзывов конкурентов', intent: 'definition', cluster: 'основы' },
      { query: 'чем заменить дорогой сервис анализа отзывов', intent: 'alternatives', cluster: 'инструменты' },
      { query: 'отзывы', intent: 'informational', cluster: 'основы' },
    ])
  }
  if (low.includes('построй структуру')) {
    return JSON.stringify({
      title: 'Черновой заголовок по теме',
      angle: 'разбор на конкретных цифрах, а не общие слова',
      audience: 'практики',
      sections: [
        { heading: 'В чём проблема', intent: 'ввести контекст', points: ['боль аудитории'], keywords: [{ word: 'анализ отзывов', required: true }, { word: 'конкуренты', required: false }], topics: ['зачем это нужно'], est_words: 200 },
        { heading: 'Как это устроено', intent: 'механика', points: ['шаги', 'пример'], keywords: [{ word: 'сбор отзывов', required: true }, { word: 'кластеризация', required: false }], topics: ['источники отзывов'], est_words: 400 },
        { heading: 'Что делать', intent: 'практика', points: ['чеклист'], keywords: [{ word: 'инструменты', required: true }, { word: 'сервис', required: false }], topics: ['вручную vs сервис'], est_words: 300 },
      ],
    })
  }
  if (low.includes('предложи') && low.includes('перспектив')) {
    return JSON.stringify([
      { name: 'Практик-внедренец', rationale: 'как применить на деле', questions: ['Какие шаги?', 'Где типичные грабли?'] },
      { name: 'Скептик по ROI', rationale: 'когда это НЕ окупается', questions: ['Сколько стоит?', 'Когда не стоит браться?'] },
    ])
  }
  if (low.includes('key_points') && low.includes('facts')) {
    return JSON.stringify({
      key_points: ['Тезис A из источника', 'Тезис B из источника'],
      facts: [{ claim: 'Демо-факт: 42% пользователей делают X', quote: '42% пользователей делают X ежедневно' }],
    })
  }
  if (low.includes('вытащи') && low.includes('тезис')) {
    return JSON.stringify(['Тезис A из источника', 'Тезис B из источника'])
  }
  if (low.includes('напиши лид')) {
    return (
      'Прямой ответ на главный вопрос темы в двух предложениях. Конкретика без подводок.\n\n'
      + '- Главный вывод один\n- Главный вывод два'
    )
  }
  if (low.includes('составь блок faq')) {
    return '## FAQ\n\n### Демо-вопрос по теме?\nКороткий прямой ответ.\n\n### Второй вопрос?\nЕщё один прямой ответ.'
  }
  if (low.includes('перепиш') || low.includes('rewrite') || low.includes('почини')) {
    return (
      'Разберём по шагам, что реально работает. Берём конкретный пример '
      + 'и смотрим на цифры. Дальше — что делать на практике и где грабли.'
    )
  }
  // Section draft.
  return (
    'Короткий осмысленный абзац по теме секции с конкретикой и примером. '
    + 'Без воды и штампов, по делу.'
  )
}
