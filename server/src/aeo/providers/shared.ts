/**
 * Shared bits of the AEO providers layer (port of helper functions from
 * scrapper/core/{kie,openrouter,gigachat,yandex_ai}.py). Only pure field-extraction
 * code from the response envelope lives here — no network. The "who was mentioned /
 * cited by what" dashboard rests on these functions, so parity with Python matters,
 * not just "the same meaning": the Python clients hand back res with the same
 * canonical citation shape `[{url,title}]`, and we reproduce the order/dedup/title
 * slicing byte-for-byte.
 */
import { isDict, pyStrip, pyStrOrEmpty, type CiteItem } from '../parse';

/**
 * Pure core of the provider response parser: envelope (JSON body) → structure.
 * `citations` are already canonicalized via `citeItems` (parse.ts) — the same
 * format as Python's `_res_cites`. `tokensIn/tokensOut` are null wherever the
 * provider doesn't return tokens (Neuro, AI Overviews: they have a fixed price
 * per request).
 */
export interface ParsedAnswer {
  text: string;
  citations: CiteItem[];
  tokensIn: number | null;
  tokensOut: number | null;
}

/** The engine's outward-facing answer (like Python's `ask_platform`): text + citations. */
export interface EngineAnswer {
  text: string;
  citations: CiteItem[];
}

/** Raw source before dedup: url/title as returned by the provider (usually strings). */
export interface RawSource {
  url?: unknown;
  title?: unknown;
}

/**
 * Python's `_int` (kie.py:281 / openrouter.py:199 / yandex_ai.py:166):
 * `int(v) if v is not None else None`, None on error. Python's `int()`
 * truncates a float toward zero and parses numeric strings; here
 * `Math.trunc(Number(v))` has the same failure modes, falling back to null on
 * a non-number.
 */
export function intOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  // Empty/whitespace string: Number('') === 0, but Python's int('') raises
  // ValueError → None. Don't let "no data" turn into zero tokens.
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.trunc(n);
}

/**
 * Python's `(x or "").strip()` over message content, where `x` may be a list
 * of parts (some models split `content` into pieces: openrouter.py:89,
 * gigachat.py:133). List → `" ".join(str((c or {}).get("text") or ""))`;
 * scalar → `str(x or "")`; then `.strip()` (Python's whitespace set).
 */
export function joinContent(content: unknown): string {
  if (Array.isArray(content)) {
    const parts = content.map((c) => {
      const t = isDict(c) ? (c as Record<string, unknown>).text : undefined;
      return t ? String(t) : ''; // (c or {}).get("text") or ""
    });
    return pyStrip(parts.join(' '));
  }
  return pyStrip(pyStrOrEmpty(content));
}

/**
 * Python's `_dedup_sources` (kie.py:101 / openrouter.py:57): dedup sources by
 * URL, preserving order; the title is taken from the FIRST occurrence where
 * it's non-empty (the same URL can arrive both bare and with a title).
 * URL/title are normalized with Python's `str(x or "").strip()`
 * (pyStrOrEmpty + pyStrip). Entries without a URL are dropped. Returns the
 * canonical `[{url,title}]`.
 */
export function dedupSources(srcs: readonly RawSource[]): CiteItem[] {
  const seen = new Map<string, CiteItem>();
  const out: CiteItem[] = [];
  for (const s of srcs) {
    const u = pyStrip(pyStrOrEmpty(s.url)); // (s.get("url") or "").strip()
    if (!u) continue;
    const prev = seen.get(u);
    if (prev) {
      // Python: if not seen[u]["title"] and s.get("title"): seen[u]["title"] = str(s["title"]).strip()
      if (!prev.title && s.title) prev.title = pyStrip(String(s.title));
      continue;
    }
    const row: CiteItem = { url: u, title: pyStrip(pyStrOrEmpty(s.title)) };
    seen.set(u, row);
    out.push(row);
  }
  return out;
}

/**
 * Dedup sources → canonical `[{url,title}]` (port of Python's `_res_cites`:
 * cite_items(sources)). `dedupSources` already produces a clean canonical form
 * (url/title via pyStrOrEmpty+pyStrip, entries without a URL dropped) — exactly
 * what `cite_items` would return on top of it, so we don't re-canonicalize.
 */
export function citationsFrom(srcs: readonly RawSource[]): CiteItem[] {
  return dedupSources(srcs);
}
