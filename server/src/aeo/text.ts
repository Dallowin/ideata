/**
 * Text primitives for the AEO core — a port of core/aeo.py, functions `_norm_prompt`,
 * `_variant_re`, `_variant_hit`, `_cyr_words`/`_to_lat`, `_content_words`,
 * `_looks_like_chat`, `_looks_human`, and Python's `round()`.
 *
 * The entire parsing of AI responses rests on these functions: who is mentioned, in
 * what order, what makes it into the prompt panel, and what percentages the client
 * sees. They lie silently — a number on the dashboard looks plausible no matter the
 * result — so what matters here isn't "roughly the same meaning" but byte-for-byte
 * parity with Python. Every value in text.spec.ts was captured by running the actual
 * Python function bodies.
 *
 * WATCH OUT — the main pitfalls of porting Python regex to JS:
 *
 * 1. In JS, `\w` and `\b` are ALWAYS ASCII-only; the `u` flag doesn't change that. In
 *    Python they're Unicode-aware. A naive `re.sub(r"[^\w\s]", ...)` in JS would wipe
 *    out all Cyrillic: "Netologiya, otzyvy 2026!" would turn into "2026". So here
 *    `\w` = `[\p{L}\p{N}_]`, and `\b` around a word is lookarounds:
 *    `(?<![\p{L}\p{N}_])` / `(?![\p{L}\p{N}_])`.
 * 2. JS `\s` and Python `\s` are DIFFERENT sets (JS doesn't know 0x1c-0x1f and 0x85,
 *    but does treat BOM as whitespace). Below, the `PY_SPACE` class replicates
 *    Python's `str.isspace()` character-by-character; it's also used instead of
 *    `.trim()`/`.split()`.
 * 3. Python's `str.isalnum()` is Unicode-aware: `'о'.isalnum()` == True. In JS this is
 *    `/[\p{L}\p{N}]/u.test(ch)`, not `/[a-z0-9]/i`.
 * 4. There's no `re.escape` in JS — hence our own `escapeRe`, which escapes ONLY
 *    syntactic characters (with the `u` flag, a stray `\&` or `\-` is a SyntaxError,
 *    not a no-op).
 * 5. Python's `round()` is banker's rounding (half-to-even), computed on the EXACT
 *    double value: `round(12.5)` == 12, `round(2.675, 2)` == 2.67. `Math.round`/
 *    `toFixed` give 13 and 2.68. We compute via BigInt, see `pyRound`.
 *
 * Where 1:1 parity isn't achievable, it's flagged `DIVERGENCE` on the relevant
 * function.
 */

/** What Python accepts in `str(text or "")`: string, number, bool, None. */
export type PyText = string | number | boolean | null | undefined;

/** (position in string, Latin form) — result of `_cyr_words`. */
export type CyrWord = [pos: number, latin: string];

// ── character classes ───────────────────────────────────────────────────────

/** Python's `\w` = `str.isalnum()` + `_`. Unicode-aware, unlike JS's `\w`. */
const WORD_CLASS = '\\p{L}\\p{N}_';

/**
 * Python's `\s` = `str.isspace()`, character-by-character (verified by iterating
 * 0..0x10FFFF on CPython 3.12). Differs from JS `\s` in both directions, hence our
 * own class.
 */
const PY_SPACE_CLASS =
  '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a' +
  '\\u2028\\u2029\\u202f\\u205f\\u3000';

const ALNUM_CHAR_RE = /[\p{L}\p{N}]/u;
const CYR_WORD_RE = /[а-яё]+/gu;
const PY_SPACE_RUN_RE = new RegExp(`[${PY_SPACE_CLASS}]+`, 'gu');
const PY_SPACE_TRIM_RE = new RegExp(
  `^[${PY_SPACE_CLASS}]+|[${PY_SPACE_CLASS}]+$`,
  'gu',
);
/** `[^\w\s]` from `_norm_prompt`. */
const NON_WORD_NON_SPACE_RE = new RegExp(
  `[^${WORD_CLASS}${PY_SPACE_CLASS}]`,
  'gu',
);
/** `[.!]\s+\S` from `_looks_human`. */
const TWO_SENTENCES_RE = new RegExp(
  `[.!][${PY_SPACE_CLASS}]+[^${PY_SPACE_CLASS}]`,
  'u',
);
/** Maximal runs of word characters — the basis for `\w{3,}`. */
const WORD_RUN_RE = new RegExp(`[${WORD_CLASS}]+`, 'gu');

// ── constants from core/aeo.py ────────────────────────────────────────────────

/** aeo.py:645-650 — letter-by-letter transliteration for matching Russian spellings. */
export const CYR_LAT: Readonly<Record<string, string>> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e',
  ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

/** aeo.py:656 — how short a transliterated-stem match is allowed to be. */
export const TRANSLIT_SLACK = 2;
/** aeo.py:657 — minimum stem length below which we don't check transliteration. */
export const TRANSLIT_MIN = 5;

/**
 * aeo.py:974-977 — words that similarity between prompts can't be measured by: they
 * show up in nearly every query and would glue together completely different
 * prompts.
 */
export const DUP_STOP: ReadonlySet<string> = new Set([
  'как', 'что', 'где', 'для', 'или', 'это', 'чем', 'мне', 'есть',
  'какой', 'какие', 'лучше', 'можно', 'нужно', 'стоит',
  'the', 'and', 'for', 'you', 'are', 'can', 'any', 'what', 'which',
  'with', 'best', 'good', 'some', 'there', 'that', 'how',
]);

/**
 * aeo.py:1460-1486 — strong markers of addressing the assistant (ru+en). We look
 * ANYWHERE in the phrase: people type into chat without punctuation.
 */
export const CHAT_MARKERS: ReadonlySet<string> = new Set([
  // ru
  'как', 'что', 'чем', 'где', 'куда', 'почему', 'зачем', 'сколько', 'кто',
  'какой', 'какая', 'какие', 'какое', 'кому', 'стоит', 'или', 'правда',
  // "ли" — Russian's key interrogative particle: "работает ли оплата картой"
  // (does paying by card work) contains no other question word.
  'ли',
  'посоветуй', 'порекомендуй', 'подскажи', 'найди', 'объясни', 'сравни',
  // Commands to the assistant — half of the live prompts among competitors are
  // phrased this way.
  'проанализируй', 'изучи', 'покажи', 'подбери', 'составь', 'перечисли',
  'расскажи', 'помоги', 'оцени', 'дай',
  'выгоднее', 'лучше', 'безопасно', 'реально', 'нормально',
  // ru: evaluative and comparative — this is NOT a raw keyword.
  'лучшие', 'лучший', 'лучшая', 'лучшее', 'топ', 'рейтинг', 'надёжные',
  'надежные', 'сравнение', 'альтернативы', 'аналоги', 'отзывы', 'дешевле',
  // en
  'what', 'which', 'how', 'where', 'why', 'who', 'when', 'whats', 'vs',
  'versus', 'recommend', 'suggest', 'worth', 'better', 'safe', 'legit',
  'best', 'top', 'rating', 'reliable', 'trusted', 'cheapest', 'fastest',
  'alternative', 'alternatives', 'comparison', 'reviews', 'safest',
  'show', 'list', 'compare', 'analyze', 'give', 'explain',
]);

/**
 * aeo.py:1490-1494 — weak markers: only count if the phrase STARTS with them. In the
 * middle they also show up in plain keywords.
 */
export const CHAT_OPENERS: ReadonlySet<string> = new Set([
  'можно', 'нужно', 'есть', 'могу', 'стоит',
  'is', 'are', 'can', 'do', 'does', 'should', 'could', 'would', 'any',
  'anyone', 'im', 'i', 'looking', 'tell', 'help', 'will',
]);

// ── small utilities of Python semantics ────────────────────────────────────

/**
 * `str(text or "")`.
 *
 * DIVERGENCE: Python's `str()` on a float always prints the fractional part —
 * `str(2026.0)` == "2026.0", while `String(2026.0)` == "2026". This doesn't matter
 * anywhere on the text path (prompts arrive as strings), but if an integer-valued
 * float ever lands here, Python would see an extra "0" token and JS wouldn't.
 */
function pyStr(text: PyText): string {
  if (text === null || text === undefined || text === false || text === '') {
    return '';
  }
  if (text === true) return 'True'; // Python: str(True) == "True"
  if (typeof text === 'number') {
    if (Number.isNaN(text)) return 'nan'; // NaN is truthy in Python, falsy in JS
    if (text === 0) return ''; // both 0 and -0 are falsy in Python
    if (text === Infinity) return 'inf';
    if (text === -Infinity) return '-inf';
    return String(text);
  }
  return text;
}

/** Python's `str.strip()` with no arguments. */
function pyStrip(s: string): string {
  return s.replace(PY_SPACE_TRIM_RE, '');
}

/** Python's `str.split()` with no arguments: on runs of whitespace, dropping empties. */
function pySplit(s: string): string[] {
  const t = pyStrip(s);
  if (!t) return [];
  return t.split(PY_SPACE_RUN_RE);
}

/** Length in code points — Python's `len(str)`. */
export function cpLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1; // surrogate pair = 1 code point
    }
    n += 1;
  }
  return n;
}

/** Slice by code points — Python's `s[:n]`. */
function cpSlice(s: string, n: number): string {
  return Array.from(s).slice(0, n).join('');
}

/** Whether the string has any characters outside the BMP (surrogate pairs). */
const ASTRAL_RE = /[\uD800-\uDBFF]/;

/**
 * Match position on Python's scale: `m.start()` counts CODE POINTS, while
 * `RegExp.index` counts UTF-16 code units, and any emoji to the left of the match
 * throws these numbers off. Positions flow into the brand card's `pos`, so we count
 * the way Python does. In strings without astral characters (99% of responses), the
 * scales agree — there we just bail out immediately.
 *
 * Will be needed by any future chunk of the port where a position from `exec()` is
 * compared against Python's — hence exported.
 */
export function pyIndex(s: string, utf16Index: number): number {
  if (utf16Index <= 0 || !ASTRAL_RE.test(s)) return utf16Index;
  let n = 0;
  for (let i = 0; i < utf16Index; i += 1) {
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    n += 1;
  }
  return n;
}

/**
 * A replacement for `re.escape`. We escape ONLY syntactic characters: with the `u`
 * flag, a stray identity-escape like `\&`, `\~`, `\-` outside a class is a
 * SyntaxError, so "escape everything" the way Python does isn't an option here (and
 * isn't needed either — `&~# ` are literals in the regex as-is).
 */
export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// ── functions ─────────────────────────────────────────────────────────────────

/**
 * `_norm_prompt` (aeo.py:806-810) — normalizes prompt text for dedup: lowercase, no
 * punctuation, collapsed whitespace.
 *
 * The dedup key for the prompt panel and the input to almost every other function in
 * this file.
 */
export function normPrompt(text: PyText): string {
  const s = pyStr(text).toLowerCase().replace(NON_WORD_NON_SPACE_RE, ' ');
  return pyStrip(s.replace(PY_SPACE_RUN_RE, ' '));
}

/** `_to_lat` (aeo.py:660-661) — letter-by-letter transliteration of a Russian word. */
export function toLat(word: string): string {
  let out = '';
  for (const c of word) out += CYR_LAT[c] ?? c;
  return out;
}

/** `_cyr_words` (aeo.py:664-666) — (position, Latin form) for Russian words. */
export function cyrWords(low: string): CyrWord[] {
  const out: CyrWord[] = [];
  for (const m of low.matchAll(CYR_WORD_RE)) {
    out.push([pyIndex(low, m.index ?? 0), toLat(m[0])]);
  }
  return out;
}

const variantReCache = new Map<string, RegExp>();

/**
 * `_variant_re` (aeo.py:670-684) — brand variant → regex with word boundaries.
 *
 * A bare `indexOf` counted a brand as mentioned inside any word: "insane" matched
 * inside "insanely", "notion" inside "notionally", the domain "vc.ru" inside
 * "svc.ru". Every such false hit inflated Visibility and SoV.
 *
 * We only require a boundary where the variant's edge is a word character: for
 * "notion.so" the trailing "o" needs a boundary, while for a variant ending in a dot
 * or hyphen, `\b` there would mean exactly the opposite.
 *
 * Case is NOT ignored — same as Python: the caller already passes `text.lower()`.
 */
export function variantRe(variant: string): RegExp {
  const cached = variantReCache.get(variant);
  if (cached) return cached;
  const chars = Array.from(variant);
  const first = chars.length ? chars[0] : '';
  const last = chars.length ? chars[chars.length - 1] : '';
  const isWordEdge = (ch: string): boolean =>
    ch !== '' && (ALNUM_CHAR_RE.test(ch) || ch === '_');
  const left = isWordEdge(first) ? `(?<![${WORD_CLASS}])` : '';
  const right = isWordEdge(last) ? `(?![${WORD_CLASS}])` : '';
  const re = new RegExp(left + escapeRe(variant) + right, 'u');
  // Python's lru_cache(maxsize=2048); a crude clear is good enough here.
  if (variantReCache.size >= 2048) variantReCache.clear();
  variantReCache.set(variant, re);
  return re;
}

/**
 * `_variant_hit` (aeo.py:687-704) — position of the first variant occurrence, or -1.
 *
 * Latin variants are matched on word boundaries (see `variantRe`). Russian words are
 * matched against the transliterated STEM — and only those: you can't truncate the
 * stem for Latin variants, or "courses" in an English response would count as a hit
 * for Coursera.
 *
 * Position is in CODE POINTS, like Python's `m.start()` (see `pyIndex`).
 */
export function variantHit(
  low: string,
  cyr: readonly CyrWord[],
  variant: string,
): number {
  const m = variantRe(variant).exec(low);
  let idx = m ? pyIndex(low, m.index) : -1;
  const len = cpLength(variant);
  if (len < TRANSLIT_MIN) return idx;
  const stem = cpSlice(variant, Math.max(TRANSLIT_MIN, len - TRANSLIT_SLACK));
  for (const [pos, word] of cyr) {
    if (word.startsWith(stem) && (idx === -1 || pos < idx)) {
      idx = pos;
      break;
    }
  }
  return idx;
}

/**
 * `_content_words` (aeo.py:988-998) — meaningful prompt words, coarsened to a stem
 * (first 4 characters).
 *
 * Without coarsening, the rephrase filter fails on case and number: "site" ≠
 * "sites", «сайты» ≠ «сайтов» (Russian: "sites" ≠ "of sites").
 */
export function contentWords(text: PyText): Set<string> {
  const out = new Set<string>();
  for (const w of pySplit(normPrompt(text))) {
    if (cpLength(w) >= 3 && !DUP_STOP.has(w)) out.add(cpSlice(w, 4));
  }
  return out;
}

/**
 * `re.findall(r"\w{3,}", text.lower())` (aeo.py:1214 and 1247) — word tokens of
 * three or more characters. The site's vocabulary and the filter for keywords from
 * unrelated industries.
 *
 * We take maximal runs of word characters and drop short ones: this is exactly what
 * a greedy `\w{3,}` does, except we count length in code points rather than UTF-16
 * units (otherwise a pair of astral characters would pass as "three characters").
 */
export function contentTokens(text: PyText): string[] {
  const s = pyStr(text).toLowerCase();
  const out: string[] = [];
  for (const m of s.matchAll(WORD_RUN_RE)) {
    if (cpLength(m[0]) >= 3) out.push(m[0]);
  }
  return out;
}

/**
 * `_looks_like_chat` (aeo.py:1497-1514) — addressed to the assistant, rather than a
 * search-engine query.
 *
 * On "buy a virtual PBX" the model answers like a search engine — links and ads —
 * while on "recommend a PBX for a sales department" it names specific services.
 * Measuring visibility makes sense on the latter.
 *
 * DIVERGENCE: Python checks `"?" in text` on the ORIGINAL object and raises
 * TypeError if it's not a string (it doesn't raise for None — the empty
 * `_norm_prompt` exit fires first). Here, instead of an exception, we apply the same
 * string conversion as in `normPrompt`.
 */
export function looksLikeChat(text: PyText): boolean {
  const t = normPrompt(text);
  if (!t) return false;
  if (pyStr(text).includes('?')) return true;
  const words = pySplit(t);
  for (const w of words) if (CHAT_MARKERS.has(w)) return true;
  return CHAT_OPENERS.has(words[0]);
}

/**
 * `_looks_human` (aeo.py:1426-1450) — whether this looks like a string a human
 * would type into chat.
 *
 * Model instructions aren't enough: in a sample, a third of prompts came as TWO
 * questions in a row, and the average length was 9.6 words against a real 3-6.
 * We filter by form, not meaning: two question marks, two sentences joined by a
 * period, a long tail.
 */
export function looksHuman(text: PyText): boolean {
  const t = pyStrip(pyStr(text));
  if (!t) return false;
  let questions = 0;
  for (const ch of t) if (ch === '?') questions += 1;
  if (questions > 1) return false; // two questions in one line
  if (TWO_SENTENCES_RE.test(t)) return false; // two sentences
  if (!looksLikeChat(t)) return false;
  const words = pySplit(t).length;
  return words >= 3 && words <= 14;
}

// ── banker's rounding ───────────────────────────────────────────────────

/** Decompose a double into exact m and e: |x| == m * 2^e. */
function decomposeDouble(x: number): { m: bigint; e: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const hi = view.getUint32(0);
  const lo = view.getUint32(4);
  const rawExp = (hi >>> 20) & 0x7ff;
  const frac = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  // Denormalized: exponent is fixed, no implicit leading bit.
  if (rawExp === 0) return { m: frac, e: -1074 };
  return { m: frac | (1n << 52n), e: rawExp - 1075 };
}

/**
 * Python's `round()` — banker's rounding (half-to-even) on the EXACT double value.
 *
 * Every AEO metric (`round(100 * v[0] / v[1])`, `round(sum(ps)/len(ps), 1)`,
 * `round(b - a, 2)`) uses exactly this, and a naive `Math.round` diverges on every
 * .5: `round(12.5)` in Python == 12, `Math.round(12.5)` == 13. At denominators of 8,
 * 16, 24 these halves come up constantly, so this isn't an edge case — it's a
 * systematic one-point shift in every percentage.
 *
 * `toFixed` doesn't work either: it rounds halves away from zero. So we compute
 * exactly, via BigInt: `q = round_half_even(|x| * 10^ndigits)`, then assemble a
 * decimal string and parse it back — the same way CPython does via
 * `_Py_dg_dtoa(mode 3)` + `strtod`.
 *
 * @param x       the number to round
 * @param ndigits decimal places; if omitted, behaves like Python's `round(x)` with a
 *                single argument, i.e. returns an integer (and never "minus zero")
 */
export function pyRound(x: number, ndigits?: number): number {
  // Python raises OverflowError/ValueError on inf/nan; for metrics it's more useful
  // to pass the value through transparently than to blow up the whole analysis.
  if (!Number.isFinite(x)) return x;
  const n = ndigits === undefined ? 0 : Math.trunc(ndigits);
  // Above 1100 digits doubles can't distinguish further; below -400 it's a guaranteed zero.
  if (n > 1100) return x;
  if (n < -400) return Object.is(x, -0) || x < 0 ? -0 : 0;

  const negative = Object.is(x, -0) || x < 0;
  const { m, e } = decomposeDouble(x);
  let num = m;
  let den = 1n;
  if (e >= 0) num <<= BigInt(e);
  else den <<= BigInt(-e);
  if (n >= 0) num *= 10n ** BigInt(n);
  else den *= 10n ** BigInt(-n);

  let q = num / den;
  const rest = num % den;
  const twice = rest * 2n;
  if (twice > den) q += 1n;
  else if (twice === den && q % 2n === 1n) q += 1n; // tie → round to even

  if (ndigits === undefined) {
    // Python returns an int: there's no "minus zero" here.
    if (q === 0n) return 0;
    return negative ? -Number(q) : Number(q);
  }

  const sign = negative ? '-' : '';
  let body: string;
  if (n > 0) {
    const digits = q.toString().padStart(n + 1, '0');
    body = `${digits.slice(0, digits.length - n)}.${digits.slice(digits.length - n)}`;
  } else if (n === 0) {
    body = q.toString();
  } else {
    body = q === 0n ? '0' : q.toString() + '0'.repeat(-n);
  }
  // Number(string) in JS parses with correctly-rounded semantics — like strtod.
  return Number(`${sign}${body}`);
}
