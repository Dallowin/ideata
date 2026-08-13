/**
 * A thin wrapper over `fetch` reproducing the shape of `httpx.get(url, params=…)`
 * from the Python adapters (meta_ads / social / entity_kg): GET with query
 * params, a timeout via AbortController, returning `{status, body}` or `null` on
 * any network failure / non-JSON body. Tests NEVER touch the network - every
 * collector accepts `get?: HttpGet` and is handed a mock; the default
 * `makeFetchGet` lives here and is not exercised by unit tests (same as the
 * injected `get` in crawlHomepage).
 *
 * SSRF: the real transports pass the address through checkPublicHttpsUrl (the
 * same gate as in crawlHomepage) - a public https host with a dot, while
 * private/link-local networks are rejected. The RapidAPI/proxy host comes from
 * admin settings, but we keep the gate on it too (defense in depth): a typo in
 * the host must not send the request into the internal network.
 */
import { checkPublicHttpsUrl } from '../blogwriter/server/utils/safeUrl';

/** Transport response: HTTP status + already parsed body (or a null body). */
export interface JsonResp {
  status: number;
  body: unknown;
}

/** Text transport response: HTTP status + raw body as a string (RSS/SERP XML). */
export interface TextResp {
  status: number;
  text: string;
}

/**
 * Build a query string from a flat dict of scalars (like httpx `params=`):
 * null/undefined values are skipped, everything else goes through String().
 */
function toQuery(url: string, params?: Record<string, unknown> | null): string {
  if (!params || !Object.keys(params).length) return url;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined) continue;
    qs.append(k, String(v));
  }
  const q = qs.toString();
  if (!q) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}${q}`;
}

/**
 * SSRF gate: the URL without its query must pass checkPublicHttpsUrl (a public
 * https host with a dot; private/link-local networks are rejected). Returns
 * true|false.
 */
function isPublicHttps(url: string): boolean {
  const base = url.split('?')[0];
  return checkPublicHttpsUrl(base).ok;
}

/**
 * Injectable transport. `params` is a flat dict of scalars (as in httpx) that is
 * turned into a query string; a null body is returned when the response is not
 * JSON. A `null` result as a whole is the Python "caught an Exception" case (the
 * request never went out / timed out).
 */
export type HttpGet = (
  url: string,
  params?: Record<string, unknown> | null,
) => Promise<JsonResp | null>;

/** Build the default JSON GET transport with the given timeout and headers. */
export function makeFetchGet(opts: {
  timeoutMs: number;
  headers?: Record<string, string>;
}): HttpGet {
  return async (url, params) => {
    const full = toQuery(url, params);
    if (!isPublicHttps(full)) return null; // SSRF gate: not a public https URL -> None
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    try {
      const res = await fetch(full, {
        method: 'GET',
        headers: opts.headers,
        signal: ac.signal,
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null; // non-JSON body - the caller decides (usually -> a null result)
      }
      return { status: res.status, body };
    } catch {
      return null; // request never went out / timeout / abort - the Python except -> None
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Injectable text transport: GET, with the body returned as a STRING (RSS/SERP
 * serve XML, not JSON). A `null` result as a whole is the Python "caught an
 * Exception" case.
 */
export type HttpGetText = (
  url: string,
  params?: Record<string, unknown> | null,
) => Promise<TextResp | null>;

/** Build the default text GET transport (for Google News RSS / SERP XML). */
export function makeFetchGetText(opts: {
  timeoutMs: number;
  headers?: Record<string, string>;
  followRedirects?: boolean;
}): HttpGetText {
  return async (url, params) => {
    const full = toQuery(url, params);
    if (!isPublicHttps(full)) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    try {
      const res = await fetch(full, {
        method: 'GET',
        headers: opts.headers,
        redirect: opts.followRedirects === false ? 'manual' : 'follow',
        signal: ac.signal,
      });
      let text = '';
      try {
        text = await res.text();
      } catch {
        text = '';
      }
      return { status: res.status, text };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Injectable JSON POST transport: the request body is JSON and the response is
 * parsed JSON (Yandex Search API, RapidAPI proxy). A `null` result as a whole is
 * the "caught an Exception" case.
 */
export type HttpPostJson = (
  url: string,
  jsonBody: unknown,
  headers?: Record<string, string>,
) => Promise<JsonResp | null>;

/** Build the default JSON POST transport with a timeout and the SSRF gate. */
export function makeFetchPostJson(opts: { timeoutMs: number }): HttpPostJson {
  return async (url, jsonBody, headers) => {
    if (!isPublicHttps(url)) return null;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(headers || {}) },
        body: JSON.stringify(jsonBody),
        signal: ac.signal,
      });
      let body: unknown = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      return { status: res.status, body };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
