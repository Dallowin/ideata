<script setup lang="ts">
/**
 * Граф «промпты ↔ источники» — как в Obsidian.
 *
 * Библиотека — force-graph (vasturiano): тот же d3-force внутри, что у
 * Obsidian, но с готовыми зумом, ховером, кликом и своей отрисовкой узлов.
 * До неё здесь было две попытки: @unovis (SVG — на 1200 связях выглядит мотком
 * проволоки, каждая линия отдельный DOM-узел) и свой рендерер на PixiJS —
 * рисовал быстро, но клик, подписи и наведение пришлось бы писать руками.
 *
 * Источники рисуются ФАВИКОНКАМИ, а не цветными точками: домен опознаётся
 * мгновенно, а цвет пришлось бы держать в голове вместе с легендой. Цвет
 * остался только там, где он что-то значит — свой сайт и конкурент.
 *
 * Данные уже есть в ответах трекера (promptRows[].answers[].citations) —
 * бэкенд не трогаем.
 *
 * Читаемость важнее полноты: на живом трекере 125 промптов и 523 источника
 * при 1962 связях. Целиком это ком, из которого ничего не достать, поэтому по
 * умолчанию показываем источники минимум с двумя цитатами.
 */
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { PromptRow } from '@/data/prompts'
import { SELF_COLOR, brandFavicon } from '@/data/dashboard'

const props = defineProps<{
  rows: PromptRow[]
  domain?: string
  competitors?: string[]
}>()
const emit = defineEmits<{ 'open-prompt': [text: string] }>()

const { t, locale } = useI18n()

type Kind = 'prompt' | 'own' | 'rival' | 'source'
interface Node {
  id: string; label: string; kind: Kind; weight: number; r: number
  x?: number; y?: number
}

const COLORS: Record<Kind, string> = {
  prompt: '#52525b',
  own: SELF_COLOR,
  rival: '#d29922',
  source: '#3f3f46',
}
const LEGEND: { kind: Kind; key: string }[] = [
  { kind: 'own', key: 'prompts.graph.legend.own' },
  { kind: 'rival', key: 'prompts.graph.legend.rival' },
  { kind: 'prompt', key: 'prompts.graph.legend.prompt' },
]

const minCites = ref(2)
const selected = ref<Node | null>(null)
/** Движок: цитаты берём только из его ответов. '' — все. */
const engine = ref('')
/** Поиск подсвечивает совпадения, а не прячет остальное: в графе важно
    видеть найденное В КОНТЕКСТЕ связей, иначе теряется сам смысл графа. */
const q = ref('')
/** Только промпты, по которым бренд не называют — где терять уже нечего. */
const onlyMissing = ref(false)

/** Движки, которые реально отвечали: список берём из данных, а не из реестра. */
const engines = computed(() => {
  const seen = new Map<string, number>()
  for (const r of props.rows) {
    for (const a of (r.answers || [])) {
      if (!a.platform) continue
      seen.set(a.platform, (seen.get(a.platform) || 0) + 1)
    }
  }
  return [...seen.keys()].sort()
})

const norm = (v: string) => String(v || '').toLowerCase().replace(/^www\./, '')
function hostOf(c: any): string {
  const raw = typeof c === 'string' ? c : (c?.host || c?.url || '')
  return norm(String(raw).replace(/^https?:\/\//, '').split('/')[0] || '')
}

const graph = computed(() => {
  const self = norm(props.domain || '')
  const rivals = new Set((props.competitors || []).map(norm))

  const pairs = new Map<string, number>()
  const hostTotal = new Map<string, number>()
  for (const r of props.rows) {
    // «не называют» считаем по видимости строки: 0 — бренда нет ни в одном
    // ответе за окно.
    if (onlyMissing.value && (r.vis ?? 0) > 0) continue
    for (const a of (r.answers || [])) {
      if (engine.value && a.platform !== engine.value) continue
      for (const c of (a.citations || [])) {
        const h = hostOf(c)
        if (!h) continue
        const k = `${r.id} ${h}`
        pairs.set(k, (pairs.get(k) || 0) + 1)
        hostTotal.set(h, (hostTotal.get(h) || 0) + 1)
      }
    }
  }

  const kept = new Set<string>()
  for (const [h, n] of hostTotal) if (n >= minCites.value) kept.add(h)

  const links: { source: string; target: string; value: number }[] = []
  const usedPrompts = new Set<string>()
  for (const [k, value] of pairs) {
    const [pid, hostKey] = k.split(' ') as [string, string]
    if (!kept.has(hostKey)) continue
    links.push({ source: `p:${pid}`, target: `h:${hostKey}`, value })
    usedPrompts.add(pid)
  }

  const maxW = Math.max(1, ...[...kept].map((h) => hostTotal.get(h) || 1))
  const nodes: Node[] = []
  for (const r of props.rows) {
    if (!usedPrompts.has(String(r.id))) continue
    nodes.push({ id: `p:${r.id}`, label: r.text, kind: 'prompt', weight: 1, r: 3 })
  }
  for (const h of kept) {
    const w = hostTotal.get(h) || 1
    const kind: Kind = h === self ? 'own' : rivals.has(h) ? 'rival' : 'source'
    // Радиус по КОРНЮ: при разбросе 1…128 линейная шкала делает из хабов
    // пятна на пол-экрана, а из остального — пыль.
    nodes.push({ id: `h:${h}`, label: h, kind, weight: w, r: 5 + Math.sqrt(w / maxW) * 13 })
  }
  return { nodes, links, dropped: hostTotal.size - kept.size, hosts: kept.size, prompts: usedPrompts.size }
})

/** Узлы, попавшие под поиск: подсвечиваем их, не пряча остальные. */
const matched = computed(() => {
  const needle = q.value.trim().toLowerCase()
  if (!needle) return null
  return new Set(graph.value.nodes.filter((n) => n.label.toLowerCase().includes(needle)).map((n) => n.id))
})

/** Соседи выделенного узла — остальное гасим, иначе выделение не читается. */
const neighbours = computed(() => {
  const sel = selected.value
  if (!sel) return null
  const set = new Set<string>([sel.id])
  for (const l of graph.value.links) {
    if (l.source === sel.id) set.add(l.target)
    else if (l.target === sel.id) set.add(l.source)
  }
  return set
})

// ── отрисовка ───────────────────────────────────────────────────────────────
const host = ref<HTMLDivElement | null>(null)
const fg = shallowRef<any>(null)
/** Кэш фавиконок: без него картинка перезапрашивается каждый кадр. */
const icons = new Map<string, HTMLImageElement | null>()

function iconFor(n: Node): HTMLImageElement | null {
  return n.kind === 'prompt' ? null : (icons.get(n.id.slice(2)) || null)
}

/**
 * Фавиконки грузим ДО старта графа.
 *
 * Ленивая загрузка прямо в отрисовке не работает: канвас перерисовывается,
 * только пока идёт симуляция, и картинка, приехавшая после её остановки,
 * никогда не попадает на экран — узлы навсегда остаются серыми точками.
 *
 * Ждём не дольше двух секунд: домен без иконки (или медленный ответ) не должен
 * задерживать весь граф — такие узлы просто останутся кружками.
 */
async function preloadIcons(domains: string[]): Promise<void> {
  const pending = domains.filter((d) => !icons.has(d))
  if (!pending.length) return
  await Promise.race([
    Promise.allSettled(pending.map((d) => new Promise<void>((res) => {
      const img = new Image()
      img.referrerPolicy = 'no-referrer'
      img.onload = () => { icons.set(d, img); res() }
      img.onerror = () => { icons.set(d, null); res() }
      img.src = brandFavicon(d)
    }))),
    new Promise((res) => setTimeout(res, 2000)),
  ])
}

async function build() {
  const el = host.value
  if (!el || !graph.value.nodes.length) return
  const mod: any = await import('force-graph')
  const ForceGraph = mod.default || mod
  await preloadIcons(graph.value.nodes.filter((n) => n.kind !== 'prompt').map((n) => n.id.slice(2)))
  if (host.value !== el) return

  const g = ForceGraph()(el)
    .backgroundColor('#0b0b0f')
    .graphData({
      nodes: graph.value.nodes.map((n) => ({ ...n })),
      links: graph.value.links.map((l) => ({ ...l })),
    })
    .nodeId('id')
    .nodeRelSize(1)
    .nodeVal((n: any) => n.r)
    // Подпись только под курсором: 600 имён сразу нечитаемы.
    .nodeLabel((n: any) => n.kind === 'prompt' ? n.label : `${n.label} · ${t('prompts.graph.nCites', n.weight)}`)
    .linkColor(() => 'rgba(255,255,255,0.08)')
    .linkWidth((l: any) => Math.min(2.5, 0.4 + l.value * 0.25))
    .cooldownTime(4000)
    .d3VelocityDecay(0.32)
    // Подогнать под панель, когда физика успокоится: иначе граф остаётся
    // плотным комком в центре и половина области пустует.
    .onEngineStop(() => g.zoomToFit(500, 60))
    .onNodeClick((n: any) => {
      if (selected.value?.id === n.id) { selected.value = null; return }
      selected.value = n
      if (n.kind === 'prompt') emit('open-prompt', n.label)
    })
    .onBackgroundClick(() => { selected.value = null })
    .nodeCanvasObject((n: any, ctx: CanvasRenderingContext2D) => {
      const near = neighbours.value
      const hit = matched.value
      const dimmed = (near && !near.has(n.id)) || (hit && !hit.has(n.id))
      ctx.globalAlpha = dimmed ? 0.12 : 1

      const img = iconFor(n)
      if (img) {
        // Фавиконка в круге: домен опознаётся без легенды и без подписи.
        ctx.save()
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
        ctx.closePath()
        ctx.clip()
        ctx.drawImage(img, n.x - n.r, n.y - n.r, n.r * 2, n.r * 2)
        ctx.restore()
        // Обвести стоит только своих и конкурентов — остальным цвет не нужен.
        if (n.kind !== 'source') {
          ctx.beginPath()
          ctx.arc(n.x, n.y, n.r + 1.2, 0, Math.PI * 2)
          ctx.strokeStyle = COLORS[n.kind as Kind]
          ctx.lineWidth = 2
          ctx.stroke()
        }
      } else {
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
        ctx.fillStyle = COLORS[n.kind as Kind]
        ctx.fill()
      }

      if (selected.value?.id === n.id || (matched.value?.has(n.id) && q.value)) {
        ctx.beginPath()
        ctx.arc(n.x, n.y, n.r + 4, 0, Math.PI * 2)
        ctx.strokeStyle = SELF_COLOR
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    })
    // Зона клика чуть больше самой точки: в промпты радиусом 3px иначе не
    // попасть мышью.
    .nodePointerAreaPaint((n: any, color: string, ctx: CanvasRenderingContext2D) => {
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r + 3, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
    })

  // Отталкивание сильнее и длиннее, связи мягче: на дефолтах узлы слипаются
  // в плотный шар и структура не видна.
  // Разводим сильнее, чем кажется нужным: 200 связей на 90 узлов стягивают
  // граф в плотный шар, где видно только внешнее кольцо, а структура внутри
  // не читается вовсе.
  g.d3Force('charge')?.strength(-320).distanceMax(900)
  g.d3Force('link')?.distance((l: any) => 70 + 40 / Math.max(1, l.value)).strength(0.12)
  fg.value = g
  resize()
  ro?.disconnect()
  ro = new ResizeObserver(() => resize())
  ro.observe(el)
}

/**
 * Размер задаём явно и следим за ним наблюдателем: по умолчанию force-graph
 * берёт собственный размер канваса, тот оказывается шире колонки — граф
 * уезжает в угол, а страница получает горизонтальную прокрутку. clientWidth
 * на момент инициализации ещё может быть нулевым (вкладка только смонтирована),
 * поэтому ResizeObserver, а не разовый замер.
 */
let ro: ResizeObserver | null = null
function resize() {
  const el = host.value
  if (!el || !fg.value) return
  const w = el.clientWidth
  const h = el.clientHeight
  if (!w || !h) return
  fg.value.width(w).height(h)
}

function teardown() {
  ro?.disconnect()
  ro = null
  try { fg.value?._destructor?.() } catch { /* уже снесён */ }
  fg.value = null
  if (host.value) host.value.innerHTML = ''
}

// locale в зависимостях: подписи узлов рисуются на канвасе один раз при сборке,
// без пересборки они остались бы на прежнем языке.
watch([host, graph, locale], () => { teardown(); void build() }, { flush: 'post' })
watch([selected, matched], () => fg.value?.refresh?.())
onBeforeUnmount(() => teardown())
</script>

<template>
  <section class="overflow-hidden rounded-xl border border-border bg-surface">
    <div class="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
      <div class="mr-auto">
        <h2 class="text-[13px] font-medium">{{ $t('prompts.graph.title') }}</h2>
        <p class="mt-0.5 text-[11.5px] text-muted-foreground">
          {{ $t('prompts.graph.nPrompts', graph.prompts) }} · {{ $t('prompts.graph.nSources', graph.hosts) }} · {{ $t('prompts.graph.nLinks', graph.links.length) }}<template
            v-if="graph.dropped"> · {{ $t('prompts.graph.hidden', { n: graph.dropped }) }}</template>
        </p>
      </div>

      <input
        v-model="q" type="search" :placeholder="$t('prompts.graph.search')"
        class="h-8 w-52 rounded-lg border border-border bg-surface-2 px-2.5 text-[12px] outline-none placeholder:text-muted-foreground/70"
      />

      <!-- Движки берём из данных: показывать в фильтре тот, что ни разу не
           отвечал, значит предлагать заведомо пустой результат. -->
      <select
        v-model="engine"
        class="h-8 rounded-lg border border-border bg-surface-2 px-2 text-[12px] outline-none"
      >
        <option value="">{{ $t('prompts.graph.allEngines') }}</option>
        <option v-for="e in engines" :key="e" :value="e">{{ e }}</option>
      </select>

      <button
        type="button"
        class="h-8 rounded-lg border border-border px-2.5 text-[11.5px] transition"
        :class="onlyMissing ? 'bg-surface-hover text-foreground' : 'text-muted-foreground hover:text-foreground'"
        @click="onlyMissing = !onlyMissing"
      >{{ $t('prompts.graph.onlyMissing') }}</button>

      <label class="flex items-center gap-2 text-[11.5px] text-muted-foreground">
        {{ $t('prompts.graph.from') }}
        <input v-model.number="minCites" type="range" min="1" max="10" class="h-1 w-28 accent-[#4267ff]" />
        <span class="w-12 tabular-nums text-foreground">{{ $t('prompts.graph.minCites', minCites) }}</span>
      </label>
    </div>

    <div v-if="!graph.nodes.length" class="px-6 py-16 text-center">
      <p class="text-[13px] font-medium">{{ $t('prompts.graph.emptyTitle') }}</p>
      <p class="mx-auto mt-1 max-w-[320px] text-[12px] text-muted-foreground">
        {{ $t('prompts.graph.emptyHint') }}
      </p>
    </div>

    <!--
      Канвас вынут из потока (absolute inset-0), а обёртка держит высоту сама.
      Иначе получается петля: канвасу задаётся ширина контейнера, после чего он
      же не даёт контейнеру сжаться — у flex-элемента min-width: auto, и вся
      страница разъезжается ровно на ширину сайдбара с горизонтальной
      прокруткой внизу.
    -->
    <div v-else class="relative h-[560px] w-full min-w-0 overflow-hidden">
      <div ref="host" class="absolute inset-0" />
      <div
        v-if="selected"
        class="absolute left-3 top-3 max-w-[60%] rounded-lg border border-border bg-background/95 px-3 py-2 backdrop-blur"
      >
        <p class="truncate text-[12.5px] font-medium">{{ selected.label }}</p>
        <p class="mt-0.5 text-[11px] text-muted-foreground">
          {{ selected.kind === 'prompt'
            ? $t('prompts.graph.kindPrompt')
            : `${$t('prompts.graph.kindSource')} · ${$t('prompts.graph.nCites', selected.weight)}` }}
        </p>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border px-4 py-2.5 text-[11.5px] text-muted-foreground">
      <span v-for="l in LEGEND" :key="l.kind" class="inline-flex items-center gap-1.5">
        <span class="size-2 rounded-full" :style="{ background: COLORS[l.kind] }" />{{ $t(l.key) }}
      </span>
      <span class="ml-auto">{{ $t('prompts.graph.hint') }}</span>
    </div>
  </section>
</template>
