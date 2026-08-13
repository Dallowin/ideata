/**
 * Shared limits for the handlers that rewrite HTML SUBMITTED by the client
 * (ai-edit, antislop/rewrite, factfix).
 *
 * Each of them used to compute maxTokens from the request body length with no
 * cap: the body is controlled by the client, and so was the LLM bill — a
 * megabyte-sized "article" turned into a single request for hundreds of
 * thousands of tokens. Hence two limits working together:
 *   • input is truncated at MAX_EDIT_HTML — long text is edited in chunks;
 *   • output is capped at MAX_EDIT_TOKENS, kept in sync with the input, so an
 *     accepted request doesn't get cut off mid-word.
 */
export const MAX_EDIT_HTML = 20_000
export const MAX_EDIT_TOKENS = 8_000

/** Cap on maxTokens for a specific fragment: half its length plus a margin, capped at the ceiling. */
export function editMaxTokens(html: string, extra = 2000): number {
  return Math.min(Math.floor((html || '').length / 2) + extra, MAX_EDIT_TOKENS)
}

/** Message about an input that's too long (shared across all handlers). */
export function tooLongMessage(what = 'fragment'): string {
  return `${what} is too large (> ${MAX_EDIT_HTML} characters) — apply the edit to part of the text`
}
