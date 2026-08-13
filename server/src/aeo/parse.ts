/**
 * AEO run parsers — a port of core/aeo.py, the "extract structured fields from
 * the AI response" layer (not an LLM, pure code). Functions:
 *   - `_brand_variants`  (aeo.py:616-636)  → brandVariants
 *   - `parse_brands`     (aeo.py:707-722)  → parseBrands
 *   - `cite_items`       (aeo.py:731-745)  → citeItems
 *   - `classify_citation`(aeo.py:753-770)  → classifyCitation
 *   - `_host`            (aeo.py:285-290)  → host  (shared with aggregate.ts)
 * plus Python-semantics helpers (`isDict`, `pyStrip`, `pyStrOrEmpty`, `cmpStr`)
 * and the host lists (aeo.py:256-267). This is the CANONICAL home of these
 * functions: aggregate.ts imports them from here rather than keeping a second
 * copy (especially the `host` urlsplit logic, whose parity with CPython is
 * delicate — see below).
 *
 * The "who's mentioned / who's cited" dashboards rest on these functions. They
 * lie silently when wrong, so byte-for-byte parity with Python matters, not
 * "same meaning". Every value in parse.parity.spec.ts was captured by running
 * the real core/aeo.py against real aeo_answers responses.
 *
 * MAIN PORTING PITFALLS (each with a core/aeo.py line reference):
 *
 * 1. `\w`/`\b` in JS are ALWAYS ASCII, and the `u` flag doesn't change that;
 *    in Python they're Unicode-aware. Anything that looks for brand variants
 *    goes through `variantHit`/`variantRe` from text.ts (there `\w`=
 *    `[\p{L}\p{N}_]`, `\b`=lookaround). A Cyrillic alias ("озон") is caught in
 *    "— озон," but NOT in "розонный" — exactly like \b in CPython
 *    (aeo.py:687-704).
 * 2. Brand ordering: `parse_brands` builds `firsts=[(min_pos, brand)]` and
 *    does `firsts.sort()` — a sort of (pos, brand) TUPLES. On equal position,
 *    Python compares the brand STRING (not input-list order!), by code point.
 *    Reproduced via `cmpStr` as the comparator's second key (aeo.py:721).
 * 3. `re.escape` + Cyrillic stemming (`_TRANSLIT_MIN=5`, `_TRANSLIT_SLACK=2`)
 *    — all inside `variantHit` from text.ts (aeo.py:687-704).
 * 4. CPython urlsplit in `host`: lstrip C0-control+space, strip \t\r\n,
 *    scheme recognition (must START with an ASCII letter: '3://'/'+x://' is
 *    NOT a scheme), `//`-netloc, ValueError on unbalanced IPv6 brackets, on a
 *    bracketed host that isn't IPv6/IPvFuture (IPv4 in brackets too), and on
 *    non-ASCII netloc where NFKC introduces `/?#@:` — all of it → "" (via
 *    aeo.py:285-290's urlparse; CPython `_check_bracketed_host`/`_checknetloc`).
 * 5. `str(x or "")` / empty fields are dropped BEFORE coercion: `cite_items`
 *    discards entries without a URL and non-str/non-dict junk (aeo.py:731-745).
 *    `str()` of a non-string is Python's, not JS's: bool → `True`/`False`,
 *    container → Python `repr` (not `[object Object]`/`a,b`). Citation
 *    iteration follows Python's `for c in (raw or [])`: `{}`/`""`/`0` → [],
 *    not a throw.
 */
import { isIPv6 } from 'node:net';
import { variantHit, cyrWords, cpLength, type CyrWord } from './text';
import { PyFloat } from './pyjson';
import type { CitationRaw } from './aggregate.types';

// ── Python semantics helpers (shared with aggregate.ts) ──────────────────────

/** `isinstance(x, dict)` — a plain object (not an array, not null). */
export function isDict(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Python `str.isspace()` whitespace set (verified against CPython in text.ts).
 * Needed for `str.strip()` inside `_brand_variants`/`cite_items` — JS `.trim()`
 * knows a different character set.
 */
const PY_SPACE_CLASS =
  '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a' +
  '\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE_CLASS}]+|[${PY_SPACE_CLASS}]+$`, 'gu');

/** Python `str.strip()` with no arguments. */
export function pyStrip(s: string): string {
  return s.replace(PY_STRIP_RE, '');
}

/**
 * Python truthiness of the `x or ""` operand (Python `bool(x)`): falsy is
 * None/False/0/0.0/"" AND EMPTY containers `[]`/`{}`. So you can't just write
 * `!v`: for an empty dict `!{}` == false, but Python `{} or ""` == "".
 * PyFloat(0.0) is also falsy.
 */
function pyFalsy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '') return true;
  if (typeof v === 'number') return v === 0; // 0 and -0
  if (v instanceof PyFloat) return v.value === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (isDict(v)) return Object.keys(v).length === 0;
  return false;
}

/**
 * Python `repr(str)` — the form `str(list/dict)` uses to print NESTED strings
 * (a container prints each element via repr). Quote choice matches CPython:
 * `'` by default, but if the string contains `'` and no `"`, use `"` (to
 * avoid escaping). We escape `\`, the quote itself, `\t\n\r`; C0/DEL control
 * characters become `\xHH`. Printable characters (including Cyrillic, any
 * non-ASCII letter) are emitted as-is.
 *
 * KNOWN GAP: `\xHH`/`\uHHHH` escaping of non-printable non-ASCII (C1, Cf,
 * line/paragraph separators, unassigned) is not reproduced — the same seam
 * as `str.isprintable()` in text.ts, which depends on the Unicode engine
 * version (ICU in Node vs unicodedata in Python). Such characters don't occur
 * in url/title/alias data.
 */
function pyStrRepr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = q;
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === q || ch === '\\') out += '\\' + ch;
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (cp < 0x20 || cp === 0x7f) out += '\\x' + cp.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + q;
}

/** Python `repr(float)`: an integer-valued float prints a trailing `.0`. */
function pyFloatRepr(v: number): string {
  if (Number.isNaN(v)) return 'nan';
  if (v === Infinity) return 'inf';
  if (v === -Infinity) return '-inf';
  const s = String(v);
  return /[.eE]/.test(s) ? s : s + '.0'; // 2 → "2.0", 1.5 → "1.5", 1e21 → "1e+21"
}

/**
 * Python `repr(x)` for JSON/pyParse values (recurses into containers). A bare
 * `number` prints as a Python int (no `.0`) — only `PyFloat` from pyParse
 * carries the float marker; in production the float flag is already erased
 * at the JS boundary (see pyjson.ts), so the int form is correct.
 */
function pyRepr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (v instanceof PyFloat) return pyFloatRepr(v.value);
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'nan';
    if (v === Infinity) return 'inf';
    if (v === -Infinity) return '-inf';
    return String(v);
  }
  if (typeof v === 'string') return pyStrRepr(v);
  if (Array.isArray(v)) return '[' + v.map(pyRepr).join(', ') + ']';
  if (isDict(v)) {
    return (
      '{' +
      Object.entries(v)
        .map(([k, val]) => pyStrRepr(k) + ': ' + pyRepr(val))
        .join(', ') +
      '}'
    );
  }
  return String(v); // unreachable for JSON/pyParse values
}

/** Python `str(x)`: a string is itself (no quotes), anything else is `repr(x)`. */
function pyStr(v: unknown): string {
  return typeof v === 'string' ? v : pyRepr(v);
}

/**
 * `str(x or "")` — Python's string conversion with falsy values falling
 * through `or` into "". In `cite_items`/`_brand_variants` url/title/alias are
 * usually strings (fast path `str → str`), but Python's `str()` of a
 * non-string prints via `repr`: bool → `True`/`False`, container → Python
 * `repr` (NOT JS `String()`: a dict would give `[object Object]`, a list —
 * `a,b`). Hence `pyStr`/`pyRepr`.
 */
export function pyStrOrEmpty(v: unknown): string {
  return pyFalsy(v) ? '' : pyStr(v);
}

/** Whether a string has a surrogate code unit (an astral character). */
const HAS_SURROGATE_RE = /[\uD800-\uDFFF]/;

/**
 * A stable string comparator matching Python's `sorted`: compares by CODE
 * POINT. JS's `<` operator compares by UTF-16 code UNIT, which diverges from
 * Python on astral characters. For strings without surrogates (99.99% — id,
 * platform, domain, date strings) the two orderings agree, so we take the
 * fast path through `<`.
 */
export function cmpStr(a: string, b: string): number {
  if (a === b) return 0;
  if (!HAS_SURROGATE_RE.test(a) && !HAS_SURROGATE_RE.test(b)) {
    return a < b ? -1 : 1;
  }
  const ai = Array.from(a); // split into code points
  const bi = Array.from(b);
  const n = Math.min(ai.length, bi.length);
  for (let k = 0; k < n; k += 1) {
    const ca = ai[k].codePointAt(0)!;
    const cb = bi[k].codePointAt(0)!;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
  return ai.length < bi.length ? -1 : ai.length > bi.length ? 1 : 0;
}

// ── _host: port of urlparse(url).netloc + strip("www.") (aeo.py:285-290) ─────

const SCHEME_CHARS =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+-.';

/** ASCII letter: CPython `url[0].isascii() and url[0].isalpha()` (see urlsplit). */
function isAsciiAlpha(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/**
 * CPython `_check_bracketed_host` (urllib.parse): a bracketed host must be a
 * valid IPv6 or IPvFuture (`v<hex>.<...>`, lowercase `v`); otherwise —
 * including IPv4 in brackets, empty, bad hex — ValueError. `ip_address` is
 * replaced with `net.isIPv6` (matches Python's `ipaddress` on every case
 * checked: `::1`/`2001:db8::1` ok, `notipv6`/`1.2.3.4`/``/`gggg::` — not).
 */
function checkBracketedHost(bh: string): void {
  if (bh.startsWith('v')) {
    if (!/^v[0-9a-fA-F]+\..+$/.test(bh)) throw new Error('invalid IPvFuture host');
  } else if (!isIPv6(bh)) {
    throw new Error('invalid bracketed host');
  }
}

/**
 * CPython `_checknetloc` (urllib.parse): a non-ASCII netloc is NFKC-normalized
 * (after stripping any `@:#?` already present), and if normalization
 * INTRODUCES any of `/?#@:` — ValueError. Catches fullwidth solidus
 * U+FF0F→'/', ℀ U+2100→'a/c', ℅ U+2105→'c/o', fullwidth colon U+FF1A→':'. An
 * ASCII netloc is left untouched.
 */
function checkNetloc(netloc: string): void {
  if (!netloc || !/[^\x00-\x7f]/.test(netloc)) return; // empty or all-ASCII
  const n = netloc.replace(/[@:#?]/g, '');
  const norm = n.normalize('NFKC');
  if (n === norm) return;
  for (const c of '/?#@:') if (norm.includes(c)) throw new Error('invalid netloc under NFKC');
}

/**
 * Python's `urlsplit(url).netloc`: strip tab/cr/nl, cut off a valid scheme up
 * to the first ':', and if the remainder starts with '//', return the chunk
 * up to the nearest of '/', '?', '#' (mirrors `_splitnetloc`). Without '//'
 * netloc is empty.
 */
function urlsplitNetloc(url: string): string {
  // CPython 3.12 urlsplit, step 1: url.lstrip(_WHATWG_C0_CONTROL_OR_SPACE) —
  // strip leading C0-control and space (U+0000..U+0020). A leading byte like
  // U+0001 survives str.strip() in cite_items (isspace(U+0001) == False), but
  // urlsplit strips it and then recognizes the scheme; without this step the
  // scheme isn't recognized and netloc ends up empty.
  let u = url.replace(/^[\x00-\x20]+/, '');
  // step 2: remove \t\r\n from the whole string (_UNSAFE_URL_BYTES_TO_REMOVE).
  u = u.replace(/[\t\r\n]/g, '');
  // step 3: strip the SCHEME. CPython requires the scheme to START with an
  // ASCII letter (`url[0].isascii() and url[0].isalpha()`), not merely
  // consist of scheme characters: '3://host' / '+x://host' are NOT a scheme
  // to Python → the remainder doesn't start with '//' → netloc="" →
  // _host="". Without the alpha gate, the port would strip '3'/'+x' as a
  // scheme and yield 'host'.
  const i = u.indexOf(':');
  if (i > 0 && isAsciiAlpha(u[0])) {
    let scheme = true;
    for (let k = 1; k < i; k += 1) {
      if (!SCHEME_CHARS.includes(u[k])) {
        scheme = false;
        break;
      }
    }
    if (scheme) u = u.slice(i + 1);
  }
  if (u.slice(0, 2) === '//') {
    const rest = u.slice(2);
    let delim = rest.length;
    for (const c of ['/', '?', '#']) {
      const w = rest.indexOf(c);
      if (w >= 0 && w < delim) delim = w;
    }
    const netloc = rest.slice(0, delim);
    // urlsplit: unbalanced IPv6 brackets — '[' without ']' or ']' without '[' —
    // → ValueError('Invalid IPv6 URL'); _host catches the Exception and
    // returns "" (aeo.py:289). Without this check the port would yield the
    // raw '[::1'.
    if (
      (netloc.includes('[') && !netloc.includes(']')) ||
      (netloc.includes(']') && !netloc.includes('['))
    ) {
      throw new Error('Invalid IPv6 URL');
    }
    // A bracketed host must be a valid IPv6/IPvFuture (otherwise ValueError →
    // ""): '[notipv6]', '[1.2.3.4]' (IPv4 in brackets), '[]', '[gggg::]' are
    // all rejected.
    if (netloc.includes('[') && netloc.includes(']')) {
      checkBracketedHost(netloc.slice(netloc.indexOf('[') + 1, netloc.indexOf(']')));
    }
    // NFKC check for non-ASCII netloc (fullwidth solidus/colon, ℀, ℅ → ValueError).
    checkNetloc(netloc);
    return netloc;
  }
  return '';
}

/** aeo.py:285-290 — host without www., lowercased; any failure → "". */
export function host(url: string): string {
  try {
    const h = (urlsplitNetloc(url) || '').toLowerCase();
    return h.startsWith('www.') ? h.slice(4) : h;
  } catch {
    return '';
  }
}

// ── citations: {url, title} + categorization ──────────────────────────────────

/** aeo.py:256-264 — citation host categories. The label strings must not change.
 *  Exported: competitors.ts (is_non_competitor_host) reuses exactly these
 *  three lists (competitors.py:56 — `aeo._UGC_HOSTS+_REVIEW_HOSTS+_MEDIA_HOSTS`). */
export const UGC_HOSTS: readonly string[] = [
  'reddit.com',
  'quora.com',
  'news.ycombinator.com',
  'habr.com',
  'vc.ru',
  'pikabu.ru',
  'otzovik.com',
  'irecommend.ru',
  'stackoverflow.com',
  'dtf.ru',
  'medium.com',
];
export const REVIEW_HOSTS: readonly string[] = [
  'g2.com',
  'capterra.com',
  'getapp.com',
  'trustpilot.com',
  'producthunt.com',
  'alternativeto.net',
  'startpack.ru',
  'softwareadvice.com',
  'trustradius.com',
];
export const MEDIA_HOSTS: readonly string[] = [
  'techcrunch.com',
  'forbes.com',
  'theverge.com',
  'wired.com',
  'zdnet.com',
  'rbc.ru',
  'vedomosti.ru',
  'kommersant.ru',
  'cnews.ru',
  'nytimes.com',
  'businessinsider.com',
];

/** Canonical citation: `{url, title}`. */
export interface CiteItem {
  url: string;
  title: string;
}

/**
 * Python's `for c in (raw or [])` (aeo.py:735). `raw or []` collapses ALL
 * falsy values (including `{}`, `[]`, `""`, `0`) into `[]` — not just
 * null/undefined, unlike `?? []` (which would throw `TypeError: not
 * iterable` on `{}`). A truthy container is iterated the Python way: a list
 * by elements, a STRING by code point, a dict by KEYS. A truthy
 * non-iterable scalar (number/True) raises TypeError in Python — we keep the
 * same effect.
 */
function pyIterForCite(raw: unknown): unknown[] {
  if (pyFalsy(raw)) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') return Array.from(raw);
  if (isDict(raw) && !(raw instanceof PyFloat)) return Object.keys(raw);
  throw new TypeError('cite_items: raw is not iterable');
}

/**
 * aeo.py:731-745 — any citation format → `[{url, title}]`. Accepts legacy
 * strings and canonical objects; discards junk (non-str/non-dict) and
 * entries without a URL. `str(x or "")` + `strip()` on url/title — an empty
 * field is dropped BEFORE coercion.
 */
export function citeItems(raw: CitationRaw[] | null | undefined): CiteItem[] {
  const out: CiteItem[] = [];
  for (const c of pyIterForCite(raw)) {
    let u: string;
    let t: string;
    if (typeof c === 'string') {
      u = pyStrip(c);
      t = '';
    } else if (isDict(c)) {
      u = pyStrip(pyStrOrEmpty(c.url));
      t = pyStrip(pyStrOrEmpty(c.title));
    } else {
      continue; // no isinstance branch matched → junk, skip
    }
    if (u) out.push({ url: u, title: t });
  }
  return out;
}

/** aeo.py:753-770 — citation category by host. */
export function classifyCitation(
  url: string,
  domain: string,
  competitors: readonly string[],
): string {
  const h = host(url);
  if (!h) return 'Другое';
  const dl = domain.toLowerCase();
  if (h === dl || h.endsWith('.' + dl)) return 'Свой сайт';
  for (const c of competitors) {
    const cl = c.toLowerCase();
    if (h === cl || h.endsWith('.' + cl)) return 'Конкуренты';
  }
  if (UGC_HOSTS.some((x) => h === x || h.endsWith('.' + x)) || h.includes('forum')) {
    return 'UGC (форумы, Reddit)';
  }
  if (REVIEW_HOSTS.some((x) => h === x || h.endsWith('.' + x))) {
    return 'Обзорники/каталоги';
  }
  if (MEDIA_HOSTS.some((x) => h === x || h.endsWith('.' + x))) return 'СМИ';
  return 'Другое';
}

// ── brands: who's mentioned and in what order ─────────────────────────────────

/** Alias dictionary `{domain: [spelling, …]}` (see brands.aliases in scrapper). */
export type AliasMap = Record<string, unknown> | null | undefined;

/**
 * `_brand_variants` (aeo.py:616-636) — 'notion.so' → ['notion.so', 'notion'].
 *
 * The base `b = brand.lower().strip()` is ALWAYS included (even if shorter
 * than 4 characters); the stem (the part before the first dot) is added only
 * if it DIFFERS from the base and is ≥ 4 characters long — otherwise a
 * domain like 'ab.com' would spawn a noisy 'ab' variant. Aliases
 * (`aliases[brand]`, keyed by the ORIGINAL brand, not lowercased) are added
 * when ≥ 3 characters long and not already present. Length is measured in
 * CODE POINTS (Python's `len`).
 */
export function brandVariants(brand: string, aliases?: AliasMap): string[] {
  const b = pyStrip(brand.toLowerCase());
  const out: string[] = [b];
  const stem = b.split('.')[0];
  if (stem !== b && cpLength(stem) >= 4) out.push(stem);
  const rawAliases = aliases ? aliases[brand] : undefined;
  const list = Array.isArray(rawAliases) ? rawAliases : [];
  for (const a0 of list) {
    // Python: a = str(a or "").lower().strip(); conversion order preserved.
    const a = pyStrip(pyStrOrEmpty(a0).toLowerCase());
    if (cpLength(a) >= 3 && !out.includes(a)) out.push(a);
  }
  return out;
}

/** One mentioned brand: name + position (1-based) in first-appearance order. */
export interface BrandHit {
  brand: string;
  pos: number;
}

/**
 * `parse_brands` (aeo.py:707-722) — who's mentioned and in what order →
 * `[{brand, pos}]`. `pos` is assigned starting at 1, in order of FIRST
 * appearance among mentioned brands; on equal position the order is decided
 * by the brand STRING (Python sorts `(pos, brand)` tuples — see pitfall 2 in
 * the header), not by input order.
 *
 * A Russian spelling counts the same as the Latin one — via the transliteration
 * stem in `variantHit`. Positions are in code points (Python's `m.start()`).
 */
export function parseBrands(
  text: string | null | undefined,
  brands: readonly string[],
  aliases?: AliasMap,
): BrandHit[] {
  // Python: low = (text or "").lower(). The text contract is a string; a
  // non-string (or "") → "" (Python's falsy `or ""`), a number would raise
  // in Python's .lower().
  const low = (typeof text === 'string' ? text : '').toLowerCase();
  const cyr: readonly CyrWord[] = cyrWords(low);
  const firsts: Array<[number, string]> = [];
  for (const brand of brands) {
    let mn = -1;
    for (const v of brandVariants(brand, aliases)) {
      const h = variantHit(low, cyr, v);
      if (h !== -1 && (mn === -1 || h < mn)) mn = h; // min(hits) across variants
    }
    if (mn !== -1) firsts.push([mn, brand]);
  }
  // firsts.sort() = sort of (pos, brand) tuples: position, then string.
  firsts.sort((x, y) => x[0] - y[0] || cmpStr(x[1], y[1]));
  return firsts.map(([, brand], i) => ({ brand, pos: i + 1 }));
}
