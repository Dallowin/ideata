/**
 * LLM agents for the AI-analytic — port of core/aa_agents.py (agents + the
 * run_llm_layer/content_guide orchestrator). The deterministic "number-guard" is
 * split out into number-guard.ts and tested separately; here — agent prompts,
 * response sanitizers, and assembling the outputs into facts.
 *
 * Agents (Python splits them across FLASH and SENIOR models via Analyzer+model_select):
 *   • clusterLabeler   — top keywords → 4-6 clusters {name, kws, strength};
 *   • intentClassifier — intents for unlabeled keys.so keywords;
 *   • crawlExtractor   — homepage hero text → {value_prop, offer, segment};
 *   • sectionCallouts  — facts → exactly 3 priorities for the "Overview" tab;
 *   • planSynthesizer  — facts → a plan of ≤8 actions;
 *   • contentGuide     — full AEO guide built on real AI answers (after the snapshot).
 *
 * LLM SEAM: a single injectable `askJson` (defaults to askFlashJson from aeo/run —
 * a direct analog of `_ask_json(FLASH_MODELS)`). In Python the senior agents
 * (callouts/plan/guide) go to the premium stack via model_select.models(); in
 * this port they use the same askFlashJson, as already done in
 * generate.ts/competitors.ts (COVERAGE-GAP: the flash/senior tiers are collapsed
 * into one). In tests askJson is a stub returning canonical JSON.
 *
 * Anti-hallucination: agent numbers are checked with filterViolations against the
 * digest's allowed_numbers — violators are dropped ITEM BY ITEM (aa_agents.py:434-447).
 */
import { cpSlice, get, isDict, pyOr, truthy } from './pyhelpers';
import { cpLen } from './pyutil';
import { pyStrip } from '../aeo/parse';
import { askFlashJson } from '../aeo/run';
import { allowedNumbers, buildDigest, filterViolations } from './number-guard';

/** Flash-JSON caller — provider's askFlashJson, a stub in tests. */
export type AskJson = (prompt: string) => Promise<Record<string, unknown> | null>;

/** aa_agents.py:38-40 — allowed values for agent fields. */
const STRENGTHS = new Set(['сильный', 'средний', 'тонкий']);
const PLAN_REFS = new Set(['SEO', 'Гэп', 'AI-поиск', 'Ссылки', 'Реклама', 'Трафик']);
const PRIORITY_TABS = new Set(['seo', 'aeo', 'traffic', 'competitors', 'plan']);
const VALID_INTENTS = new Set(['Информ.', 'Коммерч.', 'Транзакц.', 'Навигац.']);

const JSON_RULES =
  'Ответь СТРОГО одним JSON-объектом без markdown и пояснений. Используй ТОЛЬКО ' +
  'числа из приведённых данных — не выдумывай ни одной цифры.';

// ── Python-isms ────────────────────────────────────────────────────────────────

/** `str(x)` in an f-string: None→'None', True/False, otherwise String. */
function pyStr(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  return String(v);
}

/** `str(x or "")` — falsy→'', otherwise String (for .strip()[:n]). */
function pyStrOr(v: unknown): string {
  return truthy(v) ? String(v) : '';
}

/** `int(v)` in try/except → null: bool→0/1, number→truncation, integer string→parsed. */
function pyIntCoerce(v: unknown): number | null {
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string') {
    const t = pyStrip(v);
    return /^[+-]?\d+$/.test(t) ? parseInt(t, 10) : null; // int("5.0") → ValueError
  }
  return null;
}

/** `s.strip(chars)` — strip ANY character in the set from both ends (codepoints). */
function stripChars(s: string, chars: string): string {
  const set = new Set(Array.from(chars));
  const arr = Array.from(s);
  let i = 0;
  let j = arr.length;
  while (i < j && set.has(arr[i])) i += 1;
  while (j > i && set.has(arr[j - 1])) j -= 1;
  return arr.slice(i, j).join('');
}

// ── agents ────────────────────────────────────────────────────────────────────

/** aa_agents.py:147-176 — top keywords → 4-6 clusters. */
export async function clusterLabeler(
  ask: AskJson,
  digest: Record<string, unknown>,
): Promise<Array<{ name: string; kws: number; strength: string }> | null> {
  const sample = (pyOr(get(digest, 'keywordsSample'), []) as any[]);
  if (sample.length < 10) return null;
  const lines = sample
    .map((k) => `${pyStr(get(k, 'kw'))} — ${pyOr(get(k, 'vol'), '?')}`)
    .join('\n');
  const p =
    `Семантика домена ${pyStr(get(digest, 'domain'))}: список «ключ — частотность»` +
    ` (${sample.length} шт).\n${lines}\n\n` +
    'Сгруппируй в 4-6 тематических кластеров. Для каждого: name — короткое ' +
    'русское имя темы; kws — СКОЛЬКО ключей из списка ты отнёс к кластеру ' +
    '(целое, сумма kws <= числа ключей); strength — покрытие домена по позициям ' +
    'этих ключей: «сильный» (в основном топ-10), «средний», «тонкий» (мало ключей ' +
    'или глубокие позиции). Хотя бы один кластер обязан быть не «сильный», если ' +
    'это честно.\n' +
    `${JSON_RULES} Формат: {"clusters":[{"name":"...","kws":12,"strength":"сильный"}]}`;
  const data = await ask(p);
  const rows = data ? (data as Record<string, unknown>).clusters : null;
  if (!Array.isArray(rows)) return null;
  const out: Array<{ name: string; kws: number; strength: string }> = [];
  for (const r of rows.slice(0, 6)) {
    const name = pyStrip(pyStrOr(get(r, 'name')));
    const n = pyIntCoerce(get(r, 'kws'));
    const kws = n === null ? 0 : Math.max(0, n);
    const strength = pyStrip(pyStrOr(get(r, 'strength'))).toLowerCase();
    if (name && STRENGTHS.has(strength)) {
      out.push({ name: cpSlice(name, 60), kws, strength });
    }
  }
  return out.length ? out.slice(0, 6) : null;
}

/** aa_agents.py:179-196 — homepage hero text → {value_prop, offer, segment}. */
export async function crawlExtractor(
  ask: AskJson,
  digest: Record<string, unknown>,
): Promise<Record<string, string | null> | null> {
  const crawl = pyOr(get(digest, 'crawl'), {}) as Record<string, unknown>;
  const text = stripChars(
    ['title', 'description', 'h1', 'hero_text']
      .map((k) => pyStrOr(get(crawl, k)))
      .join(' | '),
    ' |',
  );
  if (cpLen(text) < 40) return null;
  const p =
    `Текст с главной страницы ${pyStr(get(digest, 'domain'))}:\n${text}\n\n` +
    'Извлеки: value_prop — главное обещание продукта одной фразой по-русски; ' +
    'offer — конкретный оффер/призыв (триал, цена, демо), если есть; segment — ' +
    'для кого продукт (сегмент ЦА). Чего нет — null.\n' +
    `${JSON_RULES} Формат: {"value_prop":"...","offer":null,"segment":"..."}`;
  const data = await ask(p);
  if (!isDict(data)) return null;
  const out: Record<string, string | null> = {};
  for (const k of ['value_prop', 'offer', 'segment']) {
    out[k] = truthy(get(data, k)) ? cpSlice(pyStrip(String(get(data, k))), 200) : null;
  }
  return Object.values(out).some((v) => truthy(v)) ? out : null;
}

/** aa_agents.py:199-212 — intents for unlabeled keywords (keys.so) → {kw: label}. */
export async function intentClassifier(
  ask: AskJson,
  keywords: any[],
): Promise<Record<string, string> | null> {
  const todo = keywords
    .filter((k) => truthy(get(k, 'kw')) && !truthy(get(k, 'intent')))
    .map((k) => get(k, 'kw') as string)
    .slice(0, 50);
  if (!todo.length) return null;
  const p =
    'Определи поисковый интент каждого запроса: Информ. / Коммерч. / Транзакц. / ' +
    'Навигац.\n' + todo.join('\n') + '\n\n' + JSON_RULES +
    ' Формат: {"intents":{"<запрос>":"Коммерч."}}';
  const data = await ask(p);
  const intents = data ? (data as Record<string, unknown>).intents : null;
  if (!isDict(intents)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(intents)) {
    if (typeof v === 'string' && VALID_INTENTS.has(v)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/** aa_agents.py:215-237 — facts → exactly 3 priorities for the "Overview" tab. */
export async function sectionCallouts(
  ask: AskJson,
  digest: Record<string, unknown>,
  clusters: unknown,
): Promise<Array<{ t: string; tab: string }> | null> {
  const d: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(digest)) if (k !== 'keywordsSample') d[k] = v;
  d.clusters = clusters;
  const p =
    'Данные разбора конкурента (JSON):\n' + JSON.stringify(d) + '\n\n' +
    'Ты AEO-консультант. Пользователь ИЗУЧАЕТ этот сайт-конкурента, чтобы обойти ' +
    'его в выдаче ИИ и поиске. Пиши про «ваш сайт» — НИКОГДА не называй продукт ' +
    '«Ideata» и не подставляй его как субъект. Сформулируй РОВНО 3 приоритета — ' +
    'самых выгодных направления, каждое одним предложением по-русски с опорой на ' +
    'конкретный факт из данных. tab — вкладка с деталями: seo | aeo | traffic | ' +
    'competitors | plan.\n' +
    `${JSON_RULES} Формат: {"priorities":[{"t":"...","tab":"seo"}]}`;
  const data = await ask(p);
  const rows = data ? (data as Record<string, unknown>).priorities : null;
  if (!Array.isArray(rows)) return null;
  const out: Array<{ t: string; tab: string }> = [];
  for (const r of rows) {
    if (!isDict(r)) continue;
    const t = pyStrip(pyStrOr(r.t));
    if (!t) continue;
    out.push({
      t: cpSlice(t, 180),
      tab: typeof r.tab === 'string' && PRIORITY_TABS.has(r.tab) ? r.tab : 'plan',
    });
  }
  return out.length ? out.slice(0, 3) : null;
}

/** aa_agents.py:240-290 — facts → a plan of ≤8 actions. */
export async function planSynthesizer(
  ask: AskJson,
  digest: Record<string, unknown>,
  clusters: unknown,
  crawlExtract: unknown,
): Promise<Array<Record<string, unknown>> | null> {
  const d: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(digest)) if (k !== 'keywordsSample') d[k] = v;
  d.clusters = clusters;
  d.crawl_extract = crawlExtract;
  const p =
    'Данные разбора сайта-конкурента (JSON):\n' + JSON.stringify(d) + '\n\n' +
    'Ты AEO/SEO-консультант. Составь ПОЛНОЦЕННЫЙ пошаговый гайд из РОВНО 8 ' +
    'действий, как ВАШЕМУ САЙТУ повысить видимость в ИИ-поиске (ChatGPT, Google ' +
    'AI Overviews, Perplexity, Gemini) и обойти этого конкурента. ВАЖНО: субъект ' +
    '— всегда «ваш сайт»; НИКОГДА не называй продукт «Ideata».\n' +
    'Приоритет — действия по AI-видимости (ref=AI-поиск): FAQPage/Organization ' +
    'Schema, llms.txt, цитируемые факты и структура, упоминания на площадках. ' +
    'Затем SEO/Гэп/Ссылки/Реклама/Трафик.\n' +
    'Каждое действие: t — что сделать; why — почему сработает; how — МАССИВ из ' +
    '2-4 шагов; impact 1-5; effort 1-5; ref — SEO | Гэп | AI-поиск | Ссылки | ' +
    'Реклама | Трафик.\n' +
    `${JSON_RULES} Формат: {"plan":[{"t":"...","why":"...","how":["шаг 1"],` +
    '"impact":5,"effort":2,"ref":"AI-поиск"}]}';
  const data = await ask(p);
  const rows = data ? (data as Record<string, unknown>).plan : null;
  if (!Array.isArray(rows)) return null;

  const clamp15 = (v: unknown): number => {
    const n = pyIntCoerce(v);
    return n === null ? 3 : Math.max(1, Math.min(5, n));
  };
  const steps = (v: unknown): string[] => {
    if (!Array.isArray(v)) return [];
    return v
      .filter((s) => pyStrip(pyStrOr(s)))
      .map((s) => cpSlice(pyStrip(String(s)), 180))
      .slice(0, 4);
  };
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows.slice(0, 8)) {
    if (!isDict(r) || !pyStrip(pyStrOr(r.t))) continue;
    out.push({
      t: cpSlice(pyStrip(String(r.t)), 220),
      why: cpSlice(pyStrip(pyStrOr(r.why)), 220),
      how: steps(r.how),
      impact: clamp15(r.impact),
      effort: clamp15(r.effort),
      ref: typeof r.ref === 'string' && PLAN_REFS.has(r.ref) ? r.ref : 'SEO',
    });
  }
  return out.length ? out : null;
}

// ── full AEO guide (after the snapshot) ─────────────────────────────────────

/** aa_agents.py:293-332 — compact guide grounding from ALREADY-collected facts. */
export function guideDigest(facts: Record<string, unknown>): Record<string, unknown> {
  const domain = (pyOr(get(pyOr(get(facts, 'meta'), {}), 'domain'), '') as string) || '';
  const gaps: Array<{ prompt: unknown; rivals: string[] }> = [];
  for (const r of pyOr(get(facts, 'aiPromptsRows'), []) as any[]) {
    if (truthy(get(r, 'mentioned'))) continue;
    const rivals: string[] = [];
    for (const a of pyOr(get(r, 'answers'), []) as any[]) {
      for (const b of pyOr(get(a, 'brandsFound'), []) as any[]) {
        const nm = get(b, 'brand');
        if (nm && nm !== domain && !rivals.includes(nm)) rivals.push(nm);
      }
    }
    gaps.push({ prompt: get(r, 'prompt'), rivals: rivals.slice(0, 4) });
  }
  const cited = (pyOr(get(facts, 'citations'), []) as any[])
    .filter((c) => truthy(get(c, 'url')))
    .map((c) => ({ url: get(c, 'url'), n: get(c, 'n'), title: pyOr(get(c, 'title'), null) }))
    .slice(0, 12);
  const rivalCited = (pyOr(get(facts, 'citedPages'), []) as any[])
    .map((p) => ({
      title: pyOr(get(p, 'title'), null),
      host: get(p, 'host'),
      cat: get(p, 'cat'),
      n: get(p, 'n'),
    }))
    .slice(0, 12);
  const crawl = pyOr(get(facts, 'crawl'), {}) as Record<string, unknown>;
  const techKeys = ['has_faq_schema', 'has_llms_txt', 'schema_types', 'has_sitemap', 'robots_blocks_all'];
  const techReadiness: Record<string, unknown> = {};
  for (const k of techKeys) techReadiness[k] = get(crawl, k);
  return {
    domain,
    valueProp: cpSlice(pyStrOr(get(crawl, 'hero_text')), 400) || null,
    gaps: gaps.slice(0, 12),
    citedByAi: cited,
    rivalCitedByAi: rivalCited,
    citeCategories: get(facts, 'citeSources'),
    foundNotCited: get(facts, 'foundNotCited'),
    competitors: (pyOr(get(facts, 'competitors'), []) as any[])
      .filter((c) => truthy(get(c, 'domain')))
      .map((c) => get(c, 'domain'))
      .slice(0, 6),
    techReadiness,
  };
}

/** aa_agents.py:335-415 — full AEO guide built on real AI answers. */
export async function contentGuide(
  ask: AskJson,
  facts: Record<string, unknown>,
  progress?: (label: string) => void,
): Promise<Record<string, unknown> | null> {
  const dig = guideDigest(facts);
  if (
    !(dig.gaps as any[]).length &&
    !(dig.citedByAi as any[]).length &&
    !(dig.rivalCitedByAi as any[]).length
  ) {
    return null;
  }
  if (progress) progress('AEO: full guide');
  const p =
    'Данные AI-видимости ВАШЕГО САЙТА (JSON): промпты ЦА, где ИИ вас НЕ назвал ' +
    '(gaps + конкуренты-победители), ваши страницы в цитатах (citedByAi), ЧУЖИЕ ' +
    'материалы, которые ИИ цитирует вместо вас — с заголовками (rivalCitedByAi), ' +
    'категории источников (citeCategories), техническая AEO-готовность ' +
    '(techReadiness):\n' + JSON.stringify(dig) + '\n\n' +
    'Составь ПОЛНОЦЕННЫЙ практический AEO-гайд — как попасть в ответы ИИ (ChatGPT, ' +
    'Google AI Overviews, Perplexity, Gemini). Субъект — всегда «ваш сайт»; ' +
    'НИКОГДА не называй продукт «Ideata».\n' +
    '- diagnosis: 2-3 предложения, где теряете AI-видимость.\n' +
    '- contentBriefs (3-5): материалы под gap-промпты. Каждый: title; forPrompts; ' +
    'outline (3-5); facts (2-4 конкретных факта).\n' +
    '- wherePublish (3-6): ГДЕ публиковаться — РЕАЛЬНЫЕ площадки из rivalCitedByAi ' +
    'и competitors. Каждый: source; cat; action.\n' +
    '- tech (3-5): техническая AEO из techReadiness. Каждый: item; status (ok/todo); how.\n' +
    `${JSON_RULES} Формат: {"diagnosis":"...","contentBriefs":[{"title":"...",` +
    '"forPrompts":["..."],"outline":["..."],"facts":["..."]}],"wherePublish":' +
    '[{"source":"...","cat":"...","action":"..."}],"tech":[{"item":"...",' +
    '"status":"todo","how":"..."}]}';
  const data = await ask(p);
  if (!isDict(data)) return null;

  const slist = (v: unknown, n = 6, ln = 200): string[] => {
    if (!Array.isArray(v)) return [];
    return v
      .filter((x) => pyStrip(pyStrOr(x)))
      .map((x) => cpSlice(pyStrip(String(x)), ln))
      .slice(0, n);
  };

  const briefs: Array<Record<string, unknown>> = [];
  for (const b of (pyOr(get(data, 'contentBriefs'), []) as any[]).slice(0, 5)) {
    if (!isDict(b) || !pyStrip(pyStrOr(b.title))) continue;
    briefs.push({
      title: cpSlice(pyStrip(String(b.title)), 180),
      forPrompts: slist(b.forPrompts, 4, 180),
      outline: slist(b.outline, 6, 180),
      facts: slist(b.facts, 4, 180),
    });
  }
  const where: Array<Record<string, unknown>> = [];
  for (const w of (pyOr(get(data, 'wherePublish'), []) as any[]).slice(0, 6)) {
    if (!isDict(w) || !pyStrip(pyStrOr(w.source))) continue;
    where.push({
      source: cpSlice(pyStrip(String(w.source)), 100),
      cat: cpSlice(pyStrip(pyStrOr(w.cat)), 40),
      action: cpSlice(pyStrip(pyStrOr(w.action)), 200),
    });
  }
  const tech: Array<Record<string, unknown>> = [];
  for (const t of (pyOr(get(data, 'tech'), []) as any[]).slice(0, 6)) {
    if (!isDict(t) || !pyStrip(pyStrOr(t.item))) continue;
    const st = pyStrOr(t.status).toLowerCase() === 'ok' ? 'ok' : 'todo';
    tech.push({
      item: cpSlice(pyStrip(String(t.item)), 160),
      status: st,
      how: cpSlice(pyStrip(pyStrOr(t.how)), 200),
    });
  }
  const guide = {
    diagnosis: cpSlice(pyStrip(pyStrOr(get(data, 'diagnosis'))), 600) || null,
    contentBriefs: briefs.length ? briefs : null,
    wherePublish: where.length ? where : null,
    tech: tech.length ? tech : null,
  };
  if (!(guide.contentBriefs || guide.wherePublish)) return null;
  return guide;
}

// ── layer orchestrator ────────────────────────────────────────────────────────

export interface RunLlmLayerResult {
  merge: Record<string, unknown>;
  outputs: Record<string, unknown>;
}

/** Model label in llm_outputs (Python model_select.current()); informational only. */
const MODEL_LABEL = 'flash';

/**
 * Port of run_llm_layer (aa_agents.py:419-483): run the agents and assemble the
 * outputs into facts (clusters/thinCluster/priorities/plan; for keys.so — fixing
 * up keyword intents IN PLACE). Returns {merge (to merge into facts), outputs
 * (for site_analyses)}. The KIE-key gate lives on the caller's side
 * (LiveLlmLayer). `ask` is the injection point for tests. Every "large" number
 * from the agents goes through filterViolations.
 */
export async function runLlmLayer(
  facts: Record<string, unknown>,
  rawKeywords: any[] | null,
  opts: { ask?: AskJson; progress?: (label: string) => void } = {},
): Promise<RunLlmLayerResult> {
  const ask = opts.ask ?? askFlashJson;
  const step = (label: string): void => opts.progress?.(label);
  const digest = buildDigest(facts, rawKeywords);
  const allowed = allowedNumbers(digest);
  const outputs: Record<string, unknown> = { model: MODEL_LABEL };

  const checked = <T>(obj: T | null): T | null =>
    obj === null ? null : filterViolations(obj, allowed);

  step('semantic clustering');
  const clusters = checked(await clusterLabeler(ask, digest));
  outputs.clusters = clusters;

  // keys.so doesn't give an intent — fix up keywords with the LLM IN PLACE (mutates facts.keywords).
  const seoSource = get(pyOr(get(facts, 'meta'), {}), 'seoSource');
  const keywords = get(facts, 'keywords');
  if (seoSource === 'keysso' && truthy(keywords)) {
    step('keyword intents');
    const fixed = await intentClassifier(ask, keywords as any[]);
    if (fixed) {
      for (const k of keywords as any[]) {
        const kw = get(k, 'kw');
        if (!truthy(get(k, 'intent')) && typeof kw === 'string' && kw in fixed) {
          (k as Record<string, unknown>).intent = fixed[kw];
        }
      }
      outputs.intents_fixed = Object.keys(fixed).length;
    }
  }

  step('offer audit');
  const crawlExtract = await crawlExtractor(ask, digest);
  outputs.crawl_extract = crawlExtract;

  step('priorities');
  const priorities = checked(await sectionCallouts(ask, digest, clusters));
  outputs.priorities = priorities;

  step('action plan');
  const plan = checked(await planSynthesizer(ask, digest, clusters, crawlExtract));
  outputs.plan = plan;

  const thinCluster =
    (clusters || []).find((c) => (c as any).strength === 'тонкий') ?? null;

  return {
    merge: { clusters, thinCluster, priorities, plan },
    outputs,
  };
}
