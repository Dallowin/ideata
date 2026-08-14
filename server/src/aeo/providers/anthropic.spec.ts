/**
 * Anthropic parser core — parseAnthropic on SYNTHETIC envelopes (Messages API
 * shape). We don't burn live calls; we check that text/citations/tokens are
 * correctly extracted from the envelope, including the web_search blocks.
 */
import { parseAnthropic, toAnthropicModel } from './anthropic';

describe('parseAnthropic — Messages envelope (grounded)', () => {
  const env = {
    content: [
      { type: 'text', text: 'Answer part 1.' },
      {
        type: 'web_search_tool_result',
        content: [
          { url: 'https://a.com/x', title: 'A title' },
          { url: 'https://b.com' }, // no title
        ],
      },
      {
        type: 'text',
        text: 'Part 2.',
        citations: [
          { url: 'https://c.com', title: 'C' },
          { url: 'https://a.com/x' }, // duplicate URL with no title — doesn't overwrite
        ],
      },
    ],
    usage: { input_tokens: 120, output_tokens: 340 },
  };

  it('joins text blocks with a space and .strip()', () => {
    expect(parseAnthropic(env).text).toBe('Answer part 1. Part 2.');
  });

  it('collects citations from web_search + citations, dedups by URL, title from the first non-empty one', () => {
    expect(parseAnthropic(env).citations).toEqual([
      { url: 'https://a.com/x', title: 'A title' },
      { url: 'https://b.com', title: '' },
      { url: 'https://c.com', title: 'C' },
    ]);
  });

  it('tokens: input_tokens/output_tokens', () => {
    const p = parseAnthropic(env);
    expect([p.tokensIn, p.tokensOut]).toEqual([120, 340]);
  });

  it('tool_result variant + document_title as a title fallback', () => {
    const p = parseAnthropic({
      content: [
        { type: 'text', text: 'T' },
        { type: 'tool_result', content: [{ url: 'https://k.com', title: 'K' }] },
        { type: 'text', text: '', citations: [{ url: 'https://doc.com', document_title: 'Doc' }] },
      ],
    });
    expect(p.text).toBe('T');
    expect(p.citations).toEqual([
      { url: 'https://k.com', title: 'K' },
      { url: 'https://doc.com', title: 'Doc' },
    ]);
  });

  it('ungrounded answer: text only, no citations', () => {
    const p = parseAnthropic({
      content: [{ type: 'text', text: 'Plain answer.' }],
      usage: { input_tokens: 10, output_tokens: 20 },
    });
    expect(p).toEqual({ text: 'Plain answer.', citations: [], tokensIn: 10, tokensOut: 20 });
  });
});

describe('parseAnthropic — empty/malformed envelope', () => {
  it('{} → text="", citations=[], tokens null', () => {
    expect(parseAnthropic({})).toEqual({ text: '', citations: [], tokensIn: null, tokensOut: null });
  });
  it('content not an array → empty', () => {
    expect(parseAnthropic({ content: 'nope' }).text).toBe('');
  });
  it('an error envelope has no content → text empty (the transport raises on it)', () => {
    expect(parseAnthropic({ type: 'error', error: { message: 'overloaded' } }).text).toBe('');
  });
  it('null envelope does not throw', () => {
    expect(parseAnthropic(null).text).toBe('');
    expect(parseAnthropic(null).citations).toEqual([]);
  });
  it('usage missing the needed fields → tokens null', () => {
    const p = parseAnthropic({ content: [{ type: 'text', text: 'x' }], usage: {} });
    expect([p.tokensIn, p.tokensOut]).toEqual([null, null]);
  });
});

describe('toAnthropicModel — model id → API slug', () => {
  it('anthropic/… → prefix stripped, version dashes', () => {
    expect(toAnthropicModel('anthropic/claude-opus-4.8')).toBe('claude-opus-4-8');
    expect(toAnthropicModel('anthropic/claude-haiku-4.5')).toBe('claude-haiku-4-5');
  });
  it(':online/:free/:nitro suffixes dropped', () => {
    expect(toAnthropicModel('anthropic/claude-sonnet-5:online')).toBe('claude-sonnet-5');
    expect(toAnthropicModel('anthropic/claude-haiku-4.5:free')).toBe('claude-haiku-4-5');
    expect(toAnthropicModel('claude-sonnet-5:nitro')).toBe('claude-sonnet-5');
  });
  it('a bare id also gets version dashes', () => {
    expect(toAnthropicModel('claude-haiku-4.5')).toBe('claude-haiku-4-5');
  });
  it('an API slug passes through unchanged', () => {
    expect(toAnthropicModel('claude-haiku-4-5')).toBe('claude-haiku-4-5');
    expect(toAnthropicModel('claude-opus-4-8')).toBe('claude-opus-4-8');
  });
  it('whitespace trimmed, empty input → empty', () => {
    expect(toAnthropicModel('  claude-sonnet-5  ')).toBe('claude-sonnet-5');
    expect(toAnthropicModel('')).toBe('');
  });
});
