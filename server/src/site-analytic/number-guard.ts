/**
 * Deterministic "number-guard" of the LLM layer — a port of core/aa_agents.py:44-126
 * (build_digest / _collect_numbers / allowed_numbers / _texts_of /
 * numbers_violations) plus the `_checked` post-check (aa_agents.py:434-447).
 *
 * The anti-hallucination guard of AI-Analytic-Spec: numbers reach agent prompts
 * ONLY from the facts digest; on the way out a "large" number (>=1000) must be
 * present in the allowed set, otherwise the item is dropped. This part is pure
 * (no network/LLM) — verified byte-for-byte against live Python (see
 * number-guard.parity.spec.ts against number-guard.golden.json).
 *
 * PARITY PITFALLS, verified against the oracle:
 *   • `int(round(obj))` — banker's rounding (pyRound), not Math.round; same for
 *     round(n,-2/-3/-4) (negative ndigits) and round(n/1000);
 *   • `_NUM_RE` is greedy: a chain of digits/spaces/dots/commas with no letter in
 *     between glues into a SINGLE token ("5000 7777 7777" → 500077777777) — the
 *     regex is ported CHARACTER-FOR-CHARACTER, class `[\d\s .,]`;
 *   • `12.300`/`12,300` (ru thousands separator, fullmatch \d{1,3}\.\d{3}) →
 *     int(float×1000); anything else → int(float), ValueError (NaN) → skipped;
 *   • `_texts_of` scans ONLY string values — a number stored as a number in the
 *     JSON (impact/effort) is not checked;
 *   • `.get()` yields None (here null, not undefined), otherwise the field would
 *     drop out of the JSON and the digest parity would diverge.
 */
import { get, isDict, pyOr, pyRound } from './pyhelpers';

// ── facts digest (the only source of numbers for prompts) ────────────────────

/** A single topKeywords entry (build_digest, aa_agents.py:58-60). */
interface DigestKw {
  kw: unknown;
  vol: unknown;
  pos: unknown;
  intent: unknown;
}

/**
 * `build_digest` (aa_agents.py:44-70). A compact digest of the facts + up to 150
 * raw keywords — the only thing that goes into agent prompts. `null` (not
 * undefined) in place of missing fields: otherwise the field would drop out of
 * the JSON and the comparison with the oracle (where `.get()` yields None) would
 * not match.
 */
export function buildDigest(
  facts: Record<string, unknown>,
  rawKeywords?: unknown[] | null,
): Record<string, unknown> {
  const kws = rawKeywords || [];
  const meta = pyOr(get(facts, 'meta'), {} as Record<string, unknown>);
  const slice = (key: string, n: number): unknown[] =>
    (pyOr(get(facts, key), []) as unknown[]).slice(0, n);

  const topKeywords: DigestKw[] = (slice('keywords', 12) as unknown[]).map((k) => ({
    kw: get(k, 'kw'),
    vol: get(k, 'vol'),
    pos: get(k, 'pos'),
    intent: get(k, 'intent'),
  }));
  const ads = slice('ads', 4); // (… or [])[:4] or None
  const keywordsSample = (kws.slice(0, 150) as unknown[]).map((k) => ({
    kw: get(k, 'keyword'),
    vol: get(k, 'volume'),
  }));

  return {
    domain: get(meta, 'domain'),
    visits: get(facts, 'visits'),
    growthPct: get(facts, 'growthPct'),
    authority: get(facts, 'authority'),
    kwTotal: get(facts, 'kwTotal'),
    refDomains: get(facts, 'refDomains'),
    backlinksTotal: get(facts, 'backlinksTotal'),
    spamScore: get(facts, 'spamScore'),
    sources: get(facts, 'sources'),
    geo: slice('geo', 5),
    intents: get(facts, 'intents'),
    topKeywords,
    topPages: slice('topPages', 5),
    competitors: slice('competitors', 5),
    gapRows: slice('gapRows', 8),
    tech: get(facts, 'tech'),
    perfScore: get(facts, 'perfScore'),
    ads: ads.length ? ads : null,
    crawl: get(facts, 'crawl'),
    keywordsSample,
  };
}

// ── allowed-number set ────────────────────────────────────────────────────────

/** `_collect_numbers` (aa_agents.py:77-93): recursive walk + roundings. */
function collectNumbers(obj: unknown, out: Set<number>): void {
  if (isDict(obj)) {
    for (const v of Object.values(obj)) collectNumbers(v, out);
  } else if (Array.isArray(obj)) {
    for (const v of obj) collectNumbers(v, out);
  } else if (typeof obj === 'number' && Number.isFinite(obj)) {
    // isinstance(x,(int,float)) and not bool — a JS bool is not 'number', so it is cut off.
    const n = pyRound(obj); // int(round(obj)) — banker's rounding to an integer
    out.add(n);
    const abs = Math.abs(n);
    for (const base of [100, 1000, 10000]) {
      // round(n, -len(str(base))+1) if base <= abs(n) else n
      out.add(base <= abs ? pyRound(n, -String(base).length + 1) : n);
    }
    if (abs >= 1000) {
      out.add(pyRound(n / 1000)); // "in thousands"
      out.add(pyRound(n / 1000) * 1000);
    }
  }
}

/** `allowed_numbers` (aa_agents.py:96-99): every digest number + its roundings. */
export function allowedNumbers(digest: unknown): Set<number> {
  const out = new Set<number>();
  collectNumbers(digest, out);
  return out;
}

// ── number post-check ─────────────────────────────────────────────────────────

/** `_NUM_RE` (aa_agents.py:74) — greedy chain of digits/spaces/dots/commas. */
const NUM_RE = /\d[\d\s .,]*\d|\d/g;

/** `_texts_of` (aa_agents.py:102-107): concatenation of string leaves ONLY. */
function textsOf(obj: unknown): string {
  if (isDict(obj)) return Object.values(obj).map(textsOf).join(' ');
  if (Array.isArray(obj)) return obj.map(textsOf).join(' ');
  return typeof obj === 'string' ? obj : '';
}

/**
 * `numbers_violations` (aa_agents.py:110-126): "large" (>=1000) numbers from
 * TEXTS that are absent from the allowed set. Small ones (step counts, percents,
 * impact/effort) are not checked — reasoning legitimately produces them.
 */
export function numbersViolations(obj: unknown, allowed: Set<number>): number[] {
  const bad: number[] = [];
  for (const m of textsOf(obj).matchAll(NUM_RE)) {
    // re.sub(r"[\s ]", "", tok) — strip spaces (incl. non-breaking U+00A0), then , → .
    const tok = m[0].replace(/[\s ]/g, '').replace(/,/g, '.');
    let n: number;
    if (/^\d{1,3}\.\d{3}$/.test(tok)) {
      n = Math.trunc(Number(tok) * 1000); // '12.300' — ru thousands separator
    } else {
      const f = Number(tok);
      if (!Number.isFinite(f)) continue; // float() ValueError → skip
      n = Math.trunc(f);
    }
    if (Math.abs(n) >= 1000 && !allowed.has(n) && !bad.includes(n)) bad.push(n);
  }
  return bad;
}

/**
 * `_checked` (aa_agents.py:434-447): number post-check; violators are dropped
 * ITEM BY ITEM (a list), not wholesale. None → None; a clean object → itself; a
 * list with violators → filtered (empty → null); a non-list with violators → null.
 */
export function filterViolations<T>(obj: T, allowed: Set<number>): T | null {
  if (obj === null || obj === undefined) return null;
  if (numbersViolations(obj, allowed).length === 0) return obj;
  if (Array.isArray(obj)) {
    const kept = obj.filter((it) => numbersViolations(it, allowed).length === 0);
    return (kept.length ? (kept as unknown as T) : null);
  }
  return null;
}
