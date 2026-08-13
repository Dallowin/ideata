<script setup lang="ts">
/**
 * Дока API приёмника для канала «Сайт».
 *
 * Раньше в «Интеграции» стояло одно поле токена и подпись «пропишите тот же
 * токен в приёмнике /blog/ingest» — по ней приёмник не написать: неизвестно ни
 * какие эндпоинты нужны, ни что лежит в теле, ни что отвечать. Здесь полный
 * контракт: эндпоинты, схема полей, пример запроса и ответа, curl-проверка,
 * коды ответов и готовое ТЗ для ИИ-ассистента.
 *
 * Base URL и заголовок подставляются из формы выше — примеры сразу рабочие,
 * копировать и править руками нечего. Токен не подставляем нигде: сервер его в
 * браузер не отдаёт, а в curl-примере он читается из переменной окружения.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronRight, Copy } from 'lucide-vue-next'
import {
  INGEST_ENDPOINTS, INGEST_ERRORS, INGEST_FIELDS,
  assistantPrompt, curlSample, samplePayload, sampleResult, type Lang,
} from '@/data/ingestDocs'

const props = defineProps<{ base: string; header: string }>()

const { locale, t } = useI18n()
const lang = computed<Lang>(() => (String(locale.value).startsWith('en') ? 'en' : 'ru'))

// Ключи статикой, а не `docs.flow.s${n}` — склейку не видит ни проверка
// словарей (npm run check:i18n), ни поиск по коду.
// {base} в тексте — настоящий адрес из формы: «мы шлём POST на /blog/ingest»
// без домена читается как абстрактный пример.
const baseArg = computed(() => ({ base: (props.base || '').trim().replace(/\/+$/, '') || 'https://api.example.com' }))
const FLOW = computed(() => [
  { t: t('blog.pages.integration.docs.flow.s1.t'), d: t('blog.pages.integration.docs.flow.s1.d', baseArg.value) },
  { t: t('blog.pages.integration.docs.flow.s2.t'), d: t('blog.pages.integration.docs.flow.s2.d') },
  { t: t('blog.pages.integration.docs.flow.s3.t'), d: t('blog.pages.integration.docs.flow.s3.d', baseArg.value) },
])

const payload = computed(() => samplePayload(lang.value))
const curl = computed(() => curlSample(props.base, props.header, lang.value))
const prompt = computed(() => assistantPrompt(lang.value, props.base, props.header))

const copied = ref('')
let copyT: ReturnType<typeof setTimeout> | undefined
async function copy(text: string, tag: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = tag
    clearTimeout(copyT)
    copyT = setTimeout(() => { if (copied.value === tag) copied.value = '' }, 2000)
  } catch { /* clipboard недоступен (не-https / отказ в правах) — текст виден и выделяется руками */ }
}

const METHOD_CLASS: Record<string, string> = {
  POST: 'bg-success-soft text-success',
  GET: 'bg-surface-2 text-muted-foreground',
  PUT: 'bg-warning-soft text-warning',
  DELETE: 'bg-danger-soft text-danger',
}
</script>

<template>
  <!-- Свёрнуто по умолчанию: это справочник на два экрана, а не часть формы —
       развёрнутым он отжимал настройки канала вниз. Кнопка «ТЗ для ассистента»
       живёт внутри, а не в summary: клик по ней схлопывал бы весь блок. -->
  <details class="group overflow-hidden rounded-xl border border-border bg-surface">
    <summary class="flex cursor-pointer list-none items-center gap-3 px-5 py-3.5 transition hover:bg-surface-2">
      <ChevronRight :size="14" class="shrink-0 text-muted-foreground transition group-open:rotate-90" />
      <div class="min-w-0">
        <h2 class="text-[13px] font-medium">{{ $t('blog.pages.integration.docs.title') }}</h2>
        <p class="mt-0.5 text-[11.5px] text-muted-foreground">{{ $t('blog.pages.integration.docs.subtitle') }}</p>
      </div>
    </summary>

    <div class="space-y-6 border-t border-border p-5">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <p class="max-w-[72ch] text-[12px] leading-[1.6] text-muted-foreground">
          {{ $t('blog.pages.integration.docs.promptHint') }}
        </p>
        <button
          type="button"
          class="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-2.5 py-1.5 text-[12px] font-medium transition hover:bg-surface-hover"
          @click="copy(prompt, 'prompt')"
        >
          <component :is="copied === 'prompt' ? Check : Copy" :size="13" class="text-muted-foreground" />
          {{ copied === 'prompt' ? $t('action.copied') : $t('blog.pages.integration.docs.copyPrompt') }}
        </button>
      </div>

      <!-- как это работает: три шага вместо абзаца прозы -->
      <div>
        <h3 class="text-[12.5px] font-medium">{{ $t('blog.pages.integration.docs.flowTitle') }}</h3>
        <ol class="mt-2.5 space-y-2">
          <li v-for="(s, i) in FLOW" :key="i" class="flex gap-2.5">
            <span class="mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full bg-surface-2 text-[10.5px] font-medium text-muted-foreground">{{ i + 1 }}</span>
            <p class="text-[12.5px] leading-[1.6] text-text-2">
              <b class="font-medium text-foreground">{{ s.t }}</b> — {{ s.d }}
            </p>
          </li>
        </ol>
      </div>

      <!-- эндпоинты -->
      <div>
        <h3 class="text-[12.5px] font-medium">{{ $t('blog.pages.integration.docs.endpointsTitle') }}</h3>
        <div class="mt-2.5 overflow-x-auto rounded-lg border border-border">
          <table class="w-full min-w-[540px] text-left">
            <tbody>
              <tr
                v-for="e in INGEST_ENDPOINTS" :key="e.m + e.path"
                class="border-b border-border/60 last:border-0"
              >
                <td class="w-16 whitespace-nowrap py-2 pl-3 align-top">
                  <span class="rounded-md px-1.5 py-0.5 font-mono text-[10.5px] font-semibold" :class="METHOD_CLASS[e.m]">{{ e.m }}</span>
                </td>
                <td class="whitespace-nowrap py-2 pl-2 align-top font-mono text-[11.5px] text-text-2">{{ e.path }}</td>
                <td class="py-2 pl-3 pr-3 align-top text-[12px] text-muted-foreground">
                  {{ e.desc[lang] }}
                  <span v-if="e.required" class="ml-1 whitespace-nowrap rounded-md bg-brand-accent-soft px-1.5 py-px text-[10px] font-medium text-brand-accent">
                    {{ $t('blog.pages.integration.docs.required') }}
                  </span>
                  <span v-if="e.when[lang]" class="block text-[11px] text-muted-foreground/60">{{ e.when[lang] }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- тело запроса + схема полей -->
      <div class="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 class="text-[12.5px] font-medium">{{ $t('blog.pages.integration.docs.payloadTitle') }}</h3>
          <div class="relative mt-2.5">
            <pre class="max-h-72 overflow-auto rounded-lg border border-border bg-surface-2 p-3 text-[11px] leading-relaxed text-text-2">{{ payload }}</pre>
            <button
              type="button"
              class="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
              @click="copy(payload, 'payload')"
            >
              <component :is="copied === 'payload' ? Check : Copy" :size="11" />
              {{ copied === 'payload' ? $t('action.copied') : $t('action.copy') }}
            </button>
          </div>
          <h3 class="mt-4 text-[12.5px] font-medium">{{ $t('blog.pages.integration.docs.responseTitle') }}</h3>
          <pre class="mt-2.5 overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 text-[11px] text-text-2">{{ sampleResult }}</pre>
        </div>

        <div>
          <h3 class="text-[12.5px] font-medium">{{ $t('blog.pages.integration.docs.fieldsTitle') }}</h3>
          <div class="mt-2.5 overflow-x-auto rounded-lg border border-border">
            <table class="w-full min-w-[420px] text-left">
              <thead>
                <tr class="border-b border-border text-[10.5px] uppercase tracking-wide text-muted-foreground/70">
                  <th class="py-1.5 pl-3 font-medium">{{ $t('blog.pages.integration.docs.col.field') }}</th>
                  <th class="py-1.5 pl-3 font-medium">{{ $t('blog.pages.integration.docs.col.type') }}</th>
                  <th class="py-1.5 pl-3 pr-3 font-medium">{{ $t('blog.pages.integration.docs.col.meaning') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="f in INGEST_FIELDS" :key="f.f" class="border-b border-border/60 last:border-0">
                  <td class="whitespace-nowrap py-1.5 pl-3 align-top font-mono text-[11.5px]"
                      :class="f.req ? 'font-semibold text-foreground' : 'text-text-2'">
                    {{ f.f }}<span v-if="f.req" class="text-brand-accent">*</span>
                  </td>
                  <td class="whitespace-nowrap py-1.5 pl-3 align-top font-mono text-[11px] text-muted-foreground">{{ f.t }}</td>
                  <td class="py-1.5 pl-3 pr-3 align-top text-[11.5px] text-muted-foreground">{{ f.note[lang] }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="mt-2 text-[11px] text-muted-foreground/70">{{ $t('blog.pages.integration.docs.requiredNote') }}</p>
        </div>
      </div>

      <!-- проверка curl-ом -->
      <div>
        <h3 class="text-[12.5px] font-medium">{{ $t('blog.pages.integration.docs.curlTitle') }}</h3>
        <p class="mt-1 text-[11.5px] text-muted-foreground">{{ $t('blog.pages.integration.docs.curlHint') }}</p>
        <div class="relative mt-2.5">
          <pre class="overflow-x-auto rounded-lg border border-border bg-surface-2 p-3 text-[11px] leading-relaxed text-text-2">{{ curl }}</pre>
          <button
            type="button"
            class="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
            @click="copy(curl, 'curl')"
          >
            <component :is="copied === 'curl' ? Check : Copy" :size="11" />
            {{ copied === 'curl' ? $t('action.copied') : $t('action.copy') }}
          </button>
        </div>
      </div>

      <!-- коды ответов -->
      <div>
        <h3 class="text-[12.5px] font-medium">{{ $t('blog.pages.integration.docs.codesTitle') }}</h3>
        <div class="mt-2.5 grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
          <div v-for="c in INGEST_ERRORS" :key="c.code" class="flex gap-2.5">
            <span class="w-16 shrink-0 font-mono text-[11.5px] text-text-2">{{ c.code }}</span>
            <span class="text-[11.5px] leading-[1.5] text-muted-foreground">{{ c.meaning[lang] }}</span>
          </div>
        </div>
        <p class="mt-3 text-[11.5px] leading-[1.6] text-muted-foreground/70">{{ $t('blog.pages.integration.docs.timeoutNote') }}</p>
      </div>
    </div>
  </details>
</template>
