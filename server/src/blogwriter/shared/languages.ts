/**
 * Content languages — the same locale set as on insane.gg (ru, en, pt, es, tr, de, pl).
 * `code` — the locale (matches insane), `label` — how we show it in the UI,
 * `prompt` — how we name the language in LLM prompts (goes into "Language: …").
 * The list is used in the settings select and for backend validation.
 */
export interface LanguageOption {
  code: string
  label: string // UI label (flag + name)
  prompt: string // value that goes into the prompt (s.language)
}

export const LANGUAGES: LanguageOption[] = [
  { code: 'ru', label: '🇷🇺 Русский', prompt: 'русский' },
  { code: 'en', label: '🇬🇧 English', prompt: 'английский (English)' },
  { code: 'pt', label: '🇵🇹 Português', prompt: 'португальский (Português)' },
  { code: 'es', label: '🇪🇸 Español', prompt: 'испанский (Español)' },
  { code: 'tr', label: '🇹🇷 Türkçe', prompt: 'турецкий (Türkçe)' },
  { code: 'de', label: '🇩🇪 Deutsch', prompt: 'немецкий (Deutsch)' },
  { code: 'pl', label: '🇵🇱 Polski', prompt: 'польский (Polski)' },
]

/** Default language (like DEFAULT_LOCALE on insane) — Russian. */
export const DEFAULT_LANGUAGE = LANGUAGES[0].prompt

/** Find an option by a value from settings (matches prompt, code, or label). */
export function findLanguage(value: string): LanguageOption | undefined {
  const v = (value || '').trim().toLowerCase()
  return LANGUAGES.find(l => l.prompt.toLowerCase() === v || l.code === v || l.label.toLowerCase().includes(v))
}
