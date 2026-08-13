/**
 * CLI runner for checking `aggregateMonitoring` parity: reads JSON
 * `{rows, domain, competitors, platforms}` from stdin (or a file argument),
 * prints `canonicalize(aggregateMonitoring(...))` as JSON to stdout.
 *
 * A reusable utility, not a throwaway script: it's used to run the port
 * against an arbitrary window and diff it against the Python reference.
 * `platforms` is optional — DEFAULT_PLATFORMS is used if it's absent.
 *
 * Running it (the CommonJS override is required: the repo is on
 * module=nodenext, and ts-node without it tries to resolve relative imports
 * as ESM; resolvePackageJsonExports=false — otherwise TS5098 combined with
 * moduleResolution=node):
 *   npx ts-node --transpile-only \
 *     -O '{"module":"commonjs","moduleResolution":"node","resolvePackageJsonExports":false}' \
 *     src/aeo/parity/run-monitoring.ts < window.json
 */
import { readFileSync } from 'fs';
import { aggregateMonitoring } from '../aggregate';
import { canonicalize } from './diff';
import { pyParse } from '../pyjson';
import type { MonitoringRow } from '../aggregate.types';

interface RunInput {
  rows: MonitoringRow[];
  domain: string;
  competitors: string[];
  platforms?: string[];
}

function run(raw: string): void {
  // pyParse (not JSON.parse): preserve int/float/bool like CPython's
  // json.load, otherwise a judge float like 70.0 is indistinguishable from
  // an int and solution_hit/row_judge would diverge from the oracle on the
  // same input (findings 1-3).
  const input = pyParse(raw) as RunInput;
  const agg = aggregateMonitoring(input.rows, input.domain, input.competitors, {
    platforms: input.platforms,
  });
  process.stdout.write(JSON.stringify(canonicalize(agg)));
}

const fileArg = process.argv[2];
if (fileArg) {
  run(readFileSync(fileArg, 'utf8'));
} else {
  const chunks: Buffer[] = [];
  process.stdin.on('data', (c: Buffer) => chunks.push(c));
  process.stdin.on('end', () => run(Buffer.concat(chunks).toString('utf8')));
}
