/**
 * AI Overviews parser core — parseAiOverview on synthetic SERP items (shape taken
 * from core/aeo.py:_ai_overview_answer). references carry url+title; collected from
 * both the element and the ai_overview block itself; dedup by URL. No text → null.
 */
import { parseAiOverview } from './dataforseo';

describe('parseAiOverview', () => {
  it('text (el.text or el.title, joined with \\n) + references from the element and the block, dedup by URL', () => {
    const items = [
      { type: 'organic', title: 'обычный результат — пропускается' },
      {
        type: 'ai_overview',
        items: [
          { type: 'ai_overview_element', text: 'AIO text 1.', references: [{ url: 'https://r1.com', title: 'R1', source: 'Site' }] },
          { type: 'ai_overview_element', title: 'AIO title only' }, // no text → falls back to title
        ],
        references: [
          { url: 'https://r2.com', title: 'R2' },
          { url: 'https://r1.com' }, // duplicate URL — ignored
        ],
      },
    ];
    expect(parseAiOverview(items)).toEqual({
      text: 'AIO text 1.\nAIO title only',
      citations: [
        { url: 'https://r1.com', title: 'R1' },
        { url: 'https://r2.com', title: 'R2' },
      ],
    });
  });

  it('no ai_overview element on the SERP → null', () => {
    expect(parseAiOverview([{ type: 'organic' }, { type: 'people_also_ask' }])).toBeNull();
  });

  it('ai_overview with no text (references only) → null (Python: if not texts)', () => {
    expect(parseAiOverview([{ type: 'ai_overview', items: [], references: [{ url: 'https://x.com' }] }])).toBeNull();
  });

  it('empty/non-array items → null', () => {
    expect(parseAiOverview([])).toBeNull();
    expect(parseAiOverview(null)).toBeNull();
    expect(parseAiOverview({})).toBeNull();
  });
});
