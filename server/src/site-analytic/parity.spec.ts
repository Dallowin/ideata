/**
 * Golden parity of the site-analytic ports against LIVE core/*.py. The reference
 * was captured by running the Python functions themselves (schema_lint.lint /
 * meta_ads.ads+_since_ru / social.youtube_interest / entity_kg.brand_entity+_host /
 * competitors.* / research._to_int / str.title) on synthetic input; Python's
 * network was replaced by an httpx.get router (we don't burn paid APIs), core.aeo
 * by a stub with the same three host lists as in parse.ts. The corpus is
 * _fixtures/parity_corpus.json (generator: scratchpad/gen_corpus.py). Criterion:
 * deepDiff(ported, golden) === [] on EVERY pair (deepDiff canonicalizes both
 * sides — key order and the sign of -0/0 are accounted for).
 *
 * DETERMINISTIC branches: competitors is run in Python with az=None (== the LLM
 * stub → null here), so extract yields [], validate yields {}, and onboarding is
 * trusted without a verdict. The LLM branches (real ask) are covered in
 * competitors.spec.ts.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { deepDiff } from '../aeo/parity/diff';

import { lint } from './schema-lint';
import { ads, sinceRu } from './meta-ads';
import { youtubeInterest } from './youtube';
import { brandEntity, hostOf } from './entity-kg';
import {
  hostLike, isNonCompetitorHost, buildCompetitors, parseOnboardingCompetitors,
  type AskJson,
} from './competitors';
import { toIntLoose, pyTitle } from './pyutil';
import type { HttpGet, JsonResp } from './http';

interface Corpus {
  schema_lint: Array<{ html: string; out: unknown }>;
  since_ru: Array<{ iso: unknown; out: unknown }>;
  to_int: Array<{ in: unknown; out: unknown }>;
  py_title: Array<{ in: string; out: unknown }>;
  host_like: Array<{ in: unknown; out: unknown }>;
  is_non_competitor: Array<{ in: unknown; out: unknown }>;
  host_of: Array<{ in: unknown; out: unknown }>;
  parse_onboarding: Array<{ comps: unknown; out: unknown }>;
  meta_ads: Array<{ brand: string; limit: number; items: unknown[]; out: unknown }>;
  youtube: Array<{
    query: string; shorts: boolean; region: string | null;
    search: unknown; videos: unknown; channels: unknown; out: unknown;
  }>;
  entity_kg: Array<{
    domain: string; name: string | null; langs: string[]; ent: any; out: unknown;
  }>;
  build_competitors: Array<{
    domain: string; about: string; seo_rows: any[]; onboarding: string[]; out: unknown;
  }>;
}

const CORPUS: Corpus = JSON.parse(
  readFileSync(join(__dirname, '_fixtures', 'parity_corpus.json'), 'utf8'),
);

/** Collect the first ported↔golden divergences with context (as in parse.parity). */
function collect<T>(
  cases: readonly T[],
  ported: (c: T) => unknown,
  golden: (c: T) => unknown,
  label: (c: T, i: number) => string,
): string[] {
  const out: string[] = [];
  cases.forEach((c, i) => {
    const p = ported(c);
    const paths = deepDiff(p, golden(c));
    if (paths.length) {
      out.push(
        `#${i} ${label(c, i)}\n   ported=${JSON.stringify(p)}\n   golden=${JSON.stringify(
          golden(c),
        )}\n   paths=${paths.slice(0, 8).join(',')}`,
      );
    }
  });
  return out;
}

async function collectAsync<T>(
  cases: readonly T[],
  ported: (c: T) => Promise<unknown>,
  golden: (c: T) => unknown,
  label: (c: T, i: number) => string,
): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < cases.length; i += 1) {
    const c = cases[i];
    const p = await ported(c);
    const paths = deepDiff(p, golden(c));
    if (paths.length) {
      out.push(
        `#${i} ${label(c, i)}\n   ported=${JSON.stringify(p)}\n   golden=${JSON.stringify(
          golden(c),
        )}\n   paths=${paths.slice(0, 8).join(',')}`,
      );
    }
  }
  return out;
}

const NULL_ASK: AskJson = async () => null; // == Python's az is None

// ── transport routers: mirror router() from gen_corpus.py ────────────────────
const metaGet = (items: unknown[]): HttpGet =>
  async () => ({ status: 200, body: { data: items } });

const youtubeGet = (c: Corpus['youtube'][number]): HttpGet =>
  async (url: string): Promise<JsonResp> => {
    if (url.includes('youtube/v3/search')) return { status: 200, body: c.search };
    if (url.includes('youtube/v3/videos')) return { status: 200, body: c.videos };
    if (url.includes('youtube/v3/channels')) return { status: 200, body: c.channels };
    return { status: 404, body: {} };
  };

const entityGet = (ent: any): HttpGet =>
  async (url: string, params?: Record<string, unknown> | null): Promise<JsonResp> => {
    if (url.includes('wikidata.org')) {
      const p = params || {};
      if (p.action === 'wbsearchentities') {
        return { status: 200, body: { search: (ent.search || {})[p.language as string] || [] } };
      }
      if (p.action === 'wbgetentities') {
        const ids = String(p.ids);
        const e = (ent.entities || {})[ids];
        return { status: 200, body: { entities: e ? { [ids]: e } : {} } };
      }
    }
    if (url.includes('wikimedia.org')) return { status: 200, body: ent.pageviews || {} };
    return { status: 404, body: {} };
  };

describe('site-analytic — golden parity with core/*.py', () => {
  it('corpus loaded and is non-empty', () => {
    expect(CORPUS.schema_lint.length).toBeGreaterThan(0);
    expect(CORPUS.build_competitors.length).toBeGreaterThan(0);
    expect(CORPUS.entity_kg.length).toBeGreaterThan(0);
  });

  it('schema_lint.lint', () => {
    const m = collect(
      CORPUS.schema_lint,
      (c) => lint(c.html),
      (c) => c.out,
      (c) => `html="${c.html.slice(0, 60)}"`,
    );
    expect(m).toEqual([]);
  });

  it('meta_ads._since_ru', () => {
    const m = collect(
      CORPUS.since_ru,
      (c) => sinceRu(c.iso),
      (c) => c.out,
      (c) => `iso=${JSON.stringify(c.iso)}`,
    );
    expect(m).toEqual([]);
  });

  it('research._to_int (toIntLoose)', () => {
    const m = collect(
      CORPUS.to_int,
      (c) => toIntLoose(c.in),
      (c) => c.out,
      (c) => `in=${JSON.stringify(c.in)}`,
    );
    expect(m).toEqual([]);
  });

  it('str.title (pyTitle)', () => {
    const m = collect(
      CORPUS.py_title,
      (c) => pyTitle(c.in),
      (c) => c.out,
      (c) => `in=${JSON.stringify(c.in)}`,
    );
    expect(m).toEqual([]);
  });

  it('competitors._host_like (hostLike)', () => {
    const m = collect(
      CORPUS.host_like,
      (c) => hostLike(c.in),
      (c) => c.out,
      (c) => `in=${JSON.stringify(c.in)}`,
    );
    expect(m).toEqual([]);
  });

  it('competitors.is_non_competitor_host', () => {
    const m = collect(
      CORPUS.is_non_competitor,
      (c) => isNonCompetitorHost(c.in),
      (c) => c.out,
      (c) => `in=${JSON.stringify(c.in)}`,
    );
    expect(m).toEqual([]);
  });

  it('entity_kg._host (hostOf)', () => {
    const m = collect(
      CORPUS.host_of,
      (c) => hostOf(c.in),
      (c) => c.out,
      (c) => `in=${JSON.stringify(c.in)}`,
    );
    expect(m).toEqual([]);
  });

  it('competitors.onboarding-parse (parseOnboardingCompetitors)', () => {
    const m = collect(
      CORPUS.parse_onboarding,
      (c) => parseOnboardingCompetitors(c.comps),
      (c) => c.out,
      (c) => `comps=${JSON.stringify(c.comps)}`,
    );
    expect(m).toEqual([]);
  });

  it('meta_ads.ads', async () => {
    const m = await collectAsync(
      CORPUS.meta_ads,
      (c) => ads(c.brand, { token: 'fake-token', limit: c.limit, get: metaGet(c.items) }),
      (c) => c.out,
      (c) => `brand=${c.brand}`,
    );
    expect(m).toEqual([]);
  });

  it('social.youtube_interest', async () => {
    const m = await collectAsync(
      CORPUS.youtube,
      (c) => youtubeInterest(c.query, {
        apiKey: 'k', region: c.region, shorts: c.shorts, get: youtubeGet(c),
      }),
      (c) => c.out,
      (c) => `query=${c.query}`,
    );
    expect(m).toEqual([]);
  });

  it('entity_kg.brand_entity', async () => {
    const m = await collectAsync(
      CORPUS.entity_kg,
      (c) => brandEntity(c.domain, {
        name: c.name, langs: c.langs, get: entityGet(c.ent), now: new Date('2026-08-10T00:00:00Z'),
      }),
      (c) => c.out,
      (c) => `domain=${c.domain}`,
    );
    expect(m).toEqual([]);
  });

  it('competitors.build_competitors (az=None deterministic branch)', async () => {
    const m = await collectAsync(
      CORPUS.build_competitors,
      (c) => buildCompetitors({
        domain: c.domain, about: c.about, seoRows: c.seo_rows,
        answers: [], onboarding: c.onboarding, ask: NULL_ASK,
      }),
      (c) => c.out,
      (c) => `domain=${c.domain}`,
    );
    expect(m).toEqual([]);
  });
});
