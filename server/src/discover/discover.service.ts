/**
 * "Monitoring" tab lookups — port of core/discover.py.
 *
 * Each lookup is synchronous and cheap: hit one or two external APIs, shape
 * the response for the frontend. No queue, no LLM — which is why these move
 * first.
 *
 * The same fork applies in all three methods: a Russian domain is served by
 * Keys.so, everything else by DataForSEO. The response shape is the same
 * either way; the only difference is which fields the source lacks (those
 * become null).
 *
 * `traffic` is still in Python: it blends DataForSEO history with a
 * Similarweb profile via a proxied RapidAPI wrapper, and moving it along with
 * this step would mean dragging in yet another client. A separate step.
 */
import { Injectable } from '@nestjs/common';
import { DataForSeoClient, supportsDataForSeo } from './dataforseo.client';
import { KeysSoClient } from './keysso.client';

/** Brand name from the domain: first part, capitalized. */
function brandOf(domain: string): string {
  const b = String(domain || '').split('.')[0];
  return b.charAt(0).toUpperCase() + b.slice(1);
}

/** Is this a domain or a search phrase: a domain has no spaces and has a dot. */
function looksLikeDomain(q: string): boolean {
  const s = String(q || '').trim().toLowerCase();
  return !s.includes(' ') && s.includes('.') && (s.split('.').pop()?.length ?? 0) >= 2;
}

/** Three competitor-strength tiers — determines the badge color on the card. */
function strengthOf(value: number | null | undefined, hi: number, mid: number): string {
  const v = value || 0;
  return v >= hi ? 'strong' : v >= mid ? 'medium' : 'weak';
}

// DataForSEO intent code → the string the frontend expects.
const INTENT_FE: Record<string, string> = {
  INFO: 'info', COMM: 'commercial', TX: 'transactional', NAV: 'navigational',
};

@Injectable()
export class DiscoverService {
  constructor(
    private readonly dfs: DataForSeoClient,
    private readonly keysso: KeysSoClient,
  ) {}

  private isRu(domain: string): boolean {
    return !supportsDataForSeo(domain);
  }

  /** Domain competitors. DataForSEO has no audience overlap; Keys.so has no traffic. */
  async competitors(domain: string) {
    if (this.isRu(domain)) {
      const rows = (await this.keysso.domainCompetitors(domain, 12)) || [];
      const maxKeys = Math.max(0, ...rows.map((r) => r.common_keywords || 0));
      const out = rows
        .filter((r) => r.name)
        .map((r) => ({
          name: brandOf(r.name!),
          domain: r.name,
          traffic: null,
          overlap: r.visibility,
          keys: r.common_keywords,
          category: null,
          strength: strengthOf(r.common_keywords, maxKeys * 0.6, maxKeys * 0.25),
        }));
      return out.length ? out : null;
    }

    const rows = (await this.dfs.domainCompetitors(domain, 12)) || [];
    const maxTraffic = Math.max(0, ...rows.map((r: any) => r.traffic || 0));
    const out = rows
      .filter((r: any) => r.domain)
      .map((r: any) => ({
        name: brandOf(r.domain),
        domain: r.domain,
        traffic: r.traffic,
        overlap: null,
        keys: r.shared_keywords,
        category: null,
        strength: strengthOf(r.traffic, maxTraffic * 0.6, maxTraffic * 0.25),
      }));
    return out.length ? out : null;
  }

  /** Keywords: domain → what it ranks for, phrase → ideas around it. */
  async keywords(q: string) {
    const query = String(q || '').trim();
    if (!query) return null;

    if (looksLikeDomain(query)) {
      if (this.isRu(query)) {
        const rows = (await this.keysso.domainKeywords(query, 40)) || [];
        const out = rows
          .filter((r) => r.keyword)
          .map((r) => ({
            kw: r.keyword, volume: r.volume, kd: null, cpc: null,
            intent: 'info', trend: null,
          }));
        return out.length ? out : null;
      }
      const rows = (await this.dfs.domainKeywords(query, 40)) || [];
      const out = rows
        .filter((r: any) => r.keyword)
        .map((r: any) => ({
          kw: r.keyword, volume: r.volume, kd: r.kd, cpc: r.cpc,
          intent: INTENT_FE[r.intent] || 'info', trend: r.trend,
        }));
      return out.length ? out : null;
    }

    // Seed phrase: Keys.so has no idea generation, so we use DataForSEO for RU too.
    const rows = (await this.dfs.keywordIdeas(query, 40)) || [];
    const out = rows
      .filter((r: any) => r.keyword)
      .map((r: any) => ({
        kw: r.keyword, volume: r.volume, kd: r.kd, cpc: r.cpc,
        intent: INTENT_FE[r.intent] || 'info', trend: r.trend,
      }));
    return out.length ? out : null;
  }

  /** Domain profile: four top-line stats plus three tables. */
  async domainProfile(domain: string) {
    const ru = this.isRu(domain);
    const overview =
      (ru ? await this.keysso.domainOverview(domain) : await this.dfs.domainOverview(domain)) ||
      null;
    const backlinks = await this.dfs.domainBacklinks(domain);

    const stats = [
      { key: 'traffic', label: 'Трафик / мес', value: overview?.total_traffic ?? null, delta: null, up: true },
      { key: 'keywords', label: 'Ключей в топе', value: overview?.organic_keywords ?? null, delta: null, up: true },
      { key: 'ads', label: 'Платных ключей', value: overview?.paid_keywords ?? null, delta: null, up: true },
      { key: 'authority', label: 'Авторитет (DR)', value: backlinks?.authority ?? null, delta: null, up: true },
    ];

    let pages: any[] = [];
    let keywordRows: any[] = [];
    let competitorRows: any[] = [];

    if (ru) {
      const kws = (await this.keysso.domainKeywords(domain, 20)) || [];
      keywordRows = kws
        .filter((k) => k.keyword)
        .map((k) => ({ kw: k.keyword, pos: k.rank, volume: k.volume, traffic: null }));
      const comps = (await this.keysso.domainCompetitors(domain, 8)) || [];
      competitorRows = comps
        .filter((c) => c.name)
        .map((c) => ({ d: c.name, overlap: c.visibility, shared: c.common_keywords }));
    } else {
      pages = ((await this.dfs.domainPages(domain, 12)) || [])
        .filter((p: any) => p.url)
        .map((p: any) => ({ url: p.url, traffic: p.clicks, keywords: p.keywords }));
      keywordRows = ((await this.dfs.domainKeywords(domain, 20)) || [])
        .filter((k: any) => k.keyword)
        .map((k: any) => ({ kw: k.keyword, pos: k.rank, volume: k.volume, traffic: k.clicks }));
      competitorRows = ((await this.dfs.domainCompetitors(domain, 8)) || [])
        .filter((c: any) => c.domain)
        .map((c: any) => ({ d: c.domain, overlap: null, shared: c.shared_keywords }));
    }

    if (!overview && !pages.length && !keywordRows.length && !competitorRows.length) return null;
    return {
      stats,
      pages: pages.length ? pages : null,
      keywords: keywordRows.length ? keywordRows : null,
      competitors: competitorRows.length ? competitorRows : null,
    };
  }
}
