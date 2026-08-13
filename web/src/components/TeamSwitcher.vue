<script setup lang="ts">
import { ChevronsUpDown, Plus } from "@lucide/vue"
import { computed, onMounted, onUnmounted, ref } from "vue"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { useRouter } from 'vue-router'
import { useBrands } from '@/composables/useBrands'
import { useI18n } from 'vue-i18n'

const router = useRouter()

// Свитчер брендов воркспейса — на реальном GraphQL (myBrands/setActiveBrand).
const { state, setActive, active } = useBrands()
const { t } = useI18n()
const { isMobile } = useSidebar()

// фавиконки брендов по домену (google s2); при ошибке — буква-фолбэк
const failedFavicons = ref<Set<string>>(new Set())
const brandFavicon = (domain: string) =>
  failedFavicons.value.has(domain) ? '' : `https://www.google.com/s2/favicons?domain=${domain}&sz=64`
function onFaviconError(domain: string) {
  failedFavicons.value = new Set([...failedFavicons.value, domain])
}

const title = computed(() => active.value?.name || active.value?.domain || 'ideata.io')
const subtitle = computed(() => {
  if (!active.value) return state.loading ? t('state.loading') : t('brandSwitcher.noBrands')
  return active.value.name ? active.value.domain : (active.value.geo || '').toUpperCase() || t('brandSwitcher.brandFallback')
})

async function pick(id: number) {
  if (id === active.value?.id) return
  await setActive(id)
  // как в web: свитч бренда = полная перезагрузка кабинета на активный бренд
  window.location.assign('/')
}

// хоткеи ⌥1…⌥9 — быстрый свитч бренда (⌘+цифра занят вкладками браузера).
// Игнорируем, когда фокус в поле ввода.
function onHotkey(e: KeyboardEvent) {
  if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return
  const tag = (e.target as HTMLElement | null)?.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement | null)?.isContentEditable) return
  // e.code — физическая клавиша: на macOS Alt+цифра даёт спецсимвол в e.key
  const m = /^Digit([1-9])$/.exec(e.code)
  if (!m) return
  const brand = state.brands[Number(m[1]) - 1]
  if (!brand) return
  e.preventDefault()
  pick(brand.id)
}
onMounted(() => window.addEventListener('keydown', onHotkey))
onUnmounted(() => window.removeEventListener('keydown', onHotkey))
</script>

<template>
  <SidebarMenu>
    <SidebarMenuItem>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <SidebarMenuButton
            size="lg"
            class="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground
                   group-data-[collapsible=icon]:!p-0"
          >
            <!-- В свёрнутом сайдбаре остаётся только этот квадрат: название,
                 подпись и шеврон скрыты, поэтому иконка бренда — единственный
                 признак того, за каким брендом ты сейчас смотришь. Раньше на
                 её месте оставался один шеврон. -->
            <div class="flex aspect-square size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg">
              <img
                v-if="active && brandFavicon(active.domain)"
                :src="brandFavicon(active.domain)" :alt="title"
                class="size-6 rounded-md" referrerpolicy="no-referrer"
                @error="onFaviconError(active!.domain)"
              />
              <span v-else class="flex size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sm font-semibold uppercase text-sidebar-primary-foreground">{{ title[0] }}</span>
            </div>
            <div class="grid flex-1 text-left text-sm leading-tight group-data-[collapsible=icon]:hidden">
              <span class="truncate font-medium">{{ title }}</span>
              <span class="truncate text-xs">{{ subtitle }}</span>
            </div>
            <ChevronsUpDown class="ml-auto group-data-[collapsible=icon]:hidden" />
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          class="w-(--reka-dropdown-menu-trigger-width) min-w-56 rounded-lg"
          align="start"
          :side="isMobile ? 'bottom' : 'right'"
          :side-offset="4"
        >
          <DropdownMenuLabel class="text-xs text-muted-foreground">
            {{ $t('brandSwitcher.brands') }}
          </DropdownMenuLabel>
          <DropdownMenuItem
            v-for="(brand, index) in state.brands"
            :key="brand.id"
            class="gap-2 p-2"
            @click="pick(brand.id)"
          >
            <div class="flex size-6 items-center justify-center overflow-hidden rounded-sm">
              <img
                v-if="brandFavicon(brand.domain)"
                :src="brandFavicon(brand.domain)" :alt="brand.name || brand.domain"
                class="size-[18px] rounded-[3px]" referrerpolicy="no-referrer"
                @error="onFaviconError(brand.domain)"
              />
              <span v-else class="flex size-6 items-center justify-center rounded-sm border text-[11px] font-semibold uppercase">{{ (brand.name || brand.domain)[0] }}</span>
            </div>
            <span class="truncate">{{ brand.name || brand.domain }}</span>
            <span v-if="brand.isActive" class="size-1.5 shrink-0 rounded-full bg-emerald-400"></span>
            <DropdownMenuShortcut>⌥{{ index + 1 }}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem v-if="!state.brands.length" disabled class="p-2 text-muted-foreground">
            {{ state.loading ? $t('state.loading') : $t('brandSwitcher.notFound') }}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem class="gap-2 p-2" @select="router.push('/onboarding')">
            <div class="flex size-6 items-center justify-center rounded-md border bg-transparent">
              <Plus class="size-4" />
            </div>
            <div class="font-medium text-muted-foreground">
              {{ $t('brandSwitcher.addBrand') }}
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </SidebarMenuItem>
  </SidebarMenu>
</template>
