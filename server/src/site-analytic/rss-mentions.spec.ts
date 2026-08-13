/**
 * News mentions (Google News RSS): deterministic parsing (parseDate /
 * parseNewsXml) on synthetic input + the network shell (googleNews /
 * brandMentions) over an INJECTED text transport. There are no keys, but we still
 * do not touch the live feed.
 */
import { parseDate, parseNewsXml, googleNews, brandMentions } from './rss-mentions';
import type { HttpGetText } from './http';

describe('parseDate — RFC-822 → ISO-8601 UTC', () => {
  it.each([
    ['Sat, 01 Feb 2026 10:00:00 GMT', '2026-02-01T10:00:00+00:00'],
    ['Mon, 31 Dec 2025 23:30:00 +0000', '2025-12-31T23:30:00+00:00'],
    ['Sat, 01 Feb 2026 13:00:00 +0300', '2026-02-01T10:00:00+00:00'], // offset → UTC
    ['Tue, 01 Jan 2030 00:30:00 -0100', '2030-01-01T01:30:00+00:00'],
  ])('%s → %s', (raw, iso) => {
    expect(parseDate(raw as string)).toBe(iso);
  });
  it('malformed date → null', () => {
    expect(parseDate('bad date')).toBeNull();
    expect(parseDate('')).toBeNull();
    expect(parseDate('2026-02-01')).toBeNull();
  });
});

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Google News</title>
  <item>
    <title>Компания X запустила Y - РБК</title>
    <link>https://news.google.com/x</link>
    <pubDate>Sat, 01 Feb 2026 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Заголовок   без   издания</title>
    <link>https://news.google.com/y</link>
    <source>Ведомости</source>
    <pubDate>bad date</pubDate>
  </item>
  <item><description>нет заголовка</description></item>
</channel></rss>`;

describe('parseNewsXml — news rows', () => {
  it('publisher from the title tail / from <source>; empty title is skipped', () => {
    const rows = parseNewsXml(RSS, 20);
    expect(rows).toEqual([
      { title: 'Компания X запустила Y', url: 'https://news.google.com/x', source: 'РБК', published_at: '2026-02-01T10:00:00+00:00' },
      { title: 'Заголовок без издания', url: 'https://news.google.com/y', source: 'Ведомости', published_at: null },
    ]);
  });

  it('limit=0 → 1 row (length check AFTER append, as in CPython)', () => {
    expect(parseNewsXml(RSS, 0)).toHaveLength(1);
  });

  it('broken XML → []', () => {
    expect(parseNewsXml('<not xml', 20)).toEqual([]);
    expect(parseNewsXml('', 20)).toEqual([]);
  });
});

const okText = (text: string): { status: number; text: string } => ({ status: 200, text });

describe('googleNews — network shell (mock transport)', () => {
  it('empty query → []', async () => {
    const trap = jest.fn();
    expect(await googleNews('', { get: trap as unknown as HttpGetText })).toEqual([]);
    expect(trap).not.toHaveBeenCalled();
  });

  it('days → the when:Nd operator; ceid/hl/gl passed through', async () => {
    let seen: Record<string, unknown> | null | undefined;
    const get: HttpGetText = async (_u, p) => { seen = p; return okText(RSS); };
    await googleNews('бренд', { get, days: 90, lang: 'ru', geo: 'RU' });
    expect(seen?.q).toBe('бренд when:90d');
    expect(seen?.hl).toBe('ru');
    expect(seen?.gl).toBe('RU');
    expect(seen?.ceid).toBe('RU:ru');
  });

  it('HTTP≠200 / empty body → []', async () => {
    expect(await googleNews('q', { get: async () => ({ status: 404, text: '' }) })).toEqual([]);
    expect(await googleNews('q', { get: async () => okText('   ') })).toEqual([]);
  });
});

describe('brandMentions — brand + domain, dedupe by title', () => {
  it('the domain is searched with a separate query; title duplicates are filtered out', async () => {
    const brandRss = RSS; // «Компания X…» + «Заголовок без издания»
    const domainRss = `<?xml version="1.0"?><rss><channel>
      <item><title>Компания X запустила Y - РБК</title><link>https://d/1</link></item>
      <item><title>Новое про домен - Коммерсант</title><link>https://d/2</link></item>
    </channel></rss>`;
    const get: HttpGetText = async (_u, p) => {
      const q = String((p || {}).q || '');
      return okText(q.startsWith('acme.com') ? domainRss : brandRss);
    };
    const rows = await brandMentions('acme', 'acme.com', { get, limit: 20 });
    const titles = rows.map((r) => r.title);
    // «Компания X запустила Y» appears in both feeds → kept once; «Новое про домен» is added
    expect(titles).toEqual(['Компания X запустила Y', 'Заголовок без издания', 'Новое про домен']);
  });
});
