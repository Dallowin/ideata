/**
 * Parity test for the homepage crawl against the EXTRACTION part of
 * core/crawl_audit.py (audit() + _hero_text + _headings). The expected values
 * were captured from LIVE Python (.venv on the reference server) using the
 * same source functions on the same fixtures — see the describe.each
 * parameters. We check three tricky invariants:
 *   • title does NOT collapse internal whitespace, only trims edges;
 *   • the h1 field is the first h1 of the FULL document (may be in nav), while
 *     headings are taken after nav/footer/script have been stripped;
 *   • get_text puts a space between nodes (span+span don't stick together).
 * Plus the crawlHomepage network shell on a mock transport (no real network)
 * and the SSRF gate.
 */
import {
  parseHomepageContext,
  crawlHomepage,
  type CrawlContext,
} from './crawl';

// ── fixtures (1:1 with /tmp/cfix, which the oracle was captured against) ─────

const BASIC = `<!doctype html><html><head>
<title>  Acme  Analytics  —  AEO платформа </title>
<meta name="description" content="  Отслеживайте упоминания бренда в ответах ИИ.  ">
<meta property="og:description" content="og fallback should be ignored">
</head><body>
<nav><h1>NAV BRAND</h1><p>menu item</p></nav>
<h1>Видимость <span>вашего</span>   бренда в ИИ</h1>
<p>Мы измеряем, как <b>ChatGPT</b> и Алиса отвечают про вас.</p>
<h2>Как это работает</h2>
<p>Промпты, движки, отчёты каждую неделю.</p>
<h3>Движки</h3>
<h3>Отчёты</h3>
<footer><h2>Footer heading</h2><p>copyright</p></footer>
<script>var x = "ignore";</script>
</body></html>`;

const OGFALLBACK = `<!doctype html><html><head>
<title></title>
<meta property="og:description" content="  Fallback OG description text.  ">
</head><body>
<h1>First H1</h1>
<h1>Second H1</h1>
<h2>Alpha</h2><h2></h2><h2>Beta</h2>
<p>   Lots   of    whitespace   here   </p>
</body></html>`;

const NOMETA = `<html><head><title>NoDesc Co</title></head><body>
<article><p>Intro paragraph one.</p><p>Intro paragraph one.</p><p>Second para.</p></article>
</body></html>`;

// ── reference values from live Python ─────────────────────────────────────────

interface Expected {
  title: string | null;
  description: string | null;
  h1: string | null;
  hero_text: string | null;
  headings: CrawlContext['headings'];
}

const ORACLE: Array<[string, string, Expected]> = [
  [
    'basic',
    BASIC,
    {
      title: 'Acme  Analytics  —  AEO платформа',
      description: 'Отслеживайте упоминания бренда в ответах ИИ.',
      h1: 'NAV BRAND',
      hero_text:
        'Видимость вашего бренда в ИИ • Мы измеряем, как ChatGPT и Алиса отвечают про вас. • Как это работает • Промпты, движки, отчёты каждую неделю.',
      headings: {
        h1: ['Видимость вашего бренда в ИИ'],
        h1_count: 1,
        h2: ['Как это работает'],
        h2_count: 1,
        h3: ['Движки', 'Отчёты'],
        h3_count: 2,
      },
    },
  ],
  [
    'ogfallback',
    OGFALLBACK,
    {
      title: '',
      description: 'Fallback OG description text.',
      h1: 'First H1',
      hero_text: 'First H1 • Second H1 • Alpha • Beta • Lots of whitespace here',
      headings: {
        h1: ['First H1', 'Second H1'],
        h1_count: 2,
        h2: ['Alpha', 'Beta'],
        h2_count: 3,
        h3: [],
        h3_count: 0,
      },
    },
  ],
  [
    'nometa',
    NOMETA,
    {
      title: 'NoDesc Co',
      description: null,
      h1: null,
      hero_text: 'Intro paragraph one. • Second para.',
      headings: {
        h1: [],
        h1_count: 0,
        h2: [],
        h2_count: 0,
        h3: [],
        h3_count: 0,
      },
    },
  ],
];

describe('parseHomepageContext — parity with core/crawl_audit.py', () => {
  describe.each(ORACLE)('%s', (_name, html, exp) => {
    const ctx = () => parseHomepageContext(html, 'example.com');

    it('title (trim edges, do NOT collapse internal whitespace)', () => {
      expect(ctx().title).toBe(exp.title);
    });
    it('description (name→og:description fallback, strip or null)', () => {
      expect(ctx().description).toBe(exp.description);
    });
    it('h1 (first h1 of the full document, before nav is stripped)', () => {
      expect(ctx().h1).toBe(exp.h1);
    });
    it('hero_text (first h1/h2/p after stripping, dedup, " • ")', () => {
      expect(ctx().hero_text).toBe(exp.hero_text);
    });
    it('headings (after stripping nav/footer; count over all, list ≤8 non-empty)', () => {
      expect(ctx().headings).toEqual(exp.headings);
    });
  });
});

describe('parseHomepageContext — pinpoint invariants', () => {
  it('space between adjacent nodes (get_text separator=" ")', () => {
    const ctx = parseHomepageContext(
      '<html><body><h1><span>ChatGPT</span><span>Алиса</span></h1></body></html>',
      'x.io',
    );
    expect(ctx.headings.h1).toEqual(['ChatGPT Алиса']);
  });

  it('no <title> → null, but an empty <title> → ""', () => {
    expect(parseHomepageContext('<html><body><p>x</p></body></html>', 'x.io').title).toBeNull();
    expect(parseHomepageContext('<html><head><title></title></head><body></body></html>', 'x.io').title).toBe('');
  });

  it('empty crawl → empty fields, not garbage', () => {
    const ctx = parseHomepageContext('<html><head></head><body></body></html>', 'x.io');
    expect(ctx.title).toBeNull();
    expect(ctx.h1).toBeNull();
    expect(ctx.hero_text).toBeNull();
    expect(ctx.headings.h1_count).toBe(0);
  });

  it('h1 is truncated to 200 code points', () => {
    const long = 'ф'.repeat(300);
    const ctx = parseHomepageContext(`<html><body><h1>${long}</h1></body></html>`, 'x.io');
    expect([...(ctx.h1 as string)]).toHaveLength(200);
  });

  it('hero cuts off around 700 characters', () => {
    const p = (i: number) => `<p>${'a'.repeat(200)}${i}</p>`;
    const html = `<html><body>${p(1)}${p(2)}${p(3)}${p(4)}${p(5)}</body></html>`;
    const ctx = parseHomepageContext(html, 'x.io');
    expect([...(ctx.hero_text as string)].length).toBeLessThanOrEqual(700);
  });
});

describe('crawlHomepage — network shell (mock transport)', () => {
  const okGet = (html: string) => async () => new Response(html, { status: 200 });

  it('domain → context via GET injection (no real network)', async () => {
    const ctx = await crawlHomepage('example.com', { get: okGet(BASIC) });
    expect(ctx?.title).toBe('Acme  Analytics  —  AEO платформа');
    expect(ctx?.headings.h3).toEqual(['Движки', 'Отчёты']);
  });

  it('normalizes a messy domain before the request', async () => {
    let seen = '';
    const ctx = await crawlHomepage('HTTPS://WWW.Example.com/some/path?q=1', {
      get: async (u) => {
        seen = u;
        return new Response(NOMETA, { status: 200 });
      },
    });
    expect(seen).toBe('https://example.com/');
    expect(ctx?.title).toBe('NoDesc Co');
  });

  it('404/unreachable → null (best-effort, suggest doesn\'t fail)', async () => {
    expect(await crawlHomepage('example.com', { get: async () => new Response('', { status: 404 }) })).toBeNull();
    expect(await crawlHomepage('example.com', { get: async () => null })).toBeNull();
  });

  it('SSRF gate: private/internal host → null without a request', async () => {
    const trap = jest.fn(async () => new Response(BASIC, { status: 200 }));
    for (const d of ['localhost', '127.0.0.1', '192.168.0.5', '169.254.169.254', 'intranet']) {
      expect(await crawlHomepage(d, { get: trap })).toBeNull();
    }
    expect(trap).not.toHaveBeenCalled();
  });

  it('empty/malformed domain → null', async () => {
    expect(await crawlHomepage('', {})).toBeNull();
  });
});

describe('crawlHomepage — SSRF on redirects (gate on every hop)', () => {
  it('requests go out with redirect:manual (auto-follow disabled)', async () => {
    const get = jest.fn(async () => new Response(BASIC, { status: 200 }));
    await crawlHomepage('example.com', { get });
    expect(get).toHaveBeenCalledWith(
      'https://example.com/',
      expect.objectContaining({ redirect: 'manual' }),
    );
  });

  it('3xx to a private IP is NOT followed — internal address untouched', async () => {
    const calls: string[] = [];
    const get = jest.fn(async (u: string) => {
      calls.push(u);
      // the user's public site redirects into internal-network Postgres
      return new Response('', { status: 302, headers: { location: 'https://192.168.0.5/latest' } });
    });
    expect(await crawlHomepage('shop.example', { get })).toBeNull();
    expect(calls).toEqual(['https://shop.example/']); // no request was made to 192.168.0.5
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('3xx to link-local (cloud tokens) is NOT followed', async () => {
    const calls: string[] = [];
    const get = jest.fn(async (u: string) => {
      calls.push(u);
      return new Response('', {
        status: 301,
        headers: { location: 'http://169.254.169.254/latest/meta-data/iam/' },
      });
    });
    expect(await crawlHomepage('evil.example', { get })).toBeNull();
    expect(calls).toEqual(['https://evil.example/']);
  });

  it('follows a PUBLIC https redirect (different host) and parses the final page', async () => {
    const get = jest.fn(async (u: string) => {
      if (u === 'https://old.example/') {
        return new Response('', { status: 301, headers: { location: 'https://new.example/home' } });
      }
      return new Response(NOMETA, { status: 200 });
    });
    const ctx = await crawlHomepage('old.example', { get });
    expect(ctx?.title).toBe('NoDesc Co');
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('a loop/too-long chain of public redirects breaks off to null', async () => {
    let n = 0;
    const get = jest.fn(async () => {
      n += 1;
      return new Response('', { status: 302, headers: { location: `https://h${n}.example/` } });
    });
    expect(await crawlHomepage('start.example', { get })).toBeNull();
    // bounded by the hop cap, doesn't spin forever
    expect(get.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it('3xx without a Location → null', async () => {
    const get = jest.fn(async () => new Response('', { status: 302 }));
    expect(await crawlHomepage('example.com', { get })).toBeNull();
  });
});
