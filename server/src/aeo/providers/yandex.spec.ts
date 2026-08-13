/**
 * Yandex parser cores — parseAlice / parseNeuro on synthetic envelopes (shape
 * taken from core/yandex_ai.py). Alice: completion, string tokens, no citations.
 * Neuro: gen search, response wrapped in an ARRAY, real citations, no tokens.
 */
import { parseAlice, parseNeuro } from './yandex';

describe('parseAlice — Foundation Models completion', () => {
  it('text from result.alternatives[0].message.text; STRING tokens → numbers; citations=[]', () => {
    const p = parseAlice({
      result: {
        alternatives: [{ message: { role: 'assistant', text: 'Alice answer.' } }],
        usage: { inputTextTokens: '25', completionTokens: '60' },
      },
    });
    expect(p).toEqual({ text: 'Alice answer.', citations: [], tokensIn: 25, tokensOut: 60 });
  });

  it('no alternatives → text=""', () => {
    expect(parseAlice({ result: { alternatives: [] } }).text).toBe('');
  });

  it('empty envelope {} → text="", tokens null', () => {
    expect(parseAlice({})).toEqual({ text: '', citations: [], tokensIn: null, tokensOut: null });
  });
});

describe('parseNeuro — Neuro generative answer (gen search)', () => {
  it('response in an ARRAY with one object: text + citations (dedup by URL), tokens null', () => {
    const env = [
      {
        message: { role: 'ROLE_ASSISTANT', content: 'Neuro answer.' },
        sources: [
          { url: 'https://n1.ru', title: 'N1' },
          { url: 'https://n2.ru' },
          { url: 'https://n1.ru', title: 'дубль' }, // repeat URL — ignored
        ],
      },
    ];
    expect(parseNeuro(env)).toEqual({
      text: 'Neuro answer.',
      citations: [
        { url: 'https://n1.ru', title: 'N1' },
        { url: 'https://n2.ru', title: '' },
      ],
      tokensIn: null,
      tokensOut: null,
    });
  });

  it('bare object (gRPC mapping) — also accepted', () => {
    const p = parseNeuro({ message: { content: 'X' }, sources: [{ url: 'https://a.ru', title: 'A' }] });
    expect(p.text).toBe('X');
    expect(p.citations).toEqual([{ url: 'https://a.ru', title: 'A' }]);
  });

  it('isAnswerRejected → empty response (the model declined)', () => {
    const p = parseNeuro([{ isAnswerRejected: true, message: { content: 'должно игнориться' } }]);
    expect(p).toEqual({ text: '', citations: [], tokensIn: null, tokensOut: null });
  });

  it('empty array / non-dict → empty', () => {
    expect(parseNeuro([]).text).toBe('');
    expect(parseNeuro(null).citations).toEqual([]);
  });
});
