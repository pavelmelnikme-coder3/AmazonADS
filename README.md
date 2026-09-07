# AdsFlow — Amazon Ads Dashboard

Full-featured Amazon Ads management dashboard: AI-powered recommendations, automated rules engine (keywords + product targets + negative actions), advanced filters with saved presets, customizable analytics, BSR tracking, weekly P&L reporting, complete change history with rollback, and global sync progress bar. Search term analysis with harvest workflow (account / campaign / ad group levels). Full negative keywords management with inline edit, bulk operations, CSV export and copy-to-campaigns. Supports SP/SB/SD campaign types across NA/EU/FE regions.

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

**Safety:** `min_bid` / `max_bid` clamp bids; `max_budget` caps budget *growth* (never lowers).
`min_budget_utilization` (default 70, `0` disables) gates `adjust_budget_pct` — the campaign must
have spent that share of its daily budget on 2 of the last 7 days, otherwise the budget is not
what limits it and the raise is skipped as `budget_not_binding`. `reconcile_grace_runs`
(default 2) is how many consecutive runs must find a negative unjustified before it is released.

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

Changes **are** sent to Amazon: bid/state updates via `PUT /sp/keywords`, budget/state via the
per-type campaign endpoints, negatives via `POST /sp/negativeKeywords` and `/sp/negativeTargets`.
`services/amazon/writeback.js` owns all of it, and `routes/rules.js` tracks every call so a run
cannot report success for a change Amazon refused.

What to know before trusting a write-back:

- **Amazon's batch endpoints answer 207 Multi-Status** — the HTTP call succeeds while individual
  items are rejected in the body. Every writer inspects `<dataKey>.error[]`; a raw `put()`/`post()`
  whose result goes unchecked will silently report a refused change as applied. This has been the
  single most recurring defect in this codebase — see the 2026-08-10, 09-04 and 09-07 CHANGELOG
  entries.
- **The local row is written first and rolled back on refusal.** A rejected negative goes back to
  `archived` carrying Amazon's message; a rejection describing the input is treated as permanent so
  later runs report it as a skip instead of re-issuing a doomed write.
- **Amazon is the source of truth on the next sync.** A local state that never landed is corrected
  by the entity sync — provided the row carries a real Amazon id. Rows with a synthetic `rule-…` id
  are invisible to every sync, which is why a failed create must never leave one behind.

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

### UI / Design System — Sprint 1 + 2 ✅ Complete

**Sprint 1 (10/10 items):**
- [x] Lucide React icons, ACOS semantic colors, inline status toggle, hover-row actions
- [x] Last sync timestamp, tooltips (Tip component), readable audit events
- [x] Products empty state, Reports UX (presets + readable dates), Rule templates (6)
- [x] Rule preview (4-step wizard + dry-run), AND/OR condition toggle

**Sprint 2 (8/8 items):**
- [x] **S2-1** Keyword metrics columns — Clicks/Orders/ACOS/Spend, sortable
- [x] **S2-2** AND/OR toggle between rule conditions — amber OR button, live preview
- [x] **S2-3** Budget utilization bar — 3px color bar in Campaigns table budget column
- [x] **S2-4** Campaign drill-down slide panel — 520px right panel, keywords by spend
- [x] **S2-5** Dayparting in rules — day/hour picker → cron string, card badge
- [x] **S2-6** Onboarding checklist — 5 auto-detected steps, Zeigarnik progress bar
- [x] **S2-7** AI recommendation params — human-readable key:value pills
- [x] **S2-8** Target ACOS — Settings input + Overview KPI card indicator

**Sprint 3 (started 25 March 2026):**
- [x] **S3-1** Search Term Harvesting — `search_term_metrics` table, `GET /search-terms` (paginated+ACOS), add-keyword + add-negative endpoints, Keywords tab with stRecommendation() auto-classify + row tints + action buttons

### 📋 Roadmap
See [docs/ROADMAP.md](./docs/ROADMAP.md) for the full prioritized feature roadmap.
See [docs/UX_AUDIT.md](./docs/UX_AUDIT.md) for the complete UX audit with competitive analysis.

**Sprint 1 — ✅ COMPLETE (23 March 2026):**
All 10 items delivered. See [CHANGELOG.md](./CHANGELOG.md) for full details.

**Sprint 2 — ✅ COMPLETE (25 March 2026):**
All 8 items delivered. See [CHANGELOG.md](./CHANGELOG.md) for full details.

**Sprint 3 — Started (25 March 2026):**
1. **Search Term Harvesting** ⭐⭐ ✅ — `search_term_metrics` table, 3 API endpoints, Keywords tab with harvest/negate workflow
2. Rule execution history modal — full audit trail per rule
3. AI suggested prompts — blank textarea guidance (Pacvue Copilot pattern)
4. Negative keywords management — dedicated tab in Keywords section
5. TACoS metric — toggle ACOS ↕ TACoS on KPI card
6. Keyboard shortcuts — power user productivity
7. User-saved filters — enterprise PPC standard (Pacvue)
8. Column resize & visibility control

## 🚧 Known Issues / TODO

> Verified against the live deployment on 2026-09-07. Items that had been sitting here as "not
> implemented" for months — write-back, the `negativeKeywords/list` migration, SB keyword-level
> metrics — were all done long ago and have been removed.

**Deployment, not yet done**

- `NODE_ENV=development` on the production server. Express serves error stack traces in responses
  and skips production optimizations. Set it to `production`.
- Redis runs with no `requirepass`. Contained — it is not published to the host (only Postgres/Redis
  container ports, no `0.0.0.0` binding) and does not answer from outside — but unauthenticated all
  the same.

**Marketing email cannot send on this deployment**

- `provider.isConfigured()` is `false`: the Brevo adapter reads `MAIL_FROM_EMAIL` (falling back to
  `SES_FROM_EMAIL`), and only `BREVO_FROM_EMAIL` is set. `/campaigns/:id/send` and `/test` return 400.
- `{{ mirror }}` and `{{ unsubscribe }}` are **not merge tags** — `applyMergeTags` substitutes contact
  fields only, so both collapse to `href=""`. The B2B campaign already went to 1070 recipients with two
  dead links, and there is no mirror route at all. The compliance footer appended by
  `renderHtmlForContact` is separate and does carry an unsubscribe link — but with `APP_PUBLIC_URL`
  unset it is a host-less relative URL, which also makes the RFC 8058 `List-Unsubscribe` header invalid.
  `COMPANY_POSTAL_ADDRESS` is unset, so that footer carries no address either.

**Automation coverage**

- **Nothing raises bids.** The nine active rules pause keywords, add negatives, and adjust one budget.
  The two `raise_bid_pct` rules this section used to describe as "paused in production" no longer
  exist in the database at all.

**External limits**

- SP-API does not return root-category BSR (Amazon bug #2533).
- Lead Finder cannot complete a country-scale scan against the free public Overpass endpoint: it
  rate-limits **by IP quota**, refusing TCP connections (`ECONNREFUSED` with an empty message) once a
  few hundred queries have gone out. Mirrors do not help — `lz4`/`z` are the same cluster,
  `overpass.osm.jp` has an expired certificate, and `overpass.osm.ch` is a Switzerland-only extract.
  A run that gets refused now ends as `failed` with the reason rather than reporting `completed`.
  Regular country-wide rebuilds need a self-hosted or paid instance, or per-Bundesland runs.
- SB search-term reports before roughly 90 days back return `400` (Amazon report retention), so those
  backfill ranges are not retryable.
