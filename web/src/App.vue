<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import AppSidebar from '@/components/AppSidebar.vue'
import LangSwitcher from '@/components/LangSwitcher.vue'
import ThemeSwitcher from '@/components/ThemeSwitcher.vue'
import IdeataLoader from '@/components/IdeataLoader.vue'
import { Separator } from '@/components/ui/separator'
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar'
import { useAuth } from '@/composables/useAuth'

const route = useRoute()
const { t } = useI18n()
// Заголовок страницы — ключ словаря в meta.titleKey, а не готовая строка:
// иначе шапка оставалась бы русской после переключения языка.
const pageTitle = computed(() =>
  route.meta.titleKey ? t(String(route.meta.titleKey)) : t('routeTitle.overview'),
)
// плавный переход контента ТОЛЬКО при входе/выходе из Blog Writer
// (ключ меняется на границе; внутри раздела переключения вкладок — мгновенно)
const inBlog = computed(() => route.path.startsWith('/blog'))
// bare-роуты (онбординг) рисуются без сайдбара и хедера — во весь экран
const bare = computed(() => route.meta.bare === true)

const { auth } = useAuth()

// boot-оверлей: рисуем «Ideata», пока не проверили сессию, минимум BOOT_MIN
// (чтобы лого успело нарисоваться). Оверлей ТОЛЬКО на старте приложения —
// на переходах между страницами лоадер показывают сами страницы, по реальной
// загрузке данных (и не показывают, если данные уже в кэше).
const BOOT_MIN = 1500
const booting = ref(true)
const bootStart = performance.now()
watch(() => auth.checked, (v) => {
  if (!v) return
  setTimeout(() => { booting.value = false }, Math.max(0, BOOT_MIN - (performance.now() - bootStart)))
}, { immediate: true })
</script>

<template>
  <Transition name="boot-fade">
    <IdeataLoader v-if="booting" fullscreen />
  </Transition>

  <RouterView v-if="bare" />

  <SidebarProvider v-else>
    <AppSidebar />
    <SidebarInset>
      <header class="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 px-4">
        <SidebarTrigger class="-ml-1" />
        <Separator orientation="vertical" class="mr-1 !h-4" />
        <span class="text-[13px] font-medium text-muted-foreground">{{ pageTitle }}</span>
        <ThemeSwitcher class="ml-auto" />
        <LangSwitcher />
      </header>
      <RouterView v-slot="{ Component }">
        <Transition name="section-fade" mode="out-in">
          <div :key="String(inBlog)" class="flex min-h-0 flex-1 flex-col">
            <component :is="Component" />
          </div>
        </Transition>
      </RouterView>
    </SidebarInset>
  </SidebarProvider>
</template>

<style>
.section-fade-enter-active,
.section-fade-leave-active {
  transition: opacity .16s ease;
}
.section-fade-enter-from,
.section-fade-leave-to {
  opacity: 0;
}

/* boot-лоадер уходит плавно */
.boot-fade-leave-active { transition: opacity .4s ease; }
.boot-fade-leave-to { opacity: 0; }
</style>
