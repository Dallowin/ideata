/**
 * DeepSeek parser core — parseDeepseek on SYNTHETIC envelopes (chat-completions
 * shape). We don't burn live calls; we check that text/tokens are extracted and
 * that citations stay empty on this route (the vendor API has no search), plus
 * the OpenRouter-id → API-slug mapping.
 */
import { parseDeepseek, toDeepseekModel } from './deepseek';

describe('parseDeepseek — chat-completions envelope', () => {
  const env = {
    choices: [{ message: { role: 'assistant', content: 'Plain answer.' } }],
    usage: { prompt_tokens: 150, completion_tokens: 420 },
    id: 'chat-1',
  };

  it('text from choices[0].message.content, .strip()', () => {
    expect(parseDeepseek({ choices: [{ message: { content: '  spaced  ' } }] }).text).toBe('spaced');
    expect(parseDeepseek(env).text).toBe('Plain answer.');
  });

  it('tokens: prompt_tokens/completion_tokens', () => {
    const p = parseDeepseek(env);
    expect([p.tokensIn, p.tokensOut]).toEqual([150, 420]);
  });

  it('citations always empty — no sources on this route', () => {
    expect(parseDeepseek(env).citations).toEqual([]);
  });

  it('a stray citations field in the envelope is ignored, not passed through', () => {
    const p = parseDeepseek({
      choices: [{ message: { content: 'X' } }],
      citations: ['https://a.com'],
    });
    expect(p.citations).toEqual([]);
  });

  it('content split into parts → joined with a space', () => {
    const env2 = { choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }, { text: '' }] } }] };
    expect(parseDeepseek(env2).text).toBe('a b');
  });
});

describe('parseDeepseek — empty/malformed envelope', () => {
  it('{} → text="", citations=[], tokens null', () => {
    expect(parseDeepseek({})).toEqual({ text: '', citations: [], tokensIn: null, tokensOut: null });
  });
  it('choices=[] → empty', () => {
    expect(parseDeepseek({ choices: [] }).text).toBe('');
  });
  it('an error envelope has no choices → text empty (the transport raises on it)', () => {
    expect(parseDeepseek({ error: { message: 'insufficient balance', code: 'invalid_request_error' } }).text).toBe('');
  });
  it('null envelope does not throw', () => {
    expect(parseDeepseek(null).text).toBe('');
    expect(parseDeepseek(null).citations).toEqual([]);
  });
  it('usage missing the needed fields → tokens null', () => {
    const p = parseDeepseek({ choices: [{ message: { content: 'x' } }], usage: {} });
    expect([p.tokensIn, p.tokensOut]).toEqual([null, null]);
  });
});

describe('toDeepseekModel — model id → API slug', () => {
  it('deepseek/deepseek-v… → deepseek-chat', () => {
    expect(toDeepseekModel('deepseek/deepseek-v3.2')).toBe('deepseek-chat');
    expect(toDeepseekModel('deepseek-v3.1')).toBe('deepseek-chat');
  });
  it('reasoning names → deepseek-reasoner', () => {
    expect(toDeepseekModel('deepseek/deepseek-r1')).toBe('deepseek-reasoner');
    expect(toDeepseekModel('deepseek/deepseek-r1-0528')).toBe('deepseek-reasoner');
  });
  it(':online/:free/:nitro suffixes dropped before the mapping', () => {
    expect(toDeepseekModel('deepseek/deepseek-v3.2:online')).toBe('deepseek-chat');
    expect(toDeepseekModel('deepseek/deepseek-v3.2:free')).toBe('deepseek-chat');
    expect(toDeepseekModel('deepseek/deepseek-r1:nitro')).toBe('deepseek-reasoner');
  });
  it('API slugs pass through unchanged', () => {
    expect(toDeepseekModel('deepseek-chat')).toBe('deepseek-chat');
    expect(toDeepseekModel('deepseek-reasoner')).toBe('deepseek-reasoner');
  });
  it('whitespace trimmed, empty input → empty', () => {
    expect(toDeepseekModel('  deepseek/deepseek-v3.2  ')).toBe('deepseek-chat');
    expect(toDeepseekModel('')).toBe('');
  });
});
