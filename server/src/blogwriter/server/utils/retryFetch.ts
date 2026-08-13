/**
 * Retrying network calls to publishing platforms.
 *
 * The main rule here is: do NOT retry something that might have gone through. A
 * dropped connection on POST /tweets doesn't tell you whether the post was
 * created or not: a retry in that case is just as likely to fix the publish as it
 * is to duplicate it. A duplicate in someone else's feed is worse than an honest
 * "please try again" error, so the policy depends on the method:
 *
 *  - GET/DELETE - retry anything: they're idempotent by definition
 *    (re-reading / deleting an already-deleted item is safe).
 *  - POST - retry ONLY on 429 and 503: the platform explicitly said the request
 *    was rejected and nothing was created. Timeout, connection drop, 500 - return
 *    the error as-is.
 *
 * The delay is taken from Retry-After (X and Bluesky send it), otherwise it doubles.
 */

/** How long to wait before retrying: Retry-After in seconds or a date, otherwise backoff. */
function delayFor(res: Response | null, attempt: number): number {
  const raw = res?.headers.get('retry-after') || ''
  if (raw) {
    const secs = Number(raw)
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 30_000)
    const at = Date.parse(raw)
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 30_000)
  }
  return Math.min(1000 * 2 ** attempt, 8000) // 1s -> 2s -> 4s
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export interface RetryOptions {
  /** how many EXTRA attempts beyond the first one */
  attempts?: number
  /** request method - determines what's even allowed to be retried */
  method?: string
  /** delay (ms) - overridden in tests so they don't wait for real */
  wait?: (ms: number) => Promise<void>
}

/** A response or a network error - we don't throw an exception outward, same as in the callers. */
export type FetchOutcome =
  | { res: Response }
  | { netError: string }

/**
 * Run a request with retries per the policy above. The argument is a function so
 * each attempt gets its own AbortController/timeout.
 */
export async function retryFetch(
  run: () => Promise<Response>,
  opts: RetryOptions = {},
): Promise<FetchOutcome> {
  const attempts = Math.max(0, opts.attempts ?? 2)
  const method = (opts.method || 'GET').toUpperCase()
  const idempotent = method === 'GET' || method === 'DELETE' || method === 'HEAD'
  const wait = opts.wait || sleep

  let last: FetchOutcome = { netError: 'network error' }
  for (let attempt = 0; attempt <= attempts; attempt++) {
    try {
      const res = await run()
      if (res.ok) return { res }
      const retryable = res.status === 429 || (idempotent && res.status >= 500)
        || (!idempotent && res.status === 503)
      if (!retryable || attempt === attempts) return { res }
      last = { res }
      await wait(delayFor(res, attempt))
    } catch (e: any) {
      const netError = e?.name === 'AbortError' ? 'timeout' : (e?.message || 'network error')
      // a drop on a non-idempotent request: cannot retry - it might have gone through
      if (!idempotent || attempt === attempts) return { netError }
      last = { netError }
      await wait(delayFor(null, attempt))
    }
  }
  return last
}
