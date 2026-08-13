/**
 * NORMALIZE — analysis raw data → `facts` per the frontend contract
 * (web/composables/useAaMock.ts). Deterministic port of core/site_analytic.py:
 * the normalize() function (:286-384) plus ~40 pure helpers (:387-647).
 *
 * A missing field = `null` (the UI renders "n/a"), NOT 0 — a zero on the
 * dashboard reads as "computed, came out empty". The Similarweb panel
 * (clickstream) sees ALL channels, so when it's present — visits/channels/geo/
 * engagement are taken from it, and the search-based estimate stays a separate
 * searchVisits field. LLM-layer fields (clusters/plan/priorities) and AEO
 * (aiBrands/citations/…) are always null here — filled in later in the pipeline.
 *
 * PARITY: normalize() is pure (no network/DB) — checked byte-for-byte against
 * the live oracle on synthetic data (normalize.golden.json, see
 * normalize.parity.spec.ts). Gotchas checked against Python: `round()` is
 * banker's rounding (pyRound), not Math.round; `str(float)` gives "3.0"
 * (_fmt_views); `[:200]` slices are by codepoints; truthiness/`or`/`.get()`
 * are Python semantics (pyhelpers).
 */
import { cpSlice, get, intTrunc, pyFloatRepr, pyOr, pyRound, truthy } from './pyhelpers';
import type { Facts, Raw } from './types';

// Order = _MONTHS_RU (site_analytic.py:52).
const MONTHS_RU = ['Янв', 'Фев', 'Мар', 'Апр', 'Май', 'Июн',
  'Июл', 'Авг', 'Сен', 'Окт', 'Ноя', 'Дек'];

// DataForSEO intent code → frontend label (site_analytic.py:56-59).
const INTENT_RU: Record<string, string> = {
  INFO: 'Информ.', COMM: 'Коммерч.', TX: 'Транзакц.', NAV: 'Навигац.',
};
const INTENT_LABELS: Record<string, string> = {
  INFO: 'Информационные', COMM: 'Коммерческие',
  TX: 'Транзакционные', NAV: 'Навигационные',
};

// DataForSEO tech group → Russian block group label (site_analytic.py:62-71).
const TECH_GROUPS_RU: Record<string, string> = {
  content: 'Платформа', web_development: 'Платформа',
  platform: 'Платформа', cms: 'Платформа',
  analytics: 'Аналитика',
  marketing: 'Маркетинг', sales: 'Маркетинг',
  customer_service: 'Маркетинг', messaging: 'Маркетинг',
  servers: 'Инфраструктура', hosting: 'Инфраструктура',
  network: 'Инфраструктура', security: 'Инфраструктура',
  ecommerce: 'E-commerce',
};
const TECH_PER_GROUP = 6;

// Similarweb channel → Russian label (site_analytic.py:418-428).
const SW_CHANNELS_RU: Record<string, string> = {
  Direct: 'Прямые', Search: 'Поиск',
  'Organic Search': 'Органический поиск', SearchOrganic: 'Органический поиск',
  'Paid Search': 'Платный поиск', SearchPaid: 'Платный поиск',
  Referrals: 'Реферальные', Referral: 'Реферальные',
  Social: 'Соцсети', SocialOrganic: 'Соцсети', SocialPaid: 'Платные соцсети',
  Mail: 'Email', Email: 'Email',
  'Paid Referrals': 'Платные рефералы', ReferralPaid: 'Платные рефералы',
  'Display Ads': 'Медийная реклама', DisplayAd: 'Медийная реклама',
};

type Row = Record<string, any>;
const asRow = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Row) : {});
const asList = (v: unknown): any[] => (Array.isArray(v) ? v : []);

/** _series (site_analytic.py:395-401): month labels + organic/paid series. */
function series(hist: any[]): [string[] | null, number[] | null, number[] | null] {
  if (!hist.length) return [null, null, null];
  const labels = hist.map((r) => MONTHS_RU[(((Number(r.month) - 1) % 12) + 12) % 12]);
  const organic = hist.map((r) => (pyOr(get(r, 'organic_etv'), 0) as number));
  const paid = hist.map((r) => (pyOr(get(r, 'paid_etv'), 0) as number));
  return [labels, organic, paid];
}

/** _growth_series (site_analytic.py:404-408): MoM over the ready totals series. */
function growthSeries(s: number[] | null): number | null {
  if (!s || s.length < 2 || !truthy(s[s.length - 2])) return null;
  return pyRound(((s[s.length - 1] - s[s.length - 2]) / s[s.length - 2]) * 100);
}

/** _panel_channel (site_analytic.py:411-415). */
function panelChannel(total: number[] | null): any[] | null {
  if (!total || !total.length) return null;
  return [{ key: 'total', label: 'Все визиты (панель)', data: total }];
}

/** _sw_sources (site_analytic.py:431-436). */
function swSources(channels: unknown): any[] | null {
  if (!truthy(channels)) return null;
  const rows: any[] = [];
  for (const [k, v] of Object.entries(asRow(channels))) {
    if (truthy(v) && pyRound(v as number) > 0) {
      rows.push({ label: SW_CHANNELS_RU[k] ?? k, pct: pyRound(v as number) });
    }
  }
  rows.sort((a, b) => b.pct - a.pct); // -pct, stable
  return rows.length ? rows : null;
}

/** _sw_geo (site_analytic.py:439-444). */
function swGeo(geo: unknown): any[] | null {
  if (!truthy(geo)) return null;
  const rows = asList(geo).map((g) => ({
    code: String(pyOr(get(g, 'code'), '')).toUpperCase(),
    share: pyRound((pyOr(get(g, 'pct'), 0) as number)),
  }));
  const out = rows.filter((r) => r.code && r.share > 0);
  return out.length ? out : null;
}

/** _growth_pct (site_analytic.py:447-455): MoM of total traffic. */
function growthPct(hist: any[]): number | null {
  if (hist.length < 2) return null;
  const last = (pyOr(get(hist[hist.length - 1], 'total_traffic'), 0) as number);
  const prev = (pyOr(get(hist[hist.length - 2], 'total_traffic'), 0) as number);
  if (prev <= 0) return null;
  return pyRound(((last - prev) / prev) * 100);
}

/** _channels (site_analytic.py:458-467): only organic/paid from DataForSEO etv. */
function channels(organic: number[] | null, paid: number[] | null): any[] | null {
  if (!organic || !organic.length) return null;
  const out: any[] = [{ key: 'organic', label: 'Органический поиск', data: organic }];
  if (paid && paid.some((x) => truthy(x))) {
    out.push({ key: 'paid', label: 'Платный', data: paid });
  }
  return out;
}

/** _sources (site_analytic.py:470-480): organic/paid shares from the overview. */
function sources(ov: Row): any[] | null {
  const org = get(ov, 'organic_etv');
  const paid = get(ov, 'paid_etv');
  if (!truthy(org) && !truthy(paid)) return null;
  const total = (pyOr(org, 0) as number) + (pyOr(paid, 0) as number);
  if (total <= 0) return null;
  const rows: any[] = [{ label: 'Органический поиск', pct: pyRound(((pyOr(org, 0) as number) / total) * 100) }];
  if (truthy(paid)) rows.push({ label: 'Платный', pct: pyRound(((paid as number) / total) * 100) });
  return rows;
}

/** _geo (site_analytic.py:483-492): country shares from geo_split. */
function geoRows(split: any[] | null): any[] | null {
  if (!split || !split.length) return null;
  const total = split.reduce((s, r) => s + (r.etv as number), 0);
  if (total <= 0) return null;
  const rows = split.map((r) => ({ code: r.code, share: pyRound((r.etv / total) * 100) }));
  const out = rows.filter((r) => r.share > 0);
  out.sort((a, b) => b.share - a.share); // -share, stable
  return out.length ? out : null;
}

/** _keywords (site_analytic.py:495-508). */
function keywords(kws: any[], limit = 50): any[] | null {
  const out: any[] = [];
  for (const k of kws.slice(0, limit)) {
    if (!truthy(get(k, 'keyword'))) continue;
    out.push({
      kw: k.keyword,
      vol: get(k, 'volume'),
      pos: get(k, 'rank'),
      prev: get(k, 'prev_rank'),
      intent: INTENT_RU[get(k, 'intent')] ?? null,
      etv: get(k, 'clicks'),
    });
  }
  return out.length ? out : null;
}

/** _intents (site_analytic.py:511-523): intent distribution, weighted by volume. */
function intents(kws: any[]): any[] | null {
  const weights = new Map<string, number>(); // insertion order = first occurrence
  for (const k of kws) {
    const code = get(k, 'intent');
    if (!(code in INTENT_LABELS)) continue;
    weights.set(code, (weights.get(code) ?? 0) + (pyOr(get(k, 'volume'), 1) as number));
  }
  let total = 0;
  for (const w of weights.values()) total += w;
  if (!total) return null;
  const entries = [...weights.entries()];
  entries.sort((a, b) => b[1] - a[1]); // -w, stable (insertion-order tiebreak)
  return entries.map(([c, w]) => ({ label: INTENT_LABELS[c], pct: pyRound((w / total) * 100) }));
}

/** _pos_dist (site_analytic.py:526-536). kw_total is unused (del). */
function posDist(dist: unknown): any[] | null {
  if (!truthy(dist)) return null;
  const d = asRow(dist);
  const buckets: [string, string][] = [
    ['1–3', '1-3'], ['4–10', '4-10'], ['11–20', '11-20'],
    ['21–50', '21-50'], ['51–100', '51-100'],
  ];
  const rows = buckets.map(([lbl, key]) => ({ bucket: lbl, count: intTrunc(pyOr(get(d, key), 0)) }));
  if (!rows.some((r) => truthy(r.count))) return null;
  return rows;
}

/** _media_host (site_analytic.py:539-544). */
function mediaHost(url: string): string | null {
  try {
    const h = url.split('//', 2).slice(-1)[0].split('/', 1)[0];
    return h.startsWith('www.') ? h.slice(4) : (h || null);
  } catch {
    return null;
  }
}

/** _fmt_views (site_analytic.py:547-554). */
function fmtViews(n: unknown): string | null {
  if (!truthy(n)) return null;
  const v = n as number;
  if (v >= 1_000_000) return `${pyFloatRepr(pyRound(v / 1_000_000, 1))}M просмотров`;
  if (v >= 1000) return `${pyRound(v / 1000)}K просмотров`;
  return `${v} просмотров`;
}

/** _media_mentions (site_analytic.py:557-592): video+press+news, dedup by url, ≤30. */
function mediaMentions(yt: unknown, serp: unknown, news: unknown): any[] | null {
  const items: any[] = [];
  for (const m of asList(get(yt, 'mentions')).slice(0, 12)) {
    if (truthy(get(m, 'url'))) {
      items.push({
        platform: 'youtube', title: get(m, 'title'), url: get(m, 'url'),
        author: get(m, 'channel'), metric: fmtViews(get(m, 'views')),
        date: get(m, 'time'),
        snippet: pyOr(cpSlice(String(pyOr(get(m, 'desc'), '')), 200), null),
      });
    }
  }
  for (const r of asList(get(serp, 'results')).slice(0, 12)) {
    if (truthy(get(r, 'url')) && truthy(get(r, 'title'))) {
      items.push({
        platform: 'press', title: get(r, 'title'), url: get(r, 'url'),
        author: mediaHost(get(r, 'url')), metric: null, date: null,
        snippet: pyOr(cpSlice(String(pyOr(get(r, 'passage'), '')), 200), null),
      });
    }
  }
  for (const n of asList(news).slice(0, 12)) {
    if (truthy(get(n, 'url')) && truthy(get(n, 'title'))) {
      items.push({
        platform: 'news', title: get(n, 'title'), url: get(n, 'url'),
        author: pyOr(get(n, 'source'), mediaHost(get(n, 'url'))),
        metric: null, date: get(n, 'published_at'), snippet: null,
      });
    }
  }
  const seen = new Set<string>();
  const out: any[] = [];
  for (const i of items) {
    if (seen.has(i.url)) continue;
    seen.add(i.url);
    out.push(i);
  }
  const capped = out.slice(0, 30);
  return capped.length ? capped : null;
}

/** _top_pages (site_analytic.py:595-601). */
function topPages(pages: unknown, limit = 10): any[] | null {
  const list = asList(pages);
  if (!list.length) return null;
  const out = list.slice(0, limit)
    .filter((p) => truthy(get(p, 'url')))
    .map((p) => ({ url: get(p, 'url'), traffic: get(p, 'clicks'), kws: get(p, 'keywords') }));
  return out.length ? out : null;
}

/** _tech (site_analytic.py:604-616): grouped into Russian buckets, deduped, capped at 6. */
function tech(techIn: unknown): Record<string, string[]> | null {
  if (!truthy(techIn)) return null;
  const out: Record<string, string[]> = {};
  for (const [group, names] of Object.entries(asRow(techIn))) {
    const ru = TECH_GROUPS_RU[String(group).toLowerCase()];
    if (!ru) continue;
    if (!(ru in out)) out[ru] = [];
    const bucket = out[ru];
    for (const n of asList(names)) {
      if (!bucket.includes(n) && bucket.length < TECH_PER_GROUP) bucket.push(n);
    }
  }
  return Object.keys(out).length ? out : null;
}

/** _competitors (site_analytic.py:619-633). */
function competitors(comp: unknown, seoSource: unknown): any[] | null {
  const list = asList(comp);
  if (!list.length) return null;
  const out: any[] = list.map((c) => (seoSource === 'keysso'
    ? { domain: get(c, 'name'), traffic: null, growth: null, shared: get(c, 'common_keywords'), dr: null }
    : { domain: get(c, 'domain'), traffic: get(c, 'traffic'), growth: null, shared: get(c, 'shared_keywords'), dr: null }));
  const kept = out.filter((c) => truthy(c.domain));
  return kept.length ? kept : null;
}

/** _gap_rows (site_analytic.py:636-647): gap rows + score = round(vol/(kd+10)). */
function gapRows(gap: unknown): any[] | null {
  const list = asList(gap);
  if (!list.length) return null;
  const out: any[] = [];
  for (const g of list) {
    if (!truthy(get(g, 'kw'))) continue;
    const vol = get(g, 'vol');
    const kd = get(g, 'kd');
    const score = truthy(vol) && kd !== null ? pyRound((vol as number) / ((kd as number) + 10)) : null;
    out.push({ kw: g.kw, vol, kd, pos: get(g, 'pos'), score });
  }
  return out.length ? out : null;
}

/** _ref_trend (site_analytic.py:387-392). */
function refTrend(history: unknown): number[] | null {
  const list = asList(history);
  if (!list.length) return null;
  const vals = list.map((r) => get(r, 'referring_domains')).filter((v) => v !== null);
  return vals.length ? vals : null;
}

/**
 * NORMALIZE (site_analytic.py:286-384). Pure function: same `raw` → same
 * `facts`. `now` is injected to test collectedAt (in prod — the current UTC).
 */
export function normalize(raw: Raw, now: () => Date = () => new Date()): Facts {
  const ov = asRow(raw.overview);
  const bl = asRow(raw.backlinks);
  const ps = asRow(raw.pagespeed);
  const sw = asRow(raw.similarweb);
  const hist = asList(raw.historical);
  const kws = asList(raw.keywords);

  let [monthLabels, organicSeries, paidSeries] = series(hist);
  let totalSeries: number[] | null = organicSeries
    ? organicSeries.map((o, i) => o + (paidSeries as number[])[i])
    : null;

  // The Similarweb panel (clickstream) overrides the search-based visits estimate.
  const panel = truthy(get(sw, 'visits_monthly'));
  const swEng = asRow(pyOr(get(sw, 'engagement'), {}));
  if (panel) {
    const swHist = asList(get(sw, 'visits_history')).slice(-12);
    if (swHist.length) {
      monthLabels = swHist
        .filter((h) => String(pyOr(get(h, 'month'), '')).slice(5, 7))
        .map((h) => MONTHS_RU[(((Number(String(h.month).slice(5, 7)) - 1) % 12) + 12) % 12]);
      totalSeries = swHist.map((h) => (pyOr(get(h, 'visits'), 0) as number));
      organicSeries = null; // panel months don't break down into channels
    }
  }

  const facts: Facts = {
    // ---- KPI ----
    visits: pyOr(get(sw, 'visits_monthly'), get(ov, 'total_traffic')),
    visitsSource: panel ? 'similarweb' : 'search',
    searchVisits: get(ov, 'total_traffic'),
    growthPct: panel ? growthSeries(totalSeries) : growthPct(hist),
    authority: get(bl, 'authority'),
    kwTotal: get(ov, 'organic_keywords'),
    refDomains: get(bl, 'referring_domains'),
    backlinksTotal: get(bl, 'backlinks'),
    spamScore: get(bl, 'spam_score'),
    bouncePct: get(swEng, 'bounce_rate'),
    pagesPerVisit: get(swEng, 'pages_per_visit'),
    avgSessionSec: get(swEng, 'time_on_site_sec'),

    // ---- traffic ----
    monthLabels,
    trafficByChannel: panel ? panelChannel(totalSeries) : channels(organicSeries, paidSeries),
    totalSeries,
    sources: panel ? swSources(get(sw, 'channels')) : sources(ov),
    geo: panel ? swGeo(get(sw, 'geo')) : geoRows((raw.geo_split as any[]) ?? null),

    // ---- SEO ----
    keywords: keywords(kws),
    intents: intents(kws),
    posDist: posDist(get(ov, 'pos_dist')),
    clusters: null,
    thinCluster: null,
    topPages: topPages(raw.pages),

    // ---- backlinks ----
    anchors: pyOr(raw.anchors, null),
    refDomainsTrend: refTrend(raw.backlinks_history),
    dofollowPct: get(bl, 'dofollow_pct'),

    // ---- technologies / CWV / ads / crowd ----
    tech: tech(raw.technologies),
    perfScore: get(ps, 'perf_score'),
    lcp: get(ps, 'lcp'),
    cls: get(ps, 'cls'),
    inp: get(ps, 'inp'),
    ads: pyOr(raw.ads, null),
    crawl: pyOr(raw.crawl, null),
    entity: pyOr(raw.entity, null),
    mediaMentions: mediaMentions(raw.youtube, raw.yandex_serp, raw.news),

    // ---- competitors ----
    competitors: competitors(raw.competitors, raw.seo_source),
    gapRows: gapRows(raw.gap),

    // ---- AEO / plan (filled in later) ----
    aiBrands: null, sovSelf: null, visTrend: null,
    solutionRate: null, solutionJudged: null,
    aiPromptsRows: null, citations: null, citedPages: null,
    citeSources: null, sentiment: null, foundNotCited: null,
    plan: null, priorities: null,

    meta: {
      domain: pyOr(raw.domain, null),
      compare: pyOr(raw.compare, null),
      geo: pyOr(raw.geo, null),
      seoSource: pyOr(raw.seo_source, null),
      collectedAt: now().toISOString(),
    },
  };
  return facts;
}
