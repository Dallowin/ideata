import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// dev-прокси на прод-бэк (как web/nuxt.config devProxy): cookieDomainRewrite ''
// срезает Domain=.ideata.io у сессионной куки _cw → после логина на localhost
// дев работает с настоящим API. API_PROXY=local → локальный NestJS :4100.
// OSS-self-host: локальный бэкенд поднят в docker compose на :4000.
// API_PROXY=local → на него; иначе (на всякий) прод.
const apiTarget = process.env.API_PROXY === 'local' ? 'http://localhost:4000' : 'https://ideata.io'
const proxyEntry = { target: apiTarget, changeOrigin: true, cookieDomainRewrite: '' }
// '/api' — новые роуты кабинета (/api/settings/*, /api/public/*). '/linkedin' и
// '/x' — статусы/OAuth соцканалов «Интеграции».
const PROXY_PATHS = ['/graphql', '/auth', '/tg', '/api', '/scrape', '/blogwriter', '/metrika', '/gsc', '/cloudflare', '/threads', '/linkedin', '/x', '/assistant']

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 3002,
    proxy: Object.fromEntries(PROXY_PATHS.map((p) => [p, { ...proxyEntry }])),
  },
})
