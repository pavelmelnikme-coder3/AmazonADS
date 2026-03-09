# AdsFlow — Amazon Ads Dashboard

> SaaS-дашборд для управления рекламными кампаниями Amazon Ads (Sponsored Products, Sponsored Display) с AI-рекомендациями на базе Claude.

<<<<<<< Updated upstream
## 🏗 Архитектура
=======
[![Node.js](https://img.shields.io/badge/Node.js-20-green)](https://nodejs.org)
[![React](https://img.shields.io/badge/React-18-blue)](https://react.dev)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791)](https://postgresql.org)
[![Redis](https://img.shields.io/badge/Redis-7-red)](https://redis.io)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED)](https://docker.com)

---

## ✨ Features

- **OAuth 2.0** — Login with Amazon (LwA), токены зашифрованы AES-256
- **Entity sync** — кампании, группы объявлений, ключевые слова, таргеты, product ads, портфели, негативы (8 типов сущностей)
- **Metrics pipeline** — Amazon Reporting API v3, 60-дневный backfill, GZIP JSON парсинг, 13K+ строк метрик
- **AI Recommendations** — Claude (claude-sonnet-4-20250514) анализирует данные кампаний, генерирует рекомендации с Apply/Preview/Dismiss на EN/RU/DE
- **Bulk operations** — пауза/активация/архивирование кампаний, массовое изменение ставок и бюджетов
- **Rule engine** — автоматические правила с условиями и действиями
- **Alerts** — пороговые уведомления
- **Audit log** — полная история изменений
- **Multilingual UI** — English 🇬🇧 / Русский 🇷🇺 / Deutsch 🇩🇪

---

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, Recharts |
| Backend | Node.js 20, Express 4 |
| Database | PostgreSQL 16 |
| Queue | Redis 7 + BullMQ |
| AI | Anthropic Claude (claude-sonnet-4-20250514) |
| Auth | JWT + LwA OAuth 2.0 + AES-256 |
| Infra | Docker Compose |

---

## 🏗 Architecture
>>>>>>> Stashed changes

```
┌──────────────────────────────────────────────────────────────────┐
│                          Browser                                 │
│              React 18 + Vite (port 3000)                        │
│  Pages: Overview · Campaigns · Keywords · Reports · Rules ·     │
│         Alerts · AI Assistant · Audit · Connections             │
└─────────────────────────┬────────────────────────────────────────┘
                          │ HTTP / REST
                          ▼
┌──────────────────────────────────────────────────────────────────┐
│               Express API (port 4000)                            │
│  /api/v1/auth · /connections · /campaigns · /keywords           │
│  /metrics · /reports · /rules · /alerts · /ai · /audit · /bulk  │
│                                                                  │
│  Middleware: JWT auth · workspace resolver · rate limit (300/min)│
└──────┬──────────────────┬────────────────────────────────────────┘
       │                  │
       ▼                  ▼
┌────────────┐   ┌────────────────────────────────────────────────┐
│ PostgreSQL │   │           BullMQ Workers (Redis)               │
│     16     │   │                                                │
│            │   │  entity-sync    — 8 entity types per profile  │
│ 22 tables  │   │  report-pipeline — Amazon Reporting API v3    │
│ 4 migrations│  │  metrics-backfill — 60-day GZIP JSON pipeline │
│            │   │  rule-engine    — hourly rule evaluation       │
│ Partitioned│   │  ai-analysis    — Claude recommendations       │
│ fact table │   │  bulk-operations — mass campaign/bid updates  │
└────────────┘   └──────────────────┬─────────────────────────────┘
                                    │
                          ┌─────────┴──────────┐
                          │                    │
                          ▼                    ▼
               ┌──────────────────┐  ┌─────────────────────┐
               │  Amazon Ads API  │  │  Anthropic Claude   │
               │       v3         │  │  claude-sonnet-4    │
               │  SP · SB · SD    │  │  -20250514          │
               │  Reporting v3    │  │                     │
               └──────────────────┘  └─────────────────────┘
```

### Cron Schedule

| Job | Schedule | Description |
|---|---|---|
| Entity sync | `0 */2 * * *` | Sync all 8 entity types for active profiles |
| Daily reports | `0 6 * * *` | Queue SP/SB/SD reports for yesterday |
| Rule engine | `0 * * * *` | Evaluate automation rules for all workspaces |
| Metrics backfill | `30 6 * * *` | Rolling 2-day metrics refresh |
| AI analysis | `0 7 * * *` | Generate Claude recommendations for all workspaces |

---

## 🗄 Database Schema

22 tables across 4 migrations:

```
001_initial.sql
├── organizations          — multi-tenant orgs
├── users                  — JWT auth, roles
├── workspaces             — workspace per org
├── workspace_members      — RBAC
├── amazon_connections     — LwA tokens (AES-256 encrypted)
├── amazon_profiles        — per-marketplace advertisers
├── campaigns              — SP/SB/SD campaigns
├── ad_groups
├── keywords
├── fact_metrics_daily     — PARTITIONED by date (2024–2026)
├── report_requests        — Amazon async report tracking
├── audit_events           — immutable append-only log
├── rules                  — automation rule DSL
├── alert_configs
├── alert_instances
├── ai_recommendations     — Claude-generated, 7-day TTL
└── sync_state

004_extended_entities.sql
├── portfolios
├── product_ads
├── targets
├── negative_keywords
├── negative_targets
└── budget_rules
```

---

## 📋 Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) 24+
- Amazon Developer account with LwA app ([developer.amazon.com](https://developer.amazon.com))
- Anthropic API key ([console.anthropic.com](https://console.anthropic.com))

---

## 🚀 Quick Start

```bash
# 1. Clone
git clone <repo-url> adsflow
cd adsflow

# 2. Configure environment
cp .env.example .env
# Edit .env — fill in required values (see Environment Variables below)

# 3. Start all services
docker compose up -d

# 4. Open in browser
open http://localhost:3000
```

First launch applies all migrations automatically. Register an account, then go to **Connections** to link your Amazon Ads account.

---

## ⚙️ Environment Variables

Create `.env` in the project root:

```env
# PostgreSQL
POSTGRES_PASSWORD=your_secure_password

# Security
JWT_SECRET=your_32_char_secret_here_minimum
ENCRYPTION_KEY=your_32_byte_hex_key_for_aes256

# Amazon Login with Amazon (LwA)
# Create app at: https://developer.amazon.com/loginwithamazon/console/site/lwa/overview.html
AMAZON_CLIENT_ID=amzn1.application-oa2-client.xxxxxxxx
AMAZON_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
AMAZON_REDIRECT_URI=http://localhost:3000/connect/amazon/callback

# Anthropic (for AI recommendations)
# Get key at: https://console.anthropic.com
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxx
```

---

## 📡 API Reference

All routes require `Authorization: Bearer <jwt>` and `x-workspace-id: <uuid>` headers (except `/auth`).

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/auth/register` | Register user + org |
| `POST` | `/api/v1/auth/login` | Login, returns JWT |
| `GET` | `/api/v1/connections` | List Amazon connections |
| `GET` | `/api/v1/campaigns` | List campaigns (filter: status, type, search) |
| `PATCH` | `/api/v1/campaigns/bulk` | Bulk pause/enable/archive/budget |
| `GET` | `/api/v1/keywords` | List keywords + targets |
| `PATCH` | `/api/v1/keywords/bulk` | Bulk bid adjustment |
| `GET` | `/api/v1/metrics/summary` | KPI summary with delta vs prior period |
| `GET` | `/api/v1/metrics/top-campaigns` | Top N campaigns by metric |
| `POST` | `/api/v1/metrics/backfill` | Trigger 60-day metrics backfill |
| `POST` | `/api/v1/reports` | Queue Amazon Reporting API v3 job |
| `GET` | `/api/v1/reports` | Report history |
| `GET/POST` | `/api/v1/rules` | Automation rules CRUD |
| `GET/POST` | `/api/v1/alerts` | Alert configs + instances |
| `GET` | `/api/v1/audit` | Audit log |
| `POST` | `/api/v1/ai/run` | Trigger Claude analysis |
| `GET` | `/api/v1/ai/recommendations` | List recommendations |
| `POST` | `/api/v1/ai/recommendations/:id/apply` | Apply recommendation |
| `POST` | `/api/v1/ai/recommendations/:id/preview` | Preview diff |
| `POST` | `/api/v1/ai/recommendations/:id/dismiss` | Dismiss |

---

## 🤖 AI Recommendations

The AI orchestrator pipeline:

1. Pulls last 30 days of campaign metrics from `fact_metrics_daily`
2. Builds a context snapshot: top spenders, high-ACoS campaigns (>30%), low-ROAS campaigns (<2x), zero-spend campaigns
3. Sends to Claude with a structured JSON-only system prompt
4. Parses 5–10 recommendations, each with:
   - `type`: `bid_increase | bid_decrease | budget_increase | budget_decrease | pause_campaign | enable_campaign | add_negative_keyword | change_bidding_strategy`
   - `title`, `rationale`, `expected_effect`, `risk_level`
   - `actions[]`: entity-level changes with exact field → value diffs
5. Saves to `ai_recommendations` with 7-day TTL

Recommendations are generated in the user's UI language (EN/RU/DE) via locale header.

---

## 🔄 Entity Sync

Each sync job processes 8 entity types per Amazon profile:

```
portfolios → campaigns → ad_groups → keywords
         → product_ads → targets (SP+SD)
         → negative_keywords → negative_targets (SP+SD)
```

Portfolios are synced first as campaigns may reference them. All SP v3 endpoints use versioned `Accept: application/vnd.sp*.v3+json` headers. SB/SD endpoints skip gracefully on 401/403/404.

---

## 📊 Metrics Pipeline

Amazon Reporting API v3 async flow:

```
POST /reporting/reports
  → Content-Type: application/vnd.createasyncreportrequest.v3+json
  → Poll GET /reporting/reports/{id} every 10s (max 10 min)
  → Download GZIP JSON from S3 presigned URL
  → Parse → upsert into fact_metrics_daily
```

Report types: `spCampaigns`, `spKeywords`, `spTargeting`, `spAdvertisedProduct`, `sdCampaigns`

60-day backfill splits date ranges into 31-day chunks (Amazon's daily report limit).

---

## 🛡 Security

- **Tokens**: LwA access + refresh tokens encrypted with AES-256-GCM before DB storage
- **Auth**: JWT with configurable secret, 7-day expiry
- **CSRF**: State parameter validation on OAuth callback
- **Rate limiting**: 300 req/min per IP on all `/api/` routes
- **Audit log**: Immutable (trigger prevents UPDATE/DELETE on `audit_events`)
- **CORS**: Restricted to `FRONTEND_URL` origin

---

## 🧑‍💻 Development

```bash
# Start with logs
docker compose up

# Backend logs only
docker logs adsflow_backend -f

# Watch for AI/reporting activity
docker logs adsflow_backend -f | grep -E "(AI|Report|Backfill|sync)"

# Connect to Postgres
docker exec -it adsflow_postgres psql -U adsflow -d adsflow

# Apply a new migration manually
docker exec adsflow_postgres psql -U adsflow -d adsflow \
  -f /docker-entrypoint-initdb.d/005_your_migration.sql

# Rebuild backend only
docker compose up --build -d backend
```

### Project Structure

```
adsflow/
├── backend/
│   └── src/
│       ├── app.js                  # Express bootstrap
│       ├── config/                 # logger, redis, encryption
│       ├── db/
│       │   ├── pool.js
│       │   └── migrations/         # 001–004 SQL migrations
│       ├── jobs/
│       │   ├── workers.js          # BullMQ workers (6 queues)
│       │   └── scheduler.js        # Cron jobs (5 schedules)
│       ├── middleware/
│       │   └── auth.js             # JWT + workspace resolver
│       ├── routes/                 # 14 Express routers
│       └── services/
│           ├── amazon/
│           │   ├── adsClient.js    # Rate-limited API client
│           │   ├── entities.js     # 8-type entity sync
│           │   ├── lwa.js          # OAuth token management
│           │   └── reporting.js    # Async report pipeline
│           └── ai/
│               └── orchestrator.js # Claude recommendations
├── frontend/
│   └── src/
│       ├── App.jsx                 # All pages (single-file SPA)
│       ├── components/             # LanguageSwitcher, SyncStatusToast
│       └── i18n/                   # en.js · ru.js · de.js
└── docker-compose.yml
```

<<<<<<< Updated upstream
## 🔑 Ключевые API endpoints

| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/auth/register` | Регистрация |
| POST | `/auth/login` | Вход |
| GET | `/connections/amazon/init` | Получить OAuth URL |
| POST | `/connections/amazon/callback` | Обработать callback с кодом |
| POST | `/connections/:id/profiles/attach` | Привязать профили к workspace |
| GET | `/campaigns` | Список кампаний с метриками |
| PATCH | `/campaigns/:id` | Изменить статус/бюджет |
| GET | `/metrics/summary` | KPI агрегация |
| GET | `/metrics/top-campaigns` | Топ кампании |
| POST | `/reports` | Запустить отчёт |
| GET | `/audit` | Лог изменений |

## 🔄 Roadmap

- [x] **Этап 1**: OAuth + Profiles + Entities sync + Campaigns table + Reports v3 + Audit
- [x] **Этап 2**: Bulk ops + Rule engine + Alerts + Keywords management
- [ ] **Этап 3**: AI Orchestrator + Recommendations + Preview/Apply
- [ ] **Этап 4**: Automated runs + DSP/AMC integration

## 🛡 Безопасность

- LwA tokens шифруются AES-256-GCM до записи в БД
- Refresh tokens никогда не передаются на frontend
- CSRF защита через state parameter в OAuth
- JWT с 7-дневным TTL
- Rate limiting на все публичные endpoints
- Audit log — append-only (триггер в PostgreSQL запрещает UPDATE/DELETE)
- RBAC проверки на каждом защищённом endpoint

=======
>>>>>>> Stashed changes
---

## 📄 License

MIT
