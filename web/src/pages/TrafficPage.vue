<script setup lang="ts">
// «AI-трафик»: KPI, интерактивный area-чарт (стиль shadcn Area Chart –
// Interactive), ассистенты, страницы входа, AI-краулеры. Управление
// коннекторами переехало в «Настройки» — здесь компактная полоска статусов.
// Трафик-данные мок до подключения отчётов Метрики.
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Check, Copy, Terminal } from 'lucide-vue-next'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import InteractiveAreaChart, { type AreaSeries } from '@/components/charts/InteractiveAreaChart.vue'
import VisitsMap, { type GeoRow } from '@/components/charts/VisitsMap.vue'
import EmptyState from '@/components/EmptyState.vue'
import { api } from '@/lib/api'
import { intlLocale } from '@/i18n'
import { useBrands } from '@/composables/useBrands'
import { useConnectors } from '@/composables/useConnectors'

const { t } = useI18n()
const { connectors, statusSource, load } = useConnectors()
const { active, activeDomain } = useBrands()

// ── реальные данные: отчёт Метрики + краулеры scrapper ────────────────────
const report = ref<any | null>(null)      // MetrikaReport | null → мок
const botsReal = ref<any | null>(null)    // /scrape/aeo/bots (лог-форвардер)
const cfReport = ref<any | null>(null)    // /cloudflare/report (AI-краулеры)
const trafficLive = computed(() => !!report.value?.ok && !!report.value?.kpi)
const botsLive = computed(() => !!botsReal.value?.hasData)
const cfLive = computed(() => !!cfReport.value?.ok && (cfReport.value?.bots?.length ?? 0) > 0)

// скоуп отчёта: только AI-источники или весь трафик счётчика
const scope = ref<'ai' | 'all'>('ai')

// счётчики Метрики аккаунта (в одном аккаунте может быть много доменов)
const counters = ref<{ id: string; name: string; site: string }[]>([])
const currentCounter = ref('')
const counterBusy = ref(false)

async function loadReport() {
  const id = active.value?.id
  const mk = connectors.find((c) => c.key === 'metrika')
  if (!id || !mk?.connected) { report.value = null; return }
  try {
    const period = range.value === '7' ? '7d' : range.value === '90' ? '90d' : '30d'
    const r = await api.metrikaReport(id, period, scope.value)
    report.value = r?.ok ? r : null
    if (r?.counterId) currentCounter.value = String(r.counterId)
  } catch { report.value = null }
}

async function loadCounters() {
  const id = active.value?.id
  const mk = connectors.find((c) => c.key === 'metrika')
  if (!id || !mk?.connected) return
  try {
    const r = await api.metrikaCounters(id)
    counters.value = r?.counters || []
    if (r?.current) currentCounter.value = String(r.current)
  } catch { counters.value = [] }
}

async function pickCounter(counterId: unknown) {
  const id = active.value?.id
  const cid = String(counterId ?? '')
  if (!id || !cid || cid === currentCounter.value || counterBusy.value) return
  counterBusy.value = true
  try {
    await api.metrikaSetCounter(id, cid)
    currentCounter.value = cid
    // выбранный домен → обновляем отчёт и подпись коннектора
    await loadReport()
    const mk = connectors.find((c) => c.key === 'metrika')
    const picked = counters.value.find((c) => c.id === cid)
    if (mk && picked) mk.detail = picked.site || picked.name
  } catch { /* счётчик не сменился — отчёт остаётся прежним */ }
  finally { counterBusy.value = false }
}

onMounted(async () => {
  await load()
  await Promise.allSettled([
    loadReport(),
    loadCounters(),
    (async () => {
      if (!activeDomain.value) return
      try { botsReal.value = await api.aeoBots(activeDomain.value) } catch { botsReal.value = null }
    })(),
    (async () => {
      const id = active.value?.id
      const cf = connectors.find((c) => c.key === 'cloudflare')
      if (!id || !cf?.connected) return
      try { cfReport.value = await api.cloudflareReport(id) } catch { cfReport.value = null }
    })(),
  ])
})

const RANGES = computed(() => [
  { value: '7', label: t('traffic.range.d7') },
  { value: '30', label: t('traffic.range.d30') },
  { value: '90', label: t('traffic.range.m3') },
])
const range = ref('30')
watch([range, scope], loadReport)

// нет отчёта или нет точек серии → «Нет данных» вместо графика
const emptyLive = computed(() => !chartData.value.length)

// ── источники под графиком: бейджи с суммами, как в Метрике ───────────────
// report.sourceSeries[] = {name, total, visits[]} — клик по бейджу
// включает/выключает серию источника на графике.
const PALETTE = ['#4267ff', '#7c93ff', '#22d3ee', '#34d399', '#f59e0b', '#f472b6', '#a78bfa', '#94a3b8']

const sourceBadges = computed(() => {
  const list: any[] = report.value?.sourceSeries || []
  return [...list]
    .filter((s) => (s?.visits?.length ?? 0) > 0)
    .sort((a, b) => (b.total ?? 0) - (a.total ?? 0))
    .slice(0, 8)
    .map((s, i) => ({
      name: String(s.name),
      total: s.total ?? (s.visits as number[]).reduce((sum: number, v: number) => sum + v, 0),
      visits: s.visits as number[],
      color: PALETTE[i % PALETTE.length]!,
    }))
})

const enabledSources = ref<Set<string>>(new Set())
// новый отчёт → включаем топ-3 источника по умолчанию
watch(sourceBadges, (list) => {
  enabledSources.value = new Set(list.slice(0, 3).map((s) => s.name))
}, { immediate: true })

function toggleSource(name: string) {
  const s = new Set(enabledSources.value)
  if (s.has(name)) { if (s.size > 1) s.delete(name) } // хотя бы одна серия остаётся
  else s.add(name)
  enabledSources.value = s
}

const activeSources = computed(() => sourceBadges.value.filter((s) => enabledSources.value.has(s.name)))

// график: серии выбранных источников; без sourceSeries — общая серия визитов
const chartData = computed(() => {
  const r = report.value
  if (!trafficLive.value || !r?.series?.labels?.length) return []
  const labels: string[] = r.series.labels
  if (activeSources.value.length) {
    return labels.map((date: string, i: number) => {
      const row: Record<string, any> = { date }
      for (const s of activeSources.value) row[s.name] = s.visits[i] ?? 0
      return row
    })
  }
  const total: number[] = r.series.visits || []
  return labels.map((date: string, i: number) => ({ date, visits: total[i] ?? 0 }))
})

const series = computed<AreaSeries[]>(() => {
  if (activeSources.value.length) {
    return activeSources.value.map((s) => ({ key: s.name, label: s.name, color: s.color }))
  }
  return [{ key: 'visits', label: scope.value === 'all' ? t('traffic.kpi.visits') : t('traffic.kpi.aiVisits'), color: '#4267ff' }]
})

// страницы входа: куда именно заходят люди (report.pages, ym:s:startURL).
// Варианты с utm-/query-хвостами суммируем по чистому пути.
const landingPages = computed(() => {
  const list: any[] = report.value?.pages || []
  const byPath = new Map<string, { url: string; path: string; visits: number; pct: number }>()
  for (const p of list) {
    const url = String(p.url || '')
    const raw = (url.replace(/^https?:\/\/[^/]+/, '').split('?')[0]!.split('#')[0]!) || '/'
    const path = raw !== '/' ? raw.replace(/\/+$/, '') : '/'
    const e = byPath.get(path)
    if (e) {
      e.visits += p.visits ?? 0
      e.pct += p.pct ?? 0
    } else {
      byPath.set(path, { url: url.split('?')[0]!, path, visits: p.visits ?? 0, pct: p.pct ?? 0 })
    }
  }
  return [...byPath.values()].sort((a, b) => b.visits - a.visits)
})
const maxLanding = computed(() => Math.max(1, ...landingPages.value.map((p) => p.visits)))

// устройства (report.devices)
const deviceRows = computed(() => (report.value?.devices || []).map((d: any) => ({
  label: d.label ?? '—', visits: d.visits ?? 0, pct: d.pct ?? 0,
})))

const round1 = (v: number) => Math.round(v * 10) / 10
// десятичный разделитель идёт за языком интерфейса: 12,5 % против 12.5%
const dec1 = (v: number) => round1(v).toLocaleString(intlLocale(), { maximumFractionDigits: 1 })
const fmtPct = (v: number | null | undefined, suffix = '%') =>
  v == null ? null : `${v > 0 ? '+' : ''}${dec1(v)}${suffix}`

const kpis = computed(() => {
  const k = report.value?.kpi
  if (trafficLive.value && k) {
    const mainVisits = scope.value === 'all' ? (k.visits ?? 0) : (k.aiVisits ?? k.visits ?? 0)
    return [
      { l: scope.value === 'all' ? t('traffic.kpi.visits') : t('traffic.kpi.aiVisits'), v: mainVisits.toLocaleString(intlLocale()), d: fmtPct(k.deltaVisits), pos: (k.deltaVisits ?? 0) >= 0 },
      { l: t('traffic.kpi.users'), v: (k.users ?? 0).toLocaleString(intlLocale()), d: fmtPct(k.deltaUsers), pos: (k.deltaUsers ?? 0) >= 0 },
      { l: t('traffic.kpi.share'), v: `${dec1(k.aiShare ?? 0)}%`, d: null, pos: true },
      { l: t('traffic.kpi.bounce'), v: `${dec1(k.bounceRate ?? 0)}%`, d: fmtPct(k.deltaBounce, t('traffic.kpi.ppSuffix')), pos: (k.deltaBounce ?? 0) <= 0 },
    ]
  }
  return [
    { l: t('traffic.kpi.aiVisits'), v: '—', d: null, pos: true },
    { l: t('traffic.kpi.users'), v: '—', d: null, pos: true },
    { l: t('traffic.kpi.share'), v: '—', d: null, pos: true },
    { l: t('traffic.kpi.bounce'), v: '—', d: null, pos: true },
  ]
})

// ── ассистенты: live из report.sources, иначе мок ─────────────────────────
const ASSISTANT_ICON: Array<[RegExp, string]> = [
  [/chatgpt|openai/i, 'openai'], [/perplexity/i, 'perplexity'], [/алис|alice/i, 'alice'],
  [/gemini|bard/i, 'googlegemini'], [/copilot|bing/i, 'copilot'], [/grok|x\.ai/i, 'x'],
  [/claude|anthropic/i, 'claude'], [/deepseek/i, 'deepseek'], [/gigachat/i, 'gigachat'],
  [/яндекс|yandex|нейро/i, 'yandex'], [/google/i, 'google'],
]
const assistantIcon = (name: string): string | null => ASSISTANT_ICON.find(([re]) => re.test(name))?.[1] ?? null

interface TrafficRow { icon: string | null; l: string; v: number; d: number | null; share?: number | null }

const assistants = computed<TrafficRow[]>(() => {
  // live: показываем реальные источники, даже если их ноль (мок = только демо-режим)
  if (trafficLive.value) {
    return (report.value?.sources || []).map((s: any) => ({
      icon: assistantIcon(String(s.assistant)), l: s.assistant,
      v: s.visits ?? 0, d: null, share: s.pct != null ? round1(s.pct) : null,
    }))
  }
  return []
})
const maxAssistant = computed(() => Math.max(1, ...assistants.value.map((a) => a.v)))
const totalVisits = computed(() => assistants.value.reduce((s, a) => s + a.v, 0))


// ── география визитов: live из report.geo (RU-имена → ISO2 для карты) ─────
const COUNTRY_ISO: Record<string, string> = {
  'россия': 'RU', 'бразилия': 'BR', 'португалия': 'PT', 'турция': 'TR', 'сша': 'US',
  'германия': 'DE', 'франция': 'FR', 'швейцария': 'CH', 'украина': 'UA', 'казахстан': 'KZ',
  'беларусь': 'BY', 'белоруссия': 'BY', 'великобритания': 'GB', 'нидерланды': 'NL', 'польша': 'PL',
  'испания': 'ES', 'италия': 'IT', 'индия': 'IN', 'китай': 'CN', 'япония': 'JP', 'канада': 'CA',
  'австралия': 'AU', 'мексика': 'MX', 'аргентина': 'AR', 'индонезия': 'ID', 'финляндия': 'FI',
  'швеция': 'SE', 'норвегия': 'NO', 'чехия': 'CZ', 'чешская республика': 'CZ', 'австрия': 'AT',
  'бельгия': 'BE', 'латвия': 'LV', 'литва': 'LT', 'эстония': 'EE', 'грузия': 'GE', 'армения': 'AM',
  'узбекистан': 'UZ', 'азербайджан': 'AZ', 'киргизия': 'KG', 'кыргызстан': 'KG', 'молдова': 'MD',
  'сербия': 'RS', 'румыния': 'RO', 'болгария': 'BG', 'греция': 'GR', 'израиль': 'IL', 'оаэ': 'AE',
  'вьетнам': 'VN', 'таиланд': 'TH', 'южная корея': 'KR', 'корея': 'KR', 'ирландия': 'IE',
  'дания': 'DK', 'венгрия': 'HU', 'словакия': 'SK', 'хорватия': 'HR', 'нигерия': 'NG',
  'египет': 'EG', 'юар': 'ZA', 'чили': 'CL', 'колумбия': 'CO', 'перу': 'PE', 'филиппины': 'PH',
  'малайзия': 'MY', 'сингапур': 'SG', 'пакистан': 'PK', 'бангладеш': 'BD', 'иран': 'IR',
}
const countryIso = (name: string) => COUNTRY_ISO[name.trim().toLowerCase()] ?? ''

const geoLive = computed(() => trafficLive.value && (report.value?.geo?.length ?? 0) > 0)
const geoRows = computed<GeoRow[]>(() => {
  if (geoLive.value) {
    return report.value.geo.map((g: any) => ({
      code: countryIso(String(g.country)),
      country: g.country,
      visits: g.visits ?? 0,
      pct: g.pct ?? 0,
    }))
  }
  return []
})

// ── лог-форвардер: ingest-токен + bash-сниппет (порт web/BotsPanel) ───────
const botToken = ref<{ token: string; ingestUrl: string } | null>(null)
const setupOpen = ref(false)
const copied = ref('')

async function toggleSetup() {
  setupOpen.value = !setupOpen.value
  if (setupOpen.value && !botToken.value) {
    try { botToken.value = await api.aeoBotToken() } catch { /* сниппет с плейсхолдером */ }
  }
}

const collectorSnippet = computed(() => {
  const tok = botToken.value?.token || 'bt_...'
  const dom = activeDomain.value || 'example.com'
  const url = botToken.value?.ingestUrl || 'https://ideata.io/scrape/aeo/bot-hit'
  return [
    '#!/usr/bin/env bash',
    t('traffic.setup.snippetHeader'),
    'set -euo pipefail',
    'LOG="/var/log/nginx/access.log"     ' + t('traffic.setup.snippetLogPath'),
    'DOMAIN="' + dom + '"',
    'TOKEN="' + tok + '"',
    'API="' + url + '"',
    'STATE="/var/tmp/ideata-bot-offset"',
    'prev=$(cat "$STATE" 2>/dev/null || echo 0)',
    'size=$(stat -c%s "$LOG" 2>/dev/null || stat -f%z "$LOG")',
    '[ "$size" -lt "$prev" ] && prev=0',
    'new=$(tail -c +$((prev+1)) "$LOG" || true); echo "$size" > "$STATE"',
    '[ -z "$new" ] && exit 0',
    'json=""',
    'for b in GPTBot ChatGPT-User OAI-SearchBot ClaudeBot Claude-User PerplexityBot Google-Extended Bingbot Applebot-Extended Amazonbot meta-externalagent Bytespider; do',
    '  c=$(printf "%s\\n" "$new" | grep -ic "$b" || true)',
    '  [ "$c" -gt 0 ] && json="$json\\"$b\\":$c,"',
    'done',
    'refjson=""',
    t('traffic.setup.snippetReferer'),
    'for r in chatgpt.com chat.openai.com perplexity.ai claude.ai gemini.google.com copilot.microsoft.com you.com poe.com deepseek.com grok.com; do',
    '  c=$(printf "%s\\n" "$new" | grep -ic "$r" || true)',
    '  [ "$c" -gt 0 ] && refjson="$refjson\\"$r\\":$c,"',
    'done',
    '[ -z "$json" ] && [ -z "$refjson" ] && exit 0',
    'body="{\\"domain\\":\\"$DOMAIN\\""',
    '[ -n "$json" ] && body="$body,\\"counts\\":{${json%,}}"',
    '[ -n "$refjson" ] && body="$body,\\"referrers\\":{${refjson%,}}"',
    'body="$body}"',
    'curl -sf -X POST "$API" -H "X-Ingest-Token: $TOKEN" -H "content-type: application/json" -d "$body" >/dev/null',
  ].join('\n')
})
const cronLine = '*/5 * * * * /opt/ideata-bot-collector.sh'

async function copyText(text: string, tag: string) {
  try {
    await navigator.clipboard.writeText(text)
    copied.value = tag
    setTimeout(() => { if (copied.value === tag) copied.value = '' }, 1500)
  } catch { /* ignore */ }
}

// краулеры: live из /scrape/aeo/bots (vendor → иконка, как BotsPanel в web)
const VENDOR_ICON: Record<string, string> = {
  OpenAI: 'openai', Anthropic: 'claude', Perplexity: 'perplexity',
  Google: 'google', Microsoft: 'copilot', Meta: 'meta', Yandex: 'yandex',
}
const crawlersSource = computed<'cloudflare' | 'forwarder' | null>(() =>
  cfLive.value ? 'cloudflare' : botsLive.value ? 'forwarder' : null)

const crawlers = computed<TrafficRow[]>(() => {
  // приоритет: Cloudflare-коннектор → лог-форвардер (scrapper bot_hits)
  if (cfLive.value) {
    return (cfReport.value.bots as any[]).map((x) => ({
      icon: VENDOR_ICON[String(x.vendor)] ?? assistantIcon(String(x.bot ?? '')),
      l: String(x.bot ?? x.vendor ?? '—'),
      v: x.hits ?? 0, d: null,
      share: x.pct != null ? round1(x.pct) : null,
    }))
  }
  const b = botsReal.value
  if (botsLive.value && b?.bots?.length) {
    const total = b.total || b.bots.reduce((s: number, x: any) => s + (x.visits ?? x.hits ?? 0), 0) || 1
    return b.bots.map((x: any) => {
      const v = x.visits ?? x.hits ?? 0
      return {
        icon: VENDOR_ICON[String(x.vendor)] ?? assistantIcon(String(x.bot ?? x.name ?? x.vendor ?? '')),
        l: String(x.bot ?? x.name ?? x.vendor ?? '—'),
        v, d: null, share: Math.round((v / total) * 100),
      }
    })
  }
  return []
})
const maxCrawler = computed(() => Math.max(1, ...crawlers.value.map((c) => c.v)))

const fmt = (n: number) => n.toLocaleString(intlLocale())
</script>

<template>
  <div class="space-y-4 p-5 lg:p-6">
    <!-- шапка -->
    <div class="flex flex-wrap items-center gap-3">
      <div class="mr-auto">
        <div class="flex items-center gap-2">
          <h1 class="text-lg font-semibold tracking-tight">{{ $t('nav.traffic') }}</h1>
        </div>
        <p class="mt-0.5 text-[12.5px] text-muted-foreground">
          {{ $t('traffic.subtitle') }}<template
            v-if="statusSource !== 'loading' && statusSource !== 'live'"> · {{ $t('traffic.noIntegrations') }}</template>
        </p>
      </div>

      <!-- компактные статусы коннекторов → управление в настройках -->
      <div class="flex items-center gap-1.5">
        <span
          v-for="c in connectors" :key="c.key" :title="`${c.title}: ${c.detail}`"
          class="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-1"
        >
          <img :src="c.icon" :alt="c.title" class="size-3.5 rounded-full" />
          <span class="size-1.5 rounded-full" :class="c.connected ? 'bg-emerald-400' : c.connected === false ? 'bg-muted-foreground/35' : 'bg-amber-400'"></span>
        </span>
        <RouterLink to="/settings" class="ml-1 inline-flex items-center gap-1 text-[12px] font-medium text-muted-foreground transition hover:text-foreground">
          {{ $t('traffic.integrations') }} <ArrowRight :size="12" />
        </RouterLink>
      </div>
    </div>

    <!-- KPI -->
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <div v-for="k in kpis" :key="k.l" class="rounded-xl border border-border bg-surface px-4 py-3">
        <div class="text-[11.5px] text-muted-foreground">{{ k.l }}</div>
        <div class="mt-0.5 flex items-baseline gap-2">
          <span class="text-xl font-semibold tabular-nums">{{ k.v }}</span>
          <span v-if="k.d" class="text-[11.5px] font-medium" :class="k.pos ? 'text-emerald-400' : 'text-rose-400'">{{ k.d }}</span>
        </div>
      </div>
    </div>

    <!-- интерактивный график -->
    <section class="overflow-hidden rounded-xl border border-border bg-surface">
      <div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3.5 sm:px-5">
        <div class="mr-auto">
          <h2 class="text-[14px] font-semibold">{{ $t('traffic.chart.title') }}</h2>
          <p class="mt-0.5 text-[12px] text-muted-foreground">{{ trafficLive ? (scope === "all" ? $t('traffic.chart.subAll') : $t('traffic.chart.subAi')) : $t('traffic.chart.subOff') }}</p>
        </div>
        <!-- скоуп: AI-источники или весь трафик счётчика -->
        <div class="flex rounded-lg border border-border bg-surface p-0.5">
          <button
            v-for="sc in [{ v: 'ai', l: $t('traffic.scope.ai') }, { v: 'all', l: $t('traffic.scope.all') }]" :key="sc.v"
            class="rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors"
            :class="scope === sc.v ? 'bg-surface-hover text-foreground' : 'text-muted-foreground hover:text-foreground'"
            @click="scope = sc.v as 'ai' | 'all'"
          >{{ sc.l }}</button>
        </div>

        <!-- домен (счётчик Метрики): в аккаунте их может быть много -->
        <Select v-if="counters.length > 1" :model-value="currentCounter" :disabled="counterBusy" @update:model-value="pickCounter">
          <SelectTrigger class="h-8 w-[180px] border-border bg-surface text-[12.5px]">
            <SelectValue :placeholder="$t('traffic.domainPlaceholder')" />
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem v-for="c in counters" :key="c.id" :value="c.id">
              {{ c.site || c.name }}
            </SelectItem>
          </SelectContent>
        </Select>

        <Select v-model="range">
          <SelectTrigger class="h-8 w-[130px] border-border bg-surface text-[12.5px]">
            <SelectValue>{{ RANGES.find((r) => r.value === range)?.label }}</SelectValue>
          </SelectTrigger>
          <SelectContent align="end">
            <SelectItem v-for="r in RANGES" :key="r.value" :value="r.value">{{ r.label }}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div class="px-2 pb-3 pt-4 sm:px-4">
        <div v-if="emptyLive" class="flex h-[260px] items-center justify-center">
          <EmptyState
            :title="$t('state.noData')"
            :hint="!trafficLive
              ? $t('traffic.chart.emptyOff')
              : scope === 'all'
                ? $t('traffic.chart.emptyAll', { total: fmt(report?.kpi?.totalVisits ?? 0) })
                : $t('traffic.chart.emptyAi', { total: fmt(report?.kpi?.totalVisits ?? 0) })"
          />
        </div>
        <InteractiveAreaChart v-else :data="chartData" :series="series" :height="260" :hide-legend="sourceBadges.length > 0" />

        <!-- бейджи источников с суммами (как в Метрике): клик = вкл/выкл серии -->
        <div v-if="sourceBadges.length" class="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-3">
          <button
            v-for="b in sourceBadges" :key="b.name" type="button"
            class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-medium transition"
            :class="enabledSources.has(b.name)
              ? 'border-border bg-surface-2 text-foreground'
              : 'border-border/60 text-muted-foreground/60 hover:text-muted-foreground'"
            :title="enabledSources.has(b.name) ? $t('traffic.chart.hide') : $t('traffic.chart.show')"
            @click="toggleSource(b.name)"
          >
            <span class="size-2 rounded-[3px]" :style="{ background: enabledSources.has(b.name) ? b.color : 'rgba(255,255,255,0.15)' }"></span>
            <span class="max-w-[180px] truncate">{{ b.name }}</span>
            <span class="tabular-nums" :class="enabledSources.has(b.name) ? 'text-muted-foreground' : 'text-muted-foreground/50'">{{ fmt(b.total) }}</span>
          </button>
        </div>
      </div>
    </section>

    <!-- ассистенты + страницы входа -->
    <div class="grid gap-4 lg:grid-cols-5">
      <section class="rounded-xl border border-border bg-surface lg:col-span-3">
        <div class="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 class="text-[13px] font-medium">{{ trafficLive && scope === "all" ? $t('traffic.assistants.titleSources') : $t('traffic.assistants.titleAssistants') }}</h2>
          <span class="text-[11.5px] text-muted-foreground">{{ $t('traffic.assistants.visitsCount', { n: fmt(totalVisits) }, totalVisits) }}</span>
        </div>
        <div class="space-y-1 p-2">
          <EmptyState
            v-if="!assistants.length" compact :title="$t('state.noData')"
            :hint="trafficLive ? $t('traffic.assistants.empty') : $t('traffic.connectMetrika')"
          />
          <div v-for="a in assistants" :key="a.l" class="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2">
            <img v-if="a.icon" :src="`/icons/ai/${a.icon}.svg`" :alt="a.l" class="size-5 shrink-0 rounded-full bg-surface-2 p-0.5" />
            <span v-else class="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-hover text-[10px] font-semibold uppercase text-muted-foreground">{{ a.l[0] }}</span>
            <span class="w-40 shrink-0 truncate text-[12.5px] text-text-2" :title="a.l">{{ a.l }}</span>
            <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover">
              <span class="block h-full rounded-full bg-gradient-to-r from-brand to-brand-soft" :style="{ width: (a.v / maxAssistant) * 100 + '%' }"></span>
            </span>
            <span class="w-14 shrink-0 text-right text-[12.5px] font-medium tabular-nums text-text-2">{{ fmt(a.v) }}</span>
            <span v-if="a.share != null" class="w-12 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{{ a.share }}%</span>
            <span v-else-if="a.d != null" class="w-10 shrink-0 text-right text-[11px] font-medium tabular-nums" :class="a.d >= 0 ? 'text-emerald-400' : 'text-rose-400'">{{ a.d >= 0 ? '+' : '' }}{{ a.d }}%</span>
          </div>
        </div>
      </section>

      <section class="overflow-hidden rounded-xl border border-border bg-surface lg:col-span-2">
        <div class="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 class="text-[13px] font-medium">{{ $t('traffic.landing.title') }}</h2>
          <span v-if="landingPages.length" class="text-[11.5px] text-muted-foreground">{{ $t('traffic.landing.note') }}</span>
        </div>
        <div class="space-y-1 p-2">
          <EmptyState
            v-if="!landingPages.length" compact :title="$t('state.noData')"
            :hint="trafficLive ? $t('traffic.landing.empty') : $t('traffic.connectMetrika')"
          />
          <a
            v-for="pg in landingPages" :key="pg.url" :href="pg.url" target="_blank" rel="noopener"
            class="group flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2"
            :title="pg.url"
          >
            <span class="min-w-0 flex-1 truncate text-[12.5px] text-text-2 transition group-hover:text-brand-soft">{{ pg.path }}</span>
            <span class="h-1 w-16 shrink-0 overflow-hidden rounded-full bg-surface-hover">
              <span class="block h-full rounded-full bg-gradient-to-r from-brand to-brand-soft" :style="{ width: (pg.visits / maxLanding) * 100 + '%' }"></span>
            </span>
            <span class="w-12 shrink-0 text-right text-[12.5px] font-medium tabular-nums text-text-2">{{ fmt(pg.visits) }}</span>
            <span class="w-11 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{{ Math.round(pg.pct * 10) / 10 }}%</span>
          </a>
        </div>
      </section>
    </div>

    <!-- география + (место под доп. панели) -->
    <div class="grid gap-4 lg:grid-cols-5">
      <section class="rounded-xl border border-border bg-surface lg:col-span-2">
        <div class="flex items-center gap-2 border-b border-border px-4 py-3">
          <h2 class="text-[13px] font-medium">{{ $t('traffic.geo.title') }}</h2>
          <span v-if="geoLive" class="ml-auto text-[11.5px] text-muted-foreground">{{ $t('traffic.byMetrika') }}</span>
        </div>
        <div class="p-3">
          <EmptyState v-if="!geoRows.length" :title="$t('state.noData')" :hint="$t('traffic.geo.empty')" />
          <VisitsMap v-else :rows="geoRows" :height="190" :top="5" />
        </div>
      </section>

      <section class="rounded-xl border border-border bg-surface lg:col-span-3">
        <div class="flex items-center justify-between border-b border-border px-4 py-3">
          <h2 class="text-[13px] font-medium">{{ $t('traffic.devices.title') }}</h2>
          <span v-if="deviceRows.length" class="text-[11.5px] text-muted-foreground">{{ $t('traffic.byMetrika') }}</span>
        </div>
        <div class="space-y-1 p-2">
          <EmptyState v-if="!deviceRows.length" compact :title="$t('state.noData')" :hint="$t('traffic.devices.empty')" />
          <div v-for="d in deviceRows" :key="d.label" class="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2">
            <span class="w-28 shrink-0 truncate text-[12.5px] text-text-2">{{ d.label }}</span>
            <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover">
              <span class="block h-full rounded-full bg-gradient-to-r from-brand to-brand-soft" :style="{ width: d.pct + '%' }"></span>
            </span>
            <span class="w-14 shrink-0 text-right text-[12.5px] font-medium tabular-nums text-text-2">{{ fmt(d.visits) }}</span>
            <span class="w-11 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{{ Math.round(d.pct * 10) / 10 }}%</span>
          </div>
        </div>
      </section>
    </div>

    <!-- AI-краулеры -->
    <section class="rounded-xl border border-border bg-surface">
      <div class="flex items-center justify-between border-b border-border px-4 py-3">
        <div class="flex items-center gap-2">
          <h2 class="text-[13px] font-medium">{{ $t('traffic.crawlers.title') }}</h2>

        </div>
        <span class="text-[11.5px] text-muted-foreground">{{ crawlersSource === "cloudflare" ? $t('traffic.crawlers.byCloudflare', { zone: cfReport?.zoneName ?? "" }) : crawlersSource === "forwarder" ? $t('traffic.crawlers.byForwarder') : "" }}</span>
      </div>
      <!-- настройка сбора: ingest-токен + bash-сниппет из access-логов -->
      <div v-if="!crawlersSource" class="border-b border-border/60 px-4 py-3">
        <button
          type="button"
          class="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-brand-soft transition hover:text-foreground"
          @click="toggleSetup"
        >
          <Terminal :size="13" /> {{ setupOpen ? $t('traffic.setup.close') : $t('traffic.setup.open') }}
        </button>
        <div v-if="setupOpen" class="mt-3 space-y-3">
          <p class="text-[12px] leading-relaxed text-muted-foreground">
            {{ $t('traffic.setup.note') }}
            <code class="rounded bg-surface-hover px-1">/opt/ideata-bot-collector.sh</code>{{ $t('traffic.setup.noteTail') }}
          </p>
          <div class="relative">
            <pre class="max-h-56 overflow-auto rounded-lg border border-border bg-black/40 p-3 text-[11px] leading-relaxed text-text-2">{{ collectorSnippet }}</pre>
            <button
              type="button"
              class="absolute right-2 top-2 inline-flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
              @click="copyText(collectorSnippet, 'sh')"
            >
              <component :is="copied === 'sh' ? Check : Copy" :size="11" /> {{ copied === 'sh' ? $t('action.copied') : $t('action.copy') }}
            </button>
          </div>
          <div class="flex items-center gap-2">
            <code class="flex-1 truncate rounded-lg border border-border bg-black/40 px-3 py-2 text-[11px] text-text-2">{{ cronLine }}</code>
            <button
              type="button"
              class="inline-flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1.5 text-[11px] font-medium text-muted-foreground transition hover:text-foreground"
              @click="copyText(cronLine, 'cron')"
            >
              <component :is="copied === 'cron' ? Check : Copy" :size="11" /> cron
            </button>
          </div>
        </div>
      </div>
      <EmptyState
        v-if="!crawlers.length" compact :title="$t('state.noData')"
        :hint="$t('traffic.crawlers.empty')"
      />
      <div v-else class="grid gap-x-6 p-2 sm:grid-cols-2">
        <div v-for="c in crawlers" :key="c.l" class="flex items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-surface-2">
          <img :src="`/icons/ai/${c.icon}.svg`" :alt="c.l" class="size-5 shrink-0 rounded-full bg-surface-2 p-0.5" />
          <span class="w-36 shrink-0 truncate text-[12.5px] text-text-2">{{ c.l }}</span>
          <span class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-hover">
            <span class="block h-full rounded-full bg-gradient-to-r from-brand to-brand-soft" :style="{ width: (c.v / maxCrawler) * 100 + '%' }"></span>
          </span>
          <span class="w-14 shrink-0 text-right text-[12.5px] font-medium tabular-nums text-text-2">{{ fmt(c.v) }}</span>
          <span v-if="c.share != null" class="w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{{ c.share }}%</span>
          <span v-else-if="c.d != null" class="w-10 shrink-0 text-right text-[11px] font-medium tabular-nums" :class="c.d >= 0 ? 'text-emerald-400' : 'text-rose-400'">{{ c.d >= 0 ? '+' : '' }}{{ c.d }}%</span>
        </div>
      </div>
    </section>
  </div>
</template>
