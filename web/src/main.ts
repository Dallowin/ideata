import { createApp } from 'vue'
import { initTheme } from '@/composables/useTheme'
import './style.css'
import App from './App.vue'
import router from './router'
import { i18n, initI18n } from './i18n'

// Тему ставим до всего: класс на <html> должен стоять раньше первого кадра,
// иначе кабинет моргает чужой темой.
initTheme()

// Словарь грузим ДО mount: иначе первый кадр кабинета рисуется голыми ключами.
initI18n().then(() => {
createApp(App).use(router).use(i18n).mount('#app')
})
