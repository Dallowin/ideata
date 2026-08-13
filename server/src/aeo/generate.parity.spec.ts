/**
 * STRICT PARITY of generate.ts's deterministic filters/rankers against LIVE
 * Python (core/aeo.py) on a fixed input. Goldens were captured by running the
 * actual Python bodies on the reference server (the oracle from the task),
 * inlined directly:
 *
 *   echo <in.json> | ssh the reference oracle 'cd the Python source && \
 *     PYTHONPATH=/opt .venv/bin/python -c "import json,sys; \
 *     from startup_scraper.core import aeo; i=json.load(sys.stdin); \
 *     print(json.dumps(aeo._rank_panel(i[\"panel\"], i[\"n\"])))"'
 *
 * Criterion: deepDiff(ported, golden) === [] on every case (deepDiff canonicalizes
 * both sides, key order/Set traversal order doesn't matter — sets are compared
 * as Set↔Set). The LLM part is NOT checked here (non-determinism) — its
 * acceptance test lives in generate.structural.spec.ts.
 */
import {
  rankPanel,
  dropNearDuplicates,
  keywordsAboutSite,
  siteVocabulary,
  productBrief,
  competitorBrands,
  capCompetitorMentions,
  ensureCompetitorFloor,
  competitorCap,
  competitorFloor,
  assignSections,
  spreadByTopic,
  relevantKeywords,
  seedFor,
  isQuestion,
  type PromptRow,
  type KeywordRow,
} from './generate';
import { deepDiff } from './parity/diff';

/** Assertion "no discrepancies with the golden Python output". */
function eqGolden(label: string, ported: unknown, golden: unknown): void {
  const diff = deepDiff(ported, golden);
  if (diff.length) {
    throw new Error(
      `${label}: mismatch with Python\n  ported=${JSON.stringify(ported)}\n` +
        `  golden=${JSON.stringify(golden)}\n  paths=${diff.slice(0, 8).join(',')}`,
    );
  }
  expect(diff).toEqual([]);
}

describe('generate.ts — parity of deterministic filters with live Python', () => {
  // ── _rank_panel ─────────────────────────────────────────────────────────────
  describe('rankPanel (_rank_panel)', () => {
    it('dedup by normalized text + sort by volume (None last) + skip empty', () => {
      const panel: PromptRow[] = [
        { prompt: 'A', volume: 10 },
        { prompt: 'a', volume: 5 },
        { prompt: 'B', volume: null },
        { prompt: 'C', volume: 30 },
        { prompt: '  ', volume: 99 },
      ];
      eqGolden('rank_basic', rankPanel(panel, 10), [
        { prompt: 'C', volume: 30 },
        { prompt: 'A', volume: 10 },
        { prompt: 'B', volume: null },
      ]);
    });

    it('stability with equal volume + truncation to n', () => {
      const panel: PromptRow[] = [
        { prompt: 'p1 alpha', volume: 5 },
        { prompt: 'p2 beta', volume: 5 },
        { prompt: 'p3 gamma', volume: null },
        { prompt: 'p4 delta', volume: 20 },
        { prompt: 'p5 epsilon', volume: null },
      ];
      eqGolden('rank_tie_slice', rankPanel(panel, 3), [
        { prompt: 'p4 delta', volume: 20 },
        { prompt: 'p1 alpha', volume: 5 },
        { prompt: 'p2 beta', volume: 5 },
      ]);
    });

    it('dedup by normalization (punctuation/case), extra keys preserved', () => {
      const panel: PromptRow[] = [
        { prompt: 'Нетология, отзывы 2026!', volume: 7, intent: 'reviews' },
        { prompt: 'нетология отзывы 2026', volume: 100, intent: 'reviews' },
        { prompt: 'что такое AEO', volume: 3 },
      ];
      eqGolden('rank_punct_dedup', rankPanel(panel, 10), [
        { prompt: 'Нетология, отзывы 2026!', volume: 7, intent: 'reviews' },
        { prompt: 'что такое AEO', volume: 3 },
      ]);
    });
  });

  // ── _drop_near_duplicates ───────────────────────────────────────────────────
  describe('dropNearDuplicates (_drop_near_duplicates)', () => {
    it('collapses paraphrases when the intent matches; different intent — kept', () => {
      const panel: PromptRow[] = [
        { prompt: 'посоветуй сайты с краш игрой на скины cs go', intent: 'best' },
        { prompt: 'где играть в краш на скины из cs go', intent: 'best' },
        { prompt: 'какой сервис аналитики выбрать для отдела продаж', intent: 'use_case' },
        { prompt: 'отзывы о сервисе аналитики для отдела продаж', intent: 'reviews' },
        { prompt: 'посоветуй сайты с краш игрой на скины cs go', intent: 'best' },
      ];
      eqGolden('drop_ru_crash', dropNearDuplicates(panel), [
        { prompt: 'посоветуй сайты с краш игрой на скины cs go', intent: 'best' },
        { prompt: 'какой сервис аналитики выбрать для отдела продаж', intent: 'use_case' },
        { prompt: 'отзывы о сервисе аналитики для отдела продаж', intent: 'reviews' },
      ]);
    });

    it('an exact duplicate is dropped even for a short prompt (<3 significant words)', () => {
      const panel: PromptRow[] = [
        { prompt: 'cs go crash sites', intent: 'best' },
        { prompt: 'cs go crash sites', intent: 'best' },
        { prompt: 'цена сервиса', intent: 'pricing' },
        { prompt: 'отзывы сервиса', intent: 'reviews' },
      ];
      eqGolden('drop_short_exact', dropNearDuplicates(panel), [
        { prompt: 'cs go crash sites', intent: 'best' },
        { prompt: 'цена сервиса', intent: 'pricing' },
        { prompt: 'отзывы сервиса', intent: 'reviews' },
      ]);
    });

    it('same words, different intent — two distinct questions', () => {
      const panel: PromptRow[] = [
        { prompt: 'какой сервис email рассылок выбрать новичку', intent: 'how_to_choose' },
        { prompt: 'какой сервис email рассылок посоветуешь новичку', intent: 'how_to_choose' },
        { prompt: 'сколько стоит сервис email рассылок для новичка', intent: 'pricing' },
      ];
      eqGolden('drop_intent_split', dropNearDuplicates(panel), [
        { prompt: 'какой сервис email рассылок выбрать новичку', intent: 'how_to_choose' },
        { prompt: 'сколько стоит сервис email рассылок для новичка', intent: 'pricing' },
      ]);
    });

    it('intent missing → filled in via _heuristic_intent', () => {
      const panel: PromptRow[] = [
        { prompt: 'посоветуй crm для отдела продаж b2b' },
        { prompt: 'порекомендуй crm для отдела продаж b2b' },
      ];
      eqGolden('drop_no_intent_field', dropNearDuplicates(panel), [
        { prompt: 'посоветуй crm для отдела продаж b2b' },
      ]);
    });
  });

  // ── _site_vocabulary / _keywords_about_site ─────────────────────────────────
  describe('siteVocabulary / keywordsAboutSite', () => {
    const ctx = {
      title: 'Ideata — платформа AEO аналитики видимости бренда в ИИ',
      description: 'Мониторинг упоминаний бренда в ChatGPT и Perplexity',
      h1: 'AEO аналитика',
      hero_text: '',
      headings: { h2: ['Отчёты', 'Конкуренты'], h3: [] as string[] },
    };

    it('siteVocabulary: 5-letter stems + brand name; duplicates collapsed', () => {
      const ctxV = {
        ...ctx,
        hero_text: 'Реклама рекламу рекламы',
        headings: { h2: ['Отчёты', 'Конкуренты'], h3: ['Тарифы'] },
      };
      // Set↔Set: traversal order doesn't affect the diff.
      eqGolden(
        'site_vocab_ru',
        siteVocabulary(ctxV, 'ideata.io'),
        new Set([
          'aeo', 'chatg', 'ideat', 'perpl', 'анали', 'бренд', 'видим',
          'конку', 'монит', 'отчёт', 'платф', 'рекла', 'тариф', 'упоми',
        ]),
      );
    });

    it('siteVocabulary: empty crawl → empty set (the brand name alone is not a vocabulary)', () => {
      eqGolden('site_vocab_empty', siteVocabulary({ title: '', description: '' }, 'brand.io'), new Set());
      eqGolden('site_vocab_nodict', siteVocabulary(null, 'brand.io'), new Set());
    });

    it('keywordsAboutSite: an unrelated industry is filtered out by the site vocabulary', () => {
      const keywords: KeywordRow[] = [
        { keyword: 'aeo аналитика' },
        { keyword: 'мониторинг бренда в ии' },
        { keyword: 'edgedata' },
        { keyword: 'конкуренты бренда' },
        { keyword: 'дрели по бетону' },
      ];
      eqGolden('kw_about_site', keywordsAboutSite(keywords, ctx, 'ideata.io'), [
        { keyword: 'aeo аналитика' },
        { keyword: 'мониторинг бренда в ии' },
        { keyword: 'конкуренты бренда' },
      ]);
    });

    it('keywordsAboutSite: no vocabulary → no filtering (nothing to judge by)', () => {
      const keywords: KeywordRow[] = [{ keyword: 'anything at all' }, { keyword: 'whatever else' }];
      eqGolden('kw_about_site_novocab', keywordsAboutSite(keywords, null, 'x.com'), [
        { keyword: 'anything at all' },
        { keyword: 'whatever else' },
      ]);
      eqGolden(
        'kw_about_site_emptycrawl',
        keywordsAboutSite([{ keyword: 'foo bar' }], { title: '', description: '', h1: '', hero_text: '', headings: {} }, 'foo.com'),
        [{ keyword: 'foo bar' }],
      );
    });
  });

  // ── _product_brief ──────────────────────────────────────────────────────────
  describe('productBrief (_product_brief)', () => {
    it('joins title/description/h1/hero_text with " • " and a prefix', () => {
      eqGolden(
        'product_brief',
        productBrief({ title: 'Ideata', description: 'AEO аналитика', h1: 'Видимость бренда', hero_text: '' }, 'ideata.io'),
        'О продукте ideata.io (текст с главной страницы): Ideata • AEO аналитика • Видимость бренда',
      );
    });
    it('no context / empty → ""', () => {
      eqGolden('product_brief_none', productBrief(null, 'x.com'), '');
      eqGolden('product_brief_empty', productBrief({ title: '', description: '' }, 'x.com'), '');
    });
  });

  // ── _competitor_brands ──────────────────────────────────────────────────────
  describe('competitorBrands (_competitor_brands)', () => {
    it('brand tokens for all competitors, TLD/generic words dropped', () => {
      eqGolden(
        'comp_brands',
        competitorBrands(['Clash.gg', 'CS Money', 'insane.gg', 'Team Pro']),
        new Set(['clash', 'insane', 'money']),
      );
      eqGolden('comp_brands_empty', competitorBrands([]), new Set());
    });
  });

  // ── competitor corridor ─────────────────────────────────────────────────────
  describe('competitor corridor (cap/floor)', () => {
    it('capCompetitorMentions: cap = round(n·0.2), excess moved to the tail', () => {
      const panel: PromptRow[] = [
        { prompt: 'что лучше clash или наш сервис', volume: 9 },
        { prompt: 'как выбрать сервис аналитики', volume: 8 },
        { prompt: 'альтернативы insane для новичка', volume: 7 },
        { prompt: 'стоит ли clash gg', volume: 6 },
        { prompt: 'посоветуй сервис мониторинга', volume: 5 },
        { prompt: 'отзывы о нашем сервисе', volume: 4 },
      ];
      eqGolden('cap_comp_basic', capCompetitorMentions(panel, new Set(['clash', 'insane']), 10), [
        { prompt: 'что лучше clash или наш сервис', volume: 9 },
        { prompt: 'как выбрать сервис аналитики', volume: 8 },
        { prompt: 'альтернативы insane для новичка', volume: 7 },
        { prompt: 'посоветуй сервис мониторинга', volume: 5 },
        { prompt: 'отзывы о нашем сервисе', volume: 4 },
        { prompt: 'стоит ли clash gg', volume: 6 },
      ]);
    });

    it('capCompetitorMentions: cap=3 at n=15 (all comp entries fit)', () => {
      const panel: PromptRow[] = [
        { prompt: 'clash обзор один' },
        { prompt: 'нормальный промпт a' },
        { prompt: 'insane обзор два' },
        { prompt: 'clash обзор три' },
        { prompt: 'нормальный промпт b' },
        { prompt: 'insane обзор четыре' },
        { prompt: 'clash обзор пять' },
      ];
      eqGolden('cap_comp_n15', capCompetitorMentions(panel, new Set(['clash', 'insane']), 15), [
        { prompt: 'clash обзор один' },
        { prompt: 'нормальный промпт a' },
        { prompt: 'insane обзор два' },
        { prompt: 'clash обзор три' },
        { prompt: 'нормальный промпт b' },
        { prompt: 'insane обзор четыре' },
        { prompt: 'clash обзор пять' },
      ]);
    });

    it('capCompetitorMentions: no brands — panel unchanged', () => {
      const panel: PromptRow[] = [{ prompt: 'один' }, { prompt: 'два' }];
      eqGolden('cap_comp_nocomp', capCompetitorMentions(panel, new Set(), 10), [{ prompt: 'один' }, { prompt: 'два' }]);
    });

    it('ensureCompetitorFloor: promotes comp entries to the head up to floor', () => {
      const ordered: PromptRow[] = [
        { prompt: 'нормальный один', volume: 50 },
        { prompt: 'нормальный два', volume: 40 },
        { prompt: 'нормальный три', volume: 30 },
        { prompt: 'нормальный четыре', volume: 20 },
        { prompt: 'что лучше clash или мы', volume: 5 },
        { prompt: 'нормальный пять', volume: 10 },
      ];
      eqGolden('ensure_floor_basic', ensureCompetitorFloor(ordered, new Set(['clash']), 4), [
        { prompt: 'нормальный один', volume: 50 },
        { prompt: 'нормальный два', volume: 40 },
        { prompt: 'нормальный три', volume: 30 },
        { prompt: 'что лучше clash или мы', volume: 5 },
        { prompt: 'нормальный четыре', volume: 20 },
        { prompt: 'нормальный пять', volume: 10 },
      ]);
    });

    it('ensureCompetitorFloor: floor already covered — unchanged', () => {
      const ordered: PromptRow[] = [
        { prompt: 'clash в голове', volume: 50 },
        { prompt: 'нормальный два', volume: 40 },
        { prompt: 'нормальный три', volume: 30 },
        { prompt: 'нормальный четыре', volume: 20 },
        { prompt: 'insane за границей', volume: 5 },
        { prompt: 'нормальный пять', volume: 10 },
      ];
      eqGolden('ensure_floor_have_enough', ensureCompetitorFloor(ordered, new Set(['clash', 'insane']), 4), [
        { prompt: 'clash в голове', volume: 50 },
        { prompt: 'нормальный два', volume: 40 },
        { prompt: 'нормальный три', volume: 30 },
        { prompt: 'нормальный четыре', volume: 20 },
        { prompt: 'insane за границей', volume: 5 },
        { prompt: 'нормальный пять', volume: 10 },
      ]);
    });

    it('ensureCompetitorFloor: list shorter than n — unchanged', () => {
      const ordered: PromptRow[] = [{ prompt: 'один' }, { prompt: 'два' }, { prompt: 'clash три' }];
      eqGolden('ensure_floor_shortlist', ensureCompetitorFloor(ordered, new Set(['clash']), 4), [
        { prompt: 'один' },
        { prompt: 'два' },
        { prompt: 'clash три' },
      ]);
    });

    it('competitorCap/Floor: banker\'s rounding (pyRound) over n=5..45', () => {
      // cap = max(1, round(0.2n)); floor = min(cap, max(1, round(0.1n))).
      // half-even catches n=25 (round(2.5)=2, NOT 3) and n=45 (round(4.5)=4, NOT 5).
      const ns = [5, 10, 15, 25, 35, 45];
      expect(ns.map(competitorCap)).toEqual([1, 2, 3, 5, 7, 9]);
      expect(ns.map(competitorFloor)).toEqual([1, 1, 2, 2, 4, 4]);
    });
  });

  // ── _assign_sections / _spread_by_topic ─────────────────────────────────────
  describe('assignSections / spreadByTopic', () => {
    it('assignSections: topic by max stem-match count; 0 matches — no topic', () => {
      const panel: PromptRow[] = [
        { prompt: 'посоветуй сайт с краш игрой на скины', volume: 5 },
        { prompt: 'как открыть кейсы выгодно', volume: 4 },
        { prompt: 'общий вопрос без темы', volume: 3 },
      ];
      eqGolden('assign_sections', assignSections(panel, ['Краш', 'Кейсы', 'Вывод скинов']), [
        { prompt: 'посоветуй сайт с краш игрой на скины', volume: 5, topic: 'Краш' },
        { prompt: 'как открыть кейсы выгодно', volume: 4, topic: 'Кейсы' },
        { prompt: 'общий вопрос без темы', volume: 3 },
      ]);
    });

    it('assignSections: no sections — panel unchanged', () => {
      eqGolden('assign_sections_empty', assignSections([{ prompt: 'что угодно', volume: 1 }], []), [
        { prompt: 'что угодно', volume: 1 },
      ]);
    });

    it('spreadByTopic: round-robin selection by topic (first-appearance order)', () => {
      const panel: PromptRow[] = [
        { prompt: 'краш 1', topic: 'Краш', volume: 9 },
        { prompt: 'краш 2', topic: 'Краш', volume: 8 },
        { prompt: 'краш 3', topic: 'Краш', volume: 7 },
        { prompt: 'кейсы 1', topic: 'Кейсы', volume: 6 },
        { prompt: 'вывод 1', topic: 'Вывод', volume: 5 },
      ];
      eqGolden('spread_by_topic', spreadByTopic(panel, 3), [
        { prompt: 'краш 1', topic: 'Краш', volume: 9 },
        { prompt: 'кейсы 1', topic: 'Кейсы', volume: 6 },
        { prompt: 'вывод 1', topic: 'Вывод', volume: 5 },
        { prompt: 'краш 2', topic: 'Краш', volume: 8 },
        { prompt: 'краш 3', topic: 'Краш', volume: 7 },
      ]);
    });
  });

  // ── keyword sources (deterministic) ─────────────────────────────────────────
  describe('relevantKeywords / seedFor / isQuestion', () => {
    it('relevantKeywords: sorted by etv, brand-homonym/competitor/near-duplicate filtered out', () => {
      const keywords: KeywordRow[] = [
        { keyword: 'cobalt', volume: 5000, rank: 40 },
        { keyword: 'аналитика продаж', volume: 800, rank: 5, clicks: 120 },
        { keyword: 'аналитика продаж b2b', volume: 300, rank: 8, clicks: 90 },
        { keyword: 'clash обзор', volume: 400, rank: 3, clicks: 200 },
        { keyword: 'crm система', volume: 600, rank: 12, clicks: 50 },
        { keyword: 'crm системы', volume: 100, rank: 15, clicks: 10 },
      ];
      eqGolden(
        'rel_basic',
        relevantKeywords(keywords, 'cobaltlab.tech', { excludeBrands: new Set(['clash']) }),
        [
          { kw: 'аналитика продаж', volume: 800 },
          { kw: 'аналитика продаж b2b', volume: 300 },
          { kw: 'crm система', volume: 600 },
          { kw: 'crm системы', volume: 100 },
        ],
      );
    });

    it('relevantKeywords: pool <8 → rank threshold relaxed to ≤40', () => {
      const keywords: KeywordRow[] = [
        { keyword: 'виртуальная атс', volume: 900, rank: 2, clicks: 300 },
        { keyword: 'атс для офиса', volume: 500, rank: 7, clicks: 150 },
        { keyword: 'облачная телефония', volume: 700, rank: 40, clicks: 999 },
        { keyword: 'ip телефония цена', volume: 200, rank: 11, clicks: 40 },
        { keyword: 'телефония', volume: 50, rank: 25, clicks: 5 },
        { keyword: 'атс', volume: 1000, rank: 1, clicks: 800 },
        { keyword: 'crm интеграция', volume: 120, rank: 9, clicks: 33 },
        { keyword: 'колл трекинг', volume: 80, rank: 6, clicks: 22 },
        { keyword: 'запись разговоров', volume: 60, rank: 4, clicks: 11 },
      ];
      eqGolden('rel_strict_rank', relevantKeywords(keywords, 'telfin.ru'), [
        { kw: 'облачная телефония', volume: 700 },
        { kw: 'атс', volume: 1000 },
        { kw: 'виртуальная атс', volume: 900 },
        { kw: 'атс для офиса', volume: 500 },
        { kw: 'ip телефония цена', volume: 200 },
        { kw: 'crm интеграция', volume: 120 },
        { kw: 'колл трекинг', volume: 80 },
        { kw: 'запись разговоров', volume: 60 },
        { kw: 'телефония', volume: 50 },
      ]);
    });

    it('seedFor: relevant keyword → top-by-volume → ""', () => {
      eqGolden(
        'seed_relevant',
        seedFor('cobaltlab.tech', [
          { keyword: 'cobalt', volume: 5000, rank: 40 },
          { keyword: 'аналитика продаж', volume: 800, rank: 5, clicks: 120 },
        ]),
        'аналитика продаж',
      );
      eqGolden(
        'seed_byvolume',
        seedFor('x.io', [
          { keyword: 'foo', volume: 10 },
          { keyword: 'bar baz qux something', volume: 99 },
        ]),
        'bar baz qux something',
      );
      eqGolden('seed_empty', seedFor('x.io', []), '');
    });

    it('isQuestion: year/marker/≥4 words/"ли" → true; raw keyword → false', () => {
      expect(isQuestion('лучший crm 2026')).toBe(true);
      expect(isQuestion('стоит ли notion')).toBe(true);
      expect(isQuestion('crm для отдела продаж')).toBe(true);
      expect(isQuestion('работает ли оплата')).toBe(true);
      expect(isQuestion('crm')).toBe(false);
    });
  });
});
