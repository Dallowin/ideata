<script setup lang="ts">
// Приём приглашения в команду по токену.
//
// Ссылку выдаёт «Команда» как `${origin}/invite/{token}`, но в новом кабинете
// такого маршрута не было: человек открывал app.ideata.io/invite/… и видел
// пустой шелл (SPA отдавала index.html на любой путь). Рабочая страница жила
// только на легаси-домене.
//
// Логин здесь проверять не нужно: гвард роутера уже отправил анонима на
// /login?next=… и вернёт его сюда после входа. acceptInvite идемпотентна —
// повторное открытие ссылки не ломается.
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Check, Loader2, TriangleAlert, Users } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'
import { useBrands } from '@/composables/useBrands'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const brands = useBrands()

const token = String(route.params.token || '')
type State = 'ready' | 'accepting' | 'done' | 'error'
const state = ref<State>(token ? 'ready' : 'error')
const errMsg = ref(token ? '' : t('team.accept.badLink'))
const account = ref<{ ownerName?: string | null; role: string } | null>(null)

// роль приходит кодом ('owner' | 'editor' | 'viewer'); неизвестную показываем как есть
const ROLES = ['owner', 'editor', 'viewer']
const roleText = computed(() => {
  const r = account.value?.role || ''
  return ROLES.includes(r) ? t(`team.roleLower.${r}`) : r
})

async function accept() {
  if (state.value === 'accepting') return
  state.value = 'accepting'
  errMsg.value = ''
  try {
    account.value = await api.acceptInvite(token)
    // бренды владельца появляются в свитчере только после перезапроса
    await brands.load(true)
    state.value = 'done'
  } catch (e: any) {
    // e.message — текст ошибки с бэка, показываем как есть
    errMsg.value = e?.message || t('team.accept.failed')
    state.value = 'error'
  }
}

onMounted(() => { if (state.value === 'ready') accept() })
</script>

<template>
  <div class="grid min-h-dvh place-items-center px-5">
    <section class="w-full max-w-[420px] text-center">
      <div class="mx-auto grid size-11 place-items-center rounded-full bg-brand/15">
        <Loader2 v-if="state === 'accepting'" :size="20" class="animate-spin text-brand" />
        <TriangleAlert v-else-if="state === 'error'" :size="19" class="text-destructive" />
        <Check v-else-if="state === 'done'" :size="20" class="text-emerald-400" />
        <Users v-else :size="19" class="text-brand" />
      </div>

      <template v-if="state === 'done'">
        <!-- ownerName — имя владельца с бэка, не переводится -->
        <h1 class="mt-5 text-[24px] font-semibold tracking-tight">
          {{ account?.ownerName
            ? $t('team.accept.doneWithOwner', { owner: account.ownerName })
            : $t('team.accept.done') }}
        </h1>
        <p class="mt-2 text-[13.5px] text-muted-foreground">
          {{ $t('team.accept.doneHint', { role: roleText }) }}
        </p>
        <Button class="mt-7 h-11 w-full" @click="router.push('/')">
          {{ $t('team.accept.goToApp') }} <ArrowRight :size="15" />
        </Button>
      </template>

      <template v-else-if="state === 'error'">
        <h1 class="mt-5 text-[24px] font-semibold tracking-tight">{{ $t('team.accept.errorTitle') }}</h1>
        <p class="mt-2 text-[13.5px] text-muted-foreground">{{ errMsg }}</p>
        <div class="mt-7 flex gap-2">
          <Button variant="outline" class="h-11 flex-1" @click="router.push('/')">{{ $t('team.accept.toApp') }}</Button>
          <Button v-if="token" class="h-11 flex-1" @click="accept">{{ $t('team.accept.retry') }}</Button>
        </div>
      </template>

      <template v-else>
        <h1 class="mt-5 text-[24px] font-semibold tracking-tight">{{ $t('team.accept.pendingTitle') }}</h1>
        <p class="mt-2 text-[13.5px] text-muted-foreground">{{ $t('team.accept.pendingHint') }}</p>
      </template>
    </section>
  </div>
</template>
