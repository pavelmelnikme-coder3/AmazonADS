# API Reference

Base URL: `http://localhost:4000/api/v1`  
All endpoints (except `/auth/*`) require: `Authorization: Bearer <jwt_token>`

**Pagination.** Every paginated route takes `?page=` and `?limit=` and shares one helper,
`routes/_pagination.js`. A value that is not a positive number — `?page=abc`, `?limit=-5` — falls
back to the default rather than reaching SQL; each route had its own copy of the arithmetic before,
and `Math.max(NaN, 1)` is `NaN`, so those two used to answer 500. `limit` is capped per route.

**Workspace.** The workspace comes from the `x-workspace-id` header, `?workspaceId`, or a route
param, and must be a UUID; anything else is a 400 before any query runs. Membership is checked
against `workspace_members`, not organization alone — an org can hold more than one workspace.

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

## Negatives *(state filter added 2026-09-04)*

### GET /negative-keywords
### GET /negative-asins

Both take `search`, `campaignId` / `campaignIds`, `campaignType`, `page`, `limit`, `sortBy`,
`sortDir` — plus `matchType` and `level` on `/negative-keywords` — and:

| param | default | effect |
|---|---|---|
| `state` | `enabled` | `enabled` \| `paused` \| `archived` \| `all`. Anything else falls back to `enabled`. |

**Why the default is not `all`.** A negative released by a rule is set to `PAUSED` on Amazon
(Amazon rejects `ARCHIVED` on a PUT), so it blocks nothing. Both endpoints used to return every
row regardless of state, which counted those as live coverage: on 2026-09-04, 246 of 8881
negative keywords and 184 of 5610 negative targets. The count query applies the same filter, so
pagination matches the rows, and `state` is returned on each row.

This only became meaningful once `negative_targets.state` was actually synced from Amazon — the
upsert had omitted the column entirely, so the value was whatever AdsFlow last wrote locally.

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

**`safety` fields** *(all optional; the two added 2026-08-18 apply their default when absent)*

| field | default | effect |
|---|---|---|
| `min_bid` / `max_bid` | — | bid clamps |
| `max_budget` | — | caps budget **growth**; never lowers a budget already above it |
| `min_budget_utilization` | `70` | percent of the daily budget a day's spend must reach for that day to count as budget-limited. `adjust_budget_pct` only raises a campaign that was budget-limited on **≥ 2 of the last 7 days**; otherwise it skips with `budget_not_binding`. `0` disables the check. |
| `reconcile_grace_runs` | `2` | consecutive runs that must find a negative unjustified before reconciliation releases it. `1` releases on the first such run (the pre-2026-08-18 behaviour). |

Response shape:
```json
{
  "matched_count":   42,
  "skipped_count":   8,
  "applied_count":   34,
  "total_evaluated": 7343,
  "removed_count":   3,
  "applied":         [{ "entity_id": "...", "keyword_text": "...", "action": "...", "metrics": {...} }],
  "skipped":         [{ "entity_id": "...", "reason": "already_negative", "action": "...", "metrics": {...} }],
  // a `budget_not_binding` skip also carries `detail`:
  //   { "daily_budget": 69.12, "max_daily_spend": 12.06, "budget_limited_days": 0,
  //     "required_days": 2, "utilization_pct": 70, "lookback_days": 7 }
  "removed":         [{ "id": "...", "keyword_text": "...", "action": "remove_negative_reconcile", "metrics": {...} }],
  "errors":          [],
  "writeback_errors":      [],
  "writeback_error_count": 0
}
```

`scope.entity_type` accepts: `keyword` (default), `product_target`, `search_term` (new).

`skipped[*].reason` is one of: `already_paused`, `already_enabled`, `not_enabled`, `already_negative`,
`wrong_entity_type`, `campaign_not_enabled`, `is_active_target`, `not_asin_query`, `empty_keyword_text`,
`unknown_budget`, `at_max_budget`, `budget_not_binding`, `no_asin_search_terms`,
`non_negatable_expression_type`, `unsupported_keyword_text`, `amazon_rejected_keyword_text`,
`amazon_rejected_negative_target`.

#### A negative Amazon refuses *(2026-09-04)*

Creating a negative is the one write-back whose failure nothing else can notice: the local row
carries a synthetic `rule-…` id, so no sync will ever reconcile it against Amazon, and the add
path then skips the term forever as `already_negative`. Until 2026-09-04 such a row was simply
left `state='enabled'` — the term kept spending with nothing blocking it and nothing retrying.

A rejected create now rolls the row back to `state='archived'` and stores the reason in
`negative_keywords.writeback_error` / `negative_targets.writeback_error`. The next run reads it:

| rejection | next run |
|---|---|
| `PATTERN_NOT_MATCHED`, `malformedValueError`, `INVALID_ARGUMENT`, `NOT_SUPPORTED` / `UNSUPPORTED` | skipped as `amazon_rejected_keyword_text` / `amazon_rejected_negative_target`, with Amazon's message in `detail.amazon_error` — the same text would be refused again |
| 401 / 429 / 5xx / timeouts, and duplicates | retried; the stored error is cleared when the row is re-owned |

Before any of that, `services/amazon/keywordText.js` rewrites Unicode whitespace (U+00A0 and
friends) to a plain space — a meaning-preserving spelling change. Other characters Amazon refuses
are **not** rewritten: the term is skipped as `unsupported_keyword_text`, with the offending
characters in `detail.characters`. Substituting a space would negate a *different* keyword
(`7 50` is not `7,50`) and the run would report success for a negative that need not block the
term. The accepted set comes from entities Amazon has actually accepted — letters, digits, space,
`- + & . ' _ ( )` — because the documented list names `"` as valid while the API rejects it
(amzn/ads-advanced-tools-docs#143).

#### `errors` vs `writeback_errors` *(2026-08-03)*

Two different failure classes — check **both** before calling a run clean:

| field | means |
|---|---|
| `errors` | an action threw locally; nothing was applied for that entity |
| `writeback_errors` | the local DB was updated but **Amazon rejected the change** |

Amazon write-backs are deliberately non-fatal, so a rejection never lands in `errors`. Until
2026-08-03 it was not reported at all and runs showed `completed / 0 failures` while Amazon had
refused the change on every run for days. Each entry is
`{ entity_id, entity_type, keyword_text, action, stage: "amazon_writeback", error }`.
`rule_executions.actions_failed` counts both, and a run with either is stored as `status: "partial"`.

### GET /rules/:id/runs

Execution history, newest first (50 max). Alongside the counters and `summary` (the applied
actions), each row carries *why* a run did what it did — added 2026-09-04, because a run that
matched entities and applied none was previously indistinguishable from a broken one:

| field | meaning |
|---|---|
| `entities_skipped` | how many matches were skipped |
| `diagnostics.skipped_by_reason` | `{ reason: count }` — e.g. `{ "budget_not_binding": 26, "not_enabled": 1 }` |
| `diagnostics.skipped_samples` | up to 5 entities per reason, each `{ entity_type, keyword_text, action, amazon_error? }` |
| `diagnostics.writeback_errors` | Amazon rejections (capped at 25) — these never appear in `errors` |
| `diagnostics.errors` | local action failures (capped at 25) |

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
- Fires one instance (`entity_type: "product_movers"`, breached products in `data.products[]`, plus `fresh_count` / `escalated_count` / `suppressed_count`) and one digest email. Products are split into **New** and **Worsening** with a `+N suppressed` line; if every flagged product is suppressed, nothing fires. Legacy `{ bsr_change_pct, orders_change_pct, require_both }` payloads are still accepted and converted. The instance title shows the comparison window (`· Nd vs prior Nd`).

**Delivery schedule** *(optional, any alert type, 2026-06-26)* — add a `schedule` object to pin the alert to a weekday + hour instead of firing whenever the cooldown elapses:
```json
"schedule": { "weekday": 5, "hour": 8, "tz": "Europe/Berlin" }
```
`weekday` 0–6 (`0`=Sun … `5`=Fri), `hour` 0–23, `tz` an IANA zone (default `UTC`). The hourly alert cron then evaluates the alert **only** during that weekday+hour in `tz` — e.g. a Friday-08:00 weekly digest. Omit for the default behaviour (every cron tick, gated only by `cooldown_hours`). `POST /alerts/check` ("Check now") ignores the schedule so manual tests fire immediately. On `PUT`, an existing schedule is preserved when the body omits it.

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

Each row also carries `ad_campaign_count` / `ad_campaign_live_count` *(2026-08-25)* —
how many campaigns hold an ad for this ASIN, and how many of those actually serve
(campaign **and** ad **and** ad group enabled). Archived campaigns and archived ads are
excluded from both, matching `GET /products/ad-placements`.

### GET /products/ad-placements?asins=B0AAA,B0BBB *(2026-08-25, SB added 2026-08-27)*
"Which campaigns advertise this ASIN?" — the lookup behind the **Кампании (live/total)**
panel on the Products page, so a product can be pulled out of advertising without hunting
through the Amazon console. Up to 200 ASINs per call; unknown/malformed ASINs are dropped,
a valid ASIN with no ads comes back as an empty array.

```json
{ "coverage": ["SP", "SD", "SB"],
  "placements": { "B0FKTRLCPJ": [ {
    "campaign_id": "…", "amazon_campaign_id": "275655371626878",
    "campaign_name": "6 [SP-BM]-Fußstütze grib - 9481",
    "campaign_type": "sponsoredProducts", "campaign_state": "enabled",
    "marketplace_id": "A1PA6795UKMFR9", "portfolio_name": null, "daily_budget": 15,
    "campaign_spend_7d": 32.77, "campaign_sales_7d": 0, "campaign_clicks_7d": 41,
    "ad_count": 2, "enabled_ad_count": 2, "skus": ["9481-FBA1", "9481-AMZ1"],
    "ad_groups": [ { "name": "…", "state": "enabled", "ad_count": 2, "enabled_ad_count": 2 } ],
    "is_live": true, "blocked_reason": null } ] } }
```

- Source is `product_ads` (one Amazon ad row per ASIN/SKU inside an ad group), grouped to one
  entry per (ASIN, campaign) — a listing normally has one ad per SKU (FBA + FBM) in every ad
  group, so the raw rows repeat the same campaign many times.
- `is_live` requires **all three** links to be enabled — campaign, ad group, ad — *and* a creative
  Amazon is willing to show. A paused ad group stops delivery exactly like a paused campaign.
- `blocked_reason` (SB only) names why an enabled ad inside an **enabled** campaign still shows
  nothing: `REJECTED_BY_MODERATION`, `PENDING_MODERATION_REVIEW`, `AD_POLICING_*`. It is null when
  anything in the campaign can serve, and null under a paused campaign (the campaign state already
  explains that). Read from `creative.creativeStatus` / `extendedData.servingStatus`, which SP/SD
  rows do not carry — their verdict is unchanged.
- `campaign_spend_7d` is the **whole campaign's** spend over the last 7 full days, across all
  its products — Amazon reports per-ASIN spend only aggregated across campaigns. The UI labels
  it as such.
- Ordering: serving first, then by campaign spend, then by name.
- **Coverage is SP + SD + SB.** SB ASINs come from `POST /sb/v4/ads/list` →
  `creative.asins` (media type `application/vnd.sbadresource.v4+json`): one ad expands to one
  `product_ads` row per ASIN, keyed `sb:{adId|adGroupId}:{ASIN}`. Pass `stateFilter` explicitly —
  the default response omits everything but ENABLED. SB rows have no SKU and no `ad_group_id`
  (Amazon's SB ad-group list is not synced), so their `ad_groups` entry is a single null-named
  bucket and their delivery chain is ad → campaign.

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

## Email Marketing *(Brevo SMTP relay in prod; SES adapter kept as a legacy fallback — 2026-06-25, updated 2026-07-01/02)*

Bulk/newsletter sending via `EMAIL_PROVIDER` (default `brevo`; `ses` still supported). Behind config:
with the active provider's creds unset, `send`/`test` return `400 "... not configured"`.

### Authenticated — `/api/v1/email-marketing` (requireAuth + requireWorkspace)
Contacts:
```
GET    /contacts?status=&tag=&search=&page=&limit=     — paginated list
POST   /contacts/import        { consent_source*, consent_method?, contacts:[{email,first_name?,last_name?,attributes?,tags?}] }
                                → { imported, tagged, skipped, invalid }   (consent_source REQUIRED — GDPR proof)
POST   /contacts/import-file   multipart file (.csv/.xlsx) + consent_source*  — auto-detects email/first/last-name columns,
                                other columns become merge-tag attributes → { imported, tagged, skipped, invalid, detected, rows }
PATCH  /contacts/:id      { first_name?, last_name?, attributes?, tags?, status? }
DELETE /contacts/:id
DELETE /contacts/lists/:tag?mode=untag|contacts   — delete a whole list (tag). DEFAULT is `untag`.
                                → { ok, tag, mode, contacts, deleted_contacts, untagged, deleted_segments }
```
- An address already on the list is **not** skipped: the import merges its tags, so it joins the audience
  it was imported under (`tagged` counts those). Only tags merge — consent (source/method/at/ip) belongs to
  the first time the address was collected and is never rewritten, and `status` is untouched, so an
  unsubscribed contact stays unsubscribed and out of every send.
- `mode=untag` (default): the list disappears, the people stay. `mode=contacts`: the people go too —
  but a contact that **also belongs to another list** is only untagged, never deleted, under either mode.
- A segment whose whole filter is that one tag is deleted with the list (it could only match nothing
  afterwards). `409` while **any** campaign in `draft`/`scheduled`/`paused`/`sending` still points at that
  segment, naming it. This is not politeness: `segment_id` is `ON DELETE SET NULL` and NULL means *all active
  contacts*, so deleting the segment would not empty that campaign's audience — it would widen it to everyone.
  `sent`/`failed` campaigns never block a cleanup.
- `404` when the tag matches no contact. Audited as `email_list.delete` / `email_list.delete_with_contacts`.
Segments: `GET/POST/PUT/DELETE /segments` — `filter` JSON `{ tags:[], status:'active' }`; a campaign with no `segment_id` targets all active contacts.
`DELETE /segments/:id` returns `409` under the same rule as the list delete above, for the same reason.

Campaigns:
```
GET    /campaigns                 GET /campaigns/:id
POST   /campaigns   { name*, subject, from_name, from_email, reply_to, html_body, segment_id, content_blocks? }
PUT    /campaigns/:id             (editable only while draft/scheduled/paused). Every field is patch-style:
                                  omit it and it keeps its value. `segment_id` and `content_blocks` are
                                  presence-checked, so both can be explicitly set to null — omitting
                                  `segment_id` does NOT clear the audience (it used to, and NULL means
                                  every active contact, so a partial update silently widened the send).
DELETE /campaigns/:id             (draft/scheduled/paused/failed only)
GET    /campaigns/:id/audience    → { recipients, segment_id, segment_name, all_contacts }
                                     — who this campaign would actually reach, resolved by the send path's own
                                     rules (active + segment tags + not suppressed). `all_contacts:true` means
                                     it has no segment and is addressed to everyone. Ask before sending.
POST   /campaigns/:id/test        { email }            — ⚠️ ALWAYS use this for verification, not /send (see below)
POST   /campaigns/:id/send        → { ok, total, batches }   — ⚠️ targets the campaign's REAL, FULL audience
                                     (or its segment) immediately, no dry-run mode; writes audit email_campaign.send
POST   /campaigns/:id/schedule    { scheduled_at }     — future ISO timestamp; a 5-min cron dispatches it
POST   /campaigns/:id/pause
GET    /campaigns/:id/stats       → counters + per-status send breakdown + computed `rates` (open/click/
                                     click-to-open/bounce/complaint/unsubscribe %, null if denominator is 0)
```
- `subject`/`html_body` support `{{first_name}}`, `{{last_name}}`, and any imported attribute, plus
  `{{unsubscribe}}` and `{{mirror}}`. A postal-address + unsubscribe footer is appended automatically;
  its opening sentence depends on the recipient's `consent_source` — an address this app collected
  itself (`scraped_public_website`) is told where it was reached, never that it opted in.
- `content_blocks: { version:1, blocks:[...] }` (block types: text/image/button/divider/spacer) — the visual editor's format; when set, `html_body` is the last-compiled-from-blocks output (source of truth for sending either way).
- **`/send` has no test/dry-run mode** — omitting `segment_id` targets ALL active contacts. Always use `/campaigns/:id/test` (single explicit recipient) to verify a campaign or the send pipeline itself; never call `/send` "just to check it works."

Uploads (images/hosted files for block content — persist independent of any campaign, public URLs):
```
POST /uploads/image   multipart file (jpeg/png/webp/gif, ≤5MB) → { url, filename, size, mime }
POST /uploads/file    multipart file (pdf/ppt/pptx/xls/xlsx, ≤15MB) → { url, filename, storedName, size, mime }
```
True SMTP attachments (embedded in every send — small files only, Brevo-only; SES silently drops them with a warning logged):
```
POST   /campaigns/:id/attachments             multipart file (≤8MB/file, ≤10MB cumulative per campaign)
DELETE /campaigns/:id/attachments/:attId
```

Suppressions: `GET /suppressions`, `POST /suppressions { email }` (manual), `DELETE /suppressions/:id`.

### Public — `/api/v1/email` (NO auth)
```
GET  /unsubscribe/:token         — confirmation page ONLY; changes nothing. Corporate mail gateways
                                    (Outlook Safe Links, Proofpoint, Mimecast) fetch every URL in a message
                                    before the recipient sees it, so a GET that unsubscribed on sight
                                    removed recipients who never clicked. The page carries a POST button and
                                    is rendered in the language the campaign was written in (?lang=en|de|ru).
POST /unsubscribe/:token         — performs the unsubscribe. RFC 8058 one-click (body List-Unsubscribe=One-Click)
                                    and the confirmation page's button both land here; attributes to the
                                    contact's most recent campaign send + bumps its unsubscribed counter,
                                    best-effort.
GET  /uploads/images/:id/:file   GET /uploads/files/:id/:file   — serves uploaded campaign assets (path-traversal guarded)
POST /webhooks/ses               — legacy. SNS endpoint; signature-validated. Auto-confirms SubscriptionConfirmation;
                                    permanent Bounce/Complaint → suppress + flag contact; Delivery/Open/Click → counters.
POST /webhooks/brevo?token=<BREVO_WEBHOOK_SECRET>   — the one actually in use. delivered/opened/unique_opened/
                                    click/hard_bounce/soft_bounce/blocked/invalid_email/spam/unsubscribed events,
                                    correlated by the `tag` Brevo echoes back (set at send time to email_sends.id).
                                    Not signed by Brevo → 403 without the correct ?token. Must be registered manually
                                    in Brevo's dashboard (Transactional → Settings → Webhook) — see docs/EMAIL_SES_SETUP.md.
                                    Both webhook paths are on their own rate-limit bucket (5,000/min) rather than
                                    the general 300/min per-IP one: a send burst used to push its own event burst
                                    past the user ceiling, and a refused webhook is a lost event. Nothing else
                                    under /email is exempt.
```

---

## Lead Finder *(business prospecting via OpenStreetMap — 2026-07; query semantics corrected 2026-09-07)*

> **Country-scale collection.** `POST /search` tiles a region's bbox — 304 requests for Germany, which
> the public `overpass-api.de` answers with an IP ban long before the end. An Overpass `area` query per
> administrative region does the same job in 16: `area["ISO3166-2"="DE-BY"]` + the same tag filters,
> `out center tags`. The whole country in one query is accepted for `out count` (13,910) but 504s when
> asked for the objects. The tool itself still only knows how to tile; the 2026-09-08 German sweep was
> collected by script and imported through `mapElements` + `persistResults`, the same path a live search
> uses.

Finds businesses in a region from public OSM data, optionally scrapes contact emails off their
websites, and promotes them into `email_contacts`. Results are **scraped, not opted-in**: they land
with `consent_source='scraped_public_website'` and are never presented as consent.

### Authenticated — `/api/v1/lead-finder` (requireAuth + requireWorkspace)
```
POST   /search               { region*, query* }  → 200 {search, results} | 202 {search, status:"running"}
GET    /searches             — history (carries `truncated` so a sampled list can be marked as one)
GET    /searches/:id         — poll an in-progress tiled search: status, tiles_done/tiles_total, truncated
GET    /searches/:id/results
POST   /searches/:id/scrape        { resultIds? }  — scrapes 25 pending websites per call
POST   /searches/:id/cancel
POST   /searches/:id/add-to-contacts { tag? }      — promotes rows that yielded an email
                                     → { added, tagged, skipped_no_email, already_added, tag }
```
- **Every lead holding an address is a candidate, promoted before or not.** `added_to_contacts` records
  that a lead has been promoted at some point; tags describe audiences and a lead can belong to several,
  so the flag is not the question this endpoint asks. It used to gate the query, which made a second
  promotion under a different tag impossible — a lead promoted in July could never join an audience
  defined in September. `tagged` counts addresses that were already contacts and have now joined this
  audience; re-promoting is idempotent.
- An address published in OSM (`email` / `contact:email`) is taken straight from the search result: the
  lead is stored `scrape_status='found'` with no site fetch at all, which also reaches the leads that
  have an address but **no** website — the ones the scraper marks `no_website` and never revisits.
  Measured on the 13,816-business German sweep: 1,674 addresses from tags, 1,302 fetches avoided.

**How the free-text query is interpreted.** OSM has no free-text description of a business: the kind
of place is one tag (`amenity=restaurant`), what it serves is another (`cuisine=chinese`), and both
use **English** values whatever language the name is in. So the query is translated, not word-matched:

- Recognised cuisine/venue words become real tag filters —
  `"asiatisches restaurant"` → `[amenity~"^(restaurant|fast_food)$"][~"^(cuisine|name)$"~"asian|chinese|…"]`.
  German inflections reduce to a stem (`asiatisch`/`asiatisches`/`asiatische`), and the user's own word
  stays in the *name* pattern because many places carry no `cuisine` tag but do say "Asia Wok" on the sign.
- A named venue is a **hint, not a restriction**: "sushi bar" also searches `amenity=restaurant`, which is
  how such places are actually tagged.
- Any remaining words are **ANDed** (one filter each). They used to be ORed, which meant the broadest word
  decided the whole search — `"asiatisches restaurant"` returned every restaurant in the region.

**Coverage.** A region larger than 2.5° is split into 0.5° tiles and run as a background job. Tiles are
visited on a stride coprime to their count, so a budget that runs out still buys a region-wide sample
rather than one edge of the map, and each tile gets only its share of `MAX_RESULTS_PER_SEARCH` (500).
`truncated` means the region holds more than was returned — the saved search is a **sample**, and the UI
labels it as one.

**Provider limits.** overpass-api.de is a free shared endpoint that rate-limits by *refusing the TCP
connection* (ECONNREFUSED with an empty message), not by answering 429. Those refusals are retried with
backoff; 8 consecutive tile failures end the run as **failed** with the reason, rather than walking the
rest of the grid collecting nothing and reporting `completed`. Country-scale grids pace at 5 s/tile
(≈25 min for Germany) — 1.5 s got this server blocked mid-run.

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
