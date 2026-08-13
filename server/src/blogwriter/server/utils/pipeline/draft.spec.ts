import { checkpointSections } from './draft';

describe('checkpointSections — reuse of completed sections from checkpoint body_md', () => {
  const md = [
    'Лид-абзац без заголовка. Прямой ответ.',
    '## Что такое AI-видимость\n\nТекст первой секции с [ссылкой](https://a.b).',
    '## Как измерять\n\nТекст второй секции.',
    '## FAQ\n\n### Вопрос?\nОтвет.',
  ].join('\n\n');

  it('maps sections by normalized heading', () => {
    const map = checkpointSections(md);
    expect(map.get('что такое ai-видимость')).toContain('Текст первой секции');
    expect(map.get('как измерять')).toContain('Текст второй секции');
  });

  it('does not reuse the lead (no H2) or the FAQ (cheap to regenerate)', () => {
    const map = checkpointSections(md);
    expect([...map.keys()]).toEqual(['что такое ai-видимость', 'как измерять']);
    for (const block of map.values()) expect(block).not.toContain('Лид-абзац');
  });

  it('empty/missing checkpoint → empty map', () => {
    expect(checkpointSections('').size).toBe(0);
    expect(checkpointSections('   ').size).toBe(0);
  });

  it('heading normalization tolerates extra whitespace and case', () => {
    const map = checkpointSections('##   Как   Измерять  \n\nТекст.');
    expect(map.get('как измерять')).toContain('Текст.');
  });
});
