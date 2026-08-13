<script setup lang="ts">
import type { SidebarProps } from '@/components/ui/sidebar'

import {
  LayoutDashboard,
  Sparkles,
  LineChart,
  Link2,
  MessageSquareText,
  PenLine,
  Swords,
} from "@lucide/vue"
import { computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import NavMain from '@/components/NavMain.vue'
import NavUser from '@/components/NavUser.vue'
import TeamSwitcher from '@/components/TeamSwitcher.vue'
import DemoBadge from '@/components/DemoBadge.vue'
import BlogNav from '@/components/blog/BlogNav.vue'
import { useAuth } from '@/composables/useAuth'
import { useBrands } from '@/composables/useBrands'

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarRail,
} from '@/components/ui/sidebar'

const props = withDefaults(defineProps<SidebarProps>(), {
  collapsible: "icon",
})

// auth + бренды с реального API (кука _cw через dev-прокси)
const { auth, check } = useAuth()
const { load } = useBrands()
onMounted(() => { check(); load() })

// внутри воркспейса Blog Writer сайдбар меняется на агентский (LobeHub-стиль)
const route = useRoute()
const { t } = useI18n()
const blogMode = computed(() => route.path.startsWith('/blog'))

const user = computed(() => ({
  name: auth.checked ? (auth.authed ? (auth.name || t('user.noName')) : t('user.guest')) : '…',
  email: auth.authed ? (auth.isAdmin ? t('user.admin') : `ID ${auth.userId}`) : t('user.anonymous'),
  avatar: '',
}))

// computed, а не константа: подписи пунктов обязаны пересобираться при смене
// языка — у объявленного один раз объекта они замерли бы на языке загрузки
const data = computed(() => ({
  navBrand: [
    { title: t('nav.overview'), url: "/", icon: Sparkles, exact: true },
    { title: t('nav.monitoring'), url: "/monitoring", icon: LayoutDashboard },
    { title: t('nav.prompts'), url: "/prompts", icon: MessageSquareText },
    { title: t('nav.links'), url: "/links", icon: Link2 },
    { title: t('nav.competitors'), url: "/competitors", icon: Swords },
    { title: t('nav.traffic'), url: "/traffic", icon: LineChart },
    { title: t('nav.blogWriter'), url: "/blog", icon: PenLine },
  ],
  // разделы аккаунта (подписка / команда / настройки) живут в меню юзера
  // внизу сайдбара — в рейле их не дублируем
}))
</script>

<template>
  <Sidebar v-bind="props">
    <!-- свитч между кабинетом и агентским сайдбаром Blog Writer — с плавным переходом -->
    <Transition name="nav-swap" mode="out-in">
      <!-- агентский сайдбар Blog Writer -->
      <div v-if="blogMode" key="blog" class="flex min-h-0 flex-1 flex-col">
        <BlogNav />
      </div>

      <!-- основной сайдбар кабинета -->
      <div v-else key="main" class="flex min-h-0 flex-1 flex-col">
        <SidebarHeader>
          <TeamSwitcher />
        </SidebarHeader>
        <SidebarContent>
          <NavMain :label="$t('nav.myBrand')" :items="data.navBrand" />
        </SidebarContent>
      </div>
    </Transition>

    <SidebarFooter>
      <DemoBadge />
      <NavUser :user="user" />
    </SidebarFooter>
    <SidebarRail />
  </Sidebar>
</template>

<style scoped>
.nav-swap-enter-active,
.nav-swap-leave-active {
  transition: opacity .18s ease, transform .18s ease;
}
.nav-swap-enter-from { opacity: 0; transform: translateX(-10px); }
.nav-swap-leave-to { opacity: 0; transform: translateX(10px); }
</style>
