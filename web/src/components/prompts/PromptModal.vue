<script setup lang="ts">
// Модалка деталей промпта — порт раскладки Peec из web/aa/PromptModal.
// Только реальные ответы прогона (row.answers); нет ответа → «Нет данных».
import { computed, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Boxes, Check, Copy, ExternalLink, Gauge, Globe, User, X,
} from 'lucide-vue-next'
import {
  ENGINE_I18N, PREFILL,
  type AnswerBlock, type AnswerSegment, type Platform, type PromptRow, type RealAnswer,
} from '@/data/prompts'

const props = defineProps<{
  row: PromptRow | null
  platforms: Platform[]
  ownBrand?: string
}>()
const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()
const engineLabel = (p: Platform) => (ENGINE_I18N.has(p.key) ? t(`prompts.engine.${p.key}`) : p.label)

function close() { open.value = false }
function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close() }
watch(open, (o) => {
  document.documentElement.style.overflow = o ? 'hidden' : ''
  if (o) window.addEventListener('keydown', onKey)
  else window.removeEventListener('keydown', onKey)
})
onUnmounted(() => {
  document.documentElement.style.overflow = ''
  window.removeEventListener('keydown', onKey)
})

// ── текущий движок ────────────────────────────────────────────────────────
const curKey = ref<string>('')
watch([open, () => props.row], ([o]) => {
  if (!o || !props.row) return
  const withMention = props.platforms.find((p) => (props.row!.engines[p.key] ?? 0) > 0)
  curKey.value = (withMention ?? props.platforms[0]!).key
})
const curMeta = computed(() =>
  props.platforms.find((p) => p.key === curKey.value) ?? props.platforms[0]!)
const pos = computed(() => props.row?.engines[curKey.value] ?? 0)

// ── реальный ответ или мок ────────────────────────────────────────────────
const realAnswer = computed<RealAnswer | null>(() =>
  props.row?.answers?.find((a) => a.platform === curKey.value) ?? null)

const own = (name: string) => {
  const ob = (props.ownBrand || 'ideata').toLowerCase()
  return name.toLowerCase().startsWith(ob)
}

// фавиконка бренда в чипе: только для доменоподобных имён (insane.gg, Clash.gg)
const failedFavicons = ref<Set<string>>(new Set())
function brandDomain(name: string): string {
  const s = name.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]!
  return /\.[a-z]{2,}$/i.test(s) ? s : ''
}
function chipFavicon(name: string): string {
  const d = brandDomain(name)
  if (!d || failedFavicons.value.has(d)) return ''
  return `https://www.google.com/s2/favicons?domain=${d}&sz=64`
}
function onChipFaviconError(name: string) {
  const d = brandDomain(name)
  if (d) failedFavicons.value = new Set([...failedFavicons.value, d])
}

// разбивка реального текста на сегменты с чипами брендов (без v-html)
function toSegments(text: string, brands: string[]): AnswerSegment[] {
  if (!brands.length) return [text]
  const escaped = brands
    .filter((b) => b.length >= 2)
    .sort((a, b) => b.length - a.length)
    .map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (!escaped.length) return [text]
  let re: RegExp
  try { re = new RegExp(`(?<![\\p{L}\\p{N}_])(${escaped.join('|')})(?![\\p{L}\\p{N}_])`, 'giu') }
  catch { re = new RegExp(`(${escaped.join('|')})`, 'gi') }
  const out: AnswerSegment[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index))
    out.push({ brand: m[0]!, own: own(m[0]!) })
    last = m.index! + m[0]!.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

interface View {
  blocks: AnswerBlock[]
  citations: { host: string; url: string }[]
  mentions: { brand: string; own: boolean; count: number }[]
  /** ключ тональности судьи ('' — судья её не дал), подпись — sentimentLabel() */
  sentiment: string
  score: number | null
  bars: { label: string; pct: number }[] | null
  empty?: boolean
}

const SENTIMENTS = new Set(['positive', 'neutral', 'negative', 'mixed'])
const sentimentLabel = (key: string) => (SENTIMENTS.has(key) ? t(`prompts.modal.sentiment.${key}`) : '—')

const view = computed<View | null>(() => {
  if (!props.row) return null

  // реальный прогон
  if (props.row.answers?.length) {
    const a = realAnswer.value
    if (!a?.text) {
      return { blocks: [], citations: [], mentions: [], sentiment: '', score: null, bars: null, empty: true }
    }
    const brandNames = (a.brandsFound || []).map((b) => b.brand).filter(Boolean)
    // лёгкая md-чистка строки: маркеры списков/заголовков/цитат, [текст](url),
    // **болд**, *курсив*, `код` — в чистую типографику
    const mdClean = (line: string) => line
      .replace(/^#{1,6}\s*/, '')
      .replace(/^>\s*/, '')
      .replace(/^[-•*]\s+/, '')
      .replace(/^\d+[.)]\s*/, '')
      .replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1')
      .replaceAll('**', '')
      .replace(/(^|\s)\*([^*\n]+)\*(?=[\s.,;:!?)]|$)/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
      .trim()
    const blocks: AnswerBlock[] = a.text
      // заголовок, приклеенный внутрь строки («…text. ## Heading») → своя строка
      .replace(/\s+(#{1,6})\s+/g, '\n$1 ')
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^([-—*_=]\s*){3,}$/.test(line)) // ---- разделители
      .map((line) => {
        const isLi = /^[-•*\d]+[.)]?\s/.test(line)
        const isHead = /^#{1,6}\s/.test(line)
        return {
          type: isLi ? 'li' as const : 'p' as const,
          strong: isHead,
          parts: toSegments(mdClean(line), brandNames),
        }
      })
      .filter((b) => b.parts.some((p) => typeof p !== 'string' || p.trim()))
    const countIn = (name: string) => {
      try {
        const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        return (a.text!.match(new RegExp(`(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`, 'giu')) || []).length
      } catch { return 1 }
    }
    const mentions = brandNames
      .map((b) => ({ brand: b, own: own(b), count: countIn(b) }))
      .sort((x, y) => (x.own === y.own ? y.count - x.count : x.own ? -1 : 1))
    const citations = (a.citations || []).map((c) => {
      const url = typeof c === 'string' ? c : (c.url || '')
      const host = (typeof c === 'object' && c.host) || url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] || ''
      return { host, url }
    }).filter((c) => c.url)
    return {
      blocks,
      citations,
      mentions,
      sentiment: String(a.judge?.sentiment || '').toLowerCase(),
      score: a.judge?.score ?? null,
      bars: null,
    }
  }

  // ответов прогона нет вовсе
  return { blocks: [], citations: [], mentions: [], sentiment: '', score: null, bars: null, empty: true }
})

// ── мета-стрип ────────────────────────────────────────────────────────────
const metaStrip = computed(() => {
  if (!props.row || !view.value) return []
  return [
    { l: t('prompts.modal.meta.model'), v: engineLabel(curMeta.value) },
    { l: t('prompts.modal.meta.run'), v: t(`prompts.run.${props.row.checked}`) },
    // язык ответов трекера, а не язык кабинета: прогон идёт по-русски
    { l: t('prompts.modal.meta.language'), v: t('prompts.modal.languageValue') },
    { l: t('prompts.modal.meta.brandMentioned'), v: pos.value ? t('prompts.modal.mentionedPos', { pos: pos.value }) : t('prompts.modal.no') },
    { l: t('prompts.modal.meta.siteCited'), v: view.value.citations.some((c) => own(c.host.split('.')[0] || '')) ? t('prompts.modal.yes') : t('prompts.modal.no') },
    { l: t('prompts.modal.meta.sentiment'), v: sentimentLabel(view.value.sentiment) },
  ]
})

const metricRows = computed(() => {
  if (!props.row) return []
  return [
    { l: t('prompts.modal.metrics.visibility'), v: `${props.row.vis}%` },
    { l: t('prompts.modal.metrics.intent'), v: t(`prompts.intent.${props.row.intent}`) },
    { l: t('prompts.modal.metrics.citations'), v: String(props.row.citations) },
    // без второй недели дельта не существует — «+0» здесь был константой
    { l: t('prompts.modal.metrics.trendWeeks', { n: props.row.trend.length || 0 }),
      v: props.row.trend.length > 1
        ? `${props.row.delta >= 0 ? '+' : ''}${props.row.delta}`
        : t('prompts.modal.metrics.noData') },
  ]
})

// ── источники ─────────────────────────────────────────────────────────────
const CITE_PREVIEW = 4
const showAllSrc = ref(false)
watch(curKey, () => { showAllSrc.value = false })
const visibleCites = computed(() => {
  const all = view.value?.citations ?? []
  return showAllSrc.value ? all : all.slice(0, CITE_PREVIEW)
})
const faviconUrl = (host: string) => `https://www.google.com/s2/favicons?domain=${host}&sz=64`

// ── «Открыть промпт» / копирование ────────────────────────────────────────
const openUrl = computed(() => PREFILL[curKey.value]?.(props.row?.text ?? '') ?? '')
const copied = ref(false)
async function copyPrompt() {
  try {
    await navigator.clipboard.writeText(props.row?.text ?? '')
    copied.value = true
    setTimeout(() => (copied.value = false), 1400)
  } catch {}
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && row"
      class="pm-root fixed inset-0 z-[100] flex items-stretch justify-center p-0 sm:items-center sm:p-6"
      role="dialog" aria-modal="true"
    >
      <div class="pm-backdrop absolute inset-0 bg-black/60 backdrop-blur-[3px]" @click="close" />
      <div class="pm-panel relative flex h-full w-full max-w-[1040px] overflow-hidden border border-border bg-popover shadow-[0_32px_80px_-20px_rgba(0,0,0,0.8)] sm:h-[86vh] sm:rounded-2xl">

        <!-- ═══ ЛЕВАЯ КОЛОНКА: чат ═══ -->
        <div class="flex min-w-0 flex-1 flex-col">
          <!-- шапка движка -->
          <div class="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-5">
            <img :src="curMeta.icon" :alt="engineLabel(curMeta)" class="size-5 shrink-0 rounded-full bg-surface-2 p-0.5" />
            <span class="text-[14px] font-semibold">{{ engineLabel(curMeta) }}</span>

            <!-- переключатель движков -->
            <div class="ml-1 flex items-center gap-1">
              <button
                v-for="p in platforms" :key="p.key" type="button"
                :title="`${engineLabel(p)} · ${row.engines[p.key] ? `#${row.engines[p.key]}` : $t('prompts.modal.engineNoMention')}`"
                class="inline-flex size-6 items-center justify-center rounded-md border transition"
                :class="p.key === curKey ? 'border-white/25 bg-surface-hover' : 'border-transparent opacity-40 hover:opacity-90'"
                @click="curKey = p.key"
              >
                <img :src="p.icon" :alt="engineLabel(p)" class="size-3.5 rounded-full" />
              </button>
            </div>

            <a
              v-if="openUrl" :href="openUrl" target="_blank" rel="noopener"
              class="ml-auto inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground transition hover:text-foreground"
            >{{ $t('prompts.modal.openPrompt') }} <ExternalLink :size="13" /></a>
            <button
              v-else type="button"
              class="ml-auto inline-flex items-center gap-1 text-[12.5px] font-medium text-muted-foreground transition hover:text-foreground"
              @click="copyPrompt"
            ><component :is="copied ? Check : Copy" :size="13" /> {{ copied ? $t('action.copied') : $t('prompts.modal.copyPrompt') }}</button>

            <button
              type="button" :aria-label="$t('action.close')"
              class="-mr-1 ml-1 flex size-8 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-surface-hover hover:text-foreground md:hidden"
              @click="close"
            ><X :size="17" /></button>
          </div>

          <!-- мета текущего ответа -->
          <div class="flex shrink-0 flex-wrap gap-x-6 gap-y-2 border-b border-border/60 bg-surface px-5 py-3">
            <div v-for="m in metaStrip" :key="m.l" class="min-w-0">
              <div class="text-[10.5px] uppercase tracking-wide text-muted-foreground/70">{{ m.l }}</div>
              <div class="mt-0.5 truncate text-[12.5px] font-medium">{{ m.v }}</div>
            </div>
          </div>

          <!-- лента чата -->
          <div class="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5">
            <!-- сообщение пользователя -->
            <div class="flex items-start justify-end gap-2.5">
              <div class="max-w-[74%] break-words rounded-2xl rounded-tr-md bg-surface-hover px-3.5 py-2.5 text-[13.5px] leading-relaxed">
                {{ row.text }}
              </div>
              <span class="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-background"><User :size="16" /></span>
            </div>

            <!-- ответ ИИ -->
            <div class="flex items-start gap-2.5">
              <span class="inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-surface-2">
                <img :src="curMeta.icon" :alt="engineLabel(curMeta)" class="size-[17px]" />
              </span>
              <div v-if="view && !view.empty" class="min-w-0 flex-1 space-y-2.5 text-[13.5px] leading-relaxed text-text-2">
                <template v-for="(b, bi) in view.blocks" :key="bi">
                  <p v-if="b.type === 'p'" :class="b.strong && 'font-semibold text-foreground'">
                    <template v-for="(part, pi) in b.parts" :key="pi">
                      <span
                        v-if="typeof part !== 'string'"
                        class="whitespace-nowrap rounded-[5px] px-[5px] py-px font-semibold"
                        :class="part.own ? 'bg-amber-400/20 text-amber-300' : 'bg-surface-hover text-foreground'"
                      ><img
                        v-if="chipFavicon(part.brand)"
                        :src="chipFavicon(part.brand)" alt=""
                        class="mr-[3px] inline-block size-3 -translate-y-px rounded-[2px] align-middle"
                        referrerpolicy="no-referrer"
                        @error="onChipFaviconError(part.brand)"
                      />{{ part.brand }}</span>
                      <template v-else>{{ part }}</template>
                    </template>
                  </p>
                  <div v-else class="flex gap-2 pl-1">
                    <span class="mt-[9px] size-1 shrink-0 rounded-full bg-muted-foreground/35"></span>
                    <p>
                      <template v-for="(part, pi) in b.parts" :key="pi">
                        <span
                          v-if="typeof part !== 'string'"
                          class="whitespace-nowrap rounded-[5px] px-[5px] py-px font-semibold"
                          :class="part.own ? 'bg-amber-400/20 text-amber-300' : 'bg-surface-hover text-foreground'"
                        ><img
                          v-if="chipFavicon(part.brand)"
                          :src="chipFavicon(part.brand)" alt=""
                          class="mr-[3px] inline-block size-3 -translate-y-px rounded-[2px] align-middle"
                          referrerpolicy="no-referrer"
                          @error="onChipFaviconError(part.brand)"
                        />{{ part.brand }}</span>
                        <template v-else>{{ part }}</template>
                      </template>
                    </p>
                  </div>
                </template>
              </div>
              <p v-else class="text-[13px] text-muted-foreground">
                {{ $t('prompts.modal.emptyAnswer') }}
              </p>
            </div>
          </div>
        </div>

        <!-- ═══ ПРАВАЯ ПАНЕЛЬ: детали ═══ -->
        <aside class="hidden w-[320px] shrink-0 flex-col border-l border-border bg-surface md:flex">
          <div class="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
            <span class="text-[13px] font-semibold">{{ $t('prompts.modal.details') }}</span>
            <button
              type="button" :aria-label="$t('action.close')"
              class="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-surface-hover hover:text-foreground"
              @click="close"
            ><X :size="17" /></button>
          </div>

          <div v-if="view" class="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
            <!-- Бренды -->
            <section v-if="view.mentions.length">
              <div class="mb-2.5 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/70"><Boxes :size="12" /> {{ $t('prompts.modal.brands') }}</div>
              <div class="space-y-2">
                <div v-for="b in view.mentions" :key="b.brand" class="flex min-w-0 items-center gap-2">
                  <img
                    v-if="chipFavicon(b.brand)"
                    :src="chipFavicon(b.brand)" alt=""
                    class="size-4 shrink-0 rounded-sm" referrerpolicy="no-referrer"
                    @error="onChipFaviconError(b.brand)"
                  />
                  <span v-else class="flex size-4 shrink-0 items-center justify-center rounded-sm bg-surface-hover text-[9px] font-bold uppercase text-muted-foreground">{{ b.brand[0] }}</span>
                  <span class="truncate text-[13px] text-text-2">{{ b.brand }}</span>
                  <span v-if="b.own" class="rounded border border-brand/30 bg-brand/15 px-1 text-[10px] font-medium text-brand-soft">{{ $t('prompts.sources.you') }}</span>
                  <span class="ml-auto inline-flex shrink-0 items-center gap-1.5">
                    <span class="size-1.5 rounded-full" :class="b.count > 0 ? 'bg-amber-400' : 'bg-muted-foreground/30'"></span>
                    <span class="text-[12.5px] font-medium tabular-nums" :class="b.count > 0 ? '' : 'text-muted-foreground/60'">{{ b.count }}</span>
                  </span>
                </div>
              </div>
            </section>

            <!-- Метрики промпта -->
            <section>
              <div class="mb-2.5 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/70"><Gauge :size="12" /> {{ $t('prompts.modal.metrics.title') }}</div>
              <div class="space-y-1.5">
                <div v-for="m in metricRows" :key="m.l" class="flex items-baseline justify-between gap-3">
                  <span class="text-[12.5px] text-muted-foreground">{{ m.l }}</span>
                  <span class="truncate text-right text-[12.5px] font-medium tabular-nums">{{ m.v }}</span>
                </div>
              </div>
            </section>

            <!-- Оценка ответа -->
            <section v-if="view.score != null">
              <div class="mb-2.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/70">{{ $t('prompts.modal.score') }}</div>
              <div class="flex items-baseline gap-2">
                <span class="text-[20px] font-semibold leading-none tracking-tight tabular-nums">{{ view.score }}</span>
                <span class="text-[11.5px] text-muted-foreground/70">/ 100</span>
                <span class="ml-auto inline-flex items-center gap-1.5 text-[12px] text-text-2">
                  <span class="size-1.5 rounded-full" :class="view.sentiment === 'positive' ? 'bg-emerald-400' : view.sentiment === 'negative' ? 'bg-rose-400' : 'bg-zinc-500'"></span>
                  {{ sentimentLabel(view.sentiment) }}
                </span>
              </div>
              <div v-if="view.bars" class="mt-3 space-y-2">
                <div v-for="b in view.bars" :key="b.label" class="flex items-center gap-2">
                  <span class="w-20 shrink-0 text-[11.5px] text-muted-foreground">{{ b.label }}</span>
                  <span class="h-1 flex-1 overflow-hidden rounded-full bg-surface-hover">
                    <span class="block h-full rounded-full bg-muted-foreground/50" :style="{ width: b.pct + '%' }"></span>
                  </span>
                  <span class="w-7 text-right text-[11.5px] tabular-nums">{{ b.pct }}</span>
                </div>
              </div>
            </section>

            <!-- Источники -->
            <section v-if="view.citations.length">
              <div class="mb-2.5 flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground/70">
                <Globe :size="12" /> {{ $t('prompts.modal.sources') }} · {{ view.citations.length }}
              </div>
              <div class="space-y-3">
                <a
                  v-for="(c, ci) in visibleCites" :key="ci" :href="c.url" target="_blank" rel="noopener"
                  class="group flex min-w-0 items-start gap-2"
                >
                  <img :src="faviconUrl(c.host)" width="16" height="16" class="mt-0.5 shrink-0 rounded-sm" loading="lazy" />
                  <div class="min-w-0">
                    <div class="truncate text-[12.5px] font-semibold transition group-hover:text-brand-soft">{{ c.host }}</div>
                    <div class="break-all text-[11px] leading-snug text-muted-foreground/70">{{ c.url }}</div>
                  </div>
                </a>
              </div>
              <button
                v-if="view.citations.length > CITE_PREVIEW && !showAllSrc" type="button"
                class="mt-3 text-[12px] font-medium text-brand-soft transition hover:text-foreground"
                @click="showAllSrc = true"
              >{{ $t('prompts.modal.showAll') }} · {{ view.citations.length }}</button>
            </section>
          </div>
        </aside>
      </div>
    </div>
  </Teleport>
</template>

<style>
.pm-root { animation: pm-fade .18s ease both; }
.pm-panel { animation: pm-rise .2s cubic-bezier(.2, .8, .2, 1) both; }
@keyframes pm-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes pm-rise { from { opacity: 0; transform: translateY(10px) scale(.99) } to { opacity: 1; transform: none } }
@media (prefers-reduced-motion: reduce) { .pm-root, .pm-panel { animation: none } }
</style>
