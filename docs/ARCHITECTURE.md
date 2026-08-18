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
    5. Reconciliation pass: re-evaluate the negatives this rule created
       (source_rule_id = rule.id, state = enabled) and un-negate any whose
       conditions no longer hold
```

### The add/reconcile symmetry invariant *(2026-08-03)*

`executeRule()` decides the same thing twice — once when adding a negative, once when
reconciling it — and **those two decisions must be made on identical terms**. If they diverge,
the rule adds on one run exactly what it removes on the next, forever. Both sides must agree on:

| dimension | rule |
|---|---|
| **granularity** | per `(query, campaign, ad_group, match_type)` slice. A negative is kept if **any** slice still matches — i.e. reconciliation never removes what the add path would immediately re-add. An ad-group-level negative only blocks its own ad group, so that is also the correct scope. |
| **term identity** | both sides group/compare on `sqlNormalizeKeywordText(...)`. Amazon returns the same shopper term in several typographic spellings (U+00A0 vs a plain space); they are one negative keyword on Amazon and must be one entity here. |
| **row ownership** | re-negating re-activates and **re-owns** an existing inactive row for that ad group instead of inserting a new one, so the rule that now justifies the negative becomes its `source_rule_id`. Otherwise the row stays owned by the rule that archived it, that rule keeps re-archiving it, and the sync keeps flipping it back. |
| **release requires conversion** | `negativeStillJustified()` — a negative comes off **only** when the term has orders. Zero orders keeps it, whatever the click count has decayed to. |
| **release must be confirmed** | a single run's verdict is not enough: reconciliation must find the negative unjustified on `safety.reconcile_grace_runs` **consecutive** runs (default 2) before releasing it. See below. |

### Why release requires conversion evidence *(2026-08-04)*

Even with add and reconcile measuring identically, one threshold governing both directions has
no deadband, so a term sitting on the boundary flip-flops forever. The feedback loop is the
problem: **a negated term stops receiving traffic, so its clicks age out of the rolling window
and the count shrinks on its own** — the negative suppresses the very data used to judge it, and
releasing on that shrinking count is circular. `footrest under desk` was negated at 8 clicks and
released at 7, repeatedly (2026-06-22/23, 07-25/28, 08-02/04).

Measured over 30 days, of 438 releases:

| | count | avg clicks | verdict |
|---|---|---|---|
| term had orders | 222 (51%) | 22.2 | correct — it started converting |
| term had **zero** orders | 216 (49%) | 6.6 | released purely by click decay |

So ~7 negatives a day were un-blocking terms that had never produced a single order, against
thresholds of 6 and 8. Requiring orders means a release is always backed by real evidence that
the term earns its traffic; a term with no traffic at all also stays negated, since absent data
is the negative working, not proof it should go.

**Consequence, by design:** negatives are now effectively sticky. A term blocked in an ad group
cannot easily gain orders there, so most negatives stay until someone removes them by hand. That
matches how negatives are normally treated in PPC and is the intended trade-off.

This was violated in production for ~2.5 months (reconciliation aggregated campaign-wide while
the add path sliced per ad group), causing 6–9 negatives per day to be added and removed in the
same run. Fixing granularity alone then exposed the identity half of the same trap. See
`backend/tests/rules.test.js` → "Add path and reconciliation agree on term identity", which
asserts both queries use the *same* normalization expression rather than merely that each
normalizes.

**Health check:** a second rule run immediately after the first must be a no-op —
`applied = 0`, `removed = 0`, zero audit writes. Any churn there means the invariant is broken.

### Why a release must be confirmed across runs *(2026-08-18)*

Requiring conversion evidence removed the click-decay loop but not a second, slower one:
**Amazon restates the search-term report.** Conversions land against a day one or two days
after that day closes, so the same term's `orders` reads 0, then 1, then 0 again as the report
is re-ingested and the 60-day window slides underneath it. A release decided on a single run
follows that noise exactly.

Measured 11–18.08.2026: 11 terms were negated, released on the very next daily run, and
re-negated two or three days later. `gaskartuschen schraubventil 230g` went add 14.08 →
release 15.08 → add 17.08, spending €10.18 on 9 clicks with **0 orders** in the gap.

`confirmReconcileRelease()` turns the one-run verdict into a confirmed one via
`negative_keywords.reconcile_miss_count` / `negative_targets.reconcile_miss_count`
(migration `048`):

- unjustified run → increment; release only when the count reaches `reconcile_grace_runs`
- justified run → reset to 0
- row re-owned by another rule (the add path re-activates an inactive row) → reset to 0, since
  it is a fresh negative for its new owner and must not inherit a part-way count

Every flip observed in that window lasted a single run, so the default of 2 removes all of
them; the cost is that a genuinely converting term is released one day later than before.

### Budget raises require the budget to be binding *(2026-08-18)*

`adjust_budget_pct` matched on performance alone, which says nothing about whether the budget
is what limits the campaign. With a 60-day qualifying window a campaign that converted well two
months ago keeps passing `ACOS <= 15 AND orders >= 3` indefinitely, so the rule kept raising
campaigns that never came near their cap — on 2026-08-18, **25 of the 31** it raised were using
under 10% of their daily budget and several were spending €0.00/day. Harmless while the
write-back was silently no-op'ing; once that was fixed (2026-08-14) each run compounded another
+20% and the account's total daily budget went 906 → 1090 → 1298 in two runs against flat spend.

A raise now requires the campaign to have been **budget-limited on at least
`MIN_BUDGET_LIMITED_DAYS` (2) of the last `BUDGET_UTILIZATION_LOOKBACK_DAYS` (7) days**, where a
day counts when its spend reached `safety.min_budget_utilization` (default 70%) of the current
daily budget. Otherwise the campaign is skipped as `budget_not_binding`, with a `detail` payload
naming the budget, the peak day's spend and the day count so the decision is checkable.

Deliberately **not** a window average: a campaign that maxes out twice a week and idles the rest
averages low but is genuinely capped on the days it runs. `loadRecentDailySpend()` fetches the
whole set in a single query covering every matched campaign, and only runs at all when the rule
actually has an `adjust_budget_pct` action.

### Negative state on Amazon

Amazon rejects `state: ARCHIVED` on the negative-keyword/target endpoints, so "archiving" a
negative sets **`PAUSED`** there while the local row is marked `archived`. The entity sync must
therefore include `PAUSED` in its `stateFilter`, or paused negatives silently vanish from the
sync and local state drifts from Amazon.

Batch endpoints answer **207 Multi-Status**: a 2xx HTTP status with per-item rejections in
`<dataKey>.error[]`. `adsClient` returns any 2xx body without throwing, so every write-back
helper must inspect that array (`partialError()` in `services/amazon/writeback.js`) — otherwise
a refused write is recorded as a success.

### Campaign endpoints differ by ad type — path, media type and budget shape *(2026-08-18)*

The three ad types are on three different API generations, and a mismatch on **any** of the
three axes below fails, each in its own way:

| | path | Accept / Content-Type | daily budget in the payload |
|---|---|---|---|
| **SP** | `/sp/campaigns` | `application/vnd.spCampaign.v3+json` | nested: `budget: { budget, budgetType: "DAILY" }` |
| **SB** | `/sb/v4/campaigns` | `application/vnd.sbcampaignresource.v4+json` | **flat**: `budget, budgetType: "DAILY"` |
| **SD** | `/sd/campaigns` | `application/json` | flat, lowercase: `budget, budgetType: "daily"` |

Both are centralised — `campaignApiPath()` / `campaignBudgetFields()` in `writeback.js`, media
type in `adsClient.getAcceptHeader()` — because the path map had been copy-pasted at **five**
call sites (write-back, `routes/campaigns.js` ×2, `routes/rules.js` ×2,
`services/rules/engine.js`) and every copy pointed SB at the removed v3 `/sb/campaigns`.

Two failure modes to keep apart:

- **Wrong media type → `406 "No match for accept header"`.** Rejected before Amazon looks at
  the body, so nothing in the payload is even evaluated. `getAcceptHeader` used to map only
  `/sp/*` paths, and `Content-Type` was derived by a *separate* expression
  (`path.startsWith("/sp/") ? … : "application/json"`) — that asymmetry is what let the SB gap
  go unnoticed. Both headers now come from the one function.
- **Wrong field shape → silent success.** Amazon drops unknown fields and still answers 207 with
  the campaign in `success[]`, so the caller records a write that never happened. This hid the
  SP budget bug for a month and would have hidden the SB one too, had the 406 not come first.

**Therefore: a write-back is only verified by reading the value back.** `{ok: true}` proves the
request was accepted, not that it changed anything. The SB fix was confirmed against the live
API on a paused campaign — budget 20 → 21 read back as 21, restored to 20, with every other
field (name, state, bidding, portfolioId) unchanged, which also confirms these PUTs are partial
updates rather than full replacements.

⚠️ SB campaign **creation** (`POST /campaigns`) still sends a v3-era payload
(`budgetType: "dailyBudget"`, no `brandEntityId`/`goal`/`costType`/creative) and does not work;
only the path was corrected.

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

## 2026-06-09 changes (reporting-ingest integrity, attribution unification, throttle resilience)

### `fact_metrics_daily` upsert — refresh every attribution window
- `services/amazon/reporting.js` `ingestReportData` `ON CONFLICT` previously updated only
  `sales_14d`/`orders_14d` (+cost/clicks/impressions). Since the 60-day backfill re-touches recent dates
  on every run, the un-refreshed `sales_1d/7d/30d` and `orders_1d/7d/30d` froze at their first-insert
  value and drifted out of sync (symptom: matured rows with `sales_1d > sales_14d`).
- Amazon **restates** conversions at 1/7/28 days after the click, so a re-ingest must overwrite *all*
  windows. The upsert now refreshes `sales_1d/7d/14d/30d`, `orders_1d/7d/14d/30d`, `units_sold` and
  `campaign_type`.

### `campaign_type` sourced from the report request (not the row)
- Amazon report **rows** carry no campaign-type field. The old `row.campaignType || "SP"` therefore tagged
  **every** row `SP`, mislabeling SB/SD spend. `ingestReportData` now takes a `campaignType` parameter
  (passed from `runReportingPipeline`, which knows the report's product) and writes it directly.
- One-time history heal: `UPDATE fact_metrics_daily … FROM campaigns` mapped campaign-level rows by
  `amazon_campaign_id` to the real short code (`SPONSOREDPRODUCTS→SP`, `…BRANDS→SB`, `…DISPLAY→SD`).

### Attribution window unified to 14d on the Products page
- The Products list (`routes/products.js`: `ad_sales_7d` lateral, `/timeseries`, export `ads` CTE) used
  `sales_1d` in the UI but `sales_14d` in the export — and the rest of the app already standardizes on
  `sales_14d`. All three now use `sales_14d`/`orders_14d`, so per-product ACOS/ROAS match
  campaigns/keywords/rules/analytics. (`sales_14d` is also the only window the old upsert kept fresh, so
  switching to it gives correct values immediately; a 30-day re-backfill heals the residual rows the old
  upsert had zeroed.)
- The alert engine (`services/alerts/evaluate.js`) was originally kept on `sales_1d`/`orders_1d` to
  avoid immature-window "drop" alerts — **superseded 2026-06-24 (see below): now 14d like the rest of
  the app.**

### Report-creation throttle resilience
- `createReportRequest` now retries 429s up to 5× with exponential backoff (15→30→60→120 s) that honors
  the `Retry-After` header, plus jitter — Amazon's Sponsored Brands report-creation has a short burst
  limit that the old fixed 3×/15s+30s retry could not outlast.

## 2026-06-24 changes (alerting capability + attribution unification)

### Percentage-change threshold alerts
- New operators `drop_pct` / `rise_pct` in `evaluateWorkspaceAlerts`. The threshold branch splits into an
  *absolute* path and a *change* path: the change path reads the current window (`aggregateMetrics`) and
  the preceding equal-length window (`aggregateMetricsRange(2N, N+1)`), requires a positive prior value,
  and fires on `pct <= -value` (drop) / `pct >= value` (rise). Perf metrics only; route validation rejects
  BSR and non-positive percentages.

### Spend-alert per-campaign breakdown
- `topSpendCampaigns(workspaceId, windowDays, limit)` returns the top spenders over the window with
  `delta`/`delta_pct` vs the prior window and a health snapshot (`sales`/`orders`/`roas`/`acos`). Attached
  to `data.top_campaigns` and the email for `metric === 'spend'` alerts (best-effort, non-fatal). Rendered
  as an expandable row in-app and a table in the email.

### Attribution unified to 14d in the alert engine
- `aggregateMetricsRange`, `topSpendCampaigns`, and the `computeMoverFlags` ad-metrics query now sum
  `sales_14d`/`orders_14d` (was `sales_1d`/`orders_1d`). Sponsored Brands report conversions **only** on
  the 14d window, so 1d dropped all SB sales; SP fills every window identically. The window already
  excludes today (`<= CURRENT_DATE - 1`), so the old "immature window" concern is moot. Now matches
  Amazon's UI default and the rest of the app. A regression test asserts `aggregateMetrics` uses
  `sales_14d`.

### Product-movers cause accuracy
- Stock: availability is `max` of genuinely-known sources (not `min`); a mapped item with no `wawi_stocks`
  row is `n/a` (unknown), not `0`; `stock_out` only when every known source is empty, else `fba_empty` /
  `erp_empty`. Demand-side causes (`price_up`/`ad_cut`) attach only when a volume/rank metric breached —
  never for efficiency ratios (a spend cut raises ROAS, so it can't explain a ROAS drop).

## 2026-06-25 — Marketing email subsystem (originally Amazon SES, migrated to Brevo — see below)

A separate bulk/newsletter pipeline, isolated from the transactional Brevo path so marketing
complaints don't degrade alert/invite deliverability. Region `eu-central-1` (Frankfurt, GDPR).

- **Tables** (migration 037): `email_contacts` (consent proof + `unsubscribe_token`), `email_segments`,
  `email_campaigns` (+counters), `email_sends` (UNIQUE(campaign,contact)), `email_suppressions`.
- **Send path**: `routes/emailMarketing.js` → `queueEmailCampaign()` (workers.js) → `email-dispatch`
  queue → `dispatch.processBatch()` → `provider.sendBulkEmail()` (provider = `ses` or `brevo`, see
  2026-07-01 below — **`brevo` is what's actually configured in prod**). Each message is rendered and
  sent **per recipient** (not templated bulk-send) so the per-recipient RFC 8058 `List-Unsubscribe`
  headers can be set; the provider throttles by messages/sec regardless, so the queue limiter
  (`SES_MAX_SEND_RATE`, batch = rate) is the real rate guard.
- **Idempotency**: deterministic batch `jobId` + `email_sends UNIQUE(campaign,contact)` +
  `processBatch` only sends rows still `status='queued'` → a job retry never re-sends.
- **Compliance**: `render.js` appends postal address + unsubscribe footer to every email; consent proof
  is required on import; account + app suppression lists; provider webhook auto-suppresses hard
  bounces/complaints (SES: SNS, signature-validated via `sns-validator`; Brevo: shared-secret URL token,
  see below).
- **Config gate**: `provider.isConfigured()` — unset = no sends, app unaffected. Operator setup:
  see `docs/EMAIL_SES_SETUP.md` (despite the filename, now documents the Brevo path prod actually uses).

## 2026-07-01 — Brevo migration, visual block editor, uploads/attachments, HTML import

Marketing email moved from Amazon SES (never left the sandbox in practice) to **Brevo SMTP relay**
(`services/email/brevo.js`, same `sendBulkEmail(...)` interface as `ses.js` — `provider.js` picks one
by `EMAIL_PROVIDER` env, defaults `brevo`). Brevo free plan caps the **whole account** at 300 msg/day
(marketing + transactional share it); `dispatch.js`'s `dripSend()` enforces a conservative
`EMAIL_DAILY_CAP` (default 250) across ALL `sending` campaigns account-wide, draining a large campaign
over several days rather than bursting — a 5-min cron plus the manual send path both call the same
self-serialising (`_dripRunning` in-process lock) function, so they can't double-fire.

- **Visual block editor** (`content_blocks` jsonb column on `email_campaigns`, nullable — null = legacy
  raw-HTML mode). `frontend/src/lib/emailBlocks.js` (`compileBlocksToHtml`) turns a flat block list
  (text/image/button/divider/spacer) into inline-styled table HTML with **zero `<style>` blocks or
  classes** — the actual fix for "looks fine in Gmail, broken in the in-app preview" (Gmail strips
  `<style>` blocks on receipt; the old raw-textarea mode didn't). Buttons use the "bulletproof button"
  table pattern (background on the `<td>`, not the `<a>`) since Outlook desktop's Word rendering engine
  ignores anchor padding/border-radius. `frontend/src/components/EmailBlockEditor.jsx` is the editor UI
  (drag-reorder via the existing `@dnd-kit` pattern used elsewhere in the app); preview renders inside a
  sandboxed `<iframe srcDoc>` (isolated document, own `<style>` reset) rather than
  `dangerouslySetInnerHTML` directly in the app DOM.
- **`htmlToBlocks(html)`** — best-effort reverse parser for converting a legacy raw-HTML campaign into
  blocks (one-way, `window.confirm`-gated; a `_htmlBeforeBlocks` snapshot lets the user restore the
  original HTML instead of the lossy recompiled version if they switch back).
- **Uploads**: `services/email/uploads.js` (multer diskStorage under `backend/uploads/email/{images,
  files,attachments}/`, not committed — see `.gitignore`) + public unauthenticated serve routes in
  `routes/emailPublic.js` (mail clients have no AdsFlow session), path-traversal guarded. Images/hosted
  files persist independent of any campaign (no orphan cleanup yet — a known gap, not urgent at current
  volume). True SMTP attachments are campaign-scoped (`attachments` jsonb column, 8MB/file, 10MB
  cumulative cap) and only forwarded to `nodemailer.sendMail` on Brevo — SES has no attachment path.
- **Standalone-HTML-bundle import**: some design tools ("Save as standalone preview") export a
  self-executing JS bundle rather than flat HTML — `unpackStandaloneHtml()` runs it once in a fully
  sandboxed off-screen `<iframe sandbox="allow-scripts">` (no `allow-same-origin` → opaque origin, no
  access to our cookies/DOM/session) and captures `document.documentElement.outerHTML` once a
  `MutationObserver` reports the DOM has settled. Such bundles typically embed images as base64 (+
  optional gzip) inside a `<script type="__bundler/manifest">` tag, decoded client-side via
  `URL.createObjectURL()` into `blob:` URLs that only resolve inside that now-destroyed iframe — the
  capture script also `fetch()`es each `blob:` image **from inside its own document** (the only context
  they're fetchable from) and returns it as a `data:` URL, which `recoverBlobImages()` then re-uploads
  through the real image-upload endpoint to get a permanent hosted URL. Any image that still fails to
  recover gets a **visible text+CSS placeholder** (`stripBlobUrls()`) — deliberately not `src=""`
  (renders as nothing, no broken-image icon, in every client tested) or a `data:` URI placeholder
  (Outlook desktop never loads `data:` images; many clients block all images including `data:` by
  default) — a pure text/CSS block needs no image request at all, so it can't silently vanish.
- **Engagement tracking (delivered/opened/clicked/bounced/complained/unsubscribed)**: previously only
  wired for SES (`applySesEvent`, SNS webhook) — dead code against the actual `brevo` provider, so these
  counters sat at 0 forever regardless of real outcomes. `brevo.js sendBulkEmail` now sets
  `X-Mailin-Tag: <email_sends.id>` per recipient — Brevo recognizes this header even over plain SMTP
  relay (not just their REST API) and echoes it back verbatim as `tag` on every webhook event, so
  `routes/emailPublic.js`'s new `POST /webhooks/brevo` (`applyBrevoEvent`) correlates straight back to
  the send row with no provider-message-id matching needed (falls back to `ses_message_id` for sends made
  before the tag existed). Brevo doesn't sign webhook payloads, so authenticity is a shared secret baked
  into the URL (`BREVO_WEBHOOK_SECRET`, fails closed if unset). Aggregate `opened`/`clicked` counters are
  gated on the send row's own `opened_at`/`clicked_at` being `NULL` (first occurrence only) — both here
  and in the legacy SES path — since a provider fires one event per open/click and re-opens are common;
  the un-gated version could push `campaign.opened` past `recipients`. `doUnsubscribe()` now also
  attributes the unsubscribe to the contact's most recent campaign send (best-effort — the unsubscribe
  token is per-contact, not per-send) and bumps that campaign's `unsubscribed` counter, which it
  previously never touched at all. `GET /campaigns/:id/stats` additionally returns computed `rates`
  (open/click/click-to-open/bounce/complaint/unsubscribe, denominated on `delivered` falling back to
  `sent`), `null` rather than `0` when the denominator is 0 so the UI shows a dash instead of a
  misleading percentage.
- **Manual step required** (can't be done from code — the Brevo SMTP credentials don't double as a REST
  API key in this account): register the webhook URL in Brevo's dashboard, Transactional → Settings →
  Webhook, for events delivered/opened/click/hard_bounce/soft_bounce/blocked/spam. Until that's done,
  only `recipients`/`sent` reflect reality; the rest stay at 0.

## 2026-06-26 changes (ad-data integrity: per-ASIN + ad-group, scheduled alert digests)

### `ingestReportData` pre-aggregates by `(amazon_id, date)`
- The `spAdvertisedProduct` report returns one row per *(campaign/ad group, ASIN, date)* — a single ASIN
  appears in many rows per day. The upsert key is `(profile_id, amazon_id, entity_type, date)`, so writing
  rows one-by-one with `DO UPDATE = EXCLUDED` **overwrote**: only the last campaign's row survived per
  ASIN/day, dropping the rest. Net effect: per-ASIN advertised_product spend (the basis of the entire
  Products page — PPC/ACOS/TACOS/ROAS) was under-counted ~46%, and overwritten-away ASINs showed €0.
- Fix: build a `Map` keyed by `(amazon_id, date)`, **sum** every metric across the rows, then upsert once
  per group. Idempotent (re-ingest reproduces the same sums) and a no-op for levels whose `amazon_id` is
  already unique per day (campaign/ad_group/keyword/target). Proof on prod: a sample window's
  advertised_product cost went €856 → **€1,580.58 = exactly the SP campaign-level total**; the full
  90-day range reconciled to within 0.02%. History re-backfilled by re-requesting the reports (Amazon caps
  a report range at **31 days**, so backfills chunk into ≤31-day windows).

### SP ad-group report fixed (was silently failing)
- SP ad-group metrics (`fact_metrics_daily entity_type='ad_group', campaign_type='SP'`, read by the
  ad-groups route's "direct" branch) were frozen/incomplete because (a) `["SP","ad_group"]` was absent
  from both report-level lists — the daily one in `scheduler.js` and the backfill one in
  `reporting.js` (SB/SD had it, SP didn't); and (b) the SP `ad_group` config used
  `reportType: "spAdGroups"`, which **Amazon rejects as an invalid reportTypeId**. SP ad-group data comes
  from the **`spCampaigns`** report with `groupBy: ["adGroup"]`; at that grouping `campaignId`/
  `campaignName` are not valid columns, so they were removed (the campaign link resolves from `adGroupId`
  via the `ad_groups` table in `resolveEntityId`). Added SP ad_group to both lists + corrected the config;
  history re-backfilled.

### Per-alert delivery schedule
- `conditions.schedule = { weekday: 0-6 (0=Sun…5=Fri), hour: 0-23, tz }`. `isScheduledDue(cfg, now)` in
  `evaluate.js` computes the current weekday+hour in `tz` (via `Intl.DateTimeFormat`, fail-open on a bad
  zone) and gates each config at the top of the `evaluateWorkspaceAlerts` loop — so the hourly alert cron
  (`15 * * * *`) fires a scheduled alert **only** during its weekday+hour, e.g. a Friday-08:00
  Europe/Berlin weekly product-movers digest. `evaluateWorkspaceAlerts({ force })` bypasses the gate for
  the manual `POST /alerts/check`. `parseSchedule()` validates on POST/PUT; PUT carries an existing
  schedule forward when the client omits it (no UI field yet). The product-movers digest title now carries
  the comparison window (`· Nd vs prior Nd`). Cooldown for the scheduled movers was set to 120h (< the 168h
  between Fridays) so the weekly run is never blocked by a not-quite-elapsed cooldown.
