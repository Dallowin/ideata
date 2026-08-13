import { createRouter, createWebHistory } from 'vue-router'
import { useAuth } from '@/composables/useAuth'
import { useBrands } from '@/composables/useBrands'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes: [
    {
      path: '/',
      name: 'overview',
      component: () => import('@/pages/OverviewPage.vue'),
      meta: { titleKey: 'routeTitle.overview' },
    },
    {
      // мастер первого бренда: без сайдбара (bare) — шелл кабинета тут мешает
      path: '/onboarding',
      name: 'onboarding',
      component: () => import('@/pages/OnboardingPage.vue'),
      meta: { titleKey: 'routeTitle.onboarding', bare: true },
    },
    {
      path: '/monitoring',
      name: 'monitoring',
      component: () => import('@/pages/DashboardPage.vue'),
      meta: { titleKey: 'routeTitle.monitoring' },
    },
    {
      path: '/prompts',
      name: 'prompts',
      component: () => import('@/pages/PromptsPage.vue'),
      meta: { titleKey: 'routeTitle.prompts' },
    },
    {
      path: '/links',
      name: 'links',
      component: () => import('@/pages/LinksPage.vue'),
      meta: { titleKey: 'routeTitle.links' },
    },
    {
      path: '/competitors',
      name: 'competitors',
      component: () => import('@/pages/CompetitorsPage.vue'),
      meta: { titleKey: 'routeTitle.competitors' },
    },
    {
      path: '/traffic',
      name: 'traffic',
      component: () => import('@/pages/TrafficPage.vue'),
      meta: { titleKey: 'routeTitle.traffic' },
    },
    // «Интеграции» слиты в «AI-трафик» (коннекторы живут там)
    { path: '/integrations', redirect: '/traffic' },
    // воркспейс Blog Writer (агентский сайдбар, LobeHub-стиль)
    {
      path: '/blog',
      name: 'blog',
      component: () => import('@/pages/blog/BlogTopicsPage.vue'),
      meta: { titleKey: 'routeTitle.blogTopics' },
    },
    {
      path: '/blog/preview',
      name: 'blog-preview',
      component: () => import('@/pages/blog/BlogPreviewPage.vue'),
      meta: { titleKey: 'routeTitle.blogPreview' },
    },
    {
      path: '/blog/new',
      name: 'blog-new',
      component: () => import('@/pages/blog/BlogNewPage.vue'),
      meta: { titleKey: 'routeTitle.blogNew' },
    },
    {
      path: '/blog/run/:id',
      name: 'blog-run',
      component: () => import('@/pages/blog/BlogRunPage.vue'),
      meta: { titleKey: 'routeTitle.blogRun' },
    },
    {
      path: '/blog/ideas',
      name: 'blog-ideas',
      component: () => import('@/pages/blog/BlogIdeasPage.vue'),
      meta: { titleKey: 'routeTitle.blogIdeas' },
    },
    {
      path: '/blog/plan',
      name: 'blog-plan',
      component: () => import('@/pages/blog/BlogPlanPage.vue'),
      meta: { titleKey: 'routeTitle.blogPlan' },
    },
    {
      path: '/blog/agent',
      name: 'blog-agent',
      component: () => import('@/pages/blog/BlogAgentPage.vue'),
      meta: { titleKey: 'routeTitle.blogAgent' },
    },
    {
      path: '/blog/integration',
      name: 'blog-integration',
      component: () => import('@/pages/blog/BlogIntegrationPage.vue'),
      meta: { titleKey: 'routeTitle.blogIntegration' },
    },
    {
      path: '/team',
      name: 'team',
      component: () => import('@/pages/TeamPage.vue'),
      meta: { titleKey: 'routeTitle.team' },
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('@/pages/SettingsPage.vue'),
      meta: { titleKey: 'routeTitle.settings' },
    },
    {
      // приём приглашения в команду: ссылка вида app.ideata.io/invite/{token}
      // раньше упиралась в отсутствующий маршрут и рисовала пустой шелл
      path: '/invite/:token',
      name: 'invite',
      component: () => import('@/pages/InvitePage.vue'),
      meta: { titleKey: 'routeTitle.invite', bare: true },
    },
    {
      // Локальный вход для self-host (в SaaS его не было — логин жил на лендинге).
      path: '/login',
      name: 'login',
      component: () => import('@/pages/LoginPage.vue'),
      meta: { titleKey: 'routeTitle.login', bare: true },
    },
    {
      // без catch-all любой неизвестный путь отдавал шелл без содержимого
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/pages/NotFoundPage.vue'),
      meta: { titleKey: 'routeTitle.notFound', bare: true },
    },
  ],
})

// ── гейт авторизации ────────────────────────────────────────────────────────
// Кабинет — не публичная страница: аноним не должен видеть шелл с «Гость, не
// авторизован» (именно так он и выглядел из инкогнито). Своего логина у app
// нет — вход живёт на старом origin, туда и отправляем с ?next= обратно.
//
// В dev по умолчанию ВЫКЛЮЧЕН: на localhost куки _cw обычно нет, и включённый
// гейт увозил бы разработку на прод-логин при каждом старте. VITE_AUTH_GUARD=1
// включает принудительно (проверить сам гейт), =0 — выключает в проде.
// self-host: логин — ЛОКАЛЬНАЯ страница /login (не внешний origin). Оверрайд —
// VITE_LOGIN_URL (напр. вернуть внешний вход в SaaS-сборке).
const LOGIN_URL = import.meta.env.VITE_LOGIN_URL || '/login'
const guardEnabled = import.meta.env.VITE_AUTH_GUARD === '1'
  || (import.meta.env.PROD && import.meta.env.VITE_AUTH_GUARD !== '0')

router.beforeEach(async (to) => {
  if (!guardEnabled) return true
  if (to.path === '/login') return true  // сам логин — без гейта (иначе петля)
  const { auth, check } = useAuth()
  await check()          // с TTL: переходы внутри SPA ловят протухшую сессию
  if (auth.authed) return true
  // Бэк не ответил — состояние сессии неизвестно. Выкидывать на логин по
  // сетевой ошибке нельзя: положенный на минуту api разлогинил бы всех живых.
  // Пускаем; страницы сами покажут, что данные не загрузились.
  if (!auth.reachable) return true
  const next = window.location.origin + to.fullPath
  window.location.replace(`${LOGIN_URL}?next=${encodeURIComponent(next)}`)
  return false           // навигацию не продолжаем — уходим с origin
})

// ── funnel первого бренда ───────────────────────────────────────────────────
// Без бренда кабинет бесполезен: все страницы читают активный домен и показывают
// пустые состояния. Раньше единственным входом в мастер был пункт свитчера —
// человек после регистрации попадал в пустой дашборд и упирался.
//
// Fail-open: если список брендов не загрузился (сеть/бэк), пускаем как есть —
// запирать в мастере из-за сбоя нельзя.
router.beforeEach(async (to) => {
  if (to.path === '/onboarding') return true
  // инвайт и 404 живут вне воронки: у приглашённого своих брендов может не быть
  if (to.name === 'invite' || to.name === 'not-found') return true
  const { auth } = useAuth()
  if (guardEnabled && !auth.authed) return true   // логин-гвард выше уже решил
  try {
    const { state, load } = useBrands()
    await load()
    if (state.loaded && !state.failed && state.brands.length === 0) {
      return { path: '/onboarding', query: { next: to.fullPath } }
    }
  } catch { /* fail-open */ }
  return true
})

export default router
