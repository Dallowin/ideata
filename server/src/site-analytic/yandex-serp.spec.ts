/**
 * Yandex press SERP: deterministic SERP-XML parsing (parseSerpXml /
 * cleanXmlText / occupancyBucket) on synthetic data + the network shell
 * (yandexSerp) over an INJECTED POST transport — we do not burn the paid Search
 * API. Regex parsing and base64 decoding are verified against demand.py.
 */
import { parseSerpXml, cleanXmlText, occupancyBucket, yandexSerp, type SerpBlock } from './yandex-serp';
import type { HttpPostJson } from './http';

describe('cleanXmlText — tags/entities/whitespace', () => {
  it('strips tags, decodes entities, collapses whitespace', () => {
    expect(cleanXmlText('<b>a</b> &amp; b')).toBe('a & b');
    expect(cleanXmlText('  x   y  ')).toBe('x y');
    expect(cleanXmlText('&lt;тег&gt;')).toBe('<тег>');
    expect(cleanXmlText('&#1090;&#1077;&#1089;&#1090;')).toBe('тест'); // numeric
    expect(cleanXmlText('&#x442;')).toBe('т'); // hex
    expect(cleanXmlText(null)).toBe('');
  });
});

describe('occupancyBucket — saturation thresholds', () => {
  it.each([
    [500, 'empty'],
    [999, 'empty'],
    [1000, 'some'],
    [5000, 'some'],
    [99999, 'some'],
    [100000, 'saturated'],
    [250000, 'saturated'],
  ])('%i → %s', (n, bucket) => {
    expect(occupancyBucket(n as number)).toBe(bucket);
  });
});

const XML = `<?xml version="1.0"?>
<yandexsearch>
  <response>
    <found priority="phrase">12345</found>
    <found priority="all">99999</found>
    <results>
      <doc>
        <url>https://a.com/page</url>
        <title>Заголовок &amp; <hlword>тест</hlword></title>
        <passage>Первый <hlword>кусок</hlword> текста</passage>
        <passage>Второй кусок</passage>
      </doc>
      <doc>
        <url>https://b.com</url>
        <title>Второй</title>
      </doc>
      <doc><snippet>ни url ни title</snippet></doc>
    </results>
  </response>
</yandexsearch>`;

describe('parseSerpXml — counter + snippets', () => {
  it('results_count = max(found); a doc without url/title is skipped', () => {
    const p = parseSerpXml(XML);
    expect(p.results_count).toBe(99999);
    expect(p.results).toEqual([
      { title: 'Заголовок & тест', url: 'https://a.com/page', passage: 'Первый кусок текста Второй кусок' },
      { title: 'Второй', url: 'https://b.com', passage: null },
    ]);
  });

  it('no <found> → results_count = null', () => {
    const p = parseSerpXml('<doc><url>https://x.io</url></doc>');
    expect(p.results_count).toBeNull();
    expect(p.results).toEqual([{ title: null, url: 'https://x.io', passage: null }]);
  });
});

const ok = (body: unknown): { status: number; body: unknown } => ({ status: 200, body });
const b64 = (s: string): string => Buffer.from(s, 'utf-8').toString('base64');

describe('yandexSerp — network shell (mocked POST)', () => {
  it('no query → null; no key/folder → null (no POST is sent)', async () => {
    const trap = jest.fn();
    expect(await yandexSerp('', { apiKey: 'k', folderId: 'f', post: trap as unknown as HttpPostJson })).toBeNull();
    expect(await yandexSerp('q', { apiKey: '', folderId: 'f', post: trap as unknown as HttpPostJson })).toBeNull();
    expect(await yandexSerp('q', { apiKey: 'k', folderId: '', post: trap as unknown as HttpPostJson })).toBeNull();
    expect(trap).not.toHaveBeenCalled();
  });

  it('happy path: base64 rawData → block; request body and header are correct', async () => {
    let seenBody: any; let seenHeaders: any; let seenUrl = '';
    const post: HttpPostJson = async (url, body, headers) => {
      seenUrl = url; seenBody = body; seenHeaders = headers;
      return ok({ rawData: b64(XML) });
    };
    const out = (await yandexSerp('крауд игры', { apiKey: 'K', folderId: 'F', post, maxResults: 1 })) as SerpBlock;
    expect(seenUrl).toContain('/web/search');
    expect(seenBody.query.queryText).toBe('крауд игры');
    expect(seenBody.folderId).toBe('F');
    expect(seenHeaders.Authorization).toBe('Api-Key K');
    expect(out.results_count).toBe(99999);
    expect(out.occupancy).toBe('some');
    expect(out.source).toBe('yandex_api');
    expect(out.results).toHaveLength(1); // maxResults=1
  });

  it('HTTP≠200 / no rawData → null', async () => {
    expect(await yandexSerp('q', { apiKey: 'k', folderId: 'f', post: async () => ({ status: 500, body: {} }) })).toBeNull();
    expect(await yandexSerp('q', { apiKey: 'k', folderId: 'f', post: async () => ok({}) })).toBeNull();
  });

  it('broken base64 → broken XML does not crash (empty results)', async () => {
    // invalid base64 decodes to garbage → parseSerpXml yields empty results.
    const out = (await yandexSerp('q', { apiKey: 'k', folderId: 'f', post: async () => ok({ rawData: '@@@' }) })) as SerpBlock;
    expect(out.results).toEqual([]);
    expect(out.results_count).toBeNull();
  });
});
