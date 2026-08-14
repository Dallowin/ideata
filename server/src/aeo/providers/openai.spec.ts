/**
 * OpenAI parser core — parseOpenAi on SYNTHETIC envelopes (Responses API
 * shape). We don't burn live calls; we check that text/citations/tokens are
 * correctly extracted from the output[] walk, including the url_citation
 * annotations of a web_search answer.
 */
import { parseOpenAi, toOpenAiModel } from './openai';

describe('parseOpenAi — Responses envelope (grounded)', () => {
  const env = {
    output: [
      { type: 'web_search_call', status: 'completed', action: { query: 'aeo tools' } },
      {
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'Answer part 1.',
            annotations: [
              { type: 'url_citation', url: 'https://a.com/x', title: 'A title' },
              { type: 'url_citation', url: 'https://b.com' }, // no title
              { type: 'file_citation', file_id: 'f-1' }, // not a URL citation
            ],
          },
          {
            type: 'output_text',
            text: 'Part 2.',
            annotations: [
              { type: 'url_citation', url: 'https://c.com', title: 'C' },
              { type: 'url_citation', url: 'https://a.com/x' }, // duplicate URL with no title
            ],
          },
        ],
      },
    ],
    usage: { input_tokens: 120, output_tokens: 340 },
  };

  it('joins output_text parts with a space and .strip()', () => {
    expect(parseOpenAi(env).text).toBe('Answer part 1. Part 2.');
  });

  it('citations from annotations, deduped by URL, title from the first non-empty one', () => {
    expect(parseOpenAi(env).citations).toEqual([
      { url: 'https://a.com/x', title: 'A title' },
      { url: 'https://b.com', title: '' },
      { url: 'https://c.com', title: 'C' },
    ]);
  });

  it('tokens: usage input_tokens/output_tokens', () => {
    const p = parseOpenAi(env);
    expect([p.tokensIn, p.tokensOut]).toEqual([120, 340]);
  });

  it('reasoning/tool-call items and non-output_text parts add nothing', () => {
    const p = parseOpenAi({
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking' }] },
        {
          type: 'message',
          content: [
            { type: 'refusal', refusal: 'no' },
            { type: 'output_text', text: 'Answer.' },
          ],
        },
      ],
    });
    expect(p.text).toBe('Answer.');
  });

  it('a bare URL picks up the title from a later annotation with the same URL', () => {
    const p = parseOpenAi({
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'T',
              annotations: [
                { type: 'url_citation', url: 'https://dup.com' },
                { type: 'url_citation', url: 'https://dup.com', title: 'Dup title' },
              ],
            },
          ],
        },
      ],
    });
    expect(p.citations).toEqual([{ url: 'https://dup.com', title: 'Dup title' }]);
  });

  it('ungrounded answer: text only, no citations', () => {
    const p = parseOpenAi({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Plain answer.' }] }],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(p).toEqual({ text: 'Plain answer.', citations: [], tokensIn: 10, tokensOut: 20 });
  });
});

describe('parseOpenAi — top-level output_text (convenience field)', () => {
  it('used when the output[] walk yields nothing', () => {
    const p = parseOpenAi({
      output: [{ type: 'reasoning', summary: [] }],
      output_text: '  Flat answer.  ',
      usage: { input_tokens: 5, output_tokens: 7 },
    });
    expect(p).toEqual({ text: 'Flat answer.', citations: [], tokensIn: 5, tokensOut: 7 });
  });

  it('the walk wins when it produced text', () => {
    const p = parseOpenAi({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'From output.' }] }],
      output_text: 'From the flat field.',
    });
    expect(p.text).toBe('From output.');
  });

  it('output[] missing entirely → the flat field still answers', () => {
    expect(parseOpenAi({ output_text: 'Only flat.' }).text).toBe('Only flat.');
  });
});

describe('parseOpenAi — empty/malformed envelope', () => {
  it('{} → text="", citations=[], tokens null', () => {
    expect(parseOpenAi({})).toEqual({ text: '', citations: [], tokensIn: null, tokensOut: null });
  });
  it('output not an array / empty → empty', () => {
    expect(parseOpenAi({ output: 'nope' }).text).toBe('');
    expect(parseOpenAi({ output: [] }).text).toBe('');
  });
  it('a message with no content parts → text empty', () => {
    expect(parseOpenAi({ output: [{ type: 'message', status: 'incomplete' }] }).text).toBe('');
  });
  it('an error envelope has no output → text empty (the transport raises on it)', () => {
    expect(parseOpenAi({ error: { message: 'Rate limit reached', code: 'rate_limit_exceeded' } }).text).toBe('');
  });
  it('null envelope does not throw', () => {
    expect(parseOpenAi(null).text).toBe('');
    expect(parseOpenAi(null).citations).toEqual([]);
  });
  it('usage missing the needed fields → tokens null', () => {
    const p = parseOpenAi({
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'x' }] }],
      usage: {},
    });
    expect([p.tokensIn, p.tokensOut]).toEqual([null, null]);
  });
});

describe('toOpenAiModel — model id → API slug', () => {
  it('openai/… → prefix stripped, version dots kept', () => {
    expect(toOpenAiModel('openai/gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(toOpenAiModel('openai/gpt-4.1-mini')).toBe('gpt-4.1-mini');
  });
  it(':online/:free/:nitro suffixes dropped', () => {
    expect(toOpenAiModel('openai/gpt-4o-mini:online')).toBe('gpt-4o-mini');
    expect(toOpenAiModel('openai/gpt-4o-mini:free')).toBe('gpt-4o-mini');
    expect(toOpenAiModel('gpt-4o-mini:nitro')).toBe('gpt-4o-mini');
  });
  it('an API slug passes through unchanged', () => {
    expect(toOpenAiModel('gpt-4o-mini')).toBe('gpt-4o-mini');
    expect(toOpenAiModel('gpt-4o-mini-search-preview')).toBe('gpt-4o-mini-search-preview');
  });
  it('whitespace trimmed, empty input → empty', () => {
    expect(toOpenAiModel('  gpt-4o-mini  ')).toBe('gpt-4o-mini');
    expect(toOpenAiModel('')).toBe('');
  });
});
