# Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (React SPA)                                            │
│  Login → Connect → Overview → Campaigns → Keywords →           │
│  Search Terms → Products → KW Research → Rank Tracker →        │
│  Reports → Rules → Strategies → Alerts → AI → Audit            │
│                    i18n: EN / RU / DE                           │
└────────────────────────┬────────────────────────────────────────┘
                         │ REST API  /api/v1
                         │ HTTP + JWT Bearer token
┌────────────────────────▼────────────────────────────────────────┐
│  Backend (Express.js :4000)                                     │
│                                                                 │
│  ┌─────────────┐  ┌───────────────┐  ┌──────────────────────┐  │
│  │  Auth/RBAC  │  │ Amazon OAuth  │  │  Ads Control API     │  │
│  │  JWT 7d TTL │  │  LwA v2       │  │  SP / SB / SD        │  │
│  └─────────────┘  └───────┬───────┘  └──────────────────────┘  │
│                           │                                     │
│  ┌────────────────────────▼───────────────────────────────┐     │
│  │  BullMQ Workers (Redis queues)                         │     │
│  │  entity-sync │ report-pipeline │ rule-engine           │     │
│  │  rank-check  │ sp-sync         │ product-meta-sync     │     │
│  └────────────────────────────────────────────────────────┘     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────────┐
│  PostgreSQL  │  │    Redis     │  │  Amazon Ads API  │
│  (entities,  │  │  (queues,    │  │  advertising-    │
│   metrics,   │  │   cache)     │  │  api.amazon.com  │
│   audit)     │  └──────────────┘  └──────────────────┘
└──────────────┘
```

---

## Data Flow: Amazon Ads Sync

```
1. User clicks "Connect Amazon Account"
2. Backend generates OAuth URL (LwA) with state param (CSRF protection)
3. User authorizes on amazon.com
4. Amazon redirects to /connections/amazon/callback with code
5. Backend exchanges code for access_token + refresh_token
6. Tokens encrypted with AES-256-GCM, stored in amazon_connections table
7. BullMQ entity-sync job queued immediately
8. Worker fetches profiles → campaigns → ad groups → keywords → targets
9. All entities stored in PostgreSQL
10. Frontend polls /metrics/summary for KPI data
```

---

## Data Flow: Rule Engine

```
Cron scheduler (every hour or daily)
  → Queries all workspaces with active rules
  → Queues rule-engine job per workspace

BullMQ rule-engine worker:
  For each active rule:
    1. Evaluate conditions against current metrics
       - acos_gt: current ACoS > threshold?
       - spend_gt: today's spend > threshold?
       - ctr_lt: CTR < threshold?
       - impressions_lt: impressions < threshold?
    2. If ALL conditions met → execute actions:
       - pause_campaign: PATCH /campaigns/:id {status: 'paused'}
       - adjust_bid_pct: PATCH /keywords/bulk {bid_change_pct: N}
       - adjust_budget_pct: PATCH /campaigns/:id {budget: current * (1 + N/100)}
       - add_negative_keyword: POST /keywords (negative)
    3. Log execution to audit_log
    4. If dry_run=true: log only, no API calls
```

---

## Authentication & Authorization

```
Request → requireAuth middleware
  → Extract Bearer token from Authorization header
  → Verify JWT signature with JWT_SECRET
  → Decode payload: { userId, orgId, role, workspaceId }
  → Attach to req.user

RBAC roles (least to most privileged):
  read_only_external → analyst → media_buyer → ai_operator → admin → owner

Route protection example:
  GET /campaigns  → requireAuth (any role)
  PATCH /campaigns/:id → requireAuth + requireRole('media_buyer')
  DELETE /connections/:id → requireAuth + requireRole('admin')
```

---

## Database Schema (key tables)

```sql
organizations     id, name, plan, created_at
users             id, org_id, email, password_hash, name, role, is_active
workspaces        id, org_id, name, amazon_connection_id
amazon_connections id, org_id, access_token_enc, refresh_token_enc, expires_at
profiles          id, connection_id, workspace_id, amazon_profile_id, marketplace
campaigns         id, workspace_id, profile_id, amazon_campaign_id, name, state, budget, type
ad_groups         id, campaign_id, amazon_ad_group_id, name, state, default_bid
keywords          id, ad_group_id, amazon_keyword_id, keyword_text, match_type, bid, state
report_requests   id, workspace_id, profile_id, campaign_type, report_type, date_start, date_end, status, error_message
reports           id, workspace_id, type, date_range, status, s3_url
rules             id, workspace_id, name, conditions(jsonb), actions(jsonb), schedule_type, is_active, dry_run
alert_configs     id, workspace_id, name, metric, operator, threshold, channels(jsonb), cooldown_hours, last_triggered_at
alert_instances   id, alert_config_id, triggered_at, metric_value, is_acknowledged
audit_logs        id, workspace_id, user_id, entity_type, entity_id, action, old_value, new_value, source
```

---

## Security Measures

| Threat | Mitigation |
|--------|-----------|
| Token theft | AES-256-GCM encryption at rest, tokens never sent to frontend |
| CSRF | `state` param in OAuth flow validated on callback |
| SQL injection | Parameterized queries only (`$1, $2`) |
| XSS | Helmet.js, React DOM escaping |
| Brute force | Rate limiting 300 req/min per IP; 5 failed logins/15 min on auth routes |
| Privilege escalation | RBAC checked on every protected route |
| Audit tampering | PostgreSQL trigger blocks UPDATE/DELETE on audit_logs |
| Secret leakage | `.env` in `.gitignore`, secrets never logged |

---

## Data Flow: Keyword Research

```
POST /keyword-research/discover
  Input: profileId, asins[], productTitle, locale, sources[]

  1. [amazon]       getAmazonKeywordRecommendations()
                    → Amazon Ads API v3 keyword recommendations for ASIN + ad group
  2. [jungle_scout] getKeywordsByAsin()
                    → Jungle Scout ASIN reverse-lookup (requires JUNGLE_SCOUT_API_KEY)
  3. [ai]           generateSeedKeywords()
                    → Claude AI generates seed keywords in target language
  4. [js + ai]      getKeywordsByKeyword() for top AI seeds (relevance ≥ 80)
                    → Jungle Scout expansion of best AI seeds
  5. scoreAndFilterKeywords()
                    → Claude AI scores all collected keywords (0–100), filters < 50

  Merge: keyword_text.lower deduplicated — higher relevance wins, sources concatenated
  Sort: amazon_ads source boosted +15 pts, then by relevance desc

POST /keyword-research/add-to-adgroup
  1. Dedup check: skip if keyword_text + match_type already in ad group
  2. INSERT into keywords table
  3. pushNewKeywords() → Amazon Ads API (non-blocking, errors logged only)
  4. writeAudit() → audit_events
```

## New Routes & Services (added April 2026)

| File | Purpose |
|------|---------|
| `routes/keywordResearch.js` | `/keyword-research/discover` + `/add-to-adgroup` |
| `services/ai/keywordResearch.js` | Claude AI seed generation + relevance scoring |
| `services/amazon/keywordRecommendations.js` | Amazon Ads API v3 keyword recommendations |

## 2026-04-27 changes (rule engine + reports)

### Rule engine extensions
- New scope `entity_type: "search_term"` — `executeRule()` aggregates `search_term_metrics` over the rule's period, joining `campaigns`/`ad_groups`/`amazon_profiles`. Synthetic `state='enabled'` so the existing `add_negative_keyword` handler accepts both keyword and search-term entities (`stm.query → keyword_text`).
- `recordSkip(entity, action, reason)` helper — every `continue` in the action loop now logs an entity to `skipped[]` with one of 5 reason keys: `already_paused | already_enabled | not_enabled | already_negative | wrong_entity_type`. Result payload gains `skipped_count` and `skipped[]`.
- `POST /rules/preview` — dry-run with body, never persists. Replaces wizard's prior `/rules/:id/run` call which silently used the saved (stale) DB version, ignoring unsaved form edits.
- Defense-in-depth validation: `Array.every([])` returns `true`, so an empty conditions array would have mass-affected every entity. Rejected at `executeRule()`, `POST /rules/preview`, and `PATCH /rules/:id`.

### Metrics endpoint changes
- `/metrics/summary` trend SQL wraps a `daily_revenue` CTE (sums `sp_orders.order_total_amount` per `purchase_date::date`) so each trend row carries `total_revenue` and per-day `tacos`. Frontend `Spark` ignores nulls and draws a gap on missing days.
- Headline TACoS uses an *aligned period*: spend and revenue are summed only over `[start, MAX(purchase_date)]`. Response gains `tacosPeriod {start, end, days, requestedDays}` so the UI can warn when coverage is partial.
- `purchase_date` filters cast to `::date` everywhere. Without the cast, a literal like `'2026-04-22'` was coerced to `timestamptz at midnight`, causing `BETWEEN` queries to lose 24 hours of data per boundary day.

### SP-API client hardening (`spClient.js`)
- `getOrders()` and `getFinancialEvents()` set `CreatedBefore`/`PostedBefore` to `now − 3 min` (clamped to ≤ `now − 2 min`). Amazon SP-API requires the timestamp be at least 2 minutes earlier than `now()` because of ingestion lag — without this, every daily orders sync was failing 400 InvalidInput.
- `_spRequest()` retries on 429 up to 3 times with `Retry-After` header (capped at 90 s).
- `syncOrders` first-time window reduced from 30 d to 7 d (Orders API rate is 0.0167 req/s).

### Products report export (`POST /products/export`)
- Uses `ExcelJS` (already a dep). Generates 1 or 2 sheets with frozen header rows.
- Sheet 1 aggregates 3 CTEs in a single query: `bsr` (min/max/avg + ARRAY_AGG for first/last), `latest` (DISTINCT ON for current rank), `ads` (joins `fact_metrics_daily` by `amazon_id = ASIN, entity_type='advertised_product'`).
- 18 whitelisted columns; unknown keys silently dropped (no SQL injection vector since we never interpolate column names).
- Numeric postgres values coerced to JS `Number` so XLSX number formats apply.
- OWASP CSV-injection mitigation: text starting with `= + - @ \t \r` is prefixed with `'`.

### Frontend additions
- `Spark` rebuilt with `dates`, `format`, `placement` props. Dots rendered as absolutely-positioned `<span>` over the SVG so they stay round under `preserveAspectRatio="none"`.
- `Tip` component gains `placement: 'top' | 'bottom'` and `style` props for use near modal edges.
- `ProductsPage`: `expandedId: string | null` migrated to `expandedIds: Set<string>`; master toggle button + batch fetch (chunks of 10) for "expand all".
- BSR + rank charts use the same `<polyline>` + dot + hover tooltip pattern (`BsrSparkline`-derived).

### Frontend code structure unchanged
- All edits stay inside the single-file `App.jsx` and 3 i18n files (EN/RU/DE) per existing convention.
- 28 new keys in `products.export*` namespace, 12 new keys for rule skip reasons, plus `tacosCoverage*` and `kpiAdSales*`.

## 2026-05-05 changes (attribution window, rank-check fix, search-terms, UX)

### Metrics backfill attribution window (14 days)
- `scheduler.js` `metricsBackfillJob`: window extended from 2 days to **14 days**.
- Amazon attributes purchases to a click within 14 days of the click date and updates report rows retroactively. Re-fetching the last 14 days every night ensures late-attributed purchases land in the DB instead of freezing at `orders=0`.
- New log message: `"last 14 days, attribution window"`.

### Rank-check BullMQ jobId — day-scoped deduplication fix
- `workers.js` `queueRankCheck()` and `queueProductMetaSync()`: static `jobId = rank_${workspaceId}` changed to `rank_${workspaceId}_${YYYYMMDD}`.
- Root cause: BullMQ's `jobId` dedup key persists even after `removeOnComplete`, so a static ID caused every subsequent same-day invocation to be silently dropped (job already seen). Day-scoped IDs allow one execution per workspace per calendar day.

### Search Terms — new filter and response fields
- `routes/searchTerms.js` GET `/search-terms`:
  - New query param `adGroupId` — filters to a single ad group (used by the Search Terms tab inside `CampaignDetailModal`).
  - New response fields: `campaign_type` (`SP`/`SB`/`SD`) and `marketplace_id` — sourced from a LEFT JOIN on `amazon_profiles`.
  - Both fields added to the GROUP BY clause to avoid aggregation conflicts.

### Search Terms tab in CampaignDetailModal
- `App.jsx`: new `SearchTermsTab` component renders inside the campaign drill-down modal alongside existing Keywords and Targets tabs.
- Fetches `GET /search-terms?campaignId=…&adGroupId=…` on tab open; shows sortable table with query, impressions, clicks, spend, orders, ACoS, match type.
- i18n keys: `campaigns.detail.searchTerms` / `campaigns.detail.noSearchTerms` in all 3 locales.

### Drill-down links on Search Terms page
- Each row in the Search Terms page now has:
  - An internal link (campaign name) → deep-links to Campaigns page with that campaign pre-searched.
  - An ExternalLink icon button → opens the campaign in the Amazon Ads console (region-aware URL via `amazonAdsCampaignUrl(term)`).

### BSR hover sparkline — gap fix
- `App.jsx` `BsrHoverChart`: tooltip `bottom` changed from `calc(100% + 6px)` to `100%` (removes 6px gap).
- Added 120 ms close timer + `bsrHoverCloseTimer` ref; `onMouseEnter`/`onMouseLeave` on tooltip div itself so the pointer can travel from badge into tooltip without it closing.

### Race condition fix — pending search auto-apply
- Root cause: `useSavedFilters` initializes from `localStorage` on first render; a `useEffect` that wrote to `localStorage` ran *after* the hook had already captured the stale value.
- Fix: `useMemo([], ...)` block (intentionally run once, before hook init) migrates the pending search from `sessionStorage` to `localStorage` synchronously, so `useSavedFilters` sees the correct value on its very first call.
- No `useEffect` cleanup needed — the memo is idempotent under React StrictMode (second call finds `sessionStorage` already empty).
