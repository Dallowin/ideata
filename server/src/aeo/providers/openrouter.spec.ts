/**
 * OpenRouter parser core — parseOpenRouter on synthetic envelopes (shape taken from
 * core/openrouter.py:_parse_sources). KEY POINT: TWO citation formats (top-level
 * `citations` for Perplexity and `message.annotations[].url_citation` for search-preview/
 * :online), both accepted and deduped with title back-filling.
 */
import { parseOpenRouter, isGroundedModel } from './openrouter';

describe('parseOpenRouter — format 1: top-level citations (Perplexity/Sonar)', () => {
  const env = {
    choices: [{ message: { content: 'P answer.' } }],
    citations: ['https://p1.com', { url: 'https://p2.com', title: 'P2' }],
    usage: { prompt_tokens: 200, completion_tokens: 100 },
    id: 'gen-123',
  };
  it('text + citations (string → no title, object → with title)', () => {
    const p = parseOpenRouter(env);
    expect(p.text).toBe('P answer.');
    expect(p.citations).toEqual([
      { url: 'https://p1.com', title: '' },
      { url: 'https://p2.com', title: 'P2' },
    ]);
    expect([p.tokensIn, p.tokensOut]).toEqual([200, 100]);
  });
});

describe('parseOpenRouter — format 2: message.annotations.url_citation (search-preview/:online)', () => {
  const env = {
    choices: [
      {
        message: {
          content: 'S answer.',
          annotations: [
            { type: 'url_citation', url_citation: { url: 'https://s1.com', title: 'S1' } },
            { type: 'url_citation', url_citation: { url: 'https://s2.com' } },
          ],
        },
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20 },
  };
  it('citations from annotations', () => {
    expect(parseOpenRouter(env).citations).toEqual([
      { url: 'https://s1.com', title: 'S1' },
      { url: 'https://s2.com', title: '' },
    ]);
  });
});

describe('parseOpenRouter — both formats together: dedup back-fills the title', () => {
  it('URL arrived bare in citations and with a title in annotations → one, with the title', () => {
    const env = {
      choices: [
        {
          message: {
            content: 'X',
            annotations: [{ url_citation: { url: 'https://dup.com', title: 'Dup title' } }],
          },
        },
      ],
      citations: ['https://dup.com'],
    };
    expect(parseOpenRouter(env).citations).toEqual([{ url: 'https://dup.com', title: 'Dup title' }]);
  });
});

describe('parseOpenRouter — content split into parts (content=list)', () => {
  it('parts joined with a space', () => {
    const env = { choices: [{ message: { content: [{ text: 'a' }, { text: 'b' }, { text: '' }] } }] };
    expect(parseOpenRouter(env).text).toBe('a b');
  });
});

describe('parseOpenRouter — empty/malformed envelope', () => {
  it('{} → text="", citations=[], tokens null', () => {
    expect(parseOpenRouter({})).toEqual({ text: '', citations: [], tokensIn: null, tokensOut: null });
  });
  it('choices=[] → empty (Python (choices or [{}])[0])', () => {
    expect(parseOpenRouter({ choices: [] }).text).toBe('');
  });
  it('null does not throw', () => {
    expect(parseOpenRouter(null).text).toBe('');
  });
});

describe('isGroundedModel (openrouter.py:140) — flag for search-execution fixed cost', () => {
  it('plugin / :online / search / sonar → grounded', () => {
    expect(isGroundedModel('deepseek/deepseek-v3.2', [{ id: 'web' }])).toBe(true);
    expect(isGroundedModel('deepseek/deepseek-v3.2:online')).toBe(true);
    expect(isGroundedModel('openai/gpt-4o-mini-search-preview')).toBe(true);
    expect(isGroundedModel('perplexity/sonar')).toBe(true);
  });
  it('plain model with no plugin → no', () => {
    expect(isGroundedModel('openai/gpt-4o-mini')).toBe(false);
    expect(isGroundedModel('deepseek/deepseek-v3.2', [])).toBe(false);
  });
});
