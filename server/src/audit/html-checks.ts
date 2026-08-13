/**
 * Checks read from static HTML — port of the first group of
 * core/site_audit.py (meta, social, content, hreflang, accessibility).
 *
 * There isn't a single network request here: the input is an already-loaded
 * page. That's why this group was ported first — it can be checked against
 * Python on the exact same HTML, and any discrepancy would be purely logical.
 *
 * Subtleties where the port is easy to get wrong:
 *   • attributes are matched case-insensitively (`[name="description" i]`) —
 *     `Name="Description"` shows up in the wild too;
 *   • `alt=""` is a legitimate way to mark a decorative image, so "no
 *     attribute" and "empty attribute" are different things — only flag the former;
 *   • heading order follows document order, otherwise the H1→H4 hierarchy
 *     check loses its meaning.
 */
import type { CheerioAPI, Cheerio } from 'cheerio';
import type { AnyNode } from 'domhandler';
import {
  Check, chk, plural, OK, WARN, FAIL, NA, HIGH, MED, LOW,
  TITLE_MIN, TITLE_MAX, DESC_MIN, DESC_MAX,
} from './types';

/**
 * Element text with no gaps — analogous to BeautifulSoup's `get_text(strip=True)`.
 * Used where Python calls it with no separator (title).
 */
const txt = (el: Cheerio<AnyNode>): string => el.text().replace(/\s+/g, ' ').trim();

/**
 * Element text with a space between nodes — analogous to `get_text(' ', strip=True)`.
 *
 * Without this, `<h1><span>ChatGPT</span><span>Алиса</span></h1>` turns into
 * "ChatGPTАлиса": cheerio glues nodes together with no gap, while BeautifulSoup
 * inserts a separator. On nested markup, the heading in the report read as garbage.
 */
function txtSpaced(el: Cheerio<AnyNode>): string {
  const parts: string[] = [];
  const walk = (node: any): void => {
    if (node.type === 'text') {
      const t = String(node.data || '').trim();
      if (t) parts.push(t);
    } else if (node.children) {
      node.children.forEach(walk);
    }
  };
  el.toArray().forEach(walk);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Meta tags: title, description, H1, canonical, viewport, lang, charset, favicon. */
export function checkMeta($: CheerioAPI, html: string, contentType = ''): Check[] {
  const out: Check[] = [];

  const title = txt($('title').first());
  if (!title) {
    out.push(chk('title', 'Мета-теги', 'Title', FAIL,
      'Тега <title> нет — в выдаче поиска показывать нечего.',
      { weight: 3, fix: 'Добавить <title> длиной 10-60 символов.', impact: HIGH, effort: LOW }));
  } else if (title.length < TITLE_MIN) {
    out.push(chk('title', 'Мета-теги', 'Title', WARN,
      `Слишком короткий (${title.length} симв.): «${title}»`,
      { value: title.length,
        fix: `Дописать title до ${TITLE_MIN}-${TITLE_MAX} симв. с ключевой темой страницы.`,
        impact: MED, effort: LOW }));
  } else if (title.length > TITLE_MAX) {
    out.push(chk('title', 'Мета-теги', 'Title', WARN,
      `${title.length} симв. — длиннее ${TITLE_MAX}, в выдаче обрежется многоточием.`,
      { value: title.length,
        fix: `Сократить title до ${TITLE_MAX} симв., главное — в начало.`,
        impact: LOW, effort: LOW }));
  } else {
    out.push(chk('title', 'Мета-теги', 'Title', OK,
      `${title.length} симв.: «${title}»`, { value: title.length }));
  }

  const desc = ($('meta[name="description" i]').first().attr('content') || '').trim();
  if (!desc) {
    out.push(chk('description', 'Мета-теги', 'Description', FAIL,
      'Нет meta description — сниппет в выдаче поиск соберёт сам из случайного текста страницы.',
      { weight: 2, fix: 'Добавить meta description на 50-160 символов.', impact: MED, effort: LOW }));
  } else if (desc.length < DESC_MIN) {
    out.push(chk('description', 'Мета-теги', 'Description', WARN,
      `Короткое (${desc.length} симв.) — место в сниппете используется не полностью.`,
      { value: desc.length, fix: `Расширить описание до ${DESC_MIN}-${DESC_MAX} симв.`,
        impact: LOW, effort: LOW }));
  } else if (desc.length > DESC_MAX) {
    out.push(chk('description', 'Мета-теги', 'Description', WARN,
      `${desc.length} симв. — длиннее ${DESC_MAX}, хвост обрежется.`,
      { value: desc.length, fix: `Сократить описание до ${DESC_MAX} симв.`,
        impact: LOW, effort: LOW }));
  } else {
    out.push(chk('description', 'Мета-теги', 'Description', OK,
      `${desc.length} симв.`, { value: desc.length }));
  }

  const h1s = $('h1');
  if (h1s.length === 0) {
    out.push(chk('h1', 'Мета-теги', 'Заголовок H1', FAIL,
      'H1 на странице нет — главная тема страницы не задана.',
      { weight: 2, fix: 'Добавить один <h1> с темой страницы.', impact: MED, effort: LOW }));
  } else if (h1s.length > 1) {
    out.push(chk('h1', 'Мета-теги', 'Заголовок H1', WARN,
      `H1 несколько (${h1s.length}) — тема страницы размывается.`, { value: h1s.length }));
  } else {
    out.push(chk('h1', 'Мета-теги', 'Заголовок H1', OK,
      `Один: «${txtSpaced(h1s.first()).slice(0, 80)}»`));
  }

  const canonical = ($('link[rel="canonical" i]').first().attr('href') || '').trim();
  if (canonical) {
    out.push(chk('canonical', 'Мета-теги', 'Canonical', OK, `Указан: ${canonical.slice(0, 90)}`));
  } else {
    out.push(chk('canonical', 'Мета-теги', 'Canonical', WARN,
      'Нет rel=canonical — при разных URL с одним контентом поиск сам выберет, какую версию считать главной.',
      { fix: 'Добавить <link rel="canonical"> с полным URL страницы.', impact: MED, effort: LOW }));
  }

  const vp = $('meta[name="viewport" i]').first();
  out.push(vp.length
    ? chk('viewport', 'Мета-теги', 'Viewport', OK, 'Мобильный viewport задан')
    : chk('viewport', 'Мета-теги', 'Viewport', FAIL,
        'Нет meta viewport — на телефоне страница отрисуется «десктопной» и нечитаемой.',
        { weight: 2,
          fix: 'Добавить <meta name="viewport" content="width=device-width, initial-scale=1">.',
          impact: HIGH, effort: LOW }));

  const lang = ($('html').first().attr('lang') || '').trim();
  out.push(lang
    ? chk('lang', 'Мета-теги', 'Атрибут lang', OK, `Язык страницы: ${lang}`, { value: lang })
    : chk('lang', 'Мета-теги', 'Атрибут lang', WARN,
        'У <html> нет lang — язык страницы не объявлен.',
        { fix: 'Проставить <html lang="ru"> (или язык сайта).', impact: LOW, effort: LOW }));

  // Charset can be declared in three equally valid ways; the Content-Type
  // header is no worse than <meta charset>, so we count it too — otherwise
  // we'd flag perfectly correct sites (example.com included).
  const inHeader = contentType.toLowerCase().includes('charset=');
  const hasCharset = inHeader
    || $('meta[charset]').length > 0
    || /http-equiv=["']?content-type/i.test(html);
  out.push(hasCharset
    ? chk('charset', 'Мета-теги', 'Кодировка', OK,
        inHeader ? 'Объявлена в HTTP-заголовке Content-Type' : 'Кодировка объявлена в HTML')
    : chk('charset', 'Мета-теги', 'Кодировка', WARN,
        'Кодировка не объявлена — возможны «кракозябры».',
        { fix: 'Добавить <meta charset="utf-8"> первой строкой <head>.', impact: MED, effort: LOW }));

  const icon = $('link[rel*="icon" i]').first();
  out.push(icon.length
    ? chk('favicon', 'Мета-теги', 'Favicon', OK, 'Иконка указана')
    : chk('favicon', 'Мета-теги', 'Favicon', WARN, 'Не найдена ссылка на favicon.',
        { fix: 'Добавить <link rel="icon"> и файл иконки.', impact: LOW, effort: LOW }));

  return out;
}

/** Social: Open Graph and Twitter Card — how the link unfurls in a messenger. */
export function checkSocial($: CheerioAPI): Check[] {
  const out: Check[] = [];
  const og = (prop: string): string => {
    const byProperty = $(`meta[property="${prop}" i]`).first().attr('content');
    if (byProperty !== undefined) return byProperty.trim();
    return ($(`meta[name="${prop}" i]`).first().attr('content') || '').trim();
  };

  const missing = ['og:title', 'og:description', 'og:image'].filter((p) => !og(p));
  if (missing.length === 0) {
    out.push(chk('open_graph', 'Соцсети', 'Open Graph', OK,
      'og:title, og:description и og:image на месте'));
  } else if (missing.length === 3) {
    out.push(chk('open_graph', 'Соцсети', 'Open Graph', FAIL,
      'Разметки Open Graph нет — ссылка в мессенджерах и соцсетях развернётся голым URL без картинки.',
      { weight: 2, fix: 'Добавить og:title, og:description и og:image (1200×630).',
        impact: MED, effort: LOW }));
  } else {
    out.push(chk('open_graph', 'Соцсети', 'Open Graph', WARN,
      `Не хватает: ${missing.join(', ')}`,
      { value: missing, fix: `Добавить недостающие теги: ${missing.join(', ')}.`,
        impact: MED, effort: LOW }));
  }

  const tw = $('meta[name="twitter:card" i]').first();
  out.push(tw.length
    ? chk('twitter', 'Соцсети', 'Twitter Card', OK, 'twitter:card задан')
    : chk('twitter', 'Соцсети', 'Twitter Card', WARN,
        'Нет twitter:card — превью в X/Twitter будет обрезанным.',
        { fix: 'Добавить <meta name="twitter:card" content="summary_large_image">.',
          impact: LOW, effort: LOW }));
  return out;
}

/** Content: image alt text, heading hierarchy, mixed content. */
export function checkContent($: CheerioAPI, html: string, baseUrl: string): Check[] {
  const out: Check[] = [];

  const imgs = $('img');
  if (imgs.length === 0) {
    out.push(chk('img_alt', 'Контент', 'Alt у изображений', NA, 'Изображений на странице нет'));
  } else {
    // Empty alt="" is a legitimate way to mark a decorative image, so "no
    // attribute" and alt="" are different things; only flag the former.
    const noAlt = imgs.toArray().filter((el) => $(el).attr('alt') === undefined);
    if (noAlt.length === 0) {
      out.push(chk('img_alt', 'Контент', 'Alt у изображений', OK,
        `Alt есть у всех изображений (${imgs.length})`, { value: 0 }));
    } else {
      const share = Math.round((noAlt.length / imgs.length) * 100);
      out.push(chk('img_alt', 'Контент', 'Alt у изображений', share > 50 ? FAIL : WARN,
        `${noAlt.length} из ${imgs.length} без alt (${share}%) — поиск не понимает, `
        + 'что на картинке, а скринридер её пропускает.',
        { value: noAlt.length,
          fix: 'Заполнить alt по смыслу; для декоративных картинок оставить пустой alt="".',
          impact: MED, effort: LOW }));
    }
  }

  // Hierarchy: a page shouldn't jump straight from H1 to H4.
  const levels = $('h1, h2, h3, h4, h5, h6').toArray()
    .map((el) => Number((el as any).tagName.slice(1)));
  let jump: string | null = null;
  for (let i = 1; i < levels.length; i++) {
    if (levels[i] - levels[i - 1] > 1) { jump = `H${levels[i - 1]} → H${levels[i]}`; break; }
  }
  if (levels.length === 0) {
    out.push(chk('headings', 'Контент', 'Иерархия заголовков', NA, 'Заголовков нет'));
  } else if (jump) {
    out.push(chk('headings', 'Контент', 'Иерархия заголовков', WARN,
      `Уровень перескакивает (${jump}) — структура текста читается машиной как рваная.`,
      { value: jump, fix: 'Не пропускать уровни: за H2 идёт H3, а не H4.',
        impact: LOW, effort: LOW }));
  } else {
    out.push(chk('headings', 'Контент', 'Иерархия заголовков', OK,
      `Ровная, ${levels.length} ${plural(levels.length, 'заголовок', 'заголовка', 'заголовков')}`));
  }

  // Mixed content: the browser blocks http:// resources on an https:// page.
  const mixed = [...html.matchAll(/(?:src|href)=["'](http:\/\/[^"']+)/g)]
    .map((m) => m[1])
    .filter((u) => !u.startsWith('http://localhost'));
  if (baseUrl.startsWith('https://') && mixed.length) {
    const n = mixed.length;
    out.push(chk('mixed_content', 'Безопасность', 'Смешанный контент', FAIL,
      `${n} ${plural(n, 'ресурс грузится', 'ресурса грузятся', 'ресурсов грузятся')} `
      + 'по http:// на https-странице — браузер их заблокирует.',
      { value: n, weight: 2,
        fix: 'Заменить http:// на https:// в ссылках на ресурсы (или на протокол-относительные пути).',
        impact: HIGH, effort: LOW }));
  } else {
    out.push(chk('mixed_content', 'Безопасность', 'Смешанный контент', OK,
      'Все ресурсы по https://'));
  }
  return out;
}

/** Hreflang: language versions and x-default. */
export function checkHreflang($: CheerioAPI): Check[] {
  const langs = $('link[rel*="alternate" i]').toArray()
    .map((el) => $(el).attr('hreflang'))
    .filter((v): v is string => Boolean(v));

  if (!langs.length) {
    return [chk('hreflang', 'Индексация', 'Hreflang', NA,
      'Не используется — это нормально для одноязычного сайта')];
  }
  if (!langs.map((l) => String(l).toLowerCase()).includes('x-default')) {
    return [chk('hreflang', 'Индексация', 'Hreflang', WARN,
      `${langs.length} языковых версий, но нет x-default — поиск сам решит, `
      + 'что показывать остальным странам.',
      { value: langs.slice(0, 10),
        fix: 'Добавить <link rel="alternate" hreflang="x-default">.',
        impact: LOW, effort: LOW })];
  }
  return [chk('hreflang', 'Индексация', 'Hreflang', OK,
    `${langs.length} языковых версий, x-default на месте`, { value: langs.slice(0, 10) })];
}

/**
 * Accessibility. Only what can honestly be checked from static HTML: contrast
 * and real focus order require rendering — we don't fake those.
 */
export function checkA11y($: CheerioAPI): Check[] {
  const out: Check[] = [];

  // Unlabelled input fields — a screen reader reads silence. A label can be
  // linked via for=, by wrapping, or replaced by aria-label/aria-labelledby.
  const skipTypes = new Set(['hidden', 'submit', 'button', 'image', 'reset']);
  const fields = $('input, select, textarea').toArray()
    .filter((el) => !skipTypes.has(($(el).attr('type') || '').toLowerCase()));

  if (!fields.length) {
    out.push(chk('form_labels', 'Доступность', 'Подписи полей форм', NA,
      'Полей ввода на странице нет'));
  } else {
    const labelledFor = new Set(
      $('label[for]').toArray().map((el) => $(el).attr('for')).filter(Boolean) as string[],
    );
    const unlabelled = fields.filter((el) => {
      const $el = $(el);
      const id = $el.attr('id');
      return !($el.attr('aria-label') || $el.attr('aria-labelledby')
        || (id && labelledFor.has(id)) || $el.closest('label').length > 0);
    });
    if (unlabelled.length) {
      out.push(chk('form_labels', 'Доступность', 'Подписи полей форм', WARN,
        `${unlabelled.length} из ${fields.length} полей без label и aria-label — `
        + 'скринридер не скажет, что вводить.',
        { value: unlabelled.length,
          fix: 'Связать <label for> с полем или задать aria-label.',
          impact: MED, effort: LOW }));
    } else {
      out.push(chk('form_labels', 'Доступность', 'Подписи полей форм', OK,
        `У всех полей есть подпись (${fields.length})`));
    }
  }

  // A button/link with no text (icon-only) — nameless to a screen reader.
  let nameless = 0;
  for (const el of $('button, a').toArray()) {
    const $el = $(el);
    if ((el as any).tagName === 'a' && !$el.attr('href')) continue;
    const hasName = Boolean(
      txtSpaced($el) || $el.attr('aria-label') || $el.attr('title')
      || $el.find('img').toArray().some((img) => $(img).attr('alt')),
    );
    if (!hasName) nameless++;
  }
  if (nameless) {
    out.push(chk('control_names', 'Доступность', 'Названия кнопок и ссылок', WARN,
      `${nameless} ${plural(nameless, 'элемент', 'элемента', 'элементов')} `
      + 'без текста и aria-label — обычно это иконки, и скринридер прочитает их как «кнопка».',
      { value: nameless, fix: 'Добавить aria-label иконочным кнопкам и ссылкам.',
        impact: MED, effort: LOW }));
  } else {
    out.push(chk('control_names', 'Доступность', 'Названия кнопок и ссылок', OK,
      'У всех кнопок и ссылок есть доступное имя'));
  }

  // Semantics: landmark tags give section navigation instead of a "wall of divs".
  const landmarks = ['main', 'nav', 'header', 'footer'].filter((t) => $(t).length > 0);
  if (landmarks.length >= 2) {
    out.push(chk('semantics', 'Доступность', 'Семантика разметки', OK,
      `Есть структурные теги: ${landmarks.join(', ')}`));
  } else {
    out.push(chk('semantics', 'Доступность', 'Семантика разметки', WARN,
      'Почти нет структурных тегов (main/nav/header/footer) — страница для скринридера это сплошной поток.',
      { fix: 'Разметить основные зоны тегами main/nav/header/footer.', impact: LOW, effort: MED }));
  }

  // Disabled zoom — a classic mobile-layout mistake.
  const vpContent = ($('meta[name="viewport" i]').first().attr('content') || '')
    .toLowerCase().replace(/ /g, '');
  if (vpContent.includes('user-scalable=no') || vpContent.includes('maximum-scale=1')) {
    out.push(chk('zoom', 'Доступность', 'Масштабирование', FAIL,
      'Viewport запрещает зум — люди со слабым зрением не смогут увеличить текст.',
      { weight: 2, fix: 'Убрать user-scalable=no и maximum-scale из viewport.',
        impact: MED, effort: LOW }));
  } else {
    out.push(chk('zoom', 'Доступность', 'Масштабирование', OK, 'Зум страницы не заблокирован'));
  }
  return out;
}
