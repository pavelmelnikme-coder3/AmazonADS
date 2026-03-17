# AdsFlow — Amazon Ads Dashboard

Full-featured Amazon Ads management dashboard: AI-powered recommendations, automated keyword rules, customizable analytics, BSR tracking, weekly P&L reporting, and complete change history with rollback. Supports SP/SB/SD campaign types across NA/EU/FE regions.

---

## ⚡ Quick Start

### 1. Get Amazon LwA Credentials

1. Go to https://developer.amazon.com/apps-and-games/console/app/list
2. Click **Create a New Security Profile**
3. Fill in: Profile Name, Description, Privacy URL
4. Go to **Web Settings → Allowed Return URLs** and add `http://localhost:3000/connect/amazon/callback`
5. Copy **Client ID** and **Client Secret**
6. Request Amazon Advertising API access: https://advertising.amazon.com/API/docs/en-us/onboarding/overview

### 2. Configure Environment

```bash
cp .env.example .env
```

Fill in `.env`:
```env
# ── Amazon Ads API ─────────────────────────────────────────────────────────────
AMAZON_CLIENT_ID=amzn1.application-oa2-client.XXXX
AMAZON_CLIENT_SECRET=your_secret_here
AMAZON_REDIRECT_URI=http://localhost:3000/connect/amazon/callback
AMAZON_ADS_API_URL=https://advertising-api.amazon.com
AMAZON_ADS_API_EU_URL=https://advertising-api-eu.amazon.com
AMAZON_ADS_API_FE_URL=https://advertising-api-fe.amazon.com

# ── App Security ───────────────────────────────────────────────────────────────
JWT_SECRET=your_jwt_secret_here
ENCRYPTION_KEY=64_char_hex_string_here
POSTGRES_PASSWORD=your_db_password

# ── AI (Anthropic Claude) ──────────────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-...

# ── SP-API (optional — required for BSR tracking) ─────────────────────────────
SP_API_CLIENT_ID=amzn1.application-oa2-client.XXXX
SP_API_CLIENT_SECRET=your_sp_api_secret
SP_API_REFRESH_TOKEN=Atzr|...
SP_API_URL_EU=https://sellingpartnerapi-eu.amazon.com
```

### 3. Start

```bash
docker compose up -d
docker compose logs -f backend
curl http://localhost:4000/health
```

### 4. Open the App

- **Frontend**: http://localhost:3000
- **Backend API**: http://localhost:4000/api/v1

### 5. Connect Amazon

1. Register → Connections → Connect Amazon Ads Account
2. Authorize on amazon.com
3. Select profiles → wait for sync (~3–10 min)

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                 Frontend (React 18 + Vite)                       │
│  Overview · Campaigns · Keywords · Products · Reports            │
│  Analytics · Rules · Alerts · AI Assistant · Audit · Connections │
│  i18n: EN / RU / DE   |   Dark theme                            │
└─────────────────────────────┬───────────────────────────────────┘
                              │ REST /api/v1
┌─────────────────────────────▼───────────────────────────────────┐
│                  Backend (Node.js / Express)                      │
│  Auth/RBAC (JWT) · Amazon OAuth (LwA) · Ads API Client           │
│  SP-API Catalog Items · SP v3 POST /list · SB v4 · SD            │
│  Reporting API v3 (async pipeline) · Audit logging               │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  BullMQ Workers (Redis)                                   │  │
│  │  entity-sync · report-pipeline · rule-engine              │  │
│  │  ai-analysis · metrics-backfill · bsr-sync (6h)           │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────┬───────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────────┐
│  PostgreSQL 16                                                   │
│  campaigns · keywords · targets · fact_metrics_daily             │
│  products · bsr_snapshots · sku_mapping                         │
│  rules · alert_configs · audit_events · ai_recommendations      │
│  ai_workspace_settings · users (settings JSONB)                 │
│  Redis 7 (BullMQ queues)                                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 📁 Project Structure

```
adsflow/
├── docker-compose.yml
├── .env.example
├── backend/src/
│   ├── app.js
│   ├── config/           logger · redis · encryption
│   ├── db/
│   │   ├── pool.js
│   │   └── migrations/   001_initial.sql · 002_add_region.sql
│   ├── middleware/auth.js
│   ├── services/amazon/
│   │   ├── lwa.js                 OAuth + token refresh
│   │   ├── adsClient.js           Ads API HTTP client
│   │   ├── spClient.js            SP-API client (BSR)
│   │   ├── entities.js            SP v3 + SB v4 + SD entity sync
│   │   └── reporting.js           Reporting API v3 async pipeline
│   ├── jobs/
│   │   ├── workers.js             BullMQ workers
│   │   └── scheduler.js           Cron jobs
│   └── routes/
│       ├── auth.js                Login · profile · settings
│       ├── connections.js         OAuth · schedule · sync
│       ├── campaigns.js           List · update · bulk · audit
│       ├── keywords.js            List · bulk bid/state · audit
│       ├── metrics.js             Summary · top-campaigns · by-type
│       ├── reports.js             Report requests
│       ├── rules.js               Rule Engine CRUD + execute + audit
│       ├── alerts.js              Alert configs + instances
│       ├── audit.js               Change history + rollback
│       ├── products.js            BSR tracking (SP-API)
│       ├── analyticsReport.js     XLSX download + SKU cost config
│       ├── ai.js                  Claude Sonnet analysis + settings
│       └── jobs.js                Queue status + manual backfill
└── frontend/src/
    ├── App.jsx                    Full SPA — all pages
    └── i18n.js                    EN / RU / DE strings
```

---

## 🔑 API Reference

### Auth & User
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/register` | Register new user |
| POST | `/auth/login` | Login → JWT |
| GET  | `/auth/me` | Current user + settings |
| PATCH | `/auth/me` | Update user settings |

### Campaigns & Keywords
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/campaigns` | List with sort, filters, pagination |
| PATCH | `/campaigns/:id` | Update state / budget (+ audit event) |
| GET  | `/keywords` | List with sort, filters, pagination |
| PATCH | `/keywords/bulk` | Bulk bid/state update (+ audit events) |

### Metrics
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/metrics/summary` | KPI totals + deltas + 9-metric daily trend |
| GET | `/metrics/top-campaigns` | Top campaigns by spend |
| GET | `/metrics/by-type` | SP / SB / SD breakdown |

### Rules Engine
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/rules` | List (paginated) |
| POST | `/rules` | Create |
| PATCH | `/rules/:id` | Update |
| DELETE | `/rules/:id` | Delete |
| POST | `/rules/:id/run` | Execute (`{ dry_run: true/false }`) |
| GET  | `/rules/campaigns` | Campaigns for scope selector |
| GET  | `/rules/ad-groups` | Ad groups for scope selector |

### Analytics Report
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/analytics-report/download` | Download XLSX (`?startDate=&endDate=`) |
| POST | `/analytics-report/config` | Upsert SKU cost config |
| POST | `/analytics-report/config/bulk` | Bulk import |

### AI Assistant
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/ai/settings` | Get business context |
| PATCH | `/ai/settings` | Save target ACOS/ROAS/margin/budget/notes |
| POST | `/ai/analyze` | Run analysis (custom prompt + scope + date range) |
| GET  | `/ai/recommendations` | List pending recommendations |
| POST | `/ai/recommendations/:id/apply` | Apply recommendation |
| POST | `/ai/recommendations/:id/dismiss` | Dismiss recommendation |

### Change History
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/audit` | List events — filters: action, entityName, source, actorId, dateFrom, dateTo, rollbackable |
| POST | `/audit/:id/rollback` | Rollback a change (keyword bid/state or campaign update) |

### Products & BSR
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/products` | List with latest BSR |
| POST | `/products` | Add ASIN |
| POST | `/products/:id/refresh` | Manual BSR refresh |
| GET  | `/products/:id/history` | BSR history |
| DELETE | `/products/:id` | Remove |

### Jobs
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/jobs` | Queue status |
| POST | `/jobs/backfill-metrics` | Trigger backfill (`{ dateFrom, dateTo }`) |

---

## 📊 Pages

### Overview — Customizable Dashboard
**16 widgets** (9 KPI + 2 charts + 2 tables + 3 misc), default 8.

- **Sparklines on all KPI cards** — mini trend chart per metric using 9 per-day fields
- **Edit mode (⊞ Customize):** add/remove, reorder, resize, reset — saved to DB via PATCH /auth/me
- **Date range:** 7d / 14d / 30d / 90d + custom date picker

### Products & BSR
- Add ASIN → instant SP-API fetch, rank badges linking to Amazon, BSR history chart
- Auto-sync every 6h, graceful degradation without SP-API credentials
- Note: SP-API does not return root category BSR (Amazon bug #2533)

### Analytics — Weekly P&L Report
XLSX with 3 sheets: per-SKU detail (32 cols with Excel formulas), summary by group, ASIN reference.
Cost config per ASIN: COGS, shipping, fees, VAT, Google/FB spend.

### AI Assistant
- Claude Sonnet called directly with metrics data (campaigns + keywords)
- Business context (target ACOS/ROAS/margin/budget/notes) factored into every analysis
- Custom prompt + scope filter + 7d/14d/30d date range
- Recommendations saved with type, rationale, risk level, actions

### Rules Engine
- Condition builder: any metric × operator × value, multiple AND conditions
- Actions: pause / enable / adjust bid% / set bid
- Scope: campaign type + match type + campaign/ad-group multi-select
- Safety limits (min/max bid), dry-run preview, result modal with per-keyword detail
- Each execution writes audit events

### Change History (Audit Log)
- Full change log: keyword bids/state, campaign updates, AI recommendations, rule executions
- **Filters:** action · entity name · source · user · date range · rollbackable-only
- **Sort** by any column with direction indicator
- **Diff column:** `field: before → after` with color coding
- **Rollback:** one click restores previous value, writes rollback audit event

---

## 📡 Metrics Pipeline

Reports fetched asynchronously from Amazon Reporting API v3:

| Type | Level | DB entity_type |
|------|-------|----------------|
| SP | campaign | campaign |
| SP | keyword | keyword |
| SP | target | target |
| SP | advertised_product | advertised_product |
| SD | campaign | campaign |

**Schedule:** daily at 06:00 UTC + 2-day rolling backfill at 06:30 UTC
**Manual trigger:** `POST /jobs/backfill-metrics { dateFrom, dateTo }`

> Keyword-level reports are required for the Rules Engine — conditions (clicks, orders, ACOS) are evaluated against `fact_metrics_daily WHERE entity_type = 'keyword'`.

---

## ⚠️ Amazon SP API v3 — Critical Notes

SP API v3 requires **POST /list** (not GET). GET returns 0 results silently.

```
POST /sp/campaigns/list    Content-Type: application/vnd.spCampaign.v3+json
POST /sp/adGroups/list     Content-Type: application/vnd.spAdGroup.v3+json
POST /sp/keywords/list     Content-Type: application/vnd.spKeyword.v3+json
```

- `state` in API responses is UPPERCASE → `.toLowerCase()` before storing
- `budget` → `c.dailyBudget ?? c.budget?.budget`
- Pagination via `nextToken`

---

## ⚠️ Write-Back to Amazon (Important)

**Current limitation:** Bid updates, keyword pauses, and campaign changes apply to the **local database only** — they are NOT sent to Amazon Ads API. Changes will be overwritten on the next entity sync.

Implementing write-back (`PUT /sp/keywords`, `PUT /sp/campaigns`) is a planned feature.

---

## 👥 RBAC

`owner` > `admin` > `media_buyer` / `ai_operator` / `analyst` > `read_only`

---

## 🔒 Security

- LwA tokens encrypted with AES-256-GCM in DB
- JWT with 7-day TTL
- Audit log is append-only (PostgreSQL trigger)
- All modals use `ReactDOM.createPortal` — render at `document.body` level

---

## 🔧 Debugging

```bash
# Rebuild backend after code changes
docker compose build --no-cache backend && docker compose up -d backend

# Env-only changes (no rebuild needed)
docker compose up -d backend

# Check metrics entity types
docker exec adsflow_postgres psql -U adsflow -d adsflow -c \
  "SELECT entity_type, COUNT(*), MAX(date) FROM fact_metrics_daily GROUP BY entity_type;"

# Monitor report pipeline
docker compose logs backend -f | grep -i "report\|keyword\|backfill"

# Direct API call (use port 3000, not 4000 — always through Vite proxy)
curl -H "Authorization: Bearer <token>" \
     -H "x-workspace-id: <wid>" \
     "http://localhost:3000/api/v1/metrics/summary?startDate=2026-03-01&endDate=2026-03-17"
```

---

## ✅ Feature Status

### Core
- [x] Auth — JWT, 6-role RBAC
- [x] Amazon OAuth LwA, auto-refresh, multi-region (NA/EU/FE)
- [x] Entity sync — SP v3 POST /list, SB v4, SD
- [x] Reporting API v3 — campaign + keyword + target + advertised_product levels
- [x] BullMQ job queues (Redis)
- [x] i18n — EN / RU / DE · Dark theme
- [x] All modals via `ReactDOM.createPortal` — always full-viewport, never clipped

### Overview
- [x] Sparklines on all 9 KPI cards (per-day trend data)
- [x] Custom date range picker (7d/14d/30d/90d + inline inputs)
- [x] 16-widget customizable dashboard with persistence

### Products & BSR
- [x] SP-API Catalog Items client, `products` + `bsr_snapshots` tables
- [x] Products page: ASIN input, rank badges, BSR history bar chart
- [x] Auto BSR sync every 6h

### Analytics Report
- [x] XLSX via `exceljs` (streaming), 3 sheets with Excel P&L formulas
- [x] Per-ASIN cost config (COGS, shipping, fees, VAT, Google/FB)

### AI Assistant
- [x] Claude Sonnet via Anthropic API
- [x] Custom prompt + scope filter + business context settings
- [x] Recommendations with risk levels and structured actions

### Rules Engine
- [x] Full CRUD, condition/action/scope builder, safety limits
- [x] Dry-run preview and real execution with per-keyword result modal
- [x] Keyword-level metrics via `amazon_id = k.amazon_keyword_id` JOIN
- [x] Audit events written for every keyword changed

### Change History
- [x] Append-only audit log with `before_data`, `after_data`, `diff` JSONB
- [x] writeAudit integrated: keywords bulk, campaigns, rules, AI recommendations
- [x] Rollback for keyword bid/state and campaign updates
- [x] Filters, sort, diff display, rollback UI

## 🚧 Known Issues / TODO

- `negativeKeywords` — needs migration to `POST /sp/negativeKeywords/list`
- SP-API root category BSR not returned by API (Amazon bug #2533)
- **Write-back to Amazon not implemented** — changes apply to local DB only
- SB keyword-level reports excluded (v3 reporting in preview)
