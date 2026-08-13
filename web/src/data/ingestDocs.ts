/**
 * Контракт приёмника /blog/ingest — то, что Blog Writer РЕАЛЬНО шлёт на сайт
 * бренда. Источник правды: api/src/blogwriter/server/utils/extPublish.ts
 * (ingestPost / ingestDelete / ingestListRemote) и shared/blog/dto (валидация
 * полей). Меняется контракт там — правим здесь, иначе дока начнёт врать.
 *
 * Тексты спецификации живут в коде, а не в locales/*.json: это ТЗ на чужой
 * бэкенд (таблицы, коды ответов, промпт для ИИ-ассистента), в JSON с экранами
 * переводов оно нечитаемо и разъезжается при первой же правке контракта.
 */
export type Lang = 'ru' | 'en'

export interface IngestEndpoint {
  m: 'POST' | 'GET' | 'PUT' | 'DELETE'
  path: string
  /** обязателен для работы автопубликации (остальное — расширения контракта) */
  required?: boolean
  desc: Record<Lang, string>
  /** когда мы это дёргаем — пусто, если только часть контракта «на будущее» */
  when: Record<Lang, string>
}

export const INGEST_ENDPOINTS: IngestEndpoint[] = [
  {
    m: 'POST', path: '/blog/ingest', required: true,
    desc: { ru: 'Идемпотентный upsert статьи по sourceId', en: 'Idempotent article upsert keyed by sourceId' },
    when: { ru: 'при публикации и каждом обновлении', en: 'on publish and on every update' },
  },
  {
    m: 'DELETE', path: '/blog/ingest?sourceId=…', required: true,
    desc: { ru: 'Снять статью по нашему sourceId (не по вашему id)', en: 'Remove an article by our sourceId (not your id)' },
    when: { ru: 'при снятии с публикации', en: 'on unpublish' },
  },
  {
    m: 'GET', path: '/blog/ingest',
    desc: {
      ru: 'Список статей с телами, включая черновики: { items, total, page, limit }',
      en: 'List of articles with bodies, drafts included: { items, total, page, limit }',
    },
    when: { ru: 'при импорте постов сайта в Blog Writer', en: 'when importing site posts into Blog Writer' },
  },
  {
    m: 'GET', path: '/blog/ingest/:id',
    desc: { ru: 'Одна статья целиком', en: 'A single article in full' },
    when: { ru: '', en: '' },
  },
  {
    m: 'PUT', path: '/blog/ingest/:id',
    desc: { ru: 'Частичное обновление по id — только присланные поля', en: 'Partial update by id — only the fields sent' },
    when: { ru: '', en: '' },
  },
  {
    m: 'DELETE', path: '/blog/ingest/:id',
    desc: { ru: 'Удалить статью по вашему id', en: 'Delete an article by your id' },
    when: { ru: '', en: '' },
  },
  {
    m: 'POST', path: '/blog/ingest/:id/cover',
    desc: { ru: 'Заливка обложки байтами (multipart) → { id, coverUrl }', en: 'Upload a cover as bytes (multipart) → { id, coverUrl }' },
    when: { ru: '', en: '' },
  },
]

export interface IngestField {
  f: string
  t: string
  req: boolean
  note: Record<Lang, string>
}

export const INGEST_FIELDS: IngestField[] = [
  { f: 'sourceId', t: 'string ≤200', req: false, note: { ru: 'ключ идемпотентности — id статьи в Ideata; шлём всегда', en: 'idempotency key — the article id in Ideata; always sent' } },
  { f: 'title', t: 'string ≤500', req: true, note: { ru: 'заголовок', en: 'headline' } },
  { f: 'bodyHtml', t: 'string', req: true, note: { ru: 'тело статьи готовым HTML', en: 'article body as ready-to-render HTML' } },
  { f: 'bodyMd', t: 'string', req: false, note: { ru: 'тот же текст в markdown', en: 'the same text in markdown' } },
  { f: 'slug', t: 'string ≤200', req: false, note: { ru: 'ЧПУ; занят другой статьёй — ответьте 409', en: 'URL slug; taken by another article — answer 409' } },
  { f: 'status', t: 'draft | published', req: false, note: { ru: 'дефолт draft; черновик не должен быть виден публично', en: 'defaults to draft; drafts must not be publicly reachable' } },
  { f: 'locale', t: 'string ≤10', req: false, note: { ru: 'язык статьи, дефолт ru', en: 'article language, defaults to ru' } },
  { f: 'topic', t: 'string ≤500', req: false, note: { ru: 'тема', en: 'topic' } },
  { f: 'category', t: 'string ≤100', req: false, note: { ru: 'рубрика', en: 'category' } },
  { f: 'author', t: 'string ≤200', req: false, note: { ru: 'автор', en: 'author' } },
  { f: 'wordCount', t: 'int ≥0', req: false, note: { ru: 'объём в словах', en: 'length in words' } },
  { f: 'coverImageUrl', t: 'http(s) URL', req: false, note: { ru: 'обложка на нашем домене — скачайте к себе при приёме', en: 'cover on our domain — download it to your storage on receipt' } },
]

/** Тело POST /blog/ingest — ровно те поля, что собирает buildIngest(). */
export const samplePayload = (lang: Lang) => lang === 'ru'
  ? `{
  "sourceId": "run_abc123",
  "title": "Как выбрать CRM для отдела продаж",
  "bodyHtml": "<h2>Что важно на старте</h2><p>…</p>",
  "bodyMd": "## Что важно на старте\\n\\n…",
  "slug": "kak-vybrat-crm",
  "status": "published",
  "locale": "ru",
  "topic": "CRM для бизнеса",
  "category": "Гайды",
  "author": "Редакция",
  "wordCount": 1200,
  "coverImageUrl": "https://ideata.io/blogwriter/covers/abc.jpg"
}`
  : `{
  "sourceId": "run_abc123",
  "title": "How to pick a CRM for your sales team",
  "bodyHtml": "<h2>What matters up front</h2><p>…</p>",
  "bodyMd": "## What matters up front\\n\\n…",
  "slug": "how-to-pick-a-crm",
  "status": "published",
  "locale": "en",
  "topic": "CRM for business",
  "category": "Guides",
  "author": "Editorial",
  "wordCount": 1200,
  "coverImageUrl": "https://ideata.io/blogwriter/covers/abc.jpg"
}`

/** Ответ, который мы парсим: id и slug показываем ссылкой на статью. */
export const sampleResult = '{ "id": 42, "slug": "kak-vybrat-crm", "status": "published" }'

const normBase = (base: string) => (base || '').trim().replace(/\/+$/, '') || 'https://api.example.com'
const normHeader = (h: string) => (h || '').trim() || 'Authorization'

/** curl-проверка приёмника: тот же запрос, что шлём мы. */
export const curlSample = (base: string, header: string, lang: Lang) => `curl -i -X POST "${normBase(base)}/blog/ingest" \\
  -H "${normHeader(header)}: $BLOG_INGEST_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"sourceId":"ideata-test","title":${lang === 'ru' ? '"Тестовая статья"' : '"Test article"'},"bodyHtml":"<p>ok</p>","slug":"ideata-test-post","status":"published"}'`

export interface ErrorCode { code: string; meaning: Record<Lang, string> }

export const INGEST_ERRORS: ErrorCode[] = [
  { code: '200 / 201', meaning: { ru: 'принято — вернуть { id, slug, status }', en: 'accepted — return { id, slug, status }' } },
  { code: '400', meaning: { ru: 'не прошло валидацию (или битый coverImageUrl)', en: 'validation failed (or a broken coverImageUrl)' } },
  { code: '401 / 403', meaning: { ru: 'токен не принят — проверьте заголовок и значение', en: 'token rejected — check the header name and value' } },
  { code: '404', meaning: { ru: 'на DELETE трактуем как «уже удалено» и считаем успехом', en: 'on DELETE we read it as “already gone” and count it a success' } },
  { code: '409', meaning: { ru: 'slug занят другой статьёй', en: 'the slug belongs to another article' } },
]

/**
 * Готовое ТЗ на приёмник для ИИ-ассистента (Claude Code / Cursor): человек
 * копирует и вставляет к себе в репозиторий. Токен НЕ подставляем — секрет с
 * сервера в браузер не приходит, и класть его в текст, который уедет в чужой
 * чат, нельзя: в промпте он читается из переменной окружения.
 */
export function assistantPrompt(lang: Lang, base: string, header: string): string {
  const b = normBase(base)
  const h = normHeader(header)
  const F = '```'
  const fields = INGEST_FIELDS
    .map((x) => `| ${x.f} | ${x.t.replace(/\|/g, '\\|')} | ${x.req ? (lang === 'ru' ? 'ДА' : 'YES') : (lang === 'ru' ? 'нет' : 'no')} | ${x.note[lang]} |`)
    .join('\n')

  if (lang === 'en') {
    return `Implement a REST receiver in my project for auto-publishing articles from an external CMS (Ideata Blog Writer).
The CMS is already configured and will call my site on its own. Your job is the receiving side.

## Context
- Base URL of my API: ${b}
- Every path below is relative to that Base URL.
- Follow MY stack (framework, ORM, routing, migrations, code style). Read the repo first and match what is already there.

## Authentication
Every request arrives with the header:
${F}
${h}: <secret token>
${F}
IMPORTANT: the header value is the token ITSELF — no "Bearer " prefix, no quotes.
- Keep the token in an env var (e.g. BLOG_INGEST_TOKEN), never in code or git.
- Compare in constant time (timingSafeEqual/hash_equals) and never log the value.
- Missing or wrong token → 401. Do not add any other auth path.

## Endpoints

### 1. POST /blog/ingest — REQUIRED (publish and update)
Content-Type: application/json. Body:
${F}json
${samplePayload('en')}
${F}

Field schema:
| field | type | required | meaning |
|---|---|---|---|
${fields}

Semantics (these matter more than the code):
1. **Idempotent upsert on sourceId.** A repeat POST with the same sourceId is an UPDATE of that article, not a second copy. Ideata sends POST both on first publish and on every "update". Add a source_id column with a UNIQUE index and upsert on it.
2. **status="draft" must not be publicly reachable** — not in listings, not by direct slug URL. Only "published" is visible to anonymous visitors.
3. **slug**: use the one sent; if it is taken by a DIFFERENT article (another sourceId), answer 409. If none is sent, generate one from the title and make it unique.
4. **coverImageUrl** is an absolute URL on someone else's domain and may die later. Download the image on receipt, store it yourself, and keep your own URL. Cap the size (e.g. ≤10 MB), allow image/* only, use a download timeout. If the download fails, still accept the article — just without a cover.
5. **bodyHtml arrives as ready HTML.** Do not escape it into text. Do not trust it blindly either: run it through a sanitizer (allow h1-h6, p, a, ul/ol/li, img, blockquote, pre/code, table, strong/em; strip script/style/iframe/on* attributes).

Success → 200 or 201, JSON:
${F}json
${sampleResult}
${F}
(id is your numeric id, slug is the final one, status is what you stored. Ideata parses this and shows a link.)

Error codes: 400 validation, 401 token, 409 slug conflict, 5xx yours.

### 2. DELETE /blog/ingest?sourceId=<sourceId> — REQUIRED (unpublish)
Deletes by OUR sourceId (not your id!). Note it comes as a QUERY PARAM, not a path segment.
- Success → 200.
- Article already gone → return 404: Ideata reads that as "already deleted" and counts it a success.

### 3. GET /blog/ingest — optional (only needed for reverse import)
List of articles WITH BODIES, drafts included. Query: status, locale, category, page (from 1), limit (≤50).
Response:
${F}json
{ "items": [ { "id": 1, "slug": "...", "title": "...", "bodyHtml": "...", "status": "published", "locale": "en" } ], "total": 42, "page": 1, "limit": 50 }
${F}
This endpoint is behind the same token — drafts never go out unauthenticated.

### 4. GET /blog/ingest/:id — optional, one article in full (the same object as in items).

## Non-functional requirements
- **Our timeout is 15 seconds.** Answer fast: push heavy work (re-uploading the cover, resizing, cache invalidation, static rebuild) to a background job and return 200 immediately.
- If the site is static (SSG), trigger a rebuild/revalidation after a successful receive, or the article will sit in the database and never appear.
- Cap the request body size (bodyHtml can be hundreds of KB) — something like 5 MB.
- Log sourceId, slug and the outcome. Never the token.

## Deliverables
1. Routes/controller with every required endpoint.
2. A migration: posts table with source_id (UNIQUE), slug (UNIQUE), status, locale, title, body_html, cover_url, published_at.
3. Token-check middleware.
4. A short README: which env vars to set and how to verify with curl.
5. Sample curl calls for POST and DELETE.

When done, tell me what to put into the Ideata fields "Base URL" (${b}) and "Auth header" (${h}), and remind me to set the token in env.`
  }

  return `Реализуй в моём проекте REST-приёмник для автопубликации статей из внешней CMS (Ideata Blog Writer).
Она уже настроена и будет ходить на мой сайт сама. Твоя задача — сделать принимающую сторону.

## Контекст
- Base URL моего API: ${b}
- Все пути ниже — относительно этого Base URL.
- Подстройся под МОЙ стек (фреймворк, ORM, роутинг, миграции, стиль кода). Сначала осмотри репозиторий и следуй тому, что уже принято в проекте.

## Аутентификация
Каждый запрос приходит с заголовком:
${F}
${h}: <секретный токен>
${F}
ВАЖНО: значение заголовка — САМ токен, БЕЗ префикса "Bearer " и без кавычек.
- Токен храни в переменной окружения (напр. BLOG_INGEST_TOKEN), НЕ в коде и не в гите.
- Сравнивай в постоянном времени (timingSafeEqual/hash_equals), не логируй значение.
- Неверный/отсутствующий токен → 401. Никаких других способов авторизации не добавляй.

## Эндпоинты

### 1. POST /blog/ingest — ОБЯЗАТЕЛЬНЫЙ (публикация и обновление)
Content-Type: application/json. Тело:
${F}json
${samplePayload('ru')}
${F}

Схема полей:
| поле | тип | обяз. | смысл |
|---|---|---|---|
${fields}

Семантика (это важнее кода):
1. **Идемпотентный upsert по sourceId.** Повторный POST с тем же sourceId — это ОБНОВЛЕНИЕ той же статьи, а НЕ вторая копия. Ideata шлёт POST и при первой публикации, и при каждом «обновить». Заведи колонку source_id с UNIQUE-индексом и делай upsert по ней.
2. **status="draft" НЕ должен быть публично доступен** — ни в списках, ни по прямой ссылке на slug. Анонимам видно только "published".
3. **slug**: прислан — используй его; занят ДРУГОЙ статьёй (другой sourceId) — ответь 409. Не прислан — сгенерируй из title и уникализируй.
4. **coverImageUrl** — абсолютный URL на чужом домене, он может со временем умереть. Скачай картинку сразу при приёме, положи в своё хранилище и храни уже свой URL. Ограничь размер (напр. ≤10 МБ) и типы (image/*), поставь таймаут. Не скачалось — всё равно прими статью, просто без обложки.
5. **bodyHtml приходит готовым HTML.** Не экранируй его в текст. Но и не доверяй слепо: прогони через санитайзер (разреши h1-h6, p, a, ul/ol/li, img, blockquote, pre/code, table, strong/em; вырежи script/style/iframe/on*-атрибуты).

Ответ при успехе — 200 или 201, JSON:
${F}json
${sampleResult}
${F}
(id — числовой id у тебя, slug — итоговый, status — как сохранил. Ideata это парсит и показывает ссылку на статью.)

Коды ошибок: 400 — валидация, 401 — токен, 409 — конфликт slug, 5xx — твоя ошибка.

### 2. DELETE /blog/ingest?sourceId=<sourceId> — ОБЯЗАТЕЛЬНЫЙ (снятие с публикации)
Удаляет статью по НАШЕМУ sourceId (не по твоему id!). Обрати внимание: sourceId приходит В QUERY-ПАРАМЕТРЕ, не в пути.
- Успех → 200.
- Такой статьи уже нет → верни 404: Ideata трактует это как «уже удалено» и считает успехом.

### 3. GET /blog/ingest — опционально (нужен только для обратного импорта)
Список статей С ТЕЛАМИ, включая черновики. Query: status, locale, category, page (с 1), limit (≤50).
Ответ:
${F}json
{ "items": [ { "id": 1, "slug": "...", "title": "...", "bodyHtml": "...", "status": "published", "locale": "ru" } ], "total": 42, "page": 1, "limit": 50 }
${F}
Этот эндпоинт тоже под токеном — черновики наружу не отдаём.

### 4. GET /blog/ingest/:id — опционально, одна статья целиком (тот же объект, что в items).

## Нефункциональные требования
- **Таймаут на нашей стороне — 15 секунд.** Отвечай быстро: тяжёлое (перезаливка обложки, ресайз, инвалидация кеша, ребилд статики) выноси в фон, а 200 отдавай сразу.
- Если сайт статический (SSG), после успешного приёма дёрни пересборку/ревалидацию, иначе статья осядет в БД и не появится на сайте.
- Ограничь размер тела запроса (bodyHtml бывает сотни КБ) — лимит вроде 5 МБ.
- Логируй sourceId, slug и результат. Токен — никогда.

## Что нужно на выходе
1. Роуты/контроллер со всеми обязательными эндпоинтами.
2. Миграция: таблица постов с source_id (UNIQUE), slug (UNIQUE), status, locale, title, body_html, cover_url, published_at.
3. Middleware проверки токена.
4. Короткий README: какие переменные окружения задать и как проверить curl-ом.
5. Примеры curl для POST и DELETE.

После реализации скажи, чем заполнить в Ideata поля «Base URL» (${b}) и «Заголовок авторизации» (${h}), и напомни задать токен в env.`
}
