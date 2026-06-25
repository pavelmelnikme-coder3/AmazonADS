# API Reference

Base URL: `http://localhost:4000/api/v1`  
All endpoints (except `/auth/*`) require: `Authorization: Bearer <jwt_token>`

---

## Authentication

### POST /auth/register
Register a new organization and owner user.
```json
// Request
{ "email": "user@example.com", "password": "min8chars", "name": "Pavel", "orgName": "West&East" }

// Response 201
{ "token": "eyJ...", "user": { "id": 1, "email": "...", "role": "owner" } }
```

### POST /auth/login
```json
// Request
{ "email": "user@example.com", "password": "..." }

// Response 200
{ "token": "eyJ...", "user": { "id": 1, "role": "owner" } }
```

---

## Amazon Connections

### GET /connections/amazon/init
Returns the Amazon OAuth URL to redirect the user to.
```json
{ "url": "https://www.amazon.com/ap/oa?..." }
```

### POST /connections/amazon/callback
Exchange OAuth code for tokens and start initial sync.
```json
// Request
{ "code": "ANB...", "state": "csrf_token" }
// Response 200
{ "connection": { "id": 1, "status": "connected" } }
```

### POST /connections/:id/profiles/attach
Attach Amazon profiles to a workspace after OAuth.
```json
// Request
{ "profileIds": [12345, 67890], "workspaceId": 1 }
```

### DELETE /connections/:id
Disconnect Amazon account (destroys tokens, stops sync jobs).

---

## Campaigns

### GET /campaigns
List campaigns with current metrics.
```
Query: ?status=enabled&type=sponsoredProducts&search=brand&page=1&limit=50
```
```json
// Response
{ "campaigns": [...], "total": 42 }
```

### PATCH /campaigns/:id
Update campaign status or budget.
```json
{ "state": "paused" }
{ "dailyBudget": 50.00 }
```

---

## Search Terms *(updated 2026-05-05)*

### GET /search-terms
Aggregated search-term metrics for the workspace, grouped by `(query, campaign, ad_group, match_type)`.

```
Query:
  ?campaignId=uuid        — filter to one campaign
  ?adGroupId=uuid         — filter to one ad group (new 2026-05-05)
  ?portfolioIds=1,2       — filter by portfolio
  ?search=keyword         — text search on query
  ?minClicks=N            — HAVING clicks >= N
  ?minSpend=N             — HAVING spend >= N
  ?hasOrders=1            — HAVING orders > 0
  ?noOrders=1             — HAVING orders = 0
  ?page=1&limit=50
  ?sortBy=spend&sortDir=desc
```

```json
// Response
{
  "terms": [
    {
      "id": "123",
      "query": "footrest ergonomic",
      "campaign_id": "uuid",
      "campaign_name": "SP - Footrest Auto",
      "campaign_type": "SP",
      "marketplace_id": "A1PA6795UKMFR9",
      "ad_group_id": "uuid",
      "ad_group_name": "Auto Targets",
      "keyword_text": null,
      "match_type": "broad",
      "impressions": 4820,
      "clicks": 88,
      "spend": "43.12",
      "orders": 3,
      "sales": "167.97",
      "acos": "25.67",
      "day_rows": 13
    }
  ],
  "total": 287
}
```

**Notes:**
- `campaign_type` and `marketplace_id` were added 2026-05-05; older rows without a joined profile will have `null`.
- `day_rows` = count of underlying daily metric rows merged into this aggregate (useful for data-quality hints).
- `id` = `MIN(stm.id::text)` — stable React key for row selection; not a real PK.

---

## Keywords

### GET /keywords
```
Query: ?adGroupId=123&search=keyword&status=enabled
```

### PATCH /keywords/:id
Update bid or status.
```json
{ "bid": 1.25 }
{ "state": "paused" }
```

### PATCH /keywords/bulk
Bulk bid or status update.
```json
{ "ids": [1, 2, 3], "bid_change_pct": 10 }
{ "ids": [1, 2, 3], "state": "paused" }
```

---

## Bulk Operations

### POST /bulk/campaigns/status
```json
{ "ids": [1, 2, 3], "state": "paused" }
// state: "enabled" | "paused" | "archived"
```

### POST /bulk/campaigns/budget
```json
{ "ids": [1, 2], "change_pct": -10 }
// change_pct: -50 to +200, floor $1/day enforced
```

### POST /bulk/keywords/bid
```json
{ "ids": [10, 11], "change_pct": 15 }
{ "ids": [10, 11], "bid": 0.75 }
// Bid range: $0.02 – $1000 enforced
```

---

## Rules

### GET /rules
List all automation rules for the current workspace.

### POST /rules
Create a new rule.
```json
{
  "name": "Pause high ACoS campaigns",
  "conditions": [
    { "metric": "acos", "operator": "gt", "value": 40 }
  ],
  "actions": [
    { "type": "pause_campaign" }
  ],
  "schedule_type": "daily",
  "dry_run": false
}
```

### PUT /rules/:id
Update rule (same body as POST).

### DELETE /rules/:id

### PATCH /rules/:id/toggle
Toggle `is_active` on/off.
```json
{ "is_active": true }
```

### POST /rules/preview *(2026-04-27)*
Dry-run a rule using the **current form body** (not the saved DB version).
Used by the wizard so unsaved edits are reflected. Never persists — does
not write to `rules`, `rule_executions`, or `audit_events`.

Request body matches the rule shape:
```json
{
  "name": "optional",
  "conditions": [{ "op": "gte", "value": 5, "metric": "clicks" }],
  "actions":    [{ "type": "add_negative_keyword", "value": "exact" }],
  "scope":      { "entity_type": "search_term", "period_days": 30 },
  "safety":     { "min_bid": 0.02, "max_bid": 50 }
}
```

Response shape:
```json
{
  "matched_count":   42,
  "skipped_count":   8,
  "applied_count":   34,
  "total_evaluated": 7343,
  "applied":         [{ "entity_id": "...", "keyword_text": "...", "action": "...", "metrics": {...} }],
  "skipped":         [{ "entity_id": "...", "reason": "already_negative", "action": "...", "metrics": {...} }],
  "errors":          []
}
```

`scope.entity_type` accepts: `keyword` (default), `product_target`, `search_term` (new).

`skipped[*].reason` is one of: `already_paused`, `already_enabled`, `not_enabled`, `already_negative`, `wrong_entity_type`.

Validation: 400 if `conditions` or `actions` arrays are missing/empty.

---

## Alerts

### GET /alerts/configs
List alert configurations.

### POST /alerts/configs *(metrics + channels + window expanded 2026-05-29)*
```json
{
  "name": "High ACoS alert",
  "metric": "acos",
  "operator": "gt",
  "value": 35,
  "window_days": 7,
  "channels": { "in_app": true, "email": true, "email_to": "a@x.com, b@y.com" },
  "cooldown_hours": 24
}
```
BSR alert (per-product, latest snapshot — `asin` required, `window_days` ignored):
```json
{ "name": "BSR drop", "metric": "bsr", "operator": "gt", "value": 5000, "asin": "B0XXXXXXXX",
  "channels": { "in_app": true } }
```
Performance metrics (account aggregate over `window_days`, default 7, max 90):
`acos`, `roas`, `spend`, `sales`, `orders`, `clicks`, `impressions`, `ctr`, `cpc`, `cvr`.
Product metric: `bsr` (requires `asin`).  
Operators: `gt`, `lt`, `gte`, `lte`, plus percentage-change `drop_pct` / `rise_pct` *(2026-06-23)*.  
**Percentage-change operators** compare the current `window_days` window to the immediately-preceding equal-length window and fire when the metric **fell** (`drop_pct`) / **rose** (`rise_pct`) by ≥ `value` %. Perf metrics only (not BSR — point-in-time); `value` must be a positive percentage. Example — "ROAS dropped ≥30% over 7 days": `{ "metric": "roas", "operator": "drop_pct", "value": 30, "window_days": 7 }`.  
Sales/orders use **14-day attribution** (`sales_14d`/`orders_14d`) — matches Amazon's campaign-manager default and captures Sponsored Brands, which report conversions only on the 14d window *(2026-06-24)*.  
**Spend (`spend`) alerts** attach a per-campaign breakdown in `data.top_campaigns[]` — the top spenders over the window, each with `delta`/`delta_pct` vs the prior window and a health snapshot (`sales`, `orders`, `roas`, `acos`) — rendered in the instance (expandable) and the email *(2026-06-24)*.  
Channels: `in_app` (creates an alert instance), `email` (sends via Brevo SMTP — to `email_to` or, if empty, workspace owners & admins).

Product-movers alert *(per-product period-over-period, 2026-06-03)* — set `alert_type: "product_movers"`. Scans all active products and compares the last `window_days` vs the preceding equal window:
```json
{
  "name": "Product decline",
  "alert_type": "product_movers",
  "window_days": 7,
  "match": "any",
  "min_orders_prev": 3,
  "product_cooldown_days": 7,
  "escalation_pct": 25,
  "metrics": [
    { "metric": "bsr",    "direction": "up",   "change_pct": 30 },
    { "metric": "orders", "direction": "down", "change_pct": 30 }
  ],
  "channels": { "in_app": true, "email": true, "email_to": "a@x.com" },
  "cooldown_hours": 24
}
```
- `match`: `any` (OR) or `all` (AND, needs ≥2 conditions).
- `direction`: `up` (metric rose by ≥ `change_pct` %) or `down` (fell by ≥). For BSR, `up` = rank worsened.
- `metrics`: `bsr` (median rank); `orders`/`units`/`sales` = **total** (organic + ads, SP-API); `ad_orders`/`ad_sales` (ad-attributed); `spend`/`clicks`/`impressions`/`acos`/`ctr`/`cpc`/`cvr`/`roas` (ads). Ad metrics use 14-day attribution *(2026-06-24)*.
- `data.products[].causes[]` — data-derived likely causes shown per product: **stock** (`stock_out` only when every known source is 0; `fba_empty` / `erp_empty` when only one source is known to be empty — never synthesised from missing data), `price_up`, and `ad_cut`. Demand-side causes (`price_up`/`ad_cut`) are attached only when the product breached a **volume/rank** metric they can plausibly explain — never for a pure efficiency-ratio breach like ROAS, where e.g. cutting spend would *raise* ROAS *(2026-06-23/24)*.
- `min_orders_prev`: noise floor — order/total metrics evaluated only if the product had ≥ N orders in the prior window (BSR is never gated).
- `product_cooldown_days` *(default 7, `0` = off)*: per-ASIN dedup — a product already alerted within this many days is **suppressed** from new alerts to cut repeat noise. `escalation_pct` *(default 25)*: a suppressed product re-surfaces ("escalated") only if its worst single-metric move grew by ≥ this many points since the last alert; the cooldown auto-resets once it elapses.
- Fires one instance (`entity_type: "product_movers"`, breached products in `data.products[]`, plus `fresh_count` / `escalated_count` / `suppressed_count`) and one digest email. Products are split into **New** and **Worsening** with a `+N suppressed` line; if every flagged product is suppressed, nothing fires. Legacy `{ bsr_change_pct, orders_change_pct, require_both }` payloads are still accepted and converted.

### PUT /alerts/configs/:id
### DELETE /alerts/configs/:id
### PATCH /alerts/configs/:id/toggle

### POST /alerts/check *(2026-05-29)*
Evaluate all **active** alert configs for the workspace immediately (manual run / "Check now").
Returns `{ evaluated, triggered, emailed }`. Also runs hourly via cron (at :15). Respects each
config's `suppression_hours` cooldown; on breach writes an instance and fires the configured channels.

### GET /alerts
List triggered alert instances.

### PATCH /alerts/:id/acknowledge
Mark a triggered alert as acknowledged.

---

## Metrics

### GET /metrics/summary
KPI aggregation for the workspace.
```
Query: ?startDate=2026-04-20&endDate=2026-04-26
```
```json
{
  "totals": {
    "spend": "1772.37", "sales": "14389.65", "orders": 394,
    "clicks": 3884, "impressions": 592306,
    "ctr": "0.6557", "cpc": "0.4563",
    "acos": "12.32", "roas": "8.12",
    "tacos": "2.16",
    "tacosSource": "sp_api",
    "tacosPeriod": { "start": "2026-04-20", "end": "2026-04-26", "days": 7, "requestedDays": 7 },
    "totalRevenue": "82103.61",
    "totalOrders": 1526,
    "currency": "EUR",
    "currencyMixed": false
  },
  "deltas":  { "spend": "-12.0", "sales": "-9.5", "acos": "...", "roas": "..." },
  "trend":   [
    { "date": "2026-04-20", "spend": "286.93", "sales": "2385.98", "tacos": "3.28", "total_revenue": "8757.83", ... }
  ],
  "period":  { "start": "2026-04-20", "end": "2026-04-26" }
}
```

**Notes**:
- `tacos` is `null` and `tacosSource` is `null` when `sp_orders` is empty (SP-API not connected or sync incomplete) — UI shows "—".
- `tacosPeriod` reports the *aligned* range (start..MAX(purchase_date)) so spend and revenue cover the same days. When `days < requestedDays` the UI surfaces a coverage chip.
- `trend[*].tacos` and `trend[*].total_revenue` are per-day; days without revenue have `tacos: null` and the sparkline draws a gap.
- `sales`/`orders` are ad-attributed (`sales_14d`/`orders_14d`); `totalRevenue`/`totalOrders` are *total* (organic + ads) from `sp_orders`. The UI shows the total when available and relabels to "Ad sales/orders" otherwise.
- `currency` is the marketplace currency of the profiles that have spend in the period (dominant wins). `currencyMixed` is `true` when >1 currency contributed — totals then sum across currencies and the UI shows a "⚠ Mixed currencies" badge. *(2026-06-08)*

### GET /metrics/top-campaigns
```
Query: ?limit=10&orderBy=spend
```

---

## Products *(2026-04-27 — export added; 2026-06-08 — listing grouping + trends)*

### GET /products
List active products with the latest BSR snapshot per ASIN. Each row also carries
`parent_asin` (Amazon variation-family parent, from SP-API Catalog `relationships`;
the UI groups by `parent_asin || asin`) and true per-ASIN ad metrics `ad_spend_7d` /
`ad_sales_7d` (from `fact_metrics_daily entity_type='advertised_product'` — `ppc_7d`
and `profit_7d` now use this, replacing the old campaign-level spend that double-counted
across a listing's variations).

> Attribution: `ad_sales_7d` is the spend/sales over the last 7 **days** but uses the
> **14-day attribution window** (`sales_14d`) — the app-wide standard (campaigns, rules,
> analytics all use `sales_14d`), so per-product ACOS/ROAS match the other pages. The
> `_7d` suffix denotes the date range, not the attribution window. Per-product ad metrics
> are **SP-only** (Sponsored Brands/Display have no product-level report in the API).

### POST /products
Add a new ASIN to track (queues a meta + BSR fetch job).

### GET /products/timeseries?asins=A,B,C&start=&end=&compare=1
Daily aligned series for the listing/ASIN charts. Returns per-ASIN series (`by_asin`)
and a listing `aggregate` (BSR = min across children, money/counts summed, price averaged,
ACOS/TACOS/ROAS from summed components). Each point: `{date, bsr, price, orders, units,
revenue, ad_spend, ad_sales, acos, tacos, roas}` — `acos = spend/adSales`, `tacos =
spend/totalRevenue`, `roas = adSales/spend` (null when the denominator is 0). With
`compare=1` the queried range is widened to also return the immediately-preceding
equal-length window as `prev` (`{start, end, by_asin, aggregate}`), aligned by index.
Max 60 ASINs; default range = last 30 days. Lazy-loaded on expand.

### GET /products/period-orders?start=&end=
Total orders/units/revenue per ASIN over a date range (default last 30d), from
`sp_orders` (status ≠ Canceled). Powers "sort by orders for the period". Returns
`{start, end, by_asin: { ASIN: { orders, units, revenue } }}`.

### GET /products/:id/history?days=30
BSR snapshots for one product over the last N days.

### GET /products/notes?product_id=...
Notes pinned to the BSR chart. With no `product_id` returns ALL workspace
notes (used for bulk expand).

### POST /products/notes / DELETE /products/notes/:id
Note CRUD.

### POST /products/sync-meta
Trigger title/brand/image scrape for products without metadata.

### **POST /products/export** *(2026-04-27)*
Generate a multi-sheet XLSX report.

Request body:
```json
{
  "startDate":      "2026-04-20",
  "endDate":        "2026-04-26",
  "columns":        ["asin","title","best_rank","ad_spend","ad_acos"],
  "includeHistory": false
}
```

Response: `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`
binary blob with `Content-Disposition: attachment; filename="adsflow-products-{from}_{to}.xlsx"`.

**Sheet 1 "Products"** — one row per active ASIN. Available columns (whitelist):
`asin · title · brand · marketplace · best_rank · best_category · min_bsr · max_bsr · avg_bsr · first_bsr · last_bsr · bsr_change · snapshots · ad_spend · ad_sales · ad_orders · ad_clicks · ad_acos`

Aggregates over the requested date range:
- BSR fields from `bsr_snapshots` (`MIN`, `MAX`, `AVG`, `ARRAY_AGG ORDER BY captured_at` for first/last).
- `bsr_change` = `(last - first) / first * 100`.
- Ad fields from `fact_metrics_daily` filtered by `entity_type='advertised_product'` and `amazon_id = p.asin`.
- `snapshots` = count of BSR datapoints in the period.

**Sheet 2 "BSR History"** *(only when `includeHistory: true`)* — one row per
snapshot (ASIN, Title, Brand, Captured At, Best BSR, Category) sorted by ASIN
then DESC by capture time.

**Validation:**
- 400 if `startDate` or `endDate` not in `YYYY-MM-DD`.
- 400 if `startDate > endDate`.
- 400 if `columns` is provided but no whitelisted key matches.
- Unknown column keys silently dropped (whitelist).

**Hardening:**
- Numeric columns (NUMERIC from postgres) coerced to JS `Number` before XLSX cell creation so number formats apply.
- OWASP CSV-injection mitigation: text cells starting with `= + - @ \t \r` are prefixed with `'`.

### DELETE /products/:id
Soft-delete (sets `is_active = false`).

---

## Reports

### POST /reports
Queue a report generation job.
```json
{
  "type": "campaigns",
  "dateFrom": "2026-03-01",
  "dateTo": "2026-03-06",
  "granularity": "daily"
}
```

### GET /reports
List generated reports.

### GET /reports/:id/download
Download report CSV/JSON.

---

## Audit Log

### GET /audit
```
Query: ?entityType=campaign&action=status_change&page=1&limit=50
```
```json
{
  "entries": [
    {
      "id": 1,
      "userId": 1,
      "userName": "Pavel",
      "entityType": "campaign",
      "entityId": "AMZ_123",
      "action": "status_change",
      "oldValue": "enabled",
      "newValue": "paused",
      "source": "rule_engine",
      "createdAt": "2026-03-06T14:00:00Z"
    }
  ],
  "total": 150
}
```

---

## Keyword Research

### POST /keyword-research/discover
Discover keywords from multiple sources for a given product.
```json
// Request
{
  "profileId": "uuid",
  "asins": ["B08XXXXXX"],
  "productTitle": "Stainless Steel Water Bottle 1L",
  "locale": "de",
  "sources": ["amazon", "ai", "jungle_scout"]
}

// Response 200
{
  "keywords": [
    {
      "keyword_text": "Edelstahl Trinkflasche",
      "source": "amazon_ads+ai_generated",
      "match_type": "broad",
      "suggested_match_types": ["broad", "phrase"],
      "relevance_score": 92,
      "monthly_search_volume": 18000,
      "bid_suggested": 0.45
    }
  ],
  "total": 48,
  "sources_used": ["amazon_ads", "ai_generated"],
  "product_title": "Stainless Steel Water Bottle 1L",
  "jungle_scout_available": false
}
```
Notes *(2026-06-22)*: `sources` drives which providers run; **AI scoring runs only when `"ai"` is in `sources`** (no billable Claude calls otherwise). Jungle Scout's own 0–100 relevance is mapped to `relevance_score` (so JS keywords show a real score, not `—`); Amazon recommendations get a fixed `relevance_score: 80`. When AI scoring does run, keywords the model drops (`keep:false` — forbidden/irrelevant terms) are removed rather than surviving on the default score.

### POST /keyword-research/add-to-adgroup
Add selected keywords to an ad group (deduplicates, then pushes to Amazon).
```json
// Request
{
  "adGroupId": "uuid",
  "defaultBid": 0.50,
  "keywords": [
    { "keyword_text": "Edelstahl Trinkflasche", "match_type": "broad", "bid": 0.45 }
  ]
}

// Response 200
{ "success": true, "added": 5, "skipped": 2 }
```
`skipped` = duplicates already present in the ad group.

---

## Email Marketing *(Amazon SES, 2026-06-25)*

Bulk/newsletter sending on Amazon SES, separate from transactional (Brevo) mail. Behind config:
with `SES_*` env unset, `send`/`test` return `400 "SES not configured"`.

### Authenticated — `/api/v1/email-marketing` (requireAuth + requireWorkspace)
Contacts:
```
GET    /contacts?status=&tag=&search=&page=&limit=     — paginated list
POST   /contacts/import   { consent_source*, consent_method?, contacts:[{email,first_name?,last_name?,attributes?,tags?}] }
                           → { imported, skipped, invalid }   (consent_source REQUIRED — GDPR proof; dedup via ON CONFLICT)
PATCH  /contacts/:id      { first_name?, last_name?, attributes?, tags?, status? }
DELETE /contacts/:id
```
Segments: `GET/POST/PUT/DELETE /segments` — `filter` JSON `{ tags:[], status:'active' }`; a campaign with no `segment_id` targets all active contacts.

Campaigns:
```
GET    /campaigns                 GET /campaigns/:id
POST   /campaigns   { name*, subject, from_name, from_email, reply_to, html_body, segment_id }
PUT    /campaigns/:id             (editable only while draft/scheduled/paused)
DELETE /campaigns/:id             (draft/scheduled/paused/failed only)
POST   /campaigns/:id/test        { email }            — one-off test send (requires SES configured)
POST   /campaigns/:id/send        → { ok, total, batches }   — enqueues; writes audit email_campaign.send
POST   /campaigns/:id/schedule    { scheduled_at }     — future ISO timestamp; a 5-min cron dispatches it
POST   /campaigns/:id/pause
GET    /campaigns/:id/stats       → counters + per-status send breakdown
```
- `subject`/`html_body` support `{{first_name}}`, `{{last_name}}`, and any imported attribute. A postal-address + unsubscribe footer is appended automatically.

Suppressions: `GET /suppressions`, `POST /suppressions { email }` (manual), `DELETE /suppressions/:id`.

### Public — `/api/v1/email` (NO auth)
```
GET  /unsubscribe/:token   — human confirmation page (also unsubscribes)
POST /unsubscribe/:token   — RFC 8058 one-click (body List-Unsubscribe=One-Click)
POST /webhooks/ses         — SNS endpoint; signature-validated. Auto-confirms SubscriptionConfirmation;
                             permanent Bounce/Complaint → suppress + flag contact; Delivery/Open/Click → counters.
```

---

## Error Responses

All errors follow this format:
```json
{ "error": "Human-readable message" }
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request / validation error |
| 401 | Missing or invalid JWT token |
| 403 | Insufficient role/permissions |
| 404 | Resource not found |
| 429 | Rate limit exceeded (300 req/min) |
| 500 | Internal server error |
