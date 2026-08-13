/**
 * Port of core/schema_lint.py — local validation of a page's JSON-LD markup
 * (without third-party validators). A pure `lint(html) -> result` function,
 * deterministic and touching neither network nor DB: an ideal golden parity
 * target against the live core/schema_lint.lint (see schema-lint.parity.spec.ts).
 *
 * What we check (as in Python): the block parses as JSON; @context and @type are
 * present; known types have their required properties filled in; @graph is
 * expanded. This is NOT a full schema.org validator — we catch the errors that
 * make engines ignore the markup, and we name them in Russian.
 *
 * Parity pitfalls verified against the oracle:
 *   • the ld+json regex: `[\s\S]*?` instead of `.` under DOTALL, flag i (the type
 *     attribute in any case and with any quotes);
 *   • the @context error is raised ONLY for a dict document: a top-level JSON
 *     array does not get it (isinstance(doc, dict) in Python);
 *   • issue order: for each entity first all REQUIRED (by types, by properties),
 *     then all RECOMMENDED — exactly Python's double loop;
 *   • `valid` is computed over the FULL issue list, and only afterwards issues is
 *     truncated to 20 (types — to 20 as well);
 *   • `json.loads(chunk.strip())`: the string is trimmed with Python's str.strip
 *     (pyStrip), then JSON.parse. The only known micro-divergence is the
 *     NaN/Infinity literals (json.loads accepts them, JSON.parse rejects them);
 *     they do not occur in valid ld+json.
 */
import { pyStrip } from '../aeo/parse';

/** Required properties per type (Google Rich Results + common sense). */
export const REQUIRED: Readonly<Record<string, readonly string[]>> = {
  Article: ['headline'],
  NewsArticle: ['headline'],
  BlogPosting: ['headline'],
  FAQPage: ['mainEntity'],
  HowTo: ['name', 'step'],
  Product: ['name'],
  Offer: ['price', 'priceCurrency'],
  Organization: ['name'],
  LocalBusiness: ['name', 'address'],
  BreadcrumbList: ['itemListElement'],
  Event: ['name', 'startDate'],
  Recipe: ['name', 'recipeIngredient'],
  VideoObject: ['name', 'uploadDate'],
  Person: ['name'],
  WebSite: ['name'],
};

/** Recommended ones (they do not break the markup, but noticeably improve it). */
export const RECOMMENDED: Readonly<Record<string, readonly string[]>> = {
  Article: ['author', 'datePublished', 'image'],
  NewsArticle: ['author', 'datePublished', 'image'],
  BlogPosting: ['author', 'datePublished', 'image'],
  Product: ['offers', 'aggregateRating', 'image'],
  Organization: ['url', 'logo', 'sameAs'],
  LocalBusiness: ['telephone', 'openingHours'],
};

const LD_RE =
  /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

export interface LintIssue {
  level: 'error' | 'warn';
  type: string | null;
  msg: string;
}

export interface LintResult {
  blocks: number;
  parsed: number;
  broken: number;
  types: string[];
  issues: LintIssue[];
  valid: boolean;
}

const isDict = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Python falsiness for values from JSON: None/False/""/0 AND empty containers
 * `[]`/`{}`. Critical for `not ent.get(prop)` and `if node.get("@type")`: JS `!x`
 * treats `[]`/`{}` as truthy while Python treats them as falsy, so an empty
 * mainEntity:[] on FAQPage must yield a missing-property error, as in the oracle.
 * NaN does not occur in JSON, so we do not reproduce its Python truthiness.
 */
function pyFalsy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === '') return true;
  if (typeof v === 'number') return v === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (isDict(v)) return Object.keys(v).length === 0;
  return false;
}

/** `node.get("@type")` → list of type strings; an @type list filters out non-strings. */
function typesOf(node: Record<string, unknown>): string[] {
  const t = node['@type'];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  return typeof t === 'string' ? [t] : [];
}

/**
 * All nodes with a truthy `@type`, including nested ones and those inside @graph.
 * Order is DFS, a node before its descendants; dict values are walked in
 * insertion order (like dict.values() in Python; JSON.parse preserves the source
 * key order).
 */
function entities(node: unknown, out: Record<string, unknown>[]): Record<string, unknown>[] {
  if (isDict(node)) {
    if (!pyFalsy(node['@type'])) out.push(node);
    for (const v of Object.values(node)) entities(v, out);
  } else if (Array.isArray(node)) {
    for (const v of node) entities(v, out);
  }
  return out;
}

/** `str.strip()` over the block body, then strict JSON — like json.loads(chunk.strip()). */
function tryParse(chunk: string): { ok: true; doc: unknown } | { ok: false } {
  try {
    return { ok: true, doc: JSON.parse(pyStrip(chunk)) };
  } catch {
    return { ok: false };
  }
}

/** Parse and check every ld+json block on the page (port of schema_lint.lint). */
export function lint(html: string): LintResult {
  const rawBlocks = [...String(html || '').matchAll(LD_RE)].map((m) => m[1]);
  const result: LintResult = {
    blocks: rawBlocks.length,
    parsed: 0,
    broken: 0,
    types: [],
    issues: [],
    valid: false,
  };
  if (!rawBlocks.length) return result;

  const docs: unknown[] = [];
  for (const chunk of rawBlocks) {
    const p = tryParse(chunk);
    if (p.ok) {
      docs.push(p.doc);
      result.parsed += 1;
    } else {
      result.broken += 1;
      result.issues.push({
        level: 'error',
        type: null,
        msg: 'блок JSON-LD не парсится — движки его игнорируют целиком',
      });
    }
  }

  const types: string[] = [];
  for (const doc of docs) {
    const hasContext =
      isDict(doc) && Object.keys(doc).some((k) => k.toLowerCase() === '@context');
    if (isDict(doc) && !hasContext) {
      result.issues.push({
        level: 'error',
        type: null,
        msg: 'нет @context — блок не считается разметкой schema.org',
      });
    }
    for (const ent of entities(doc, [])) {
      const entTypes = typesOf(ent);
      for (const t of entTypes) if (!types.includes(t)) types.push(t);
      for (const t of entTypes) {
        for (const prop of REQUIRED[t] || []) {
          if (pyFalsy(ent[prop])) {
            result.issues.push({
              level: 'error',
              type: t,
              msg: `${t}: нет обязательного свойства «${prop}»`,
            });
          }
        }
        for (const prop of RECOMMENDED[t] || []) {
          if (pyFalsy(ent[prop])) {
            result.issues.push({
              level: 'warn',
              type: t,
              msg: `${t}: не заполнено «${prop}» — блок беднее, чем мог бы быть`,
            });
          }
        }
      }
    }
  }

  if (!types.length && result.parsed) {
    result.issues.push({
      level: 'error',
      type: null,
      msg: 'в разметке нет ни одного @type — движку нечего понять',
    });
  }

  result.types = types.slice(0, 20);
  result.valid =
    result.broken === 0 && types.length > 0 && !result.issues.some((i) => i.level === 'error');
  result.issues = result.issues.slice(0, 20);
  return result;
}
