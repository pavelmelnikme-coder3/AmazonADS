# AdsFlow — Amazon Ads Dashboard

Full-featured Amazon Ads management dashboard: AI-powered recommendations, automated rules engine (keywords + product targets + negative actions), advanced filters with saved presets, customizable analytics, BSR tracking, weekly P&L reporting, complete change history with rollback, and global sync progress bar. Supports SP/SB/SD campaign types across NA/EU/FE regions.

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
3. Select profiles → wait for sync (~1–3 min with optimized batch upserts)

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
│  campaigns · keywords · targets · negative_keywords             │
│  negative_targets · fact_metrics_daily (partitioned)            │
│  products · bsr_snapshots · sku_mapping                         │
│  rules · alert_configs · audit_events · ai_recommendations      │
│  ai_workspace_settings · users (settings JSONB)                 │
│  Redis 7 (BullMQ queues)                                        │
└─────────────────────────────────────────────────────────────────┘
```

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

> Keyword-level and target-level reports are required for the Rules Engine. The JOIN uses `amazon_id = k.amazon_keyword_id` or `amazon_id = t.amazon_target_id`.

---

## ⚡ Sync Performance

Entity sync is optimized with:
- **Batch DB upserts** in chunks of 500 rows (replaces per-row sequential queries)
- **Parallel SP/SB/SD fetch** via `Promise.allSettled`
- **Pre-loaded ID maps** (1 query per entity type instead of N lookups)
- **maxResults 500** for SP v3 pagination (was 100 → 5× fewer API pages)
- **Worker concurrency 5** (was 3)

Result: sync of 33,000+ keywords reduced from 3–5 min → ~30 seconds.

---

## 🔑 API Reference

### Auth & User
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/auth/register` | Register new user |
| POST | `/auth/login` | Login → JWT |
| GET  | `/auth/me` | Current user + settings |
| PATCH | `/auth/me` | Update user settings |

### Connections & Sync
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/connections` | List connections |
| GET  | `/connections/amazon/init` | Get OAuth URL |
| POST | `/connections/amazon/callback` | OAuth callback |
| PATCH | `/connections/:id/schedule` | Set sync schedule |
| POST | `/connections/:id/sync` | Manual sync (`{ mode: "quick" | "full" }`) |
| POST | `/connections/sync-all` | Sync all profiles (`{ mode: "quick" | "full" }`) |

### Campaigns & Keywords
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/campaigns` | List — filters: status, type, strategy, budgetMin/Max, spendMin/Max, acosMin/Max, roasMin/Max, ordersMin, clicksMin, noSales, hasMetrics, metricsDays |
| PATCH | `/campaigns/:id` | Update state/budget (+ audit event) |
| GET  | `/keywords` | List — filters: state, matchType, campaignType, bidMin/Max, spendMin/Max, acosMin/Max, clicksMin, ordersMin, noSales, hasClicks, metricsDays |
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
| GET  | `/rules/targets` | Product targets for scope selector |

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
| PATCH | `/ai/settings` | Save settings |
| POST | `/ai/analyze` | Run analysis |
| GET  | `/ai/recommendations` | List pending |
| POST | `/ai/recommendations/:id/apply` | Apply |
| POST | `/ai/recommendations/:id/dismiss` | Dismiss |

### Change History
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/audit` | List — filters: action, entityName, source, actorId, dateFrom, dateTo, rollbackable |
| POST | `/audit/:id/rollback` | Rollback a change |

### Jobs
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET  | `/jobs` | Queue status |
| GET  | `/jobs/progress` | Active job progress (for progress bar) |
| POST | `/jobs/backfill-metrics` | Trigger backfill |

---

## 📊 Pages

### Overview — Customizable Dashboard
- **16 widgets** — 9 KPI + 2 charts + 2 tables + misc
- **Sparklines** on all 9 KPI cards (per-day trend, each metric its own color)
- **Edit mode** — add/remove/reorder/resize widgets, saved to DB via PATCH /auth/me
- **Date range** — 7d / 14d / 30d / 90d + custom date picker
- **Sync button** — split button: select Quick or Full mode first, then run; shows active mode label
- **Global progress bar** — bottom-right corner, polls `/jobs/progress` every 3s, visible on all pages, disappears when done, fires "Синхронизация закончена ✓" toast on completion

### Campaigns & Keywords — Advanced Filters

Both pages feature a slide-in filter panel with saved presets:

**Campaigns filters:**
- Status (Enabled/Paused/Archived), Type (SP/SB/SD)
- Budget range (€), Metrics period (yesterday/7/14/30/60/90d)
- Spend range, ACOS range, ROAS range
- Min orders, Min clicks
- Toggles: "No orders", "Has activity"

**Keywords filters:**
- State, Match type (Exact/Phrase/Broad), Campaign type
- Bid range (€), Spend range, ACOS range
- Min clicks, Min orders
- Toggles: "No orders", "Has clicks"

**Saved presets:** name any filter combination and restore it with one click. Persisted to localStorage.  
**Active count badge** shown on the ⊞ Filters button.

### Rules Engine

Full automation covering all patterns used in production (Intentwise-compatible logic):

**Entity types:**
- `keyword` — SP/SB/SD keywords
- `product_target` — Product/Audience targeting

**Actions:**
| Action | Description |
|--------|-------------|
| `pause_keyword` | Pause keyword |
| `enable_keyword` | Enable keyword |
| `adjust_bid_pct` | Change bid ±% (positive=increase, negative=decrease) |
| `set_bid` | Set fixed bid |
| `pause_target` | Pause product/audience target |
| `enable_target` | Enable product/audience target |
| `adjust_target_bid_pct` | Change target bid ±% |
| `add_negative_keyword` | Add as negative keyword (Exact / Phrase / Both) |
| `add_negative_target` | Add as negative product target |

**Conditions (metric):** clicks · spend · orders · acos · roas · impressions · ctr · cpc · **bid** (threshold)

**Scope filters:**
- Entity type (keyword / product_target)
- Period: yesterday / 7 / 14 / 30 / 60 / 90 days
- Campaign type, Match type, Campaign multi-select, Ad group multi-select
- **Campaign name contains** — comma-separated substring filter (e.g. "CAT, DEF, PTC")
- **Targeting type** — product / views / audience / auto

**Safety limits:** min bid / max bid  
**Dry-run preview** — see what would change without applying  
**Audit events** written for every entity changed

**Production rules logic (analyst patterns):**
```
# Bid down -10% — yesterday, clicks ≥ 6, orders = 0
scope: { entity_type: "keyword", period_days: 1 }
conditions: [{ metric: "clicks", op: "gte", value: 6 }, { metric: "orders", op: "eq", value: 0 }]
actions: [{ type: "adjust_bid_pct", value: "-10" }]

# Add as negative exact — 30d, clicks ≥ 11, orders = 0
scope: { entity_type: "keyword", period_days: 30 }
conditions: [{ metric: "clicks", op: "gte", value: 11 }, { metric: "orders", op: "eq", value: 0 }]
actions: [{ type: "add_negative_keyword", value: "exact" }]

# Pause product target — 30d, clicks ≥ 9, orders = 0, CAT campaigns only
scope: { entity_type: "product_target", period_days: 30, campaign_name_contains: "CAT" }
conditions: [{ metric: "clicks", op: "gte", value: 9 }, { metric: "orders", op: "eq", value: 0 }]
actions: [{ type: "pause_target" }]

# Bid down -10% — bid > 1€ AND clicks > 3 AND orders = 0 / 60d
scope: { entity_type: "keyword", period_days: 60 }
conditions: [{ metric: "bid", op: "gt", value: 1 }, { metric: "clicks", op: "gt", value: 3 }, { metric: "orders", op: "eq", value: 0 }]
actions: [{ type: "adjust_bid_pct", value: "-10" }]
```

### AI Assistant
- Claude Sonnet via Anthropic API
- Custom prompt + scope filter + business context (target ACOS/ROAS/margin/budget/notes)
- Recommendations with risk levels and structured actions

### Analytics Report
- XLSX via `exceljs` (streaming), 3 sheets with Excel P&L formulas
- Per-ASIN cost config (COGS, shipping, fees, VAT, Google/FB)

### Change History (Audit Log)
- Append-only log: keyword bids/state, campaign updates, AI recommendations, rule executions
- **Filters:** action · entity name · source · user · date range · rollbackable-only
- **Sort** by any column with direction indicator
- **Diff column:** `field: before → after` with color coding
- **Rollback:** restore previous value + writes rollback audit event

---

## ⚙ Rules Engine DSL

**Rule object:**
```json
{
  "name": "SP-Key / Down bid 10% / Click >3, bid>1, Or 0 / 60d",
  "conditions": [
    { "metric": "bid",    "op": "gt",  "value": 1 },
    { "metric": "clicks", "op": "gt",  "value": 3 },
    { "metric": "orders", "op": "eq",  "value": 0 }
  ],
  "actions": [
    { "type": "adjust_bid_pct", "value": "-10" }
  ],
  "scope": {
    "entity_type": "keyword",
    "period_days": 60,
    "campaign_type": "sponsoredProducts",
    "match_types": ["exact", "phrase", "broad"],
    "campaign_name_contains": "SP",
    "campaign_ids": [],
    "ad_group_ids": []
  },
  "safety": { "min_bid": 0.02, "max_bid": 50 },
  "dry_run": false,
  "is_active": true
}
```

**Operators:** `gt` `gte` `lt` `lte` `eq` `neq`  
**Bid condition:** metric `"bid"` → applied as SQL WHERE on `k.bid` / `t.bid` directly  
**Period:** `period_days: 1` = yesterday only; otherwise last N days

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
- Pagination via `nextToken`, maxResults=500

---

## ⚠️ Write-Back to Amazon (Important)

**Current limitation:** All changes (bid updates, pauses, negative keyword inserts) apply to the **local database only** — they are NOT sent to Amazon Ads API. Changes will be overwritten on the next entity sync.

Planned: write-back via `PUT /sp/keywords`, `PUT /sp/campaigns`, `POST /sp/negativeKeywords`

---

## 🔒 Security

- LwA tokens encrypted with AES-256-GCM in DB
- JWT with 7-day TTL
- Audit log is append-only (PostgreSQL trigger)
- All modals via `ReactDOM.createPortal` — always full-viewport, never clipped

---

## 👥 RBAC

`owner` > `admin` > `media_buyer` / `ai_operator` / `analyst` > `read_only`

---

## 🔧 Debugging

```bash
# Rebuild backend after code changes
docker compose build --no-cache backend && docker compose up -d backend

# Check entity_type distribution in metrics
docker exec adsflow_postgres psql -U adsflow -d adsflow -c \
  "SELECT entity_type, COUNT(*), MAX(date) FROM fact_metrics_daily GROUP BY entity_type;"

# Monitor pipeline
docker compose logs backend -f | grep -i "report\|keyword\|backfill"

# Manual backfill
curl -X POST http://localhost:3000/api/v1/jobs/backfill-metrics \
  -H "Authorization: Bearer TOKEN" -H "x-workspace-id: WID" \
  -H "Content-Type: application/json" \
  -d '{"dateFrom":"2026-01-01","dateTo":"2026-03-17"}'
```

> Always use port 3000 (Vite proxy), not 4000 directly.

---

## ✅ Feature Status

### Core
- [x] Auth — JWT, 6-role RBAC
- [x] Amazon OAuth LwA, auto-refresh, multi-region (NA/EU/FE)
- [x] Entity sync — SP v3 POST /list, SB v4, SD
- [x] **10× faster entity sync** — batch upserts, parallel fetch, maxResults 500
- [x] Reporting API v3 — campaign + keyword + target + advertised_product levels
- [x] BullMQ job queues · i18n EN/RU/DE · Dark theme
- [x] All modals via `ReactDOM.createPortal`

### Overview
- [x] Sparklines on all 9 KPI cards
- [x] Custom date range picker
- [x] 16-widget customizable dashboard with persistence
- [x] **Sync button** — select Quick/Full mode, label updates, 2s "Synced" flash
- [x] **Global progress bar** — bottom-right, all pages, completion toast

### Campaigns & Keywords — Advanced Filters
- [x] **Filter panel** (slide-in drawer) — range, select, toggle, multiselect fields
- [x] **Saved presets** — named filter sets, localStorage persistence
- [x] **Active count badge** on filter button
- [x] **Metrics period selector** — yesterday/7/14/30/60/90d
- [x] Filter persistence across page reloads

### Rules Engine
- [x] **Entity type selector** — keyword / product_target
- [x] **Configurable period** — yesterday / 7 / 14 / 30 / 60 / 90 days
- [x] **Bid threshold condition** — `metric: "bid"` applied as SQL WHERE
- [x] **Campaign name filter** — comma-separated ILIKE
- [x] **Targeting type scope** — product / views / audience / auto
- [x] **5 new actions:** pause_target, enable_target, adjust_target_bid_pct, add_negative_keyword, add_negative_target
- [x] Negative keyword deduplication guard
- [x] Negative target deduplication guard
- [x] Entity counts in result (keywords + targets evaluated)
- [x] Rule cards show entity type + period badges

### Analytics Report
- [x] XLSX via `exceljs`, 3 sheets, Excel P&L formulas, streaming response

### AI Assistant
- [x] Claude Sonnet integration, business context, custom prompt

### Change History
- [x] Append-only audit with rollback, filters, sort, diff display

### UI / Design System
- [x] **Lucide React icons** — all unicode glyphs replaced with SVG (strokeWidth 1.75, consistent sizing)
- [x] **Rule creation wizard** — 3-step flow: Basics → Conditions → Actions
- [x] **Live rule preview** — IF/THEN sentence updates reactively as user edits
- [x] **Condition row layout** — metric/operator/value flex proportions fixed
- [x] **Unit suffixes** — €, %, × appear inline after condition value input
- [x] **Campaign search** in rule scope — filters 40+ campaign checkbox list in real time

### 📋 Roadmap
See [docs/ROADMAP.md](./docs/ROADMAP.md) for the full prioritized feature roadmap.
See [docs/UX_AUDIT.md](./docs/UX_AUDIT.md) for the complete UX audit with competitive analysis.

**Sprint 1 priorities (quick wins):**
1. Rule templates (Pacvue/Scale Insights pattern)
2. Rule preview — object count before saving
3. ACOS color coding in all tables
4. Inline status toggle (click status dot to change)
5. Hover-row actions (hide Edit button until hover)

**Critical missing features vs competitors:**
- Search Term Harvesting (present in Pacvue, Helium10, Adbrew, Intentwise)
- Dayparting / hourly scheduling in rules
- Write-back to Amazon API (currently local DB only)

## 🚧 Known Issues / TODO

- `negativeKeywords` entity sync — needs migration to `POST /sp/negativeKeywords/list`
- SP-API root category BSR not returned (Amazon bug #2533)
- **Write-back to Amazon not implemented** — all changes apply to local DB only
- SB keyword-level reports excluded (Reporting API v3 in preview for SB)
- Rules engine "yesterday" period: both startDate and endDate = yesterday
- Two bid-increase rules (PT-Asins/SP-Key) are in Paused state in production — raise_bid_pct not yet scheduled automatically
