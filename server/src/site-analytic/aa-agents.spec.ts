/**
 * LLM agents + the run_llm_layer orchestrator (port of aa_agents) on a STUB
 * askJson — no live LLM burned. Checks the assembly of outputs into facts
 * (clusters/thinCluster/priorities/plan), the anti-hallucination number-guard
 * (an item with a made-up "large" number is dropped, others survive), and the
 * keys.so intent fix-up IN PLACE.
 */
import { runLlmLayer } from './aa-agents';

/** Stub flash-JSON: routes by a distinctive substring of the agent's prompt. */
const stubAsk = async (p: string): Promise<Record<string, unknown> | null> => {
  // Order matters: the section_callouts/plan_synthesizer prompts embed the digest
  // JSON (incl. crawl_extract with "value_prop"), so agent-specific markers are
  // checked BEFORE the generic "value_prop".
  if (p.includes('тематических кластеров')) {
    return { clusters: [
      { name: 'CRM для продаж', kws: 10, strength: 'сильный' },
      { name: 'Аналитика', kws: 3, strength: 'тонкий' },
    ] };
  }
  if (p.includes('поисковый интент')) return { intents: { 'срм система': 'Коммерч.', мусор: 'НЕвалид' } };
  if (p.includes('пошаговый гайд')) {
    return { plan: [
      { t: 'Добавить llms.txt', why: 'ИИ доверяет', how: ['создать файл', 'указать разделы'], impact: 5, effort: 2, ref: 'AI-поиск' },
      { t: 'Нарастить трафик до 900000 визитов', why: 'рост', how: [], impact: 3, effort: 4, ref: 'Трафик' },
    ] };
  }
  if (p.includes('приоритета')) {
    return { priorities: [
      { t: 'Внедрить FAQPage Schema', tab: 'aeo' },
      { t: 'Взлёт до 500000 визитов за месяц', tab: 'traffic' },
    ] };
  }
  if (p.includes('value_prop')) return { value_prop: 'Быстрый CRM', offer: null, segment: 'SMB' };
  return null;
};

function mkFacts(): Record<string, unknown> {
  return {
    meta: { domain: 'shop.ru', seoSource: 'keysso' },
    visits: 128770, growthPct: 12, authority: 40, kwTotal: 5400,
    keywords: [
      { kw: 'срм система', intent: null },
      { kw: 'crm', intent: 'Коммерч.' },
    ],
    crawl: { title: 'CRM для бизнеса и отдела продаж', description: 'Продавайте больше', h1: '', hero_text: '' },
  };
}
// keywordsSample >= 10 — otherwise cluster_labeler stays silent (aa_agents.py:149).
const rawKeywords = Array.from({ length: 12 }, (_, i) => ({ keyword: `запрос номер ${i}`, volume: 100 + i }));

describe('run_llm_layer — assembling outputs into facts (aa_agents.py:419)', () => {
  it('clusters/thinCluster/priorities/plan are merged; outputs are populated', async () => {
    const facts = mkFacts();
    const r = await runLlmLayer(facts, rawKeywords, { ask: stubAsk });

    expect(r.merge.clusters).toEqual([
      { name: 'CRM для продаж', kws: 10, strength: 'сильный' },
      { name: 'Аналитика', kws: 3, strength: 'тонкий' },
    ]);
    // thinCluster = first cluster with strength 'тонкий'
    expect(r.merge.thinCluster).toEqual({ name: 'Аналитика', kws: 3, strength: 'тонкий' });
    expect(r.outputs.model).toBe('flash');
    expect(r.outputs.crawl_extract).toEqual({ value_prop: 'Быстрый CRM', offer: null, segment: 'SMB' });
  });

  it('number-guard: item with a made-up "large" number is dropped, the clean one survives', async () => {
    const r = await runLlmLayer(mkFacts(), rawKeywords, { ask: stubAsk });
    // 500000 is not in the input data → the priority with it is dropped, FAQPage remains.
    expect(r.merge.priorities).toEqual([{ t: 'Внедрить FAQPage Schema', tab: 'aeo' }]);
    // 900000 is not in the input data → the plan item is dropped, llms.txt remains.
    expect((r.merge.plan as any[]).map((x) => x.t)).toEqual(['Добавить llms.txt']);
  });

  it('keys.so: unlabeled keyword intents get fixed up IN PLACE', async () => {
    const facts = mkFacts();
    const r = await runLlmLayer(facts, rawKeywords, { ask: stubAsk });
    // mutates facts.keywords: the empty intent is filled in, the labeled one is untouched
    expect((facts.keywords as any[])[0].intent).toBe('Коммерч.');
    expect((facts.keywords as any[])[1].intent).toBe('Коммерч.');
    expect(r.outputs.intents_fixed).toBe(1);
  });
});
