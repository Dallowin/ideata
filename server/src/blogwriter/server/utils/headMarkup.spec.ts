import { buildHeadMarkup, clampWords, extractFaq, DESC_MAX, TITLE_MAX } from './headMarkup';

const BODY = `
Вступление, которое достаточно длинное, чтобы стать описанием статьи и пройти
фильтр по длине абзаца в генераторе разметки.

## Как выбрать конструктор сайтов?

Смотрите на три вещи: скорость запуска, цену владения и то, насколько легко
забрать контент, если сервис перестанет устраивать.

## Таблица тарифов

| план | цена |
| --- | --- |

## Чем отличается конструктор от CMS

Конструктор берёт на себя хостинг и обновления, CMS даёт контроль над кодом и
требует администрирования, а значит и человека, который этим занят.

## Короткий раздел

Мало текста.
`;

describe('clampWords', () => {
  it('truncates on a word boundary and appends an ellipsis', () => {
    const out = clampWords('одно два три четыре пять шесть семь', 20);
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/\s…$/);       // no dangling space before the ellipsis
  });

  it('leaves a short string untouched and strips markup', () => {
    expect(clampWords('**Заголовок** статьи', 60)).toBe('Заголовок статьи');
  });
});

describe('extractFaq', () => {
  it('picks up question subheadings with a substantial answer', () => {
    const faq = extractFaq(BODY);
    expect(faq).toHaveLength(2);
    expect(faq[0].q).toBe('Как выбрать конструктор сайтов?');
    expect(faq[0].a).toContain('скорость запуска');
    // "Таблица тарифов" is not a question, "Короткий раздел" has too short an answer
    expect(faq.map((f) => f.q)).not.toContain('Таблица тарифов');
    expect(faq.map((f) => f.q)).not.toContain('Короткий раздел');
  });

  it('a question without "?" also counts if it starts with a question word', () => {
    const faq = extractFaq(BODY);
    expect(faq[1].q).toBe('Чем отличается конструктор от CMS');
  });
});

describe('buildHeadMarkup', () => {
  const base = {
    title: 'Конструкторы сайтов в 2026 году: как выбрать и не переплатить',
    body: BODY,
    url: 'https://acme.io/blog/builders',
    coverUrl: 'https://acme.io/cover.png',
    author: 'Иван Петров',
    siteName: 'Acme',
    locale: 'ru_RU',
    publishedAt: '2026-07-01T10:00:00Z',
  };

  it('respects the title and description limits', () => {
    const m = buildHeadMarkup(base);
    expect(m.titles[0].length).toBeLessThanOrEqual(TITLE_MAX);
    expect(m.descriptions[0].length).toBeLessThanOrEqual(DESC_MAX);
    expect(m.descriptions[0]).toContain('Вступление');
  });

  it('builds OG and Twitter tags with the cover image', () => {
    const m = buildHeadMarkup(base);
    expect(m.og['og:type']).toBe('article');
    expect(m.og['og:image']).toBe(base.coverUrl);
    expect(m.twitter['twitter:card']).toBe('summary_large_image');
  });

  it('falls back to a summary card without a cover image', () => {
    const m = buildHeadMarkup({ ...base, coverUrl: undefined });
    expect(m.twitter['twitter:card']).toBe('summary');
    expect(m.og['og:image']).toBeUndefined();
  });

  it('produces a BlogPosting with all the required fields', () => {
    const m = buildHeadMarkup(base);
    const post = m.jsonLd[0] as any;
    expect(post['@type']).toBe('BlogPosting');
    expect(post.headline.length).toBeGreaterThan(0);
    expect(post.author).toEqual({ '@type': 'Person', name: 'Иван Петров' });
    expect(post.datePublished).toBe('2026-07-01T10:00:00Z');
    expect(post.mainEntityOfPage).toEqual({ '@type': 'WebPage', '@id': base.url });
  });

  it('adds a FAQPage when there are enough questions', () => {
    const m = buildHeadMarkup(base);
    const faq = m.jsonLd.find((d: any) => d['@type'] === 'FAQPage') as any;
    expect(faq).toBeDefined();
    expect(faq.mainEntity).toHaveLength(2);
    expect(faq.mainEntity[0].acceptedAnswer['@type']).toBe('Answer');
    expect(m.faqCount).toBe(2);
  });

  it('one question is not enough for a FAQPage - we do not fabricate the block', () => {
    const m = buildHeadMarkup({
      ...base,
      body: '## Как выбрать?\n\nДлинный ответ, которого достаточно по длине для FAQ-блока.',
    });
    expect(m.jsonLd.find((d: any) => d['@type'] === 'FAQPage')).toBeUndefined();
  });

  it('the html block escapes quotes and contains valid JSON-LD', () => {
    const m = buildHeadMarkup({ ...base, title: 'Тест "кавычек" & символов' });
    expect(m.html).toContain('&quot;');
    const raw = /<script type="application\/ld\+json">(.*?)<\/script>/s.exec(m.html)?.[1];
    expect(() => JSON.parse(raw || '')).not.toThrow();
  });
});
