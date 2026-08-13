// meta.titleKey — ключ словаря для шапки (см. App.vue). Строкой заголовок
// здесь держать нельзя: он не переключался бы вместе с языком.
import 'vue-router'

declare module 'vue-router' {
  interface RouteMeta {
    titleKey?: string
    bare?: boolean
  }
}
