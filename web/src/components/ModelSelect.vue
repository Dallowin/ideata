<script setup lang="ts">
/**
 * ЕДИНЫЙ селектор моделей. Эталон — «Профиль агента»: shadcn Select, иконка
 * вендора у значения и у каждого пункта, группировка по вендору, справа —
 * короткая подпись (её задаёт вызывающий: цена действия, «2 кр.» за картинку).
 *
 * size='pill' — вид из композера чата: круглая пилюля с иконкой вендора в ряду
 * кнопок под полем ввода. Это эталон для ЛЮБОГО композера (чат ассистента,
 * «О чём написать статью?»), поэтому живёт здесь, а не копируется по страницам.
 *
 * Подробности (что за модель, прайс по вводу/выводу, контекст) не грузим в
 * список — они всплывают КАРТОЧКОЙ сбоку по наведению на пункт: в списке видно
 * главное, а детали — по требованию. Содержимое карточки собирает вызывающий
 * (`card`), потому что цена «за статью» и «за вопрос» считается по-разному.
 *
 * Любой новый список моделей берём отсюда, а не рисуем свой — иначе селекторы
 * снова разъедутся по виду.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { groupByVendor, modelIcon } from '@/lib/models'

export interface ModelCard {
  /** одна фраза «что это за модель» */
  desc?: string | null
  /** строки «параметр → значение»: Ввод, Вывод, Контекст, Статья ≈ … */
  rows?: { label: string; value: string }[]
}

export interface ModelOption {
  id: string
  label: string
  /** правая подпись пункта: цена или любой короткий признак */
  hint?: string | null
  /** карточка по наведению; нет — пункт просто без карточки */
  card?: ModelCard | null
}

const props = withDefaults(defineProps<{
  modelValue: string
  models: ModelOption[]
  placeholder?: string
  /** вид триггера: 'md' — профиль агента, 'sm' — панели, 'pill' — ряд кнопок композера */
  size?: 'md' | 'sm' | 'pill'
  /** что означает подпись справа — строка-легенда над списком */
  note?: string
  disabled?: boolean
}>(), { placeholder: '', size: 'md' })

const emit = defineEmits<{ 'update:modelValue': [string] }>()

// Плейсхолдер по умолчанию — из словаря: в withDefaults он бы застыл на языке
// первого рендера и не переключался вместе с интерфейсом.
const { t } = useI18n()
const ph = computed(() => props.placeholder || t('onboarding.components.modelSelect.placeholder'))

/**
 * reka-ui ЗАПРЕЩАЕТ пустой value у SelectItem (бросает из setup и роняет ВЕСЬ
 * выпадающий список — дропдаун просто не открывается). А пустой id — наш способ
 * сказать «модель как в настройках», поэтому наружу оставляем '', а внутри
 * подменяем на служебное значение.
 */
const DEFAULT_VALUE = '__default__'
const raw = (v: string) => (v === DEFAULT_VALUE ? '' : v)
const val = (id: string) => id || DEFAULT_VALUE

/** пункт «как в настройках» (пустой id) — всегда первым, вне групп по вендору */
const fallbackOption = computed(() => props.models.find((m) => !m.id) || null)
const groups = computed(() => groupByVendor(props.models.filter((m) => m.id)))
const current = computed(() => props.models.find((m) => m.id === props.modelValue) || null)

// Карточка по наведению: держим сам пункт (а не id) — карточку рисуем из него.
// Живёт в body-телепорте с фиксированными координатами: внутри SelectContent её
// срезает overflow (список скроллится), а popper-контент не растянуть наружу.
const CARD_W = 300
const hovered = ref<ModelOption | null>(null)
const cardPos = ref({ top: 0, left: 0 })
const hoveredCard = computed(() =>
  hovered.value?.card?.desc || hovered.value?.card?.rows?.length ? hovered.value : null)

function onItemEnter(m: ModelOption, e: PointerEvent) {
  hovered.value = m
  const box = (e.currentTarget as HTMLElement | null)?.closest('[data-slot=select-content]')
  if (!box) return
  const r = box.getBoundingClientRect()
  // слева от списка; не влезло — справа (узкие экраны/список у левого края)
  const left = r.left - CARD_W - 8
  cardPos.value = { top: r.top, left: left >= 8 ? left : Math.min(r.right + 8, window.innerWidth - CARD_W - 8) }
}
</script>

<template>
  <Select
    :model-value="val(modelValue)" :disabled="disabled"
    @update:model-value="emit('update:modelValue', raw(String($event)))"
    @update:open="hovered = null"
  >
    <SelectTrigger
      :class="[
        'border-border bg-surface-2 font-medium',
        size === 'pill'
          ? 'h-8 w-auto gap-1.5 rounded-full px-2.5 text-[12px] text-muted-foreground hover:text-foreground data-[state=open]:text-foreground'
          : size === 'sm' ? 'h-9 w-full text-[12.5px]' : 'h-11 w-full text-[13.5px]',
      ]"
    >
      <span :class="['flex min-w-0 items-center', size === 'pill' ? 'gap-1.5' : 'gap-2']">
        <img
          v-if="modelValue" :src="modelIcon(modelValue)" alt=""
          :class="['shrink-0 rounded-full bg-surface-2 p-0.5', size === 'md' ? 'size-5' : 'size-4']"
        />
        <SelectValue :placeholder="ph">
          <span class="truncate">{{ current?.label || modelValue || ph }}</span>
        </SelectValue>
      </span>
    </SelectTrigger>

    <SelectContent class="max-h-[360px]" @pointerleave="hovered = null">
      <!-- max-w + перенос: иначе длинная подпись растягивает весь список в строку -->
      <p v-if="note" class="mb-1 max-w-[260px] border-b border-border px-2 py-1.5 text-[11px] leading-snug text-wrap text-muted-foreground/70">{{ note }}</p>

      <SelectItem v-if="fallbackOption" :value="DEFAULT_VALUE" @pointerenter="onItemEnter(fallbackOption, $event)">
        <span class="flex items-center gap-2">{{ fallbackOption.label }}</span>
      </SelectItem>

      <SelectGroup v-for="[vendor, list] in groups" :key="vendor">
        <SelectLabel>{{ vendor }}</SelectLabel>
        <SelectItem v-for="m in list" :key="m.id" :value="m.id" @pointerenter="onItemEnter(m, $event)">
          <span class="flex items-center gap-2">
            <img :src="modelIcon(m.id)" alt="" class="size-4 shrink-0 rounded-full bg-surface-2 p-0.5" />
            {{ m.label }}
            <span v-if="m.hint" class="ml-1 text-[10.5px] tabular-nums text-muted-foreground/70">{{ m.hint }}</span>
          </span>
        </SelectItem>
      </SelectGroup>

    </SelectContent>

    <!-- карточка модели: сбоку от списка, курсор не перехватывает -->
    <Teleport to="body">
      <div
        v-if="hoveredCard"
        :style="{ top: `${cardPos.top}px`, left: `${cardPos.left}px`, width: `${CARD_W}px` }"
        class="pointer-events-none fixed z-[60] hidden rounded-md border border-border bg-popover p-3 shadow-xl shadow-black/40 md:block"
      >
        <div class="flex items-center gap-2">
          <img v-if="hoveredCard.id" :src="modelIcon(hoveredCard.id)" alt="" class="size-5 shrink-0 rounded-full bg-surface-2 p-0.5" />
          <span class="truncate text-[13px] font-medium">{{ hoveredCard.label }}</span>
        </div>

        <p v-if="hoveredCard.card?.desc" class="mt-2 text-[11.5px] leading-relaxed text-muted-foreground">
          {{ hoveredCard.card.desc }}
        </p>

        <dl v-if="hoveredCard.card?.rows?.length" class="mt-2.5 space-y-1.5 border-t border-border pt-2.5">
          <div v-for="r in hoveredCard.card.rows" :key="r.label" class="flex items-baseline justify-between gap-3">
            <dt class="text-[11.5px] text-muted-foreground">{{ r.label }}</dt>
            <dd class="text-[11.5px] tabular-nums">{{ r.value }}</dd>
          </div>
        </dl>
      </div>
    </Teleport>
  </Select>
</template>
