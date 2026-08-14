<div align="center">

<img src=".github/assets/logo.png" alt="Ideata" width="300">

### Open-source **AEO tracker** + **AI content studio** — self-hosted in one command.

See how ChatGPT, Claude, Gemini, Perplexity & friends talk about your brand —
then out-publish your competitors with an AI writing studio built right in.

<br/>

<a href="#quick-start"><img alt="Docker Compose" src="https://img.shields.io/badge/Docker-compose-2496ED?style=flat&logo=docker&logoColor=white"></a>
<a href="https://vuejs.org"><img alt="Vue 3" src="https://img.shields.io/badge/Vue-3-42b883?style=flat&logo=vuedotjs&logoColor=white"></a>
<a href="https://nestjs.com"><img alt="NestJS" src="https://img.shields.io/badge/NestJS-E0234E?style=flat&logo=nestjs&logoColor=white"></a>
<a href="https://www.postgresql.org"><img alt="PostgreSQL 16" src="https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat&logo=postgresql&logoColor=white"></a>
<a href="#contributing"><img alt="PRs welcome" src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat"></a>
<a href="#quick-start"><img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-%E2%9C%93-6d071a?style=flat"></a>
<a href="LICENSE"><img alt="License AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat"></a>

[Quick start](#quick-start) · [Features](#features) · [Configuration](#configuration) · [Architecture](#architecture) · [Roadmap](#roadmap)

<br/>

<img src=".github/assets/dashboard.png" alt="Ideata dashboard — AI visibility monitoring across answer engines" width="900">

</div>

<br/>

## Why Ideata?

Search moved into the chat box. People ask **ChatGPT** and **Perplexity** for recommendations
instead of scrolling ten blue links. **AEO — Answer Engine Optimization — is the new SEO**, and
Ideata is the open, self-hosted way to measure it and win it.

- **Track your AI visibility.** Run your real buyer prompts across 8+ engines and see exactly when you're mentioned, cited, or ignored — and who gets recommended instead of you.
- **Benchmark competitors.** Share of voice, sentiment, and which sources the models actually trust.
- **Close the gap.** A built-in AI writing studio that researches, drafts, and multi-posts content engineered to get cited back.
- **Own everything.** Runs entirely on your infrastructure. Bring your own API keys. No seats, no per-report fees, no limits.

<br/>

## Features

### AEO tracking

- **8+ answer engines** — ChatGPT, Claude, Gemini, Perplexity, DeepSeek, Grok + regional **Yandex** (Alice / Neuro) & **GigaChat**
- **Prompt panels** — track dozens of real prompts, run on a daily schedule
- **Mentions & citations** — read the exact AI answers that name you
- **Competitor analysis** — share of voice, sentiment, source leaderboard
- **AI-crawler analytics** — GPTBot, ClaudeBot & co. via Cloudflare
- **AI-referred traffic** — Yandex Metrica + Google Search Console

### Blog Writer studio

- **Full pipeline** — brief → research → outline → draft → anti-slop → fact-check
- **Per-article model** with a live price estimate before you spend a token
- **Brand-voice agent** — one prompt, quality gates, target length & sources
- **Cover studio** — 50+ templates, PNG composited in the browser
- **Content calendar** + idea generator
- **Bilingual** — interface and generated content in English or Russian

### Cross-posting

One article, rewritten per platform — each with its own character limit, threading
rules, tone and hashtag policy, not the same text copy-pasted everywhere.

- **One-click publish** — Telegram, X, LinkedIn, Bluesky, Mastodon
- **Auto-pull** — Zen subscribes to your `rss.xml` and picks articles up itself
- **Adapt & copy** — VK, Threads
- **The article itself** — your own blog, WordPress (app password or OAuth), or any REST endpoint
- **Media** included: images and video ride along to every connector that accepts them

### Built for self-hosting

- **One `docker compose up`** brings up Postgres, Redis, the API, the worker and the dashboard.
- **Bring your own keys** through a slick in-app Settings UI — one OpenRouter key for everything, or native per-provider keys for geo-control.
- **Bilingual dashboard** — English / Русский, switchable in a click.
- **No phone-home.** Everything runs on your machine.

<br/>

## Quick start

```bash
git clone https://github.com/Dallowin/ideata.git
cd ideata
cp .env.example .env          # add at least one LLM key (e.g. OPENROUTER_API_KEY)
docker compose up -d --build
```

Then open **http://localhost:8080**, sign up (the first account becomes the
**owner/admin**), go to **Settings → Providers**, paste your keys, and run your
first analysis.

No cloud account. No credit card. Just Docker.

<br/>

## Configuration

Everything is configured through `.env` (see [`.env.example`](.env.example)) or, once
you're the owner, straight from the dashboard. The only thing you truly need is **model access** —
and there are two ways to give it.

### Models — which key powers which engine

Engines are split across providers. Set the keys for the engines you actually want:

| Engine | Variable | Where |
| --- | --- | --- |
| ChatGPT, Claude, Gemini, DeepSeek, Grok, Perplexity | `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) |
| ChatGPT — official OpenAI API | `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com/api-keys) |
| Claude — official Anthropic API | `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com/settings/keys) |
| Gemini — official Google API **+ all image generation** | `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com/app/apikey) |
| DeepSeek — official DeepSeek API | `DEEPSEEK_API_KEY` | [platform.deepseek.com](https://platform.deepseek.com/api_keys) |
| Grok — official xAI API | `XAI_API_KEY` | [console.x.ai](https://console.x.ai) |
| Perplexity — official Sonar API | `PERPLEXITY_API_KEY` | [perplexity.ai/settings/api](https://www.perplexity.ai/settings/api) |
| Google AI Overviews | `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | [dataforseo.com](https://app.dataforseo.com/api-access) |
| GigaChat (RU market) | `GIGACHAT_API_KEY` | [developers.sber.ru/studio](https://developers.sber.ru/studio) |
| Yandex Alice, Yandex Neuro (RU market) | `YANDEX_SEARCH_API_KEY` + `YANDEX_CLOUD_FOLDER_ID` | [console.yandex.cloud](https://console.yandex.cloud) |

> **One key is enough — the rest is per engine.** With just `OPENROUTER_API_KEY` all six global engines run. Each engine then runs through its vendor's official API when that key is set, and through OpenRouter otherwise — mix the two freely, engine by engine, and the app shows you the active route on every row. Images are the one exception: covers and illustrations need `GEMINI_API_KEY`, there is no fallback for them.

**Grounding depends on the route.** In grounded ("full") runs the engines search the live web like this:

- **ChatGPT** — official OpenAI `web_search` with real citations. Through OpenRouter it gets no web search at all, so this key is a real upgrade.
- **Claude**, **Gemini** — official `web_search` / `google_search` with real citations; the OpenRouter route serves these models without a search tool.
- **Grok** — official xAI Live Search with real citations; through OpenRouter, the web plugin.
- **Perplexity** — Sonar searches on every call, on both routes.
- **DeepSeek** — the vendor API has **no web search**: on the official route a grounded run returns a plain answer with no citations. The OpenRouter route keeps its web plugin, so leave `DEEPSEEK_API_KEY` empty if citations matter more than a direct connection.

### Everything else (all optional)

| Variable | What it unlocks |
| --- | --- |
| `DATAFORSEO_*` / `KEYSSO_API_KEY` | competitor & keyword SEO data |
| `RESEND_API_KEY` / `SMTP_FROM` | weekly report emails |
| `YANDEX_*` (OAuth) | Yandex Metrica — AI-assistant traffic |
| `GOOGLE_*` / `GSC_REDIRECT_URI` | Google Search Console |
| `OSS_UNLOCKED` | `1` = all features on, no paywall (default) |

<br/>

## Architecture

```mermaid
flowchart LR
    U([You]) --> WEB[web · Vue 3 SPA<br/>nginx :8080]
    WEB -->|/api, /graphql| API[server · NestJS :4000]
    API --> DB[(PostgreSQL 16)]
    API --> REDIS[(Redis 7)]
    REDIS <--> WORKER[worker · BullMQ]
    WORKER --> LLM{{LLM engines<br/>OpenRouter / native}}
    WORKER --> DB
```

| Layer | Stack |
| --- | --- |
| Dashboard | Vue 3 · Vite · Tailwind v4 |
| API & Worker | NestJS · Prisma · BullMQ |
| Data | PostgreSQL 16 · Redis 7 |
| Models | OpenRouter, or native provider keys |

<br/>

## Localization

The dashboard is **bilingual (English / Русский)** via a frontend i18n layer.
Backend messages default to English; language-dependent **product content**
(weekly reports, LLM prompts) is generated in the language of the tracked site.
New UI locales are welcome — they live in the frontend translation dictionaries.

<br/>

## Roadmap

- [ ] More answer engines & regional assistants
- [ ] Per-country geo-targeting for the answer engines
- [ ] Scheduled PDF/email visibility reports out of the box
- [ ] One-click deploy templates (Railway / Render / Coolify)

<br/>

## Contributing

Issues and PRs are very welcome. Spin it up locally, break something, send a fix.
If you add a feature that touches the UI, keep it token-driven so it works in both themes.

## License

[AGPL-3.0](LICENSE) — free to self-host, modify and use commercially. If you run a
modified version as a network service, you have to share your changes under the same
license. Same deal as Postiz, Grafana and friends.

<div align="center">
<br/>
<sub>Built for a world where the answer box is the new front page.</sub>
</div>
