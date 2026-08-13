/**
 * Outbound calls to the Ideata AI API (domain AEO analysis) — server-to-server.
 * The sk_ideata_… key lives ONLY on the server (env IDEATA_API_KEY);
 * the front end talks to /blogwriter/ideata/*. Analysis is asynchronous: analyze → poll job → read results.
 */
export interface IdeataConfig {
  base: string
  key: string
  hasKey: boolean
}

const DEFAULT_BASE = 'https://api.ideata.io/api/public/v1'

/** Base + key from env (IDEATA_API_BASE / IDEATA_API_KEY). */
export function ideataConfig(): IdeataConfig {
  const base = String(process.env.IDEATA_API_BASE || DEFAULT_BASE).replace(/\/+$/, '')
  const key = String(process.env.IDEATA_API_KEY || '')
  return { base, key, hasKey: !!key }
}

/** Plain Error with an attached statusCode — the controller maps it to an HTTP response. */
function ideataError(statusCode: number, msg: string): Error {
  const err = new Error(msg) as Error & { statusCode?: number, statusMessage?: string }
  err.statusCode = statusCode
  err.statusMessage = msg
  return err
}

/** Ideata error → plain Error (with statusCode) and a readable message. */
function mapError(e: any): Error {
  const status: number | undefined = e?.response?.status ?? e?.status ?? e?.statusCode
  const map: Record<number, { code: number, msg: string }> = {
    401: { code: 502, msg: 'Ideata: key not accepted (401) — check IDEATA_API_KEY' },
    403: { code: 502, msg: 'Ideata: access denied (403) — requires the Scale plan and a valid key' },
    404: { code: 404, msg: 'Ideata: analysis not found (404)' },
    429: { code: 429, msg: 'Ideata: rate limit exceeded (429) — try again later' },
  }
  if (status && map[status]) {
    const { code, msg } = map[status]
    return ideataError(code, msg)
  }
  if (status) {
    const msg = `Ideata API returned error ${status}`
    return ideataError(502, msg)
  }
  const msg = `Could not connect to the Ideata API (${e?.message || 'network error'})`
  return ideataError(502, msg)
}

interface IdeataFetchOpts {
  method?: string
  body?: unknown
  query?: Record<string, any>
  headers?: Record<string, string>
}

/** Low-level Ideata call with a bearer key (global fetch). */
async function ideataFetch<T>(path: string, opts: IdeataFetchOpts = {}): Promise<T> {
  const { base, key } = ideataConfig()
  if (!key) {
    throw ideataError(503, 'IDEATA_API_KEY is not set on the server — Ideata integration is unavailable')
  }

  let url = `${base}${path}`
  if (opts.query) {
    const qs = new URLSearchParams()
    for (const [k, v] of Object.entries(opts.query)) {
      if (v === undefined || v === null) continue
      qs.append(k, String(v))
    }
    const s = qs.toString()
    if (s) url += (url.includes('?') ? '&' : '?') + s
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    ...(opts.headers || {}),
  }
  const init: RequestInit = { method: opts.method || 'GET', headers }
  if (opts.body !== undefined) {
    if (!headers['Content-Type'] && !headers['content-type']) headers['Content-Type'] = 'application/json'
    init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
  }

  let res: Response
  try {
    res = await fetch(url, init)
  } catch (e) {
    // Network error (no status) → 502 "could not connect".
    throw mapError(e)
  }
  if (!res.ok) {
    throw mapError({ status: res.status })
  }

  const text = await res.text()
  if (!text) return undefined as unknown as T
  try {
    return JSON.parse(text) as T
  } catch {
    // Invalid JSON from upstream → treat as a connection failure.
    throw mapError({ message: 'invalid JSON from Ideata' })
  }
}

// --- Ideata endpoints (see https://ideata.io/openapi.json) ----------------------- //

/** POST /analyze — start a domain analysis. { id, job_id, status, cached }. */
export const ideataAnalyze = (body: Record<string, unknown>) =>
  ideataFetch<any>('/analyze', { method: 'POST', body })

/** GET /jobs/:jobId — status of an async analysis. { status, log }. */
export const ideataJob = (jobId: string | number) => ideataFetch<any>(`/jobs/${jobId}`)

/** GET /analyses — list of past analyses. */
export const ideataList = (query?: Record<string, any>) => ideataFetch<any>('/analyses', { query })

/** GET /analyses/:id — full analysis result (facts, llm_outputs). */
export const ideataAnalysis = (id: string | number) => ideataFetch<any>(`/analyses/${id}`)

/** GET /analyses/:id/prompts — AI prompts/queries (vol, intent, mentioned, pos). */
export const ideataPrompts = (id: string | number) => ideataFetch<any>(`/analyses/${id}/prompts`)

/** GET /analyses/:id/guide — AEO guide and content plan. */
export const ideataGuide = (id: string | number) => ideataFetch<any>(`/analyses/${id}/guide`)
