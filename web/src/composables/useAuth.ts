import { reactive } from 'vue'
import { api, type Me } from '@/lib/api'

// Синглтон auth-состояния. Два важных отличия от прежней версии:
//
// 1. «Сервер сказал: не авторизован» и «запрос не удался» — РАЗНЫЕ состояния.
//    Раньше любая ошибка me() ставила authed=false, и с появлением гварда это
//    значило бы, что моргнувшая сеть или пятисотка выкидывает живого юзера на
//    внешний логин. Теперь неудачный запрос ставит reachable=false, а гвард на
//    такое состояние пропускает (fail-open — как весь остальной слой данных).
// 2. Проверка не «один раз за загрузку», а с TTL. Прежний флаг inited означал,
//    что протухшая посреди работы сессия не обнаруживается вообще: SPA-переходы
//    не перезагружают страницу, и кабинет продолжал кликаться, молча получая 401.
const CHECK_TTL_MS = 60_000

const auth = reactive<Me & { checked: boolean; reachable: boolean }>({
  authed: false, name: '', userId: null, isAdmin: false,
  checked: false,     // хоть раз получили ответ (для boot-оверлея)
  reachable: true,    // последний запрос дошёл до бэка
})

let pending: Promise<void> | null = null
let checkedAt = 0

export function useAuth() {
  /** Обновить состояние сессии. force — не смотреть на TTL. */
  function check(force = false): Promise<void> {
    if (pending) return pending          // параллельные вызовы ждут один запрос
    if (!force && auth.checked && Date.now() - checkedAt < CHECK_TTL_MS) {
      return Promise.resolve()
    }
    pending = (async () => {
      try {
        const r = await api.me()
        auth.authed = r.authed
        auth.name = r.name
        auth.userId = r.userId
        auth.isAdmin = r.isAdmin
        auth.reachable = true
      } catch {
        // Сессия неизвестна: бэк не ответил. Прежнее значение authed не трогаем —
        // разлогинивать по сетевой ошибке нельзя.
        auth.reachable = false
      } finally {
        auth.checked = true
        checkedAt = Date.now()
        pending = null
      }
    })()
    return pending
  }

  async function logout() {
    try { await api.logout() } catch { /* ignore */ }
    auth.authed = false; auth.name = ''; auth.userId = null; auth.isAdmin = false
    auth.reachable = true      // логаут — авторитетное «не авторизован»
    checkedAt = Date.now()
  }

  return { auth, check, logout }
}
