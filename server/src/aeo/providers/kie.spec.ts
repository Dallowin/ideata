/**
 * kie parser core — parseKie on SYNTHETIC envelopes (shape taken from core/kie.py:
 * _parse_claude/_parse_openai/_usage_tokens). We don't burn live calls; we check that
 * text/citations/tokens are correctly extracted from the envelope in BOTH formats.
 */
import { parseKie, toKieModel, isClaudeSlug } from './kie';

describe('parseKie — Anthropic envelope (Claude, grounded)', () => {
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
    expect(parseKie(env, { claude: true }).text).toBe('Answer part 1. Part 2.');
  });

  it('collects citations from web_search + citations, dedups by URL, title from the first non-empty one', () => {
    expect(parseKie(env, { claude: true }).citations).toEqual([
      { url: 'https://a.com/x', title: 'A title' },
      { url: 'https://b.com', title: '' },
      { url: 'https://c.com', title: 'C' },
    ]);
  });

  it('Anthropic tokens: input_tokens/output_tokens', () => {
    const p = parseKie(env, { claude: true });
    expect([p.tokensIn, p.tokensOut]).toEqual([120, 340]);
  });

  it('tool_result variant (kie normalization) + document_title as a title fallback', () => {
    const p = parseKie(
      {
        content: [
          { type: 'text', text: 'T' },
          { type: 'tool_result', content: [{ url: 'https://k.com', title: 'K' }] },
          { type: 'text', text: '', citations: [{ url: 'https://doc.com', document_title: 'Doc' }] },
        ],
      },
      { claude: true },
    );
    expect(p.text).toBe('T');
    expect(p.citations).toEqual([
      { url: 'https://k.com', title: 'K' },
      { url: 'https://doc.com', title: 'Doc' },
    ]);
  });
});

describe('parseKie — OpenAI envelope (Gemini, lite)', () => {
  const env = {
    choices: [
      {
        message: {
          content: 'Gemini answer.',
          annotations: [{ url_citation: { url: 'https://d.com', title: 'D' } }],
        },
      },
    ],
    citations: ['https://e.com', { url: 'https://f.com', title: 'F' }],
    usage: { prompt_tokens: 50, completion_tokens: 80 },
  };

  it('text from choices[0].message.content', () => {
    expect(parseKie(env, { claude: false }).text).toBe('Gemini answer.');
  });

  it('citations: top-level citations (string+object) then annotations.url_citation', () => {
    expect(parseKie(env, { claude: false }).citations).toEqual([
      { url: 'https://e.com', title: '' },
      { url: 'https://f.com', title: 'F' },
      { url: 'https://d.com', title: 'D' },
    ]);
  });

  it('OpenAI tokens: prompt_tokens/completion_tokens', () => {
    const p = parseKie(env, { claude: false });
    expect([p.tokensIn, p.tokensOut]).toEqual([50, 80]);
  });
});

describe('parseKie — empty/malformed envelope', () => {
  it('Claude: {} → text="", citations=[], tokens null', () => {
    expect(parseKie({}, { claude: true })).toEqual({ text: '', citations: [], tokensIn: null, tokensOut: null });
  });
  it('OpenAI: {} → empty (no choices)', () => {
    expect(parseKie({}, { claude: false })).toEqual({ text: '', citations: [], tokensIn: null, tokensOut: null });
  });
  it('Claude: content not an array → empty', () => {
    expect(parseKie({ content: 'nope' }, { claude: true }).text).toBe('');
  });
  it('null envelope does not throw', () => {
    expect(parseKie(null, { claude: true }).text).toBe('');
    expect(parseKie(null, { claude: false }).citations).toEqual([]);
  });
  it('usage missing the needed fields → tokens null', () => {
    const p = parseKie({ content: [{ type: 'text', text: 'x' }], usage: {} }, { claude: true });
    expect([p.tokensIn, p.tokensOut]).toEqual([null, null]);
  });
});

describe('toKieModel / isClaudeSlug (kie.py:67,87)', () => {
  it('anthropic/… → version dashes', () => {
    expect(toKieModel('anthropic/claude-opus-4.8')).toBe('claude-opus-4-8');
  });
  it('vendor prefixes stripped, :online/:free suffixes dropped', () => {
    expect(toKieModel('google/gemini-3.5-flash')).toBe('gemini-3.5-flash');
    expect(toKieModel('deepseek/deepseek-v3.2:online')).toBe('deepseek-v3.2');
    expect(toKieModel('perplexity/sonar:free')).toBe('sonar');
  });
  it('already-kie slug passes through unchanged', () => {
    expect(toKieModel('claude-haiku-4-5')).toBe('claude-haiku-4-5');
    expect(toKieModel('gemini-3-5-flash-openai')).toBe('gemini-3-5-flash-openai');
  });
  it('isClaudeSlug', () => {
    expect(isClaudeSlug('claude-haiku-4-5')).toBe(true);
    expect(isClaudeSlug('gemini-3-5-flash-openai')).toBe(false);
  });
});
