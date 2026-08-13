<script lang="ts">
/**
 * Действия ряда. Компонент только сообщает, что выбрали, — вставку делает
 * родитель (ArticleEditor), у которого уже живут пикеры, диалог и загрузка.
 */
export type PlusAction = 'image' | 'video' | 'attach' | 'embed' | 'code' | 'rule'
</script>

<script setup lang="ts">
// Плюс-меню вставки в стиле Medium. Пока курсор стоит в ПУСТОМ абзаце верхнего
// уровня, слева от строки, в поле документа, висит круглая «+»; по клику она
// поворачивается в «✕», а справа выезжает ряд из шести круглых действий.
// Зачем так, а не тулбар над текстом: медиа в теле статьи появляется редко, и
// постоянная панель только шумит; здесь вход возникает ровно там, где автор
// остановился, и исчезает, как только он начал печатать.
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import type { Editor } from '@tiptap/vue-3'
import { Braces, Code, Film, Image as ImageIcon, Minus, Paperclip, Plus } from 'lucide-vue-next'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const props = defineProps<{ editor: Editor }>()
const emit = defineEmits<{ (e: 'action', action: PlusAction): void }>()

const { t } = useI18n()

// порядок ряда фиксирован — по нему считается геометрия; подписи берём из
// словаря на каждый рендер, иначе меню осталось бы на старом языке
const IDS: PlusAction[] = ['image', 'video', 'attach', 'embed', 'code', 'rule']
const ICONS: Record<PlusAction, unknown> = {
  image: ImageIcon, video: Film, attach: Paperclip, embed: Code, code: Braces, rule: Minus,
}
const ITEMS = computed(() => IDS.map((id) => ({ id, label: t(`blog.editor.plus.${id}`), icon: ICONS[id] })))

const SIZE = 40 // диаметр кружка
const GUTTER = 48 // насколько «+» уходит влево от текстовой колонки
const GAP_MAX = 8
const GAP_MIN = 2
const ROW_W = IDS.length * SIZE // ширина ряда без промежутков

const rowId = `ipm-row-${useId()}`
const rootEl = ref<HTMLElement>()
const visible = ref(false)
const open = ref(false)
const top = ref(0)
const left = ref(-GUTTER)
const gap = ref(GAP_MAX)
const rowLeft = ref(SIZE + GAP_MAX)

/** ближайший скроллящийся предок — по нему меряем, влезает ли «+» в поле слева */
let scroller: HTMLElement | null = null
function findScroller(el: HTMLElement | null): HTMLElement | null {
  let n = el?.parentElement || null
  while (n && n !== document.body) {
    const s = getComputedStyle(n)
    if (/(auto|scroll|hidden)/.test(s.overflowX + s.overflowY)) return n
    n = n.parentElement
  }
  return null
}

/**
 * Кнопку показываем только в пустом абзаце верхнего уровня: в списке, цитате
 * или ячейке таблицы вставка блока разорвала бы структуру, да и «+» там висел
 * бы поверх маркера.
 */
function anchorOk(): boolean {
  const ed = props.editor
  if (!ed || ed.isDestroyed || !ed.isEditable) return false
  const sel = ed.state.selection
  if (!sel.empty) return false
  const $from = sel.$from
  if ($from.depth !== 1) return false // не верхний уровень — значит, вложенный блок
  const parent = $from.parent
  return parent.type.name === 'paragraph' && parent.content.size === 0
}

function place() {
  const root = rootEl.value
  const host = root?.parentElement
  if (!root || !host) return
  let coords: { top: number; bottom: number }
  try {
    coords = props.editor.view.coordsAtPos(props.editor.state.selection.from)
  } catch {
    return // позиция уехала посреди транзакции — пересчитаем на следующем событии
  }
  const hostRect = host.getBoundingClientRect()
  top.value = (coords.top + coords.bottom) / 2 - hostRect.top

  // слева от колонки может не быть места (узкое окно, свёрнутый инспектор) —
  // тогда прижимаем «+» к началу строки, иначе её срежет скроллящаяся секция
  const room = scroller ? hostRect.left - scroller.getBoundingClientRect().left : hostRect.left
  left.value = room >= GUTTER ? -GUTTER : 0

  // ряд не должен вылезать за правый край колонки: сначала жмём шаг, потом
  // подтягиваем начало ряда ближе к «+»
  const free = hostRect.width - left.value - SIZE - ROW_W
  gap.value = Math.max(GAP_MIN, Math.min(GAP_MAX, free / IDS.length))
  const span = ROW_W + (IDS.length - 1) * gap.value
  rowLeft.value = Math.max(0, Math.min(SIZE + gap.value, hostRect.width - left.value - span))
}

let raf = 0
function schedule() {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    sync()
  })
}

function sync() {
  const ed = props.editor
  if (!ed || ed.isDestroyed || !ed.isFocused || !anchorOk()) {
    visible.value = false
    open.value = false
    return
  }
  visible.value = true
  place()
}

function toggle() {
  open.value = !open.value
  if (open.value) place()
}

function close(focus = false) {
  if (!open.value) return
  open.value = false
  if (focus) props.editor.commands.focus()
}

function choose(id: PlusAction) {
  open.value = false
  emit('action', id)
}

// клик по кнопкам не должен уводить фокус из текста: иначе редактор теряет
// каретку, меню считает себя «не у дела» и схлопывается прямо под курсором
function holdFocus(e: MouseEvent) {
  e.preventDefault()
}

function onDocPointerDown(e: PointerEvent) {
  if (!open.value) return
  if (rootEl.value?.contains(e.target as Node)) return
  open.value = false
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !open.value) return
  e.stopPropagation()
  close(true)
}

/** редактор потерял фокус по-настоящему (не в пользу наших кнопок) — прячемся */
function onBlur() {
  setTimeout(() => {
    if (rootEl.value?.contains(document.activeElement)) return
    open.value = false
    visible.value = false
  }, 0)
}

let ro: ResizeObserver | null = null

onMounted(() => {
  const ed = props.editor
  ed.on('selectionUpdate', schedule)
  ed.on('transaction', schedule)
  ed.on('focus', schedule)
  ed.on('blur', onBlur)
  window.addEventListener('resize', schedule)
  // редактор лежит в секции с overflow-auto: её скролл окно не видит, поэтому
  // слушаем в фазе перехвата (так же сделан тулбар агента в ArticleEditor)
  window.addEventListener('scroll', schedule, true)
  window.addEventListener('pointerdown', onDocPointerDown, true)
  window.addEventListener('keydown', onKeydown, true)
  const host = rootEl.value?.parentElement || null
  scroller = findScroller(host)
  if (host && typeof ResizeObserver !== 'undefined') {
    // колонка меняет ширину без resize окна (свернули инспектор) — ловим сами
    ro = new ResizeObserver(() => schedule())
    ro.observe(host)
  }
  sync()
})

onBeforeUnmount(() => {
  const ed = props.editor
  ed.off('selectionUpdate', schedule)
  ed.off('transaction', schedule)
  ed.off('focus', schedule)
  ed.off('blur', onBlur)
  window.removeEventListener('resize', schedule)
  window.removeEventListener('scroll', schedule, true)
  window.removeEventListener('pointerdown', onDocPointerDown, true)
  window.removeEventListener('keydown', onKeydown, true)
  if (raf) cancelAnimationFrame(raf)
  ro?.disconnect()
})
</script>

<template>
  <div
    v-show="visible"
    ref="rootEl"
    class="ipm"
    :style="{ top: `${top}px`, left: `${left}px` }"
  >
    <button
      type="button"
      class="ipm-btn ipm-plus"
      :class="{ 'is-open': open }"
      :aria-expanded="open"
      :aria-controls="rowId"
      :aria-label="$t('blog.editor.plus.aria')"
      @mousedown="holdFocus"
      @click="toggle"
    >
      <Plus :size="18" />
    </button>

    <TooltipProvider :delay-duration="150">
      <div
        :id="rowId"
        class="ipm-row"
        :class="{ 'is-open': open }"
        :style="{ '--gap': `${gap}px`, left: `${rowLeft}px` }"
        role="group"
        :aria-label="$t('blog.editor.plus.group')"
      >
        <Tooltip v-for="(it, i) in ITEMS" :key="it.id">
          <TooltipTrigger as-child>
            <button
              type="button"
              class="ipm-btn ipm-act"
              :style="{ '--i': i }"
              :tabindex="open ? 0 : -1"
              :aria-hidden="!open"
              :aria-label="it.label"
              :title="it.label"
              @mousedown="holdFocus"
              @click="choose(it.id)"
            >
              <component :is="it.icon" :size="18" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" :side-offset="6">{{ it.label }}</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  </div>
</template>

<style scoped>
/* координаты считает place(); по вертикали центруемся по строке */
.ipm {
  position: absolute;
  z-index: 20;
  height: 40px;
  transform: translateY(-50%);
}

/* токены темы — oklch, поэтому прозрачность только через color-mix. Цвет —
   акцент бренда (бордо): «+» приглашает к действию, поэтому не нейтральный. */
.ipm-btn {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 9999px;
  border: 1px solid color-mix(in srgb, var(--brand-accent) 35%, transparent);
  background: transparent;
  color: color-mix(in srgb, var(--brand-accent) 65%, transparent);
}
.ipm-btn:hover {
  background: color-mix(in srgb, var(--brand-accent) 8%, transparent);
  color: var(--brand-accent);
  border-color: color-mix(in srgb, var(--brand-accent) 55%, transparent);
}
.ipm-btn:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}

.ipm-plus {
  transition: transform .18s ease, color .18s ease, border-color .18s ease, background .12s ease;
}
/* раскрыто — «+» становится «✕»: нейтральный контур и поворот на 45° */
.ipm-plus.is-open {
  transform: rotate(45deg);
  color: var(--foreground);
  border-color: color-mix(in srgb, var(--foreground) 35%, transparent);
}
.ipm-plus.is-open:hover {
  background: color-mix(in srgb, var(--foreground) 8%, transparent);
}

.ipm-row {
  position: absolute;
  top: 0;
  display: flex;
  gap: var(--gap, 8px);
}
/* закрытое состояние: кнопки не кликабельны и выпадают из Tab (visibility) */
.ipm-act {
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateX(-10px) scale(.6);
  transition:
    opacity .12s ease,
    transform .12s ease,
    visibility 0s linear .12s,
    background .12s ease,
    color .12s ease,
    border-color .12s ease;
}
/* открытие: выезжают по очереди слева направо, ~25 мс между соседями */
.ipm-row.is-open .ipm-act {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: none;
  transition:
    opacity .18s ease,
    transform .18s cubic-bezier(.2, .8, .3, 1),
    visibility 0s,
    background .12s ease,
    color .12s ease,
    border-color .12s ease;
  transition-delay: calc(var(--i, 0) * 25ms);
}
/* закрытие — та же дорога назад, но одним махом и короче (без stagger) */

@media (prefers-reduced-motion: reduce) {
  .ipm-plus,
  .ipm-act,
  .ipm-row.is-open .ipm-act {
    transition: none;
    transition-delay: 0s;
  }
  .ipm-act { transform: none; }
}
</style>
