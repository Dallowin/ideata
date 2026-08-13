/**
 * GigaChat parser core — parseGigachat on synthetic envelopes (shape taken from
 * core/gigachat.py:_extract_text + usage). No citations (no web search in the API).
 */
import { parseGigachat } from './gigachat';

describe('parseGigachat', () => {
  it('text from choices[0].message.content, prompt/completion tokens, citations=[]', () => {
    const p = parseGigachat({
      choices: [{ message: { role: 'assistant', content: 'Giga answer.' } }],
      usage: { prompt_tokens: 30, completion_tokens: 40 },
    });
    expect(p).toEqual({ text: 'Giga answer.', citations: [], tokensIn: 30, tokensOut: 40 });
  });

  it('content split into parts (list) → joined with a space', () => {
    const p = parseGigachat({ choices: [{ message: { content: [{ text: 'раз' }, { text: 'два' }] } }] });
    expect(p.text).toBe('раз два');
  });

  it('empty envelope {} → text="", citations=[], tokens null', () => {
    expect(parseGigachat({})).toEqual({ text: '', citations: [], tokensIn: null, tokensOut: null });
  });

  it('no usage → tokens null; .strip() of whitespace', () => {
    const p = parseGigachat({ choices: [{ message: { content: '  hi  ' } }] });
    expect(p.text).toBe('hi');
    expect([p.tokensIn, p.tokensOut]).toEqual([null, null]);
  });
});
