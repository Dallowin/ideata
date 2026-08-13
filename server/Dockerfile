# Multi-stage образ api. Один образ обслуживает ДВА процесса из dist:
#   • dist/main        — HTTP-api (NestFactory), CMD по умолчанию
#   • dist/aeo-worker  — BullMQ-воркер AEO-прогонов (compose command его переопределяет)
# nest build (tsc) компилирует ВСЕ файлы из src, включая standalone
# src/aeo-worker.ts → dist/aeo-worker.js (как sitemap.controller.ts → dist/).
# ВНИМАНИЕ: `npm run build` требует существующего src/aeo/run-job.ts
# (processAeoRun) — его поставляет соседний агент; без него tsc падает и dist не
# соберётся. Это ожидаемая точка интеграции фазы B3.

# ── build ────────────────────────────────────────────────────────────────────
FROM node:22 AS build
WORKDIR /app

# Слой зависимостей кэшируется по package*.json. --legacy-peer-deps — как в
# локальной установке (Nest 11 тянет конфликтующие peer-диапазоны).
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

# Клиент Prisma — до копирования исходников (схема меняется реже кода).
COPY prisma ./prisma
RUN npx prisma generate

# Исходники и сборка. node_modules/dist/.env отсечены .dockerignore, так что
# COPY не затирает установленные зависимости и сгенерированный клиент.
COPY . .
RUN npm run build

# ── runtime ──────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Prisma query engine (debian-openssl-3.0.x) требует openssl в рантайме.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# Готовый dist + node_modules (с уже сгенерированным клиентом) + схема.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json

EXPOSE 4000
# Дефолт — HTTP-api; воркер запускается той же image с command: node dist/aeo-worker.
CMD ["node", "dist/main"]
