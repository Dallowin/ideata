/**
 * Perplexity parser core — parsePerplexity on SYNTHETIC envelopes (sonar
 * chat-completions shape). KEY POINT: sources arrive in TWO places at once —
 * the top-level `citations` (bare URLs) and `search_results[]` (the same URLs
 * with titles) — both are accepted and deduped with title back-filling.
 */
import { parsePerplexity, toPerplexityModel } from './perplexity';

describe('parsePerplexity — sonar envelope (citations + search_results)', () => {
  const env = {
    choices: [{ message: { role: 'assistant', content: 'Sonar answer.' } }],
    citations: ['https://a.com/x', 'https://b.com'],
    search_results: [
      { title: 'A title', url: 'https://a.com/x', date: '2026-01-02' },
      { title: 'C title', url: 'https://c.com' },
    ],
    usage: { prompt_tokens: 210, completion_tokens: 90 },
  };

  it('text from choices[0].message.content', () => {
    expect(parsePerplexity(env).text).toBe('Sonar answer.');
  });

  it('both formats merged, deduped by URL, title back-filled from search_results', () => {
    expect(parsePerplexity(env).citations).toEqual([
      { url: 'https://a.com/x', title: 'A title' },
      { url: 'https://b.com', title: '' },
      { url: 'https://c.com', title: 'C title' },
    ]);
  });

  it('tokens: prompt_tokens/completion_tokens', () => {
    const p = parsePerplexity(env);
    expect([p.tokensIn, p.tokensOut]).toEqual([210, 90]);
  });

  it('citations only (no search_results) → bare URLs without titles', () => {
    const p = parsePerplexity({
      choices: [{ message: { content: 'X' } }],
      citations: ['https://p1.com', 'https://p2.com'],
    });
    expect(p.citations).toEqual([
      { url: 'https://p1.com', title: '' },
      { url: 'https://p2.com', title: '' },
    ]);
  });

  it('search_results only → sources with titles', () => {
    const p = parsePerplexity({
      choices: [{ message: { content: 'X' } }],
      search_results: [{ title: 'S1', url: 'https://s1.com' }, { url: 'https://s2.com' }],
    });
    expect(p.citations).toEqual([
      { url: 'https://s1.com', title: 'S1' },
      { url: 'https://s2.com', title: '' },
    ]);
  });

  it('an object entry in citations is accepted too ({url,title})', () => {
    const p = parsePerplexity({
      choices: [{ message: { content: 'X' } }],
      citations: [{ url: 'https://o.com', title: 'O' }],
    });
    expect(p.citations).toEqual([{ url: 'https://o.com', title: 'O' }]);
  });

  it('content split into parts → joined with a space', () => {
    const env2 = { choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }] } }] };
    expect(parsePerplexity(env2).text).toBe('a b');
  });
});

describe('parsePerplexity — empty/malformed envelope', () => {
  it('{} → text="", citations=[], tokens null', () => {
    expect(parsePerplexity({})).toEqual({ text: '', citations: [], tokensIn: null, tokensOut: null });
  });
  it('choices=[] → empty', () => {
    expect(parsePerplexity({ choices: [] }).text).toBe('');
  });
  it('an error envelope has no choices → text empty (the transport raises on it)', () => {
    expect(parsePerplexity({ error: { message: 'invalid model', code: 'bad_request' } }).text).toBe('');
  });
  it('null envelope does not throw', () => {
    expect(parsePerplexity(null).text).toBe('');
    expect(parsePerplexity(null).citations).toEqual([]);
  });
  it('sources without a URL are dropped', () => {
    const p = parsePerplexity({
      choices: [{ message: { content: 'X' } }],
      search_results: [{ title: 'no url' }, { title: 'ok', url: 'https://ok.com' }],
    });
    expect(p.citations).toEqual([{ url: 'https://ok.com', title: 'ok' }]);
  });
  it('usage missing the needed fields → tokens null', () => {
    const p = parsePerplexity({ choices: [{ message: { content: 'x' } }], usage: {} });
    expect([p.tokensIn, p.tokensOut]).toEqual([null, null]);
  });
});

describe('toPerplexityModel — model id → API slug', () => {
  it('perplexity/… → prefix stripped', () => {
    expect(toPerplexityModel('perplexity/sonar')).toBe('sonar');
    expect(toPerplexityModel('perplexity/sonar-pro')).toBe('sonar-pro');
  });
  it(':online/:free/:nitro suffixes dropped', () => {
    expect(toPerplexityModel('perplexity/sonar:online')).toBe('sonar');
    expect(toPerplexityModel('sonar-reasoning:nitro')).toBe('sonar-reasoning');
  });
  it('an API slug passes through unchanged', () => {
    expect(toPerplexityModel('sonar')).toBe('sonar');
    expect(toPerplexityModel('sonar-reasoning-pro')).toBe('sonar-reasoning-pro');
  });
  it('whitespace trimmed, empty input → empty', () => {
    expect(toPerplexityModel('  perplexity/sonar  ')).toBe('sonar');
    expect(toPerplexityModel('')).toBe('');
  });
});
