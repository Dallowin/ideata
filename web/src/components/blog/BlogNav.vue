<script setup lang="ts">
// Контекстный сайдбар воркспейса Blog Writer (референс — LobeHub agent):
// ← назад, шапка агента, действия, ниже — реальные темы, сгруппированные по дате.
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, CalendarDays, Hash, Image as ImageIcon, Lightbulb, Radio, SquarePen, UserPen, MessagesSquare } from 'lucide-vue-next'
import {
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { useBlogRuns, runPhase, type BlogRun } from '@/composables/useBlogRuns'
import { useBrands } from '@/composables/useBrands'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { state, load } = useBlogRuns()
const { activeDomain, load: loadBrands } = useBrands()
onMounted(() => { load(); loadBrands() })

// Аватар шапки — фавикон САЙТА активного бренда (как в табе браузера), не
// абстрактная иллюстрация. Тянем через google s2 (тот же путь, что для иконок
// провайдеров в настройках). Если домена нет или фавикон не отдался — падаем
// на дефолтную иллюстрацию blog-writer.
const FALLBACK_ICON = '/icons/blog-writer.webp'
const faviconFailed = ref(false)
watch(activeDomain, () => { faviconFailed.value = false }) // новый бренд — пробуем заново
const avatarSrc = computed(() =>
  (activeDomain.value && !faviconFailed.value)
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(activeDomain.value)}&sz=128`
    : FALLBACK_ICON,
)

// «Темы» — сразу под «Начать новую тему»: это главный список раздела, а не
// хвост меню (ниже он же раскрыт по датам)
const NAV = computed(() => [
  { title: t('blog.pages.nav.newTopic'), url: '/blog/new', icon: SquarePen },
  { title: t('blog.pages.nav.topics'), url: '/blog', icon: MessagesSquare, exact: true },
  { title: t('blog.pages.nav.ideas'), url: '/blog/ideas', icon: Lightbulb },
  { title: t('blog.pages.nav.plan'), url: '/blog/plan', icon: CalendarDays },
  { title: t('blog.pages.nav.covers'), url: '/blog/preview', icon: ImageIcon },
  { title: t('blog.pages.nav.agent'), url: '/blog/agent', icon: UserPen },
  { title: t('blog.pages.nav.integration'), url: '/blog/integration', icon: Radio },
])
const isActive = (url: string, exact?: boolean) => {
  const path = url.split('?')[0]!
  // открытая статья принадлежит «Темам»: без этого на /blog/run/:id в меню не
  // подсвечено вообще ничего и непонятно, где ты находишься
  if (exact) return route.path === path || route.path.startsWith('/blog/run/')
  return route.path.startsWith(path) && path !== '/blog'
}

// темы по дате обновления: Сегодня / Вчера / Ранее
type Bucket = 'today' | 'yesterday' | 'earlier'
const groups = computed(() => {
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  const g: Record<Bucket, BlogRun[]> = { today: [], yesterday: [], earlier: [] }
  for (const r of state.runs) {
    const d = new Date(r.updatedAt || r.createdAt)
    if (d >= today) g.today.push(r)
    else if (d >= yesterday) g.yesterday.push(r)
    else g.earlier.push(r)
  }
  return (Object.entries(g) as [Bucket, BlogRun[]][])
    .filter(([, items]) => items.length)
    .map(([key, items]) => ({ key, label: t(`blog.pages.nav.groups.${key}`), items: items.slice(0, 12) }))
})
// список обрезан до 12 на группу — честно говорим, сколько показано из скольких
const shown = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0))
const activeRunId = computed(() => (route.path.startsWith('/blog/run/') ? route.path.slice('/blog/run/'.length) : ''))
</script>

<template>
  <SidebarHeader>
    <div class="flex items-center gap-2 px-1 py-0.5">
      <button
        type="button" :aria-label="$t('blog.pages.nav.back')"
        class="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-surface-hover hover:text-foreground"
        @click="router.push('/')"
      >
        <ArrowLeft :size="15" />
      </button>
      <img
        :src="avatarSrc" alt="Blog Writer"
        class="size-8 shrink-0 rounded-lg border border-border bg-surface object-contain p-0.5"
        @error="faviconFailed = true"
      />

      <div class="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
        <div class="truncate text-sm font-semibold leading-tight">Blog Writer</div>
        <div class="truncate text-[11px] text-muted-foreground">{{ $t('blog.pages.nav.subtitle') }}</div>
      </div>
    </div>
  </SidebarHeader>

  <SidebarContent>
    <SidebarGroup>
      <SidebarMenu>
        <SidebarMenuItem v-for="n in NAV" :key="n.title">
          <SidebarMenuButton as-child :tooltip="n.title" :is-active="isActive(n.url, n.exact)">
            <RouterLink :to="n.url">
              <component :is="n.icon" />
              <span>{{ n.title }}</span>
            </RouterLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>

    <SidebarGroup class="group-data-[collapsible=icon]:hidden">
      <SidebarGroupLabel>{{ shown < state.runs.length
        ? $t('blog.pages.nav.topicsGroupPartial', { n: shown, total: state.runs.length })
        : $t('blog.pages.nav.topicsGroup', { n: state.runs.length }) }}</SidebarGroupLabel>
      <p v-if="state.status === 'loading'" class="px-2 py-2 text-[12px] text-muted-foreground">{{ $t('state.loading') }}</p>
      <p v-else-if="!state.runs.length" class="px-2 py-2 text-[12px] leading-snug text-muted-foreground">
        {{ $t('blog.pages.nav.empty') }}
      </p>
      <template v-for="g in groups" :key="g.key">
        <div class="px-2 pb-1 pt-2 text-[11px] text-muted-foreground/70">{{ g.label }}</div>
        <SidebarMenu>
          <SidebarMenuItem v-for="r in g.items" :key="r.id">
            <SidebarMenuButton as-child :tooltip="r.title || r.topic" :is-active="activeRunId === r.id">
              <RouterLink :to="`/blog/run/${r.id}`">
                <Hash class="text-muted-foreground/60" />
                <span class="truncate">{{ r.title || r.topic }}</span>
                <!-- topic is paused, waiting on the author's decision: without a marker it gets lost -->
                <span
                  v-if="runPhase(r) === 'awaiting'"
                  class="ml-auto size-1.5 shrink-0 rounded-full bg-warning"
                  :title="$t('blog.pages.topics.phase.awaiting')"
                ></span>
              </RouterLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </template>
    </SidebarGroup>
  </SidebarContent>
</template>
