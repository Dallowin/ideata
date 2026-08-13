/**
 * Thin wrapper over the LLM (port of blog_agent/llm.py).
 * Providers:
 *  - kie (default) — api.kie.ai, Anthropic Messages format (/claude/v1/messages),
 *    noticeably cheaper; slugs like claude-opus-4-8 (our OpenRouter slugs are mapped automatically);
 *  - openrouter — OpenAI chat-completions format.
 * Plus: per-call model choice (strong/fast), mock mode without a key,
 * a json() helper with resilient parsing and repair of truncated JSON.
 */

import { costRubLive, estimateTokens, type LlmUsageContext, recordLlmUsage } from './llmUsage'
import { isKieModel, kieSlugFor, providerForModel } from './modelCatalog'

export type LlmProvider = 'kie' | 'openrouter'

export interface LlmConfig {
  provider?: LlmProvider
  apiKey: string
  /** keys for both providers — for per-model routing (kie is cheap Claude,
   *  OpenRouter is everything else). If set, the provider is chosen BY MODEL,
   *  not by cfg.provider. If not set → previous behavior (a single apiKey/provider). */
  kieKey?: string
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
 * A provider failure, not a request failure: 5xx, network drop, timeout. kie
 * returns "Network error / Server exception, please try again later" in these
 * cases — on long prompts (translating a whole article) this hits regularly.
 * A retry fixes it.
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
 * Without this, an empty kie balance would stop the ENTIRE blog writer even
 * with a working OpenRouter key at hand.
 */
function isOutOfCredits(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return /\b402\b/.test(m) || /credits? insufficient|insufficient credits|top up|quota/i.test(m)
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/**
 * Response wait ceiling. Long responses (translating a whole article: 8000
 * output tokens) take a minute-plus on kie — at 100s they were timing out for
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
const KIE_URL = 'https://api.kie.ai/claude/v1/messages'

/**
 * kie.ai expects slugs WITHOUT a vendor prefix: `claude-opus-4-8`, `gemini-2.5-pro`,
 * `gpt-4o-mini`. Our settings store the OpenRouter style (`anthropic/claude-opus-4.8`,
 * `google/gemini-2.5-pro`) — we map it automatically: strip the `<vendor>/` from all
 * of them (with the prefix kie returns 404 on `api.kie.ai/<model>/v1/chat/completions`),
 * and for Claude additionally turn version dots into hyphens.
 */
export function toKieModel(model: string): string {
  const slug = model.replace(/^[\w.-]+\//, '')
  return slug.startsWith('claude') ? slug.replace(/\.(?=\d)/g, '-') : slug
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
    // at least one key present (active apiKey / kie / openrouter) → not mock
    const anyKey = cfg.apiKey || cfg.kieKey || cfg.openrouterKey
    this.mock = !!cfg.mock || !anyKey
    this.usage = cfg.usage
  }

  get isMock(): boolean {
    return this.mock
  }

  /** keys for both providers: explicit kieKey/openrouterKey → use those; otherwise a single apiKey under cfg.provider */
  private keys(): { kieKey: string; orKey: string } {
    const prov = this.cfg.provider ?? 'kie'
    return {
      kieKey: this.cfg.kieKey || (prov === 'kie' ? this.cfg.apiKey : ''),
      orKey: this.cfg.openrouterKey || (prov === 'openrouter' ? this.cfg.apiKey : ''),
    }
  }

  /** route for a model: provider (from the kie catalog) + its key */
  private route(model: string): { provider: LlmProvider; key: string } {
    const { kieKey, orKey } = this.keys()
    const provider = providerForModel(model, { kieKey, orKey })
    // Models outside the kie catalog don't exist for kie: it responds with 200 and
    // {code:422,"The model is not supported"}. This used to reach the user as an
    // "empty model response" — say plainly what's wrong and what to do about it.
    if (provider === 'kie' && !isKieModel(model)) {
      throw new Error(
        `Model ${model} is only available through OpenRouter, and no OpenRouter key is set. `
        + 'Add OPENROUTER_API_KEY in the Admin panel or choose a Claude/Gemini model (served by kie.ai).',
      )
    }
    return { provider, key: provider === 'kie' ? kieKey : orKey }
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
    // provider is chosen BY MODEL: Claude → kie (cheaper), everything else → OpenRouter
    const { provider, key } = this.route(model)

    // Accounting wrapper: measures latency, extracts usage tokens and request_id,
    // writes a row to llm_usage (ok/error). The log never breaks the call.
    const runOnce = async (mt: number, prov: LlmProvider, k: string): Promise<LlmCallResult> => {
      const started = Date.now()
      try {
        const r = prov === 'kie'
          ? await this.completeKie(model, k, prompt, { system, maxTokens: mt, temperature })
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

    // Backup provider in case kie flaps: the same model through OpenRouter
    // (Claude's id is already in its format). More expensive, but the pipeline step gets through.
    const { orKey } = this.keys()
    const backup: { provider: LlmProvider; key: string } | null =
      provider === 'kie' && orKey && model.includes('/') ? { provider: 'openrouter', key: orKey } : null

    // Transient provider failure — up to two retries with a pause, the second one
    // already through the backup (if any). Without this a single 500 from kie breaks
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
   * kie.ai. Two formats:
   *  - Claude models → Anthropic Messages API (/claude/v1/messages, response content[].text,
   *    usage.input_tokens/output_tokens);
   *  - everything else (gemini-*, gpt-5-2…) → a per-model OpenAI endpoint
   *    api.kie.ai/<model>/v1/chat/completions (choices[0].message.content,
   *    usage.prompt_tokens/completion_tokens).
   * Some kie responses arrive without usage — then tokens are NULL (cost gets backfilled by the scrapper).
   */
  private async completeKie(
    model: string,
    key: string,
    prompt: string,
    o: { system: string, maxTokens: number, temperature: number },
  ): Promise<LlmCallResult> {
    // slug comes from the catalog (for some models it can't be derived from the id:
    // gemini-3-5-flash-openai), and only as a fallback do we guess it from the id
    const slug = kieSlugFor(model) || toKieModel(model)
    const system = o.system || 'Ты — редактор и автор технического блога.'
    const isClaude = slug.startsWith('claude')

    const url = isClaude ? KIE_URL : `https://api.kie.ai/${slug}/v1/chat/completions`
    const body = isClaude
      ? { model: slug, max_tokens: o.maxTokens, temperature: o.temperature, system, messages: [{ role: 'user', content: prompt }] }
      : { model: slug, max_tokens: o.maxTokens, temperature: o.temperature, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(callTimeoutMs(o.maxTokens)),
    })
    if (!res.ok) {
      const errBody = (await res.text()).slice(0, 300)
      throw new Error(`kie.ai ${res.status} (${slug}): ${errBody}`)
    }
    const data: any = await res.json()
    // kie also returns errors with HTTP 200 — its own envelope {code,msg,data:null}
    // (e.g. code:422 "The model is not supported") and the Anthropic style {type:'error'}.
    if (typeof data?.code === 'number' && data.code !== 200) {
      throw new Error(`kie.ai ${data.code} (${slug}): ${data?.msg || 'provider error'}`)
    }
    if (data?.type === 'error') {
      throw new Error(`kie.ai (${slug}): ${data?.error?.message || 'provider error'}`)
    }
    const text = isClaude
      ? (Array.isArray(data?.content) ? data.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('') : '')
      : (typeof data?.choices?.[0]?.message?.content === 'string' ? data.choices[0].message.content : '')
    if (!text) throw new Error(`kie.ai: empty model response (${JSON.stringify(data).slice(0, 200)})`)
    // usage: Anthropic format (input/output_tokens) or OpenAI format (prompt/completion_tokens)
    const u = data?.usage || {}
    let tokensIn = numOrNull(u.input_tokens ?? u.prompt_tokens)
    let tokensOut = numOrNull(u.output_tokens ?? u.completion_tokens)
    // Some kie responses arrive without usage. NULL tokens = "price unknown" =
    // zero credits for the call, i.e. a free article. We estimate from length —
    // approximate, but not free (the estimated flag carries through to accounting).
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
      // Anthropic: stop_reason=max_tokens; OpenAI style: finish_reason=length
      truncated: data?.stop_reason === 'max_tokens' || data?.choices?.[0]?.finish_reason === 'length',
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
