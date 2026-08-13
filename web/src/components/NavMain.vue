<script setup lang="ts">
import type { LucideIcon } from "@lucide/vue"
import { ChevronRight } from "@lucide/vue"
import { useRoute } from "vue-router"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from '@/components/ui/sidebar'

// Группа навигации: плоские пункты — RouterLink с активным стейтом по роуту,
// пункты с children — collapsible-подменю (как у Блог-райтера).
defineProps<{
  label: string
  items: {
    title: string
    url: string
    icon?: LucideIcon
    exact?: boolean
    items?: {
      title: string
      url: string
    }[]
  }[]
}>()

const route = useRoute()
const isActive = (url: string, exact?: boolean) =>
  exact ? route.path === url : route.path.startsWith(url)
</script>

<template>
  <SidebarGroup>
    <SidebarGroupLabel>{{ label }}</SidebarGroupLabel>
    <SidebarMenu>
      <template v-for="item in items" :key="item.title">
        <!-- пункт с подменю -->
        <Collapsible
          v-if="item.items?.length"
          as-child
          :default-open="isActive(item.url)"
          class="group/collapsible"
        >
          <SidebarMenuItem>
            <CollapsibleTrigger as-child>
              <SidebarMenuButton :tooltip="item.title" :is-active="isActive(item.url)">
                <component :is="item.icon" v-if="item.icon" />
                <span>{{ item.title }}</span>
                <ChevronRight class="ml-auto transition-transform duration-200 group-data-[state=open]/collapsible:rotate-90" />
              </SidebarMenuButton>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub>
                <SidebarMenuSubItem v-for="subItem in item.items" :key="subItem.title">
                  <SidebarMenuSubButton as-child :is-active="isActive(subItem.url, true)">
                    <RouterLink :to="subItem.url">
                      <span>{{ subItem.title }}</span>
                    </RouterLink>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              </SidebarMenuSub>
            </CollapsibleContent>
          </SidebarMenuItem>
        </Collapsible>

        <!-- плоский пункт -->
        <SidebarMenuItem v-else>
          <SidebarMenuButton as-child :tooltip="item.title" :is-active="isActive(item.url, item.exact)">
            <RouterLink :to="item.url">
              <component :is="item.icon" v-if="item.icon" />
              <span>{{ item.title }}</span>
            </RouterLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </template>
    </SidebarMenu>
  </SidebarGroup>
</template>
