# ideata / api

NestJS + GraphQL + Prisma backend. Serves the public catalog, comments, auth,
and (later) blog + marketplace. Reads `products`/`product_snapshots` written by
the Python scraper; **owns** `users`/`comments` and **all Postgres migrations**.

Part of the `ideata` GitLab group:
- `web` — Nuxt 3 / Vue front (consumes this GraphQL API)
- `api` — this repo
- `scrapper` — Python scraper + LLM analysis (writes products to the same Postgres)

## Stack
- NestJS (code-first GraphQL via `@nestjs/graphql` + Apollo)
- Prisma → PostgreSQL (single source of truth)
- Telegram-login auth (signed session cookie, shared across subdomains)

## Dev
```bash
cp .env.example .env          # set DATABASE_URL + Telegram creds
npm install
npx prisma migrate dev        # apply schema to Postgres
npm run start:dev             # GraphQL at http://localhost:4000/graphql
```

## Schema ownership
`api` runs every migration. The scraper only writes the columns of
`products`/`product_snapshots` — it never alters the schema. App tables
(`users`, `comments`, future `blog_posts`, `listings`) belong to `api`.
