/**
 * Content-language picker for LLM prompts. The pipeline threads the brand's
 * content language (s.language: 'ru' | 'en' | …); anything English-y selects the
 * English variant, everything else keeps Russian. Keep the Russian text of every
 * prompt byte-for-byte identical so the live RU product is unaffected — the
 * English branch is purely additive.
 */
export function pl(lang: string | undefined | null, ru: string, en: string): string {
  return String(lang || '').toLowerCase().startsWith('en') ? en : ru;
}
