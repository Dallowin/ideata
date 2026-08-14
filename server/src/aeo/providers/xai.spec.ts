/**
 * xAI parser core — parseXai on SYNTHETIC envelopes (chat completions shape with
 * the Live Search additions). We don't burn live calls; we check that text/
 * citations/tokens are correctly extracted, including the top-level `citations`
 * a grounded answer carries.
 */
import { parseXai, toXaiModel } from './xai';

describe('parseXai — chat completions envelope (grounded)', () => {
  const env = {
    choices: [{ index: 0, message: { role: 'assistant', content: 'Grok answer.' }, finish_reason: 'stop' }],
    citations: [
      'https://a.com/x',
      { url: 'https://b.com', title: 'B' },
      { url: 'https://a.com/x', title: 'A title' }, // duplicate URL, arrives with a title
      { title: 'no url' }, // dropped: no URL
    ],
    usage: { prompt_tokens: 200, completion_tokens: 100 },
  };

  it('text from choices[0].message.content', () => {
    expect(parseXai(env).text).toBe('Grok answer.');
  });

  it('citations from the top-level list (string → no title, object → with title), deduped with title back-fill', () => {
    expect(parseXai(env).citations).toEqual([
      { url: 'https://a.com/x', title: 'A title' },
      { url: 'https://b.com', title: 'B' },
    ]);
  });

  it('tokens: usage prompt_tokens/completion_tokens', () => {
    const p = parseXai(env);
    expect([p.tokensIn, p.tokensOut]).toEqual([200, 100]);
  });

  it('content split into parts: joined with a space and .strip()', () => {
    const p = parseXai({ choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }, { text: '' }] } }] });
    expect(p.text).toBe('a b');
  });

  it('ungrounded answer (no citations): text only', () => {
    const p = parseXai({
      choices: [{ message: { content: 'Plain answer.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
    expect(p).toEqual({ text: 'Plain answer.', citations: [], tokensIn: 10, tokensOut: 20 });
  });
});

describe('parseXai — empty/malformed envelope', () => {
  it('{} → text="", citations=[], tokens null', () => {
    expect(parseXai({})).toEqual({ text: '', citations: [], tokensIn: null, tokensOut: null });
  });
  it('choices empty / not an array → empty', () => {
    expect(parseXai({ choices: [] }).text).toBe('');
    expect(parseXai({ choices: 'nope' }).text).toBe('');
  });
  it('a choice with no message (refusal) → text empty', () => {
    expect(parseXai({ choices: [{ finish_reason: 'content_filter' }] }).text).toBe('');
  });
  it('citations not an array → no citations, no throw', () => {
    expect(parseXai({ choices: [{ message: { content: 'x' } }], citations: 'nope' }).citations).toEqual([]);
  });
  it('an error envelope has no choices → text empty (the transport raises on it)', () => {
    expect(parseXai({ code: 'Client specified an invalid argument', error: 'model not found' }).text).toBe('');
    expect(parseXai({ error: { message: 'Incorrect API key provided' } }).text).toBe('');
  });
  it('null envelope does not throw', () => {
    expect(parseXai(null).text).toBe('');
    expect(parseXai(null).citations).toEqual([]);
  });
  it('usage missing the needed fields → tokens null', () => {
    const p = parseXai({ choices: [{ message: { content: 'x' } }], usage: {} });
    expect([p.tokensIn, p.tokensOut]).toEqual([null, null]);
  });
});

describe('toXaiModel — model id → API slug', () => {
  it('x-ai/… → prefix stripped, version dots kept', () => {
    expect(toXaiModel('x-ai/grok-4.3')).toBe('grok-4.3');
    expect(toXaiModel('x-ai/grok-4-fast')).toBe('grok-4-fast');
  });
  it(':online/:free/:nitro suffixes dropped', () => {
    expect(toXaiModel('x-ai/grok-4.3:online')).toBe('grok-4.3');
    expect(toXaiModel('x-ai/grok-4.3:free')).toBe('grok-4.3');
    expect(toXaiModel('grok-4.3:nitro')).toBe('grok-4.3');
  });
  it('an API slug passes through unchanged', () => {
    expect(toXaiModel('grok-4.3')).toBe('grok-4.3');
    expect(toXaiModel('grok-3-mini')).toBe('grok-3-mini');
  });
  it('whitespace trimmed, empty input → empty', () => {
    expect(toXaiModel('  grok-4.3  ')).toBe('grok-4.3');
    expect(toXaiModel('')).toBe('');
  });
});
