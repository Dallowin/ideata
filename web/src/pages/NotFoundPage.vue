<script setup lang="ts">
// 404 кабинета. Без этого маршрута любой неизвестный путь (опечатка в URL,
// старая ссылка из письма) отдавал index.html и рисовал пустой шелл: сайдбар
// есть, контента нет, и непонятно, сломалось приложение или страница пустая.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ArrowLeft, Compass } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()

// кириллица в URL приходит percent-encoded — читать такое невозможно
const prettyPath = computed(() => {
  try { return decodeURIComponent(route.fullPath) } catch { return route.fullPath }
})

// подписи — те же, что в сайдбаре: берём общие ключи, а не дублируем перевод
const LINKS = computed(() => [
  { to: '/', label: t('nav.overview') },
  { to: '/monitoring', label: t('nav.monitoring') },
  { to: '/prompts', label: t('nav.prompts') },
  { to: '/blog', label: t('nav.blogWriter') },
  { to: '/subscription', label: t('nav.subscription') },
])
</script>

<template>
  <div class="grid min-h-dvh place-items-center px-5">
    <section class="w-full max-w-[460px] text-center">
      <div class="mx-auto grid size-11 place-items-center rounded-full bg-surface-hover">
        <Compass :size="20" class="text-muted-foreground" />
      </div>
      <h1 class="mt-5 text-[24px] font-semibold tracking-tight">{{ $t('onboarding.notFound.title') }}</h1>
      <p class="mt-2 break-all text-[13px] text-muted-foreground">{{ prettyPath }}</p>

      <div class="mt-6 flex flex-wrap justify-center gap-1.5">
        <RouterLink
          v-for="l in LINKS" :key="l.to" :to="l.to"
          class="rounded-full border border-border bg-surface px-3 py-1.5 text-[12.5px] text-text-2 transition hover:border-white/20 hover:bg-surface-hover"
        >{{ l.label }}</RouterLink>
      </div>

      <Button variant="outline" class="mt-7 h-10" @click="router.back()">
        <ArrowLeft :size="14" /> {{ $t('action.back') }}
      </Button>
    </section>
  </div>
</template>
