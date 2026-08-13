/**
 * Google AI Overviews via DataForSEO SERP Advanced — the "aio" engine, port of
 * scrapper/core/aeo.py::_ai_overview_answer (aeo.py:373) + the dataforseo._post
 * transport (dataforseo.py:125). Real Google SERP + references (real citations).
 * No tokens → fixed price per request (cost is taken from the DataForSEO envelope's
 * `cost` in dollars, otherwise the FIXED_DATAFORSEO fallback).
 *
 * PURE VERIFIABLE CORE — `parseAiOverview(items)`: `result[0].items` →
 * {text, citations} | null. Collects elements with type=="ai_overview" (text +
 * references from the element and from the block itself), dedups citations by URL.
 * No text → null (no overview was present on the SERP).
 */
import { isDict, pyStrip, pyStrOrEmpty, type CiteItem } from '../parse';
import { fixedCostUsd } from '../cost';
import { type EngineAnswer } from './shared';
import { getSettingKey } from './settings';
import { recordUsage, shortError } from '../usage';

const BASE = 'https://api.dataforseo.com';
const SERP_PATH = '/v3/serp/google/organic/live/advanced';
const TIMEOUT_MS = 30_000;

/**
 * PURE CORE: `items` (result[0].items) → {text, citations} | null. Port of the body
 * of `_ai_overview_answer` (aeo.py:391-418): references carry url + title, we keep
 * the title (the domain alone doesn't show which piece was cited); dedup by URL.
 */
export function parseAiOverview(items: unknown): EngineAnswer | null {
  const texts: string[] = [];
  const cites: CiteItem[] = [];
  const seen = new Set<string>();
  const addRef = (ref: unknown): void => {
    const u = pyStrip(pyStrOrEmpty(isDict(ref) ? ref.url : undefined));
    if (!u || seen.has(u)) return;
    seen.add(u);
    cites.push({ url: u, title: pyStrip(pyStrOrEmpty(isDict(ref) ? ref.title : undefined)) });
  };
  for (const it of Array.isArray(items) ? items : []) {
    if (!isDict(it) || it.type !== 'ai_overview') continue;
    const inner = (it as Record<string, unknown>).items;
    for (const el of Array.isArray(inner) ? inner : []) {
      const t = isDict(el) ? el.text || el.title : undefined; // el.get("text") or el.get("title")
      if (t) texts.push(String(t));
      const refs = isDict(el) ? (el as Record<string, unknown>).references : undefined;
      for (const ref of Array.isArray(refs) ? refs : []) addRef(ref);
    }
    const blockRefs = (it as Record<string, unknown>).references;
    for (const ref of Array.isArray(blockRefs) ? blockRefs : []) addRef(ref);
  }
  if (!texts.length) return null; // no overview present on the SERP
  // Python: "\n".join(texts)[:12000] (sliced by code point; here it's UTF-16 —
  // the only divergence is on astral characters within the first 12k, which never happens in a SERP).
  return { text: texts.join('\n').slice(0, 12000), citations: cites };
}

/**
 * POST to the live DataForSEO endpoint + usage accounting (port of dataforseo._post,
 * dataforseo.py:125): returns the first task's `result` or null (no keys / non-200 /
 * envelope error / task error). Cost: the envelope's `cost` (USD) if > 0, otherwise the fixed rate.
 */
async function dataforseoPost(path: string, payload: unknown[]): Promise<unknown[] | null> {
  const login = await getSettingKey('DATAFORSEO_LOGIN');
  const password = await getSettingKey('DATAFORSEO_PASSWORD');
  if (!login || !password) return null;
  const auth = Buffer.from(`${login}:${password}`).toString('base64');
  const started = Date.now();
  const lat = () => Date.now() - started;

  const costOf = (data: unknown): number => {
    const c = Number((isDict(data) ? data.cost : 0) || 0);
    return Number.isFinite(c) && c > 0 ? c : fixedCostUsd('dataforseo');
  };

  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (exc) {
    recordUsage({ provider: 'dataforseo', model: path, status: 'error', error: shortError(exc), latencyMs: lat(), costUsd: null });
    return null;
  }
  if (!res.ok) {
    recordUsage({ provider: 'dataforseo', model: path, status: 'error', error: String(res.status), latencyMs: lat(), costUsd: null });
    return null;
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    recordUsage({ provider: 'dataforseo', model: path, status: 'error', error: 'non_json', latencyMs: lat(), costUsd: null });
    return null;
  }
  // Errors arrive with HTTP 200 — check the envelope first, then the task (dataforseo.py:165-188).
  if (!isDict(data) || data.status_code !== 20000) {
    recordUsage({ provider: 'dataforseo', model: path, status: 'error', error: String(isDict(data) ? data.status_code : 'no_json'), latencyMs: lat(), costUsd: null });
    return null;
  }
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  if (!tasks.length) {
    recordUsage({ provider: 'dataforseo', model: path, status: 'error', error: 'no_tasks', latencyMs: lat(), costUsd: costOf(data) });
    return null;
  }
  const task = tasks[0];
  if (!isDict(task) || task.status_code !== 20000) {
    // Out of funds / no data — degrade silently (the task is billed even on error).
    recordUsage({ provider: 'dataforseo', model: path, status: 'error', error: String(isDict(task) ? task.status_code : 'bad_task'), latencyMs: lat(), costUsd: costOf(data) });
    return null;
  }
  recordUsage({ provider: 'dataforseo', model: path, status: 'ok', latencyMs: lat(), costUsd: costOf(data) });
  return (Array.isArray(task.result) ? task.result : []) as unknown[];
}

/**
 * The "aio" engine (port of `_ai_overview_answer`, aeo.py:373): SERP Advanced →
 * the ai_overview element. DataForSEO's Google SERP API doesn't accept Russia
 * (2643) as a location — we substitute Kazakhstan (2398), the language stays as-is.
 * null if no overview is present on the SERP.
 */
export async function aiOverviewAnswer(
  prompt: string,
  { locationCode = 2840, languageCode = 'en' }: { locationCode?: number; languageCode?: string } = {},
): Promise<EngineAnswer | null> {
  let loc = locationCode;
  if (loc === 2643) loc = 2398; // RU → KZ (aeo.py:382-383)
  const res = await dataforseoPost(SERP_PATH, [
    {
      keyword: prompt.slice(0, 700),
      location_code: loc,
      language_code: languageCode,
      depth: 10,
      load_async_ai_overview: true,
    },
  ]);
  if (!res) return null;
  const items = isDict(res[0]) ? (res[0] as Record<string, unknown>).items : undefined;
  return parseAiOverview(items);
}
