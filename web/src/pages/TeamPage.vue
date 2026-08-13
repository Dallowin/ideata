<script setup lang="ts">
// «Команда»: участники аккаунта, роли и приглашения по ссылке.
// Данные — реальный контракт myTeam (GraphQL) + гейт мест из usePlan
// (limits.seats===1 → на тарифе команды нет). Раскладка — канон Rows/Figma:
// один список участников, pending-приглашения строками в нём же, «Пригласить»
// в шапке открывает диалог (Clay/Cohere).
//
// Имена и e-mail участников, как и тексты ошибок api, приходят с бэка — их не
// переводим, словарь закрывает только обвязку.
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight, Check, Copy, Link2, Trash2, UserPlus } from 'lucide-vue-next'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import EmptyState from '@/components/EmptyState.vue'
import { api, type Team, type TeamMember, type TeamRole } from '@/lib/api'
import { useAuth } from '@/composables/useAuth'
import { usePlan } from '@/composables/usePlan'
import { intlLocale } from '@/i18n'

const { t } = useI18n()
const { auth, check: checkAuth } = useAuth()
const { check: checkPlan, title: planTitle, noSeats } = usePlan()

const loading = ref(true)
const team = ref<Team>({ seatsLimit: null, members: [], invites: [], myAccounts: [] })

async function load() {
  loading.value = true
  try {
    await Promise.allSettled([checkAuth(), checkPlan()])
    team.value = (await api.myTeam()) || team.value
  } catch {
    // fail-open: пустая команда, апселл/пустой стейт покажет причину
  } finally {
    loading.value = false
  }
}
onMounted(load)

const roleLabel = (r: string) => (r ? t(`team.role.${r}`) : r)
const roleHint = (r: TeamRole) => t(`team.roleHint.${r}`)
// название тарифа, с которого открывается команда, — из витрины подписки
const proName = computed(() => t('subscription.plan.pro.name'))

const seatsUsed = computed(() => (team.value.members?.length || 0) + (team.value.invites?.length || 0))
const seatsText = computed(() => {
  const total = Number(team.value.seatsLimit || 0)
  return t('team.seats', { used: seatsUsed.value, total }, { plural: total })
})
const initials = (s: string) => (s || '?').trim().slice(0, 1).toUpperCase()
const fmtDate = (s?: string) =>
  s ? new Date(s).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) : ''
const inviteLink = (token: string) => `${location.origin}/invite/${token}`

// ── копирование ссылки ────────────────────────────────────────────────────
const copiedKey = ref('')
function copy(text: string, key: string) {
  navigator.clipboard?.writeText(text)
  copiedKey.value = key
  setTimeout(() => { if (copiedKey.value === key) copiedKey.value = '' }, 1600)
}

// ── приглашение ───────────────────────────────────────────────────────────
const inviteOpen = ref(false)
const inviteRole = ref<TeamRole>('editor')
const inviteEmail = ref('')
const inviting = ref(false)
const inviteErr = ref('')
const issuedToken = ref('')

function openInvite() {
  inviteErr.value = ''; issuedToken.value = ''; inviteEmail.value = ''; inviteRole.value = 'editor'
  inviteOpen.value = true
}

async function submitInvite() {
  if (inviting.value) return
  inviteErr.value = ''
  inviting.value = true
  try {
    const inv = await api.createInvite(inviteRole.value, inviteEmail.value.trim() || undefined)
    issuedToken.value = inv.token
    team.value.invites = [inv, ...(team.value.invites || [])]
  } catch (e: any) {
    // e.message — текст с бэка, показываем как есть; переводим только фолбэки
    inviteErr.value = e?.code === 'PLAN_LIMIT_SEATS'
      ? (e?.message || t('team.error.planLimit', { pro: proName.value }))
      : (e?.message || t('team.error.createFailed'))
  } finally {
    inviting.value = false
  }
}

async function revoke(id: number) {
  const prev = team.value.invites
  team.value.invites = prev.filter((i) => i.id !== id)
  try { await api.revokeInvite(id) } catch { team.value.invites = prev }
}

// ── участники ─────────────────────────────────────────────────────────────
const savingRole = ref<number | null>(null)
async function changeRole(m: TeamMember, role: unknown) {
  const next = String(role || '') as TeamRole
  if (!next || m.role === next) return
  const prev = m.role
  m.role = next
  savingRole.value = m.userId
  try { await api.setMemberRole(m.userId, next) } catch { m.role = prev } finally { savingRole.value = null }
}

async function removeMember(m: TeamMember) {
  const name = m.name || m.email || t('team.remove.fallbackName')
  if (!window.confirm(t('team.remove.confirm', { name }))) return
  const prev = team.value.members
  team.value.members = prev.filter((x) => x.userId !== m.userId)
  try { await api.removeMember(m.userId) } catch { team.value.members = prev }
}
</script>

<template>
  <div class="space-y-4 p-5 lg:p-6">
    <!-- шапка -->
    <div class="flex flex-wrap items-center gap-3">
      <div class="mr-auto">
        <h1 class="text-lg font-semibold tracking-tight">{{ $t('nav.team') }}</h1>
        <p class="mt-0.5 text-[12.5px] text-muted-foreground">
          {{ $t('team.subtitle') }}
          <template v-if="!loading && team.seatsLimit"> · {{ seatsText }}</template>
        </p>
      </div>
      <Button size="sm" class="h-8 text-[12.5px]" :disabled="loading || noSeats" @click="openInvite">
        <UserPlus :size="14" /> {{ $t('team.invite') }}
      </Button>
    </div>

    <!-- тарифный гейт мест: тонкая полоса, список ниже остаётся виден -->
    <div
      v-if="!loading && noSeats"
      class="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border bg-surface-2 px-4 py-2.5 text-[12.5px]"
    >
      <span class="text-muted-foreground">
        {{ $t('team.gate.text', { plan: planTitle, pro: proName }) }}
      </span>
      <RouterLink to="/subscription" class="inline-flex items-center gap-1 font-medium text-foreground hover:underline">
        {{ $t('team.gate.upgrade') }} <ArrowRight :size="12" />
      </RouterLink>
    </div>

    <!-- участники + приглашения одним списком -->
    <div class="overflow-hidden rounded-xl border border-border bg-surface">
      <Table>
        <TableHeader>
          <TableRow class="border-border hover:bg-transparent">
            <TableHead class="h-9 px-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{{ $t('team.col.member') }}</TableHead>
            <TableHead class="h-9 w-[200px] px-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{{ $t('team.col.since') }}</TableHead>
            <TableHead class="h-9 w-[180px] px-4 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{{ $t('team.col.role') }}</TableHead>
            <TableHead class="h-9 w-[52px] px-4"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <!-- участники: имя и e-mail — с бэка, не переводим -->
          <TableRow v-for="m in team.members" :key="'m' + m.userId" class="border-border hover:bg-surface">
            <TableCell class="px-4 py-2.5">
              <div class="flex items-center gap-2.5">
                <Avatar class="size-7">
                  <AvatarFallback class="bg-surface-hover text-[11px] font-medium">{{ initials(m.name || m.email || '?') }}</AvatarFallback>
                </Avatar>
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5">
                    <span class="truncate text-[13px] font-medium">{{ m.name || m.email || $t('user.noName') }}</span>
                    <span v-if="m.userId === auth.userId" class="rounded-full border border-border bg-surface-hover px-1.5 py-0.5 text-[10px] text-muted-foreground">{{ $t('team.you') }}</span>
                  </div>
                  <div class="truncate text-[11.5px] text-muted-foreground/70">{{ m.email || '—' }}</div>
                </div>
              </div>
            </TableCell>
            <TableCell class="px-4 py-2.5 text-[12.5px] text-muted-foreground/70">{{ fmtDate(m.createdAt) || '—' }}</TableCell>
            <TableCell class="px-4 py-2.5">
              <span v-if="m.role === 'owner'" class="text-[12.5px] text-muted-foreground">{{ $t('team.role.owner') }}</span>
              <Select
                v-else :model-value="m.role" :disabled="savingRole === m.userId"
                @update:model-value="(v) => changeRole(m, v)"
              >
                <SelectTrigger class="h-7 w-[150px] border-border bg-surface text-[12.5px]">
                  <SelectValue>{{ $t(`team.role.${m.role}`) }}</SelectValue>
                </SelectTrigger>
                <SelectContent class="border-border bg-popover">
                  <SelectItem value="editor" class="text-[12.5px]">{{ $t('team.role.editor') }}</SelectItem>
                  <SelectItem value="viewer" class="text-[12.5px]">{{ $t('team.role.viewer') }}</SelectItem>
                </SelectContent>
              </Select>
            </TableCell>
            <TableCell class="px-4 py-2.5">
              <button
                v-if="m.role !== 'owner'" type="button" :title="$t('team.remove.title')"
                class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/60 transition hover:bg-rose-500/10 hover:text-rose-400"
                @click="removeMember(m)"
              >
                <Trash2 :size="14" />
              </button>
            </TableCell>
          </TableRow>

          <!-- pending-приглашения -->
          <TableRow v-for="inv in team.invites" :key="'i' + inv.id" class="border-border hover:bg-surface">
            <TableCell class="px-4 py-2.5">
              <div class="flex items-center gap-2.5">
                <Avatar class="size-7">
                  <AvatarFallback class="bg-transparent text-muted-foreground/60 ring-1 ring-inset ring-border">
                    <Link2 :size="13" />
                  </AvatarFallback>
                </Avatar>
                <div class="min-w-0">
                  <div class="flex items-center gap-1.5">
                    <span class="truncate text-[13px] text-muted-foreground">{{ inv.email || $t('team.pending.linkInvite') }}</span>
                    <span class="rounded-full border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">{{ $t('team.pending.badge') }}</span>
                  </div>
                  <button
                    type="button"
                    class="mt-0.5 inline-flex items-center gap-1 text-[11.5px] text-muted-foreground/70 transition hover:text-foreground"
                    @click="copy(inviteLink(inv.token), 'inv' + inv.id)"
                  >
                    <component :is="copiedKey === 'inv' + inv.id ? Check : Copy" :size="11" />
                    {{ copiedKey === 'inv' + inv.id ? $t('team.pending.copied') : $t('team.pending.copy') }}
                  </button>
                </div>
              </div>
            </TableCell>
            <TableCell class="px-4 py-2.5 text-[12.5px] text-muted-foreground/70">
              {{ fmtDate(inv.createdAt)
                ? $t('team.pending.invitedAt', { date: fmtDate(inv.createdAt) })
                : $t('team.pending.sent') }}
            </TableCell>
            <TableCell class="px-4 py-2.5">
              <span class="text-[12.5px] text-muted-foreground">{{ roleLabel(inv.role) || inv.role }}</span>
            </TableCell>
            <TableCell class="px-4 py-2.5">
              <button
                type="button" :title="$t('team.pending.revoke')"
                class="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/60 transition hover:bg-rose-500/10 hover:text-rose-400"
                @click="revoke(inv.id)"
              >
                <Trash2 :size="14" />
              </button>
            </TableCell>
          </TableRow>

          <TableRow v-if="!loading && !team.members.length && !team.invites.length" class="border-border hover:bg-transparent">
            <TableCell colspan="4" class="px-4">
              <EmptyState :title="$t('team.empty.title')" :hint="$t('team.empty.hint')" compact />
            </TableCell>
          </TableRow>
          <TableRow v-else-if="loading" class="border-border hover:bg-transparent">
            <TableCell colspan="4" class="px-4 py-8 text-center text-[12.5px] text-muted-foreground/70">{{ $t('team.loading') }}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>

    <!-- чужие аккаунты, куда пригласили меня -->
    <section v-if="team.myAccounts?.length" class="space-y-2">
      <h2 class="text-[13px] font-medium">{{ $t('team.myTeams.title') }}</h2>
      <div class="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
        <div v-for="a in team.myAccounts" :key="a.ownerUserId" class="flex items-center gap-2.5 px-4 py-2.5">
          <Avatar class="size-7">
            <AvatarFallback class="bg-surface-hover text-[11px] font-medium">{{ initials(a.ownerName || '?') }}</AvatarFallback>
          </Avatar>
          <span class="min-w-0 flex-1 truncate text-[13px]">{{ a.ownerName || $t('team.myTeams.account', { id: a.ownerUserId }) }}</span>
          <span class="text-[12px] text-muted-foreground">{{ roleLabel(a.role) || a.role }}</span>
        </div>
      </div>
    </section>

    <!-- диалог приглашения -->
    <Dialog v-model:open="inviteOpen">
      <DialogContent class="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('team.dialog.title') }}</DialogTitle>
          <DialogDescription class="text-[12.5px]">
            {{ $t('team.dialog.description') }}
          </DialogDescription>
        </DialogHeader>

        <!-- ссылка готова -->
        <div v-if="issuedToken" class="space-y-2">
          <div class="flex items-center gap-2">
            <code class="min-w-0 flex-1 truncate rounded-md border border-border bg-surface-2 px-2.5 py-1.5 font-mono text-[12px] text-muted-foreground">{{ inviteLink(issuedToken) }}</code>
            <Button
              variant="outline" size="sm" class="h-8 shrink-0 border-border bg-surface text-[12px]"
              @click="copy(inviteLink(issuedToken), 'issued')"
            >
              <component :is="copiedKey === 'issued' ? Check : Copy" :size="13" />
              {{ copiedKey === 'issued' ? $t('action.copied') : $t('action.copy') }}
            </Button>
          </div>
          <p class="text-[12px] text-muted-foreground/70">
            {{ $t('team.dialog.issuedHint', { role: roleLabel(inviteRole) }) }}
          </p>
        </div>

        <!-- форма -->
        <form v-else class="space-y-3" @submit.prevent="submitInvite">
          <div>
            <label class="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground/70">{{ $t('team.dialog.roleLabel') }}</label>
            <Select v-model="inviteRole">
              <SelectTrigger class="h-9 w-full border-border bg-surface text-[13px]">
                <SelectValue>{{ $t(`team.role.${inviteRole}`) }}</SelectValue>
              </SelectTrigger>
              <SelectContent class="border-border bg-popover">
                <SelectItem value="editor" class="text-[12.5px]">{{ $t('team.role.editor') }}</SelectItem>
                <SelectItem value="viewer" class="text-[12.5px]">{{ $t('team.role.viewer') }}</SelectItem>
              </SelectContent>
            </Select>
            <p class="mt-1.5 text-[12px] text-muted-foreground/70">{{ roleHint(inviteRole) }}</p>
          </div>
          <div>
            <label class="mb-1 block text-[11px] uppercase tracking-wide text-muted-foreground/70">
              {{ $t('team.dialog.emailLabel') }} <span class="normal-case tracking-normal text-muted-foreground/50">{{ $t('team.dialog.emailNote') }}</span>
            </label>
            <Input v-model="inviteEmail" type="email" :placeholder="$t('team.dialog.emailPlaceholder')" class="h-9 border-border bg-surface text-[13px]" />
          </div>
          <!-- inviteErr может быть текстом ошибки с бэка — показываем как есть -->
          <p v-if="inviteErr" class="text-[12.5px] text-rose-400">{{ inviteErr }}</p>
        </form>

        <DialogFooter>
          <Button v-if="issuedToken" size="sm" class="h-8 text-[12.5px]" @click="inviteOpen = false">{{ $t('action.done') }}</Button>
          <template v-else>
            <Button variant="outline" size="sm" class="h-8 border-border bg-surface text-[12.5px]" @click="inviteOpen = false">{{ $t('action.cancel') }}</Button>
            <Button size="sm" class="h-8 text-[12.5px]" :disabled="inviting" @click="submitInvite">
              <UserPlus :size="13" /> {{ inviting ? $t('team.dialog.creating') : $t('team.dialog.submit') }}
            </Button>
          </template>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
