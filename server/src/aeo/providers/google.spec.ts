/**
 * Gemini parser core — parseGemini on SYNTHETIC envelopes (generateContent
 * shape). We don't burn live calls; we check that text/citations/tokens are
 * correctly extracted, including the groundingMetadata of a google_search answer.
 */
import { parseGemini, toGeminiModel } from './google';

describe('parseGemini — generateContent envelope (grounded)', () => {
  const env = {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: 'Answer part 1.' }, { text: 'Part 2.' }],
        },
        groundingMetadata: {
          webSearchQueries: ['aeo tools'],
          groundingChunks: [
            { web: { uri: 'https://a.com/x', title: 'A title' } },
            { web: { uri: 'https://b.com' } }, // no title
            { web: { uri: 'https://a.com/x', title: 'Later title' } }, // duplicate URL
            { retrievedContext: { uri: 'https://ignored.com' } }, // not a web chunk
          ],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 55, candidatesTokenCount: 88 },
  };

  it('joins the candidate parts with a space and .strip()', () => {
    expect(parseGemini(env).text).toBe('Answer part 1. Part 2.');
  });

  it('citations from groundingChunks[].web, deduped by URL, non-web chunks dropped', () => {
    expect(parseGemini(env).citations).toEqual([
      { url: 'https://a.com/x', title: 'A title' },
      { url: 'https://b.com', title: '' },
    ]);
  });

  it('tokens: usageMetadata promptTokenCount/candidatesTokenCount', () => {
    const p = parseGemini(env);
    expect([p.tokensIn, p.tokensOut]).toEqual([55, 88]);
  });

  it('a part without text does not add anything to the answer', () => {
    const p = parseGemini({
      candidates: [{ content: { parts: [{ text: 'Answer.' }, { thought: true }] } }],
    });
    expect(p.text).toBe('Answer.');
  });

  it('ungrounded answer (no groundingMetadata): text only, citations empty', () => {
    const p = parseGemini({
      candidates: [{ content: { parts: [{ text: 'Plain answer.' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20 },
    });
    expect(p).toEqual({ text: 'Plain answer.', citations: [], tokensIn: 10, tokensOut: 20 });
  });

  it('a bare URL picks up the title from a later chunk with the same URL', () => {
    const p = parseGemini({
      candidates: [
        {
          content: { parts: [{ text: 'T' }] },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://c.com' } },
              { web: { uri: 'https://c.com', title: 'C' } },
            ],
          },
        },
      ],
    });
    expect(p.citations).toEqual([{ url: 'https://c.com', title: 'C' }]);
  });
});

describe('parseGemini — empty/malformed envelope', () => {
  it('{} → text="", citations=[], tokens null', () => {
    expect(parseGemini({})).toEqual({ text: '', citations: [], tokensIn: null, tokensOut: null });
  });
  it('candidates empty / not an array → empty', () => {
    expect(parseGemini({ candidates: [] }).text).toBe('');
    expect(parseGemini({ candidates: 'nope' }).text).toBe('');
  });
  it('a candidate with no content (safety block) → text empty', () => {
    expect(parseGemini({ candidates: [{ finishReason: 'SAFETY' }] }).text).toBe('');
  });
  it('an error envelope has no candidates → text empty (the transport raises on it)', () => {
    expect(parseGemini({ error: { code: 429, message: 'RESOURCE_EXHAUSTED' } }).text).toBe('');
  });
  it('null envelope does not throw', () => {
    expect(parseGemini(null).text).toBe('');
    expect(parseGemini(null).citations).toEqual([]);
  });
  it('usageMetadata missing the needed fields → tokens null', () => {
    const p = parseGemini({ candidates: [{ content: { parts: [{ text: 'x' }] } }], usageMetadata: {} });
    expect([p.tokensIn, p.tokensOut]).toEqual([null, null]);
  });
});

describe('toGeminiModel — model id → API slug', () => {
  it('google/… → prefix stripped, version dots kept', () => {
    expect(toGeminiModel('google/gemini-3.5-flash')).toBe('gemini-3.5-flash');
    expect(toGeminiModel('google/gemini-2.5-pro')).toBe('gemini-2.5-pro');
  });
  it(':online/:free/:nitro suffixes dropped', () => {
    expect(toGeminiModel('google/gemini-3.5-flash:online')).toBe('gemini-3.5-flash');
    expect(toGeminiModel('gemini-3.5-flash:free')).toBe('gemini-3.5-flash');
  });
  it('an API slug passes through unchanged', () => {
    expect(toGeminiModel('gemini-3.5-flash')).toBe('gemini-3.5-flash');
    expect(toGeminiModel('gemini-2.5-flash-lite')).toBe('gemini-2.5-flash-lite');
  });
  it('whitespace trimmed, empty input → empty', () => {
    expect(toGeminiModel('  gemini-3.5-flash  ')).toBe('gemini-3.5-flash');
    expect(toGeminiModel('')).toBe('');
  });
});
