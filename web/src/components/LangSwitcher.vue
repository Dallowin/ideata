<script setup lang="ts">
/**
 * Dashboard language switcher: EN | RU.
 *
 * Writes the `ideata_lang` cookie on `.ideata.io` — the same one the landing
 * reads, so the choice carries across both products. It ALSO syncs the active
 * brand's CONTENT language (brand.language): switching the dashboard language
 * switches what the agent writes in (persona, articles, AEO prompts, reports).
 * When the brand language actually changes we reload, so brand-language-dependent
 * content re-fetches in the new language.
 */
import { useI18n } from 'vue-i18n'
import { LOCALES, LOCALE_NAMES, setLocale, type Locale } from '@/i18n'
import { useBrands } from '@/composables/useBrands'
import { api } from '@/lib/api'

const { locale } = useI18n()
const { active } = useBrands()

async function pick(code: Locale) {
  if (code === locale.value) return
  const b = active.value
  const syncBrand = !!(b && b.id && b.language !== code)
  await setLocale(code)
  if (syncBrand) {
    try {
      await api.updateBrand({ id: b!.id, language: code })
      window.location.reload() // re-fetch brand-language-dependent content in the new language
    } catch { /* interface still switched; brand sync is best-effort */ }
  }
}
</script>

<template>
  <div
    class="flex items-center gap-0.5 rounded-full border border-border/60 p-0.5"
    role="group"
    :aria-label="$t('lang.label')"
  >
    <button
      v-for="code in LOCALES"
      :key="code"
      type="button"
      :title="LOCALE_NAMES[code]"
      :aria-pressed="code === locale"
      class="rounded-full px-2 py-0.5 text-[11.5px] font-medium transition"
      :class="code === locale
        ? 'bg-muted text-foreground'
        : 'text-muted-foreground hover:text-foreground'"
      @click="pick(code)"
    >{{ code.toUpperCase() }}</button>
  </div>
</template>
