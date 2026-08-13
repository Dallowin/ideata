/**
 * CLI runner for checking parse-run parity: reads from stdin (or a file
 * argument) either a single `{fn, ...args}` object OR an array of such
 * objects, calls the corresponding ported function from ../parse for each,
 * and prints `canonicalize(result)` as JSON. An array input yields an array
 * of results.
 *
 * Dispatch by `fn`:
 *   {"fn":"parse_brands","text":str,"brands":[str],"aliases":{domain:[str]}|null}
 *   {"fn":"cite_items","raw":<any citation format>}
 *   {"fn":"classify_citation","url":str,"domain":str,"competitors":[str]}
 *
 * The live Python oracle (core/aeo.parse_brands/cite_items/classify_citation)
 * is fed the same input — that's how the port is diffed against the
 * reference on arbitrary data. pyParse (not JSON.parse): the oracle reads its
 * input via `json.loads`, where `2.0` is a float and `str(2.0)=="2.0"`, while
 * plain `JSON.parse` would strip the dot (`2`). pyParse preserves a float
 * literal as PyFloat, and `pyStrOrEmpty` prints it with Python's float repr —
 * without this, cite_items with a numeric url/title and a float alias
 * element would silently diverge from the oracle on the very same text.
 *
 * Running it (the CommonJS override is required: the repo is on
 * module=nodenext, and ts-node without it resolves relative imports as ESM;
 * resolvePackageJsonExports=false — otherwise TS5098 combined with
 * moduleResolution=node):
 *   npx ts-node --transpile-only \
 *     -O '{"module":"commonjs","moduleResolution":"node","resolvePackageJsonExports":false}' \
 *     src/aeo/parity/run-parse.ts < case.json
 */
import { readFileSync } from 'fs';
import { parseBrands, citeItems, classifyCitation } from '../parse';
import type { CitationRaw } from '../aggregate.types';
import { pyParse } from '../pyjson';
import { canonicalize } from './diff';

interface ParseBrandsTask {
  fn: 'parse_brands';
  text: string | null | undefined;
  brands: string[];
  aliases?: Record<string, unknown> | null;
}
interface CiteItemsTask {
  fn: 'cite_items';
  raw: CitationRaw[] | null | undefined;
}
interface ClassifyTask {
  fn: 'classify_citation';
  url: string;
  domain: string;
  competitors: string[];
}
type Task = ParseBrandsTask | CiteItemsTask | ClassifyTask;

function dispatch(task: Task): unknown {
  switch (task.fn) {
    case 'parse_brands':
      return parseBrands(task.text, task.brands ?? [], task.aliases);
    case 'cite_items':
      return citeItems(task.raw);
    case 'classify_citation':
      return classifyCitation(task.url, task.domain, task.competitors ?? []);
    default: {
      const bad = task as { fn?: unknown };
      throw new Error(`unknown fn: ${String(bad.fn)}`);
    }
  }
}

function run(rawText: string): void {
  const parsed = pyParse(rawText) as Task | Task[];
  const result = Array.isArray(parsed)
    ? parsed.map((t) => dispatch(t))
    : dispatch(parsed);
  process.stdout.write(JSON.stringify(canonicalize(result)));
}

const fileArg = process.argv[2];
if (fileArg) {
  run(readFileSync(fileArg, 'utf8'));
} else {
  const chunks: Buffer[] = [];
  process.stdin.on('data', (c: Buffer) => chunks.push(c));
  process.stdin.on('end', () => run(Buffer.concat(chunks).toString('utf8')));
}
