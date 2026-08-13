<script setup lang="ts">
// Локальная страница входа для self-host (в SaaS-версии логина в кабинете не было —
// вход жил на лендинге ideata.io). Форма шлёт email+пароль на бэкенд
// (POST /auth/login | /auth/register), бэк ставит сессию-куку _cw и мы уходим на
// дашборд. Первый запуск: аккаунтов нет — создаём через «Создать аккаунт».
import { ref } from 'vue'

const email = ref('')
const password = ref('')
const mode = ref<'login' | 'register'>('login')
const error = ref('')
const busy = ref(false)

/** Безопасный next: только относительный путь того же origin (без open-redirect). */
function nextPath(): string {
  const raw = new URLSearchParams(window.location.search).get('next') || '/'
  try {
    const u = new URL(raw, window.location.origin)
    if (u.origin === window.location.origin) return u.pathname + u.search
  } catch { /* ignore */ }
  return '/'
}

async function submit() {
  error.value = ''
  if (!email.value || !password.value) { error.value = 'Введите email и пароль'; return }
  busy.value = true
  try {
    const r = await fetch(`/auth/${mode.value}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email: email.value.trim(), password: password.value }),
    })
    const data = await r.json().catch(() => ({} as any))
    if (r.ok && data?.ok !== false) {
      window.location.assign(nextPath())
      return
    }
    error.value = data?.error || (r.status === 401 ? 'Неверный email или пароль' : `Ошибка (${r.status})`)
  } catch {
    error.value = 'Сеть недоступна — бэкенд не отвечает'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-neutral-50 dark:bg-neutral-950 p-4">
    <div class="w-full max-w-sm rounded-2xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-900 p-6 shadow-sm">
      <div class="mb-6 text-center">
        <div class="text-lg font-semibold text-neutral-900 dark:text-neutral-100">ideata-app</div>
        <div class="text-sm text-neutral-500">
          {{ mode === 'login' ? 'Вход в кабинет' : 'Создать аккаунт' }}
        </div>
      </div>

      <form class="space-y-3" @submit.prevent="submit">
        <input
          v-model="email" type="email" autocomplete="email" placeholder="email"
          class="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:border-neutral-500"
        />
        <input
          v-model="password" type="password" autocomplete="current-password" placeholder="пароль"
          class="w-full rounded-lg border border-neutral-300 dark:border-neutral-700 bg-transparent px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 outline-none focus:border-neutral-500"
        />

        <p v-if="error" class="text-sm text-red-600 dark:text-red-400">{{ error }}</p>

        <button
          type="submit" :disabled="busy"
          class="w-full rounded-lg bg-neutral-900 dark:bg-neutral-100 px-3 py-2 text-sm font-medium text-white dark:text-neutral-900 disabled:opacity-60"
        >
          {{ busy ? '…' : (mode === 'login' ? 'Войти' : 'Создать аккаунт') }}
        </button>
      </form>

      <button
        class="mt-4 w-full text-center text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
        @click="mode = mode === 'login' ? 'register' : 'login'; error = ''"
      >
        {{ mode === 'login' ? 'Нет аккаунта? Создать' : 'Уже есть аккаунт? Войти' }}
      </button>
    </div>
  </div>
</template>
