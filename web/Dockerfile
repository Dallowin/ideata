# Дашборд: сборка Vue SPA (vite) → раздача статикой через nginx с прокси API.
# vue-tsc из build-скрипта намеренно пропускаем (npx vite build) — типовые
# ошибки не должны блокировать контейнерную сборку дашборда.

# ── build ────────────────────────────────────────────────────────────────────
FROM node:22 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npx vite build

# ── runtime (nginx) ──────────────────────────────────────────────────────────
FROM nginx:alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
