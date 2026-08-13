/**
 * Шаблоны-сцены (объектная модель). Редизайн под 2026: редакторская сдержанность,
 * честная типографика, один акцент, тонкие линии — БЕЗ неон-глоу/фиолетовых орбов/
 * глассморфизма (то, что читается как «иишно»). Референсы: editorial/Swiss,
 * clean-product (Linear/Vercel/Stripe), industrial-mono.
 */
import type { Scene, SceneObject } from './scene'
import { detectLocale } from '@/i18n'

/**
 * Демо-текст шаблонов — это КОНТЕНТ обложки, и он должен быть на языке контента
 * бренда (как всё остальное в блог-райтере), а не только по-русски. Локаль читаем
 * один раз при загрузке модуля: смена языка в кабинете перезагружает страницу
 * (LangSwitcher), поэтому SCENE_TEMPLATES пересобираются в нужном языке.
 * Латинские токены (Ideata, ideata.io, `$ ideata deploy`, «34%») одинаковы в обоих
 * языках — их не дублируем.
 */
const L = (ru: string, en: string): string => (detectLocale() === 'en' ? en : ru)

/* --------------------------------------------------------------- шрифты */
export const SF = {
  grotesk: '"Space Grotesk", "Archivo", Inter, sans-serif',
  archivo: '"Archivo", Inter, sans-serif',
  serif: '"Fraunces", "Playfair Display", Georgia, serif',
  serif2: '"DM Serif Display", Georgia, serif',
  mono: '"JetBrains Mono", ui-monospace, monospace',
  sans: 'Inter, system-ui, sans-serif',
}
/** Семейства для Google Fonts <link> (Inter уже бандлится в кабинете). */
export const SCENE_FONT_FAMILIES = [
  'Space Grotesk:wght@400;500;700',
  'Archivo:wght@400;600;700;800',
  'Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700',
  'Playfair Display:wght@400;600;700',
  'DM Serif Display:wght@400',
  'JetBrains Mono:wght@400;500;700',
]
export function sceneFontsHref(): string {
  // пробел в имени → '+', спец-символы спецификации (:@;,..) Google принимает как есть
  return 'https://fonts.googleapis.com/css2?'
    + SCENE_FONT_FAMILIES.map((f) => 'family=' + f.replace(/ /g, '+')).join('&')
    + '&display=swap'
}

/* --------------------------------------------------------------- палитры */
const P = {
  paper: { bg: '#f4f1ea', ink: '#18150f', sub: '#6b6355', accent: '#bb4a24' },
  news: { bg: '#eeebe3', ink: '#161616', sub: '#5f5f5f', accent: '#b2341f' },
  cobalt: { bg: '#ffffff', ink: '#0a1020', sub: '#5a6274', accent: '#2f5fe0' },
  forest: { bg: '#f1efe6', ink: '#12251b', sub: '#5c6a60', accent: '#1e7a52' },
  ink: { bg: '#101012', ink: '#f1efe8', sub: '#a5a29a', accent: '#d7b26a' },
  slate: { bg: '#0e1116', ink: '#eef1f5', sub: '#8b94a3', accent: '#5b9dff' },
  bw: { bg: '#ffffff', ink: '#0a0a0a', sub: '#666666', accent: '#0a0a0a' },
}

/* ------------------------------------------------------------- билдеры */
let n = 0
const idc = () => 't' + (++n)
function txt(x: number, y: number, w: number, text: string, o: Partial<SceneObject> = {}): SceneObject {
  return { id: idc(), type: 'text', x, y, w, text, size: 40, weight: 600, lh: 1.06, align: 'left', ...o }
}
function block(x: number, y: number, w: number, h: number, o: Partial<SceneObject> = {}): SceneObject {
  return { id: idc(), type: 'block', x, y, w, h, ...o }
}
function scene(objects: SceneObject[], bg: Scene['bg'], width = 1200, height = 630): Scene {
  return { width, height, bg, objects }
}

/**
 * В шаблоне лежат КЛЮЧИ словаря, а не готовые подписи: сцена сериализуется в
 * Postgres («Мои шаблоны»), и язык интерфейса не должен попадать в данные.
 * Переводит галерея — `preview.template.name.*` / `preview.template.tag.*`.
 * Демо-текст внутри scene — это стартовый контент обложки; его локализуем
 * хелпером `L(ru, en)` по языку контента (см. верх файла), чтобы англоязычный
 * рынок не получал русские заглушки. Латинские токены не дублируем.
 */
export interface SceneTemplate { id: string; nameKey: string; tagKeys: string[]; scene: Scene }
let pn = 0
const pid = () => 's' + String(++pn).padStart(2, '0')

/* =============================================================== шаблоны */
export const SCENE_TEMPLATES: SceneTemplate[] = [
  // 1 — Editorial serif, бумага
  { id: pid(), nameKey: 'editorial', tagKeys: ['blog', 'editorial'], scene: scene([
    txt(90, 74, 400, 'Ideata', { font: SF.grotesk, size: 26, weight: 700, color: P.paper.ink }),
    txt(90, 168, 400, L('ЖУРНАЛ · №07', 'JOURNAL · №07'), { font: SF.grotesk, size: 19, weight: 600, color: P.paper.accent, caps: true, ls: 2 }),
    txt(90, 208, 1010, L('Тихая сила хорошей типографики', 'The quiet power of good typography'), { font: SF.serif, size: 88, weight: 600, color: P.paper.ink, lh: 1.0 }),
    block(92, 452, 120, 5, { fill: P.paper.accent, radius: 3 }),
    txt(90, 486, 900, L('Почему шрифт решает больше, чем кажется — и как это использовать.', 'Why type matters more than it seems — and how to use it.'), { font: SF.sans, size: 27, weight: 400, color: P.paper.sub, lh: 1.35 }),
  ], { type: 'solid', color: P.paper.bg }) },

  // 2 — Swiss grid, гигантский заголовок
  { id: pid(), nameKey: 'swissGrid', tagKeys: ['magazine', 'editorial'], scene: scene([
    block(90, 120, 1020, 2, { fill: P.news.ink }),
    txt(90, 130, 500, 'ISSUE', { font: SF.archivo, size: 20, weight: 700, color: P.news.ink, caps: true, ls: 3 }),
    txt(700, 130, 410, 'ideata.io', { font: SF.archivo, size: 20, weight: 600, color: P.news.sub, align: 'right', ls: 1 }),
    txt(86, 300, 1020, L('Эра нулевого клика', 'The zero-click era'), { font: SF.archivo, size: 132, weight: 800, color: P.news.ink, lh: 0.92, ls: -2 }),
    block(90, 512, 1020, 2, { fill: P.news.ink }),
    txt(90, 528, 700, 'IDEATA', { font: SF.archivo, size: 22, weight: 800, color: P.news.ink, ls: 1 }),
    txt(700, 528, 410, '№ 01', { font: SF.archivo, size: 22, weight: 800, color: P.news.accent, align: 'right' }),
  ], { type: 'solid', color: P.news.bg }) },

  // 3 — Clean product: заголовок + рамка UI
  { id: pid(), nameKey: 'product', tagKeys: ['saas', 'product'], scene: scene([
    txt(80, 80, 480, 'Ideata', { font: SF.grotesk, size: 26, weight: 700, color: P.cobalt.ink }),
    txt(80, 175, 520, L('МОНИТОРИНГ', 'MONITORING'), { font: SF.grotesk, size: 18, weight: 600, color: P.cobalt.accent, caps: true, ls: 2 }),
    txt(80, 210, 520, L('Видимость бренда в AI-поиске', 'Brand visibility in AI search'), { font: SF.grotesk, size: 60, weight: 700, color: P.cobalt.ink, lh: 1.02 }),
    txt(80, 470, 480, L('ChatGPT · Perplexity · AI Overviews — в одном отчёте.', 'ChatGPT · Perplexity · AI Overviews — in one report.'), { font: SF.sans, size: 24, weight: 400, color: P.cobalt.sub, lh: 1.35 }),
    block(650, 150, 560, 470, { fill: '#eef2fb', radius: 16 }),
    block(650, 150, 560, 46, { fill: '#e2e8f6', radius: 16 }),
    block(676, 168, 12, 12, { fill: '#c6d0e6', radius: 6 }),
    block(696, 168, 12, 12, { fill: '#c6d0e6', radius: 6 }),
    block(716, 168, 12, 12, { fill: '#c6d0e6', radius: 6 }),
    block(686, 250, 300, 22, { fill: '#d4def0', radius: 6 }),
    block(686, 300, 460, 14, { fill: '#e0e7f5', radius: 4 }),
    block(686, 330, 420, 14, { fill: '#e0e7f5', radius: 4 }),
    block(686, 400, 180, 120, { fill: P.cobalt.accent, radius: 10, opacity: 0.9 }),
    block(890, 400, 256, 120, { fill: '#dbe4f4', radius: 10 }),
  ], { type: 'solid', color: P.cobalt.bg }) },

  // 4 — Big stat, сдержанно (без глоу)
  { id: pid(), nameKey: 'metric', tagKeys: ['metric', 'report'], scene: scene([
    txt(90, 80, 500, 'Ideata', { font: SF.grotesk, size: 26, weight: 700, color: P.paper.ink }),
    txt(90, 200, 700, L('ДОЛЯ ГОЛОСА В НИШЕ', 'SHARE OF VOICE IN THE NICHE'), { font: SF.grotesk, size: 20, weight: 600, color: P.paper.sub, caps: true, ls: 2 }),
    txt(84, 232, 800, '34%', { font: SF.grotesk, size: 220, weight: 700, color: P.paper.accent, lh: 0.9, ls: -4 }),
    txt(90, 496, 900, L('против 12% в начале квартала — кейс внедрения AEO.', 'up from 12% at the start of the quarter — an AEO rollout case.'), { font: SF.sans, size: 26, weight: 400, color: P.paper.sub, lh: 1.3 }),
  ], { type: 'solid', color: P.paper.bg }) },

  // 5 — Цитата, серифный крупный текст
  { id: pid(), nameKey: 'quote', tagKeys: ['quote'], scene: scene([
    txt(88, 96, 200, '“', { font: SF.serif, size: 160, weight: 600, color: P.forest.accent, lh: 0.6 }),
    txt(90, 190, 1000, L('Видимость в AI — это не трафик, а доверие движка к вашему бренду.', 'Visibility in AI isn\'t traffic — it\'s the engine\'s trust in your brand.'), { font: SF.serif, size: 62, weight: 400, color: P.forest.ink, lh: 1.14 }),
    block(90, 486, 44, 44, { fill: P.forest.accent, radius: 22 }),
    txt(150, 490, 500, L('Адиль Унаев', 'Adil Unaev'), { font: SF.sans, size: 24, weight: 600, color: P.forest.ink }),
    txt(150, 522, 500, 'Founder, Ideata', { font: SF.sans, size: 22, weight: 400, color: P.forest.sub }),
  ], { type: 'solid', color: P.forest.bg }) },

  // 6 — Mono / industrial (тёмный, БЕЗ неона)
  { id: pid(), nameKey: 'mono', tagKeys: ['dev', 'release'], scene: scene([
    txt(80, 84, 500, 'ideata-cli', { font: SF.mono, size: 24, weight: 500, color: P.ink.sub }),
    txt(80, 250, 900, '$ ideata deploy --prod', { font: SF.mono, size: 34, weight: 500, color: P.ink.accent }),
    txt(80, 310, 1000, L('Публичный API · новые лимиты · стабильный SSE', 'Public API · new limits · stable SSE'), { font: SF.mono, size: 52, weight: 700, color: P.ink.ink, lh: 1.12 }),
    block(80, 470, 40, 4, { fill: P.ink.accent }),
    txt(80, 500, 800, L('v2.4.0 — changelog на ideata.io/docs', 'v2.4.0 — changelog at ideata.io/docs'), { font: SF.mono, size: 22, weight: 400, color: P.ink.sub }),
  ], { type: 'solid', color: P.ink.bg }) },

  // 7 — Announcement, плоский (пилюля-обводка, без глоу)
  { id: pid(), nameKey: 'announce', tagKeys: ['launch', 'saas'], scene: scene([
    txt(0, 118, 1200, 'NEW', { font: SF.grotesk, size: 20, weight: 700, color: P.cobalt.accent, align: 'center', caps: true, ls: 3, fill: 'transparent' }),
    block(536, 112, 128, 44, { fill: 'transparent', radius: 22 }),
    txt(100, 210, 1000, L('Конструктор превью — в кабинете', 'Cover builder — right in the app'), { font: SF.grotesk, size: 76, weight: 700, color: P.cobalt.ink, align: 'center', lh: 1.02 }),
    txt(200, 390, 800, L('Тащи объекты, правь текст по дабл-клику, экспортируй в один клик.', 'Drag objects, edit text on double-click, export in one click.'), { font: SF.sans, size: 27, weight: 400, color: P.cobalt.sub, align: 'center', lh: 1.35 }),
    txt(500, 486, 200, L('Попробовать', 'Try it'), { font: SF.grotesk, size: 24, weight: 700, color: '#ffffff', fill: P.cobalt.ink, radius: 12, pad: 15, align: 'center' }),
  ], { type: 'solid', color: P.cobalt.bg }) },

  // 8 — Split: текст слева, плоский цветной блок справа
  { id: pid(), nameKey: 'split', tagKeys: ['saas'], scene: scene([
    block(720, 0, 480, 630, { fill: P.forest.accent }),
    txt(760, 210, 400, 'A', { font: SF.serif2, size: 300, weight: 400, color: '#ffffff', opacity: 0.9, lh: 0.9 }),
    txt(90, 100, 560, 'Ideata', { font: SF.grotesk, size: 26, weight: 700, color: P.forest.ink }),
    txt(90, 230, 560, L('Ответ движка — новая выдача', 'The engine\'s answer is the new SERP'), { font: SF.grotesk, size: 58, weight: 700, color: P.forest.ink, lh: 1.04 }),
    txt(90, 430, 540, L('Займите в нём место раньше конкурентов.', 'Claim your spot there before competitors do.'), { font: SF.sans, size: 25, weight: 400, color: P.forest.sub, lh: 1.35 }),
  ], { type: 'solid', color: P.forest.bg }) },

  // 9 — Минимал: воздух, маленький вордмарк
  { id: pid(), nameKey: 'minimal', tagKeys: ['minimal'], scene: scene([
    txt(0, 250, 1200, L('меньше украшений — больше смысла', 'less decoration — more meaning'), { font: SF.serif, size: 56, weight: 400, color: P.bw.ink, align: 'center', italic: true, lh: 1.1 }),
    block(560, 360, 80, 3, { fill: P.bw.ink }),
    txt(0, 540, 1200, 'IDEATA', { font: SF.grotesk, size: 20, weight: 700, color: P.bw.sub, align: 'center', caps: true, ls: 4 }),
  ], { type: 'solid', color: P.bw.bg }) },

  // 10 — Duotone photo (AI-фон) + крупный заголовок
  { id: pid(), nameKey: 'photoHeadline', tagKeys: ['blog', 'photo'], scene: scene([
    txt(80, 80, 500, 'Ideata', { font: SF.grotesk, size: 26, weight: 700, color: '#ffffff' }),
    txt(80, 300, 520, L('ГАЙД', 'GUIDE'), { font: SF.grotesk, size: 20, weight: 700, color: '#ffffff', caps: true, ls: 3 }),
    txt(80, 336, 780, L('Как попасть в ответы ChatGPT', 'How to land in ChatGPT\'s answers'), { font: SF.grotesk, size: 66, weight: 700, color: '#ffffff', lh: 1.02 }),
    txt(80, 528, 800, L('ideata.io/блог', 'ideata.io/blog'), { font: SF.sans, size: 22, weight: 500, color: 'rgba(255,255,255,.8)' }),
  ], { type: 'gradient', color: '#141a24', color2: '#243244', angle: 160, image: '', scrim: 0.35 }) },

  // 11 — Список фич (чистый)
  { id: pid(), nameKey: 'featureList', tagKeys: ['saas', 'guide'], scene: scene([
    txt(90, 84, 500, 'Ideata', { font: SF.grotesk, size: 26, weight: 700, color: P.slate.ink }),
    txt(90, 180, 900, L('Что вы получаете', 'What you get'), { font: SF.grotesk, size: 58, weight: 700, color: P.slate.ink }),
    block(92, 300, 26, 26, { fill: P.slate.accent, radius: 6 }),
    txt(140, 296, 900, L('Мониторинг видимости по 4 движкам', 'Visibility monitoring across 4 engines'), { font: SF.sans, size: 30, weight: 500, color: P.slate.ink }),
    block(92, 372, 26, 26, { fill: P.slate.accent, radius: 6 }),
    txt(140, 368, 900, L('Цитаты, доля голоса и сентимент', 'Citations, share of voice and sentiment'), { font: SF.sans, size: 30, weight: 500, color: P.slate.ink }),
    block(92, 444, 26, 26, { fill: P.slate.accent, radius: 6 }),
    txt(140, 440, 900, L('AEO-рекомендации по шагам', 'Step-by-step AEO recommendations'), { font: SF.sans, size: 30, weight: 500, color: P.slate.ink }),
  ], { type: 'solid', color: P.slate.bg }) },

  // 12 — Newsprint headline (крупный серьёзный)
  { id: pid(), nameKey: 'newspaper', tagKeys: ['blog', 'editorial'], scene: scene([
    txt(90, 80, 400, 'IDEATA', { font: SF.archivo, size: 22, weight: 800, color: P.news.ink, ls: 3 }),
    txt(760, 84, 350, L('17 июля 2026', 'July 17, 2026'), { font: SF.archivo, size: 20, weight: 600, color: P.news.sub, align: 'right' }),
    block(90, 128, 1020, 3, { fill: P.news.ink }),
    txt(88, 190, 1024, L('10 приёмов, которые ускорят вашу сборку', '10 tactics that will speed up your build'), { font: SF.serif, size: 82, weight: 700, color: P.news.ink, lh: 1.02 }),
    txt(90, 470, 900, L('Практика без воды — с примерами и цифрами.', 'Practical, no fluff — with examples and numbers.'), { font: SF.sans, size: 26, weight: 400, color: P.news.sub, lh: 1.3 }),
    txt(90, 540, 500, L('Читать →', 'Read →'), { font: SF.archivo, size: 24, weight: 700, color: P.news.accent }),
  ], { type: 'solid', color: P.news.bg }) },
]

/** Ключи тегов в порядке первого появления — фильтр галереи переводит их сам. */
export function sceneTags(): string[] {
  const set = new Set<string>()
  for (const t of SCENE_TEMPLATES) for (const tag of t.tagKeys) set.add(tag)
  return [...set]
}
