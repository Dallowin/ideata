/**
 * Social-media profiles for the "content factory": one finished article -> a native
 * post for EVERY platform. A profile describes both the hard format constraints
 * (character limit, number of thread posts, hashtags) and the style instruction
 * for the LLM repackager.
 *
 * The profile's constraints are applied DETERMINISTICALLY in crosspost.ts
 * (truncation, post limit, hashtag top-up/trim, appending the article link) - so
 * the format is guaranteed even if the LLM misses the limit.
 *
 * Publishing itself does NOT happen here: the engine just returns ready text for
 * preview cards (and, later, for the tg/vk/threads connectors). Dzen has no
 * auto-publish (no public API) - its card is purely for manual transfer/RSS.
 */
import { pl } from '../lang'

/** How the result is rendered: social posts - plain text with emoji; Dzen - long-form markdown. */
export type PlatformFormat = 'plain' | 'markdown'

export interface PlatformProfile {
  key: string // machine key (matches the settings keys: tg/vk/threads/dzen)
  label: string // human-readable platform name
  emoji: string // icon for the UI card
  format: PlatformFormat
  charLimit: number // character limit per ONE post
  maxPosts: number // max number of posts (1 - single post; >1 - thread)
  thread: boolean // platform natively supports a thread of linked posts
  hashtags: { min: number, max: number } // how many hashtags fit (0/0 - none needed)
  appendLink: boolean // append a link to the full article at the end (if the URL is known)
  /** Style instruction for the LLM: how a native post on this platform should sound. */
  guide: string
}

/**
 * Platform registry. Order = card order in the UI. LinkedIn isn't enabled yet
 * (needs the app-review API) - it will be added as a profile right here, the engine
 * is platform-agnostic.
 */
export const PLATFORM_PROFILES: Record<string, PlatformProfile> = {
  tg: {
    key: 'tg',
    label: 'Telegram-канал',
    emoji: '✈️',
    format: 'plain',
    // sendMessage text limit is 4096 (tgPublish sends the cover as a separate photo
    // without a caption, so the 1024 caption limit doesn't apply to us). We leave a
    // small margin for the hashtags/link that get appended deterministically.
    charLimit: 3900,
    maxPosts: 1,
    thread: false,
    hashtags: { min: 0, max: 3 },
    appendLink: true,
    guide:
      'Формат: пост в Telegram-канале. Первая строка — цепляющий крючок (можно с эмодзи). '
      + 'Дальше — суть статьи ровно в том объёме, какого она заслуживает: короткая заметка → '
      + '2–3 абзаца, большой разбор → развёрнутый пост с буллетами «•» и мини-подзаголовками '
      + 'эмодзи-акцентом. Технический потолок — 4096 символов, но НЕ ориентир: не растягивай '
      + 'короткую статью до него. Пост самодостаточен и полезен сам по себе, ссылка в конце — '
      + 'для полной версии. Эмодзи — как акценты, не пачками. 0–3 хэштега в конце. Живо, без канцелярита.',
  },
  vk: {
    key: 'vk',
    label: 'ВКонтакте',
    emoji: '🅥',
    format: 'plain',
    charLimit: 1500,
    maxPosts: 1,
    thread: false,
    hashtags: { min: 3, max: 5 },
    appendLink: true,
    guide:
      'Формат: пост в сообществе ВКонтакте. Крючок в первой строке, затем связный текст с '
      + 'пользой из статьи (2–5 абзацев), допустимы буллеты через «•». Тон живой и полезный, '
      + 'без официоза. Эмодзи — умеренно. В конце 3–5 тематических хэштегов вида #тег (нижним '
      + 'регистром, слитно или через_подчёркивание, релевантные теме).',
  },
  threads: {
    key: 'threads',
    label: 'Threads',
    emoji: '🧵',
    format: 'plain',
    charLimit: 480, // technical limit is 500; we leave margin for numbering/link
    maxPosts: 6,
    thread: true,
    hashtags: { min: 0, max: 1 },
    appendLink: true,
    guide:
      'Формат: тред в Threads из 2–5 коротких постов. Каждый пост ≤480 символов и самодостаточен. '
      + 'Первый пост — сильный крючок, который заставляет раскрыть тред. Дальше — по одной мысли на '
      + 'пост, разговорным тоном, как будто рассказываешь коллеге. Без нумерации «1/5» (площадка сама '
      + 'сшивает). Эмодзи — точечно. Максимум 1 хэштег и только если он реально в тему. '
      + 'Последний пост — короткий вывод и приглашение к полной статье.',
  },
  x: {
    key: 'x',
    label: 'X (Twitter)',
    emoji: '𝕏',
    format: 'plain',
    charLimit: 270, // technical limit is 280; margin for link and numbering
    maxPosts: 8,
    thread: true,
    hashtags: { min: 0, max: 2 },
    appendLink: true,
    guide:
      'Формат: тред в X из 3–7 постов. Каждый пост ≤270 символов и читается отдельно. '
      + 'Первый — сильный крючок с конкретикой (цифра, неожиданный факт), без «в этой ветке расскажу». '
      + 'Дальше по одной мысли на пост, короткими фразами, без канцелярита и без воды. '
      + 'Хэштеги почти не нужны: 0–2 и только если это реальные теги сообщества. '
      + 'Последний пост — вывод и ссылка на полную статью.',
  },
  bluesky: {
    key: 'bluesky',
    label: 'Bluesky',
    emoji: '🦋',
    format: 'plain',
    charLimit: 290, // technical limit is 300 graphemes; margin for numbering and link
    maxPosts: 8,
    thread: true,
    hashtags: { min: 0, max: 2 },
    appendLink: true,
    guide:
      'Формат: тред в Bluesky из 3–6 постов. Каждый пост ≤290 символов и читается '
      + 'отдельно. Аудитория там техническая и скептичная к маркетингу: конкретика, '
      + 'цифры, никакого «мы рады сообщить». Первый пост — сильное утверждение по '
      + 'делу. Хэштеги почти не в ходу: 0–2 и только по существу. Последний пост — '
      + 'вывод и ссылка на полную статью.',
  },
  mastodon: {
    key: 'mastodon',
    label: 'Mastodon',
    emoji: '🐘',
    format: 'plain',
    charLimit: 480, // most instances allow 500; margin for numbering
    maxPosts: 6,
    thread: true,
    hashtags: { min: 1, max: 3 },
    appendLink: true,
    guide:
      'Формат: тред в Mastodon из 2–5 постов. Каждый пост ≤480 символов. Тон '
      + 'разговорный и без рекламы — там это считывается мгновенно и отталкивает. '
      + 'Хэштеги в Mastodon реально работают как навигация: 1–3 по теме поста. '
      + 'Последний пост — вывод и ссылка на полную статью.',
  },
  linkedin: {
    key: 'linkedin',
    label: 'LinkedIn',
    emoji: 'in',
    format: 'plain',
    charLimit: 2900, // technical post limit is 3000; margin for the link
    maxPosts: 1,
    thread: false, // their API posts single entries, no threads
    hashtags: { min: 2, max: 4 },
    appendLink: true,
    guide:
      'Формат: пост в LinkedIn на 700–1500 символов. Аудитория профессиональная, '
      + 'поэтому по делу и без восторгов: сначала наблюдение или цифра, дальше 2–4 '
      + 'коротких абзаца с выводами, в конце вопрос к читателю и ссылка на статью. '
      + 'Первые две строки решают всё — их видно до «показать ещё». Без канцелярита '
      + 'и без «рады поделиться». Хэштеги 2–4, по теме, в самом конце.',
  },
  dzen: {
    key: 'dzen',
    label: 'Дзен',
    emoji: '⚡',
    format: 'markdown',
    charLimit: 8000,
    maxPosts: 1,
    thread: false,
    hashtags: { min: 3, max: 5 },
    appendLink: false, // Dzen is a full-fledged article, a link to the source isn't required
    guide:
      'Формат: статья для Дзена (markdown). Дай новый цепляющий заголовок (# H1) под дзеновскую '
      + 'аудиторию, затем вводку-крючок из 2–3 предложений, которая обещает пользу и держит до-скролл. '
      + 'Разбей тело на 3–5 разделов с подзаголовками (## H2), пиши разговорнее и проще, чем в '
      + 'экспертном блоге, но без воды и кликбейта-обмана. Сохрани фактуру и главные выводы статьи. '
      + 'В конце — короткий итог и 3–5 хэштегов вида #тег.',
  },
}

/** List of profiles in display order. */
export const PLATFORM_LIST: PlatformProfile[] = Object.values(PLATFORM_PROFILES)

/**
 * English translation of each profile's `guide` (the LLM style instruction).
 * Kept as a side map, not inline in PLATFORM_PROFILES, so the Russian object
 * above stays byte-for-byte untouched — the live RU pipeline is unaffected.
 */
const PLATFORM_GUIDE_EN: Record<string, string> = {
  tg:
    'Format: a post in a Telegram channel. First line — a catchy hook (emoji optional). '
    + 'Then — the gist of the article in exactly the volume it deserves: a short note → '
    + '2–3 paragraphs, an in-depth piece → an expanded post with "•" bullets and mini-subheadings '
    + 'with an emoji accent. Technical ceiling — 4096 characters, but NOT a target: don\'t stretch a '
    + 'short article to reach it. The post is self-sufficient and useful on its own, the link at the '
    + 'end is for the full version. Emoji — as accents, not in bunches. 0–3 hashtags at the end. '
    + 'Lively, no corporate-speak.',
  vk:
    'Format: a post in a VKontakte community. A hook in the first line, then coherent text with '
    + 'value from the article (2–5 paragraphs), "•" bullets are fine. Tone — lively and useful, no '
    + 'officialese. Emoji — moderate. At the end, 3–5 topical hashtags in the form #tag (lowercase, '
    + 'either solid or with_underscores, relevant to the topic).',
  threads:
    'Format: a Threads thread of 2–5 short posts. Each post ≤480 characters and self-contained. '
    + 'First post — a strong hook that makes people expand the thread. Then — one idea per post, in '
    + 'a conversational tone, as if telling a colleague. No "1/5" numbering (the platform stitches it '
    + 'together itself). Emoji — sparingly. At most 1 hashtag, and only if it\'s genuinely on-topic. '
    + 'Last post — a short takeaway and an invitation to the full article.',
  x:
    'Format: an X thread of 3–7 posts. Each post ≤270 characters and reads on its own. The first — '
    + 'a strong hook with specifics (a number, an unexpected fact), without "in this thread I\'ll tell '
    + 'you". Then one idea per post, in short phrases, no corporate-speak and no filler. Hashtags are '
    + 'barely needed: 0–2, and only if they\'re real community tags. Last post — a takeaway and a link '
    + 'to the full article.',
  bluesky:
    'Format: a Bluesky thread of 3–6 posts. Each post ≤290 characters and reads on its own. The '
    + 'audience there is technical and skeptical of marketing: specifics, numbers, no "we\'re excited '
    + 'to announce". First post — a strong, substantive statement. Hashtags are rarely used: 0–2 and '
    + 'only if truly relevant. Last post — a takeaway and a link to the full article.',
  mastodon:
    'Format: a Mastodon thread of 2–5 posts. Each post ≤480 characters. Conversational tone and no '
    + 'advertising — it reads as such instantly there and turns people off. Hashtags actually work as '
    + 'navigation on Mastodon: 1–3 relevant to the post\'s topic. Last post — a takeaway and a link to '
    + 'the full article.',
  linkedin:
    'Format: a LinkedIn post of 700–1500 characters. The audience is professional, so keep it to the '
    + 'point and without enthusiasm: start with an observation or a number, then 2–4 short paragraphs '
    + 'with takeaways, end with a question to the reader and a link to the article. The first two lines '
    + 'decide everything — that\'s what\'s visible before "see more". No corporate-speak and no "excited '
    + 'to share". 2–4 hashtags, on-topic, right at the end.',
  dzen:
    'Format: an article for Zen (markdown). Give it a new catchy headline (# H1) for the Zen audience, '
    + 'then a 2–3 sentence hook intro that promises value and keeps people scrolling. Break the body '
    + 'into 3–5 sections with subheadings (## H2), write more conversationally and simply than in an '
    + 'expert blog, but without filler or deceptive clickbait. Keep the factual substance and the '
    + 'article\'s main takeaways. End with a short summary and 3–5 hashtags in the form #tag.',
}

/**
 * Profile by key (or undefined, if the key is unknown). `lang` selects the
 * LLM-facing `guide` instruction only — everything else (limits, keys, labels)
 * is language-independent. Defaults to 'ru' so existing callers are unaffected.
 */
export function platformProfile(key: string, lang: string = 'ru'): PlatformProfile | undefined {
  const k = (key || '').trim().toLowerCase()
  const base = PLATFORM_PROFILES[k]
  if (!base) return undefined
  const en = PLATFORM_GUIDE_EN[k]
  return en ? { ...base, guide: pl(lang, base.guide, en) } : base
}

/** Keys of all known platforms. */
export const PLATFORM_KEYS = Object.keys(PLATFORM_PROFILES)
