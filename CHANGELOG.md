# Changelog

All notable changes to AdsFlow are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`

---

## [Unreleased] — 2026-04-27

### Added — Products report export (XLSX)

- **`POST /products/export`** — generates a multi-sheet XLSX report.
  - Accepts `{startDate, endDate, columns[], includeHistory}` body.
  - 18 selectable columns across 3 groups: Info (ASIN/Title/Brand/Marketplace), BSR (Latest/Min/Max/Avg/First/Last/Change %/Snapshots/Best Category), Ads (Spend/Sales/Orders/Clicks/ACoS).
  - Optional Sheet 2 "BSR History" with every snapshot in the period (frozen header, formatted timestamps).
  - Aggregates done in a single SQL with 3 CTEs: `bsr` (min/max/avg + first/last via `ARRAY_AGG ORDER BY captured_at`), `latest` (`DISTINCT ON`), `ads` (joins `fact_metrics_daily` by `entity_type='advertised_product'` and `amazon_id = ASIN`).
- **Frontend export modal** (`ProductsPage`) — preset periods (7d/30d/90d) + custom date pickers, grouped column checkboxes with select-all/none, optional history sheet toggle, in-modal loading state.
- i18n: 28 new keys in `products.export*` namespace across EN/RU/DE.

### Added — Search-term entity type for rules

- New scope `entity_type: "search_term"` in rule engine — aggregates `search_term_metrics` over the rule's period and applies `add_negative_keyword` (or `add_negative_target`) to matched queries.
- `query` from `search_term_metrics` is aliased to `keyword_text` so existing add-negative handler accepts both keyword and search-term entities without a special branch.
- Wizard auto-resets incompatible actions when entity type changes (e.g. switching to `search_term` keeps only `add_negative_keyword`).
- `ruleActionsList` items can declare `et` as a string OR array (`add_negative_keyword.et = ["keyword","search_term"]`).
- i18n key `rules.searchTerm` in EN/RU/DE.

### Added — Skip-reason tracking in rule preview

- `executeRule()` now records every entity that matched conditions but couldn't be acted on, with one of 5 reasons: `already_paused`, `already_enabled`, `not_enabled`, `already_negative`, `wrong_entity_type`.
- API response gains `skipped_count` and `skipped[]` array (each with `entity_id`, `keyword_text`, `campaign_name`, `action`, `reason`, `metrics`).
- Run-result modal renders a 4-counter funnel (`Evaluated → Passed conditions → Skipped → Will change`) with per-counter tooltips and a collapsible Skipped table where each reason is dotted-underlined and explained on hover.
- "Совпадений" → "Прошли условия" rename across EN/RU/DE; 12 new tooltip keys.

### Added — Per-day TACoS in metrics trend

- Trend SQL now wraps `fact_metrics_daily` aggregation with a `daily_revenue` CTE that sums `sp_orders.order_total_amount` per `purchase_date::date`. Each trend row carries `total_revenue` and a true per-day `tacos`.
- `Spark` component split into segments and ignores nulls — sparkline draws a gap on days without revenue instead of a misleading 0%.
- Headline TACoS uses an **aligned period**: spend and revenue are both summed only up to `MAX(purchase_date)` from `sp_orders`; response includes `tacosPeriod {start, end, days, requestedDays}`. UI shows an amber chip "20 Apr – 25 Apr · 6/8 d" with hover-tooltip when coverage is partial.

### Added — KPI sparklines with hover tooltip

- `Spark` rebuilt with optional `dates`, `format` props. Always-visible round dots (rendered as absolutely-positioned divs over the SVG to stay round under `preserveAspectRatio="none"`). Hover crosshair + emphasised dot + tooltip showing per-day `value · date`.
- Per-metric formatters (`spend → $1,234`, `acos → 12.3%`, `roas → 8.12×`, etc.) passed through `KPICard.sparkFormat`.

### Added — Continuous-line keyword rank chart + BSR hover time

- `HistoryBars` (Rank Tracker) replaced with SVG `<polyline>` chart in the BsrSparkline style: line + area gradient + dot per day + hover tooltip with `#rank · date hh:mm`.
- BSR sparkline tooltip now includes time (`27 Apr 2026, 08:00`) — disambiguates multiple snapshots per day.

### Added — Bulk expand/collapse all BSR histories

- Master toggle button on Products page (`Раскрыть все` / `Свернуть все`).
- Migrated `expandedId` (single string) → `expandedIds: Set<string>`. Per-product toggle adds/removes from set; master button fills/clears it.
- Lazy fetch in batches of 10 (`Promise.all` chunks) to avoid hammering the backend pool with 137 simultaneous requests.
- `loadAllNotes()` fetches every workspace note in one call so pins/notes appear on bulk-expanded charts.

### Added — Rule preview endpoint + wizard fix

- **`POST /rules/preview`** — accepts `{conditions, actions, scope, safety}` body, runs `executeRule` synthetically with `dry_run=true`. Never writes to `rules`, `rule_executions`, or `audit_events`.
- Wizard `handlePreview` unified: always sends current form state. Previously edit mode called `/rules/:id/run` which read the **stale DB version** of the rule, ignoring unsaved form edits.
- New endpoint defends against `Array.every([]) === true` mass-action bug: rejects empty `conditions` / `actions` with 400. Same check added to `executeRule()` (defense in depth) and `PATCH /rules/:id`.

### Added — KPI sales label adapts to SP-API availability

- "Общие продажи" KPI card now uses `totals.totalRevenue` (real organic + ads) when SP-API populated `sp_orders`. When sp_orders is empty, label switches to "Рекл. продажи" + tooltip explaining the difference. New i18n keys `kpiAdSales`, `kpiSalesTotalTooltip`, `kpiSalesAdTooltip`.

### Added — Tip placement + 4-column grid layout

- `Tip` component gains `placement: 'top' | 'bottom'` and `style` props. Used `placement="bottom"` for counter cards near the top of modals so tooltips don't clip against the modal edge.
- Counter cards switched from flexbox `flex:1` (the inline-flex Tip wrapper was the flex child, ignoring `flex:1` on the inner card) to `display:grid; grid-template-columns: repeat(4, minmax(0, 1fr))` — all four counters now equal width regardless of content.

### Fixed — TACoS calculation correctness

- Removed misleading `cost / sales_14d` fallback that produced ACoS-equal-to-TACoS when SP-API was absent. TACoS now returns `null` when no SP-API data — UI shows "—" with `tacosNoData` hint.
- Real TACoS computed from `sp_orders.order_total_amount` only.

### Fixed — Orders / Financials sync 400 InvalidInput

- `getOrders()` and `getFinancialEvents()` in `spClient.js` set `CreatedBefore` / `PostedBefore` to `now()`; Amazon SP-API requires it to be **at least 2 minutes earlier** because of ingestion lag. Result: every daily orders sync was failing with 400 for an unknown number of days.
- Now uses `now − 3 min` default with a clamp to `min(requested, now − 2 min)`. Also added 3-attempt rate-limit retry (`Retry-After` aware, 90 s cap) inside `_spRequest`.
- `syncOrders` first-time sync window reduced from 30 days to 7 days — Orders API rate is 0.0167 req/s (1/min), so a 30-page backfill could take an hour. Subsequent runs are incremental and tiny.

### Fixed — `purchase_date` timestamptz vs date-literal off-by-one

- `purchase_date BETWEEN '2026-04-22' AND '2026-04-22'` matched only midnight orders (because postgres coerces a date literal to `timestamptz at 00:00:00`). For a typical day with 247 orders, the metrics endpoint returned `0`. Fixed in 4 places (`metrics.js` × 2, `sp.js` × 2) by casting `purchase_date::date BETWEEN $a AND $b`.

### Fixed — Rules wizard rendered stale data on preview

- Wizard's "Preview" button was calling `/rules/:id/run` on the saved version when editing an existing rule, ignoring unsaved form edits. Replaced with the new `/rules/preview` endpoint that always uses the current form body.

### Fixed — Rules executor accepted empty conditions array (defense)

- `Array.prototype.every([])` returns `true`, so a rule with no conditions would mass-affect every entity in scope. `executeRule()` now throws `"Rule must have at least one condition"`. `POST /rules/preview` and `PATCH /rules/:id` validate explicitly.

### Fixed — Export endpoint hardening

- Malformed dates (`"abc"`, `"2026-13-99"`, numeric values) used to leak postgres stack trace via 500. Now rejected with 400 + ISO format check before the SQL.
- Numeric postgres columns (NUMERIC) come back as strings via `node-postgres` — they were stored as text in XLSX, breaking number formatting. Now coerced to JS `Number` for any column with a `numFmt`.
- OWASP CSV/XLSX formula injection mitigation: text cells starting with `= + - @ \t \r` are prefixed with a single quote so Excel renders them as text instead of executing.

---

## [Unreleased] — 2026-04-17

### Fixed — TACoS metric

- **TACoS now displays without SP-API** — falls back to `sales_14d` (ad-attributed sales) as denominator when `sp_orders` table is empty; `tacosSource: 'sp_api' | 'ads_attributed'` returned in metrics response.
- When SP-API is connected, true TACoS (Spend / Total Revenue from orders) is used automatically.
- i18n: `tacosEstimated` key added to EN / RU / DE.

### Added — Product metadata auto-sync

- **`scrapeProductMeta(asin, marketplaceId)`** — scrapes title, brand, and main image from Amazon product page (`/dp/{ASIN}`); uses existing ScraperAPI / proxy / UA-rotation infrastructure from rankScraper; decodes HTML entities.
- **`syncProductsMeta(workspaceId, db)`** — batch syncs all products without `title` for a workspace; respects 3–7 s delay between ASINs (no SP-API required).
- **BullMQ queue `product-meta-sync`** — dedicated worker, job deduplication by workspace ID.
- **Daily cron 04:30 UTC** — automatically queues meta sync for workspaces with `title IS NULL` products.
- **`POST /products/sync-meta`** — manual trigger endpoint (auth required).
- **Auto-trigger on add** — `POST /products` (add ASIN) immediately queues meta sync when SP-API is not configured.

### Changed — Products coverage

- **19 missing ASINs** found in campaign names (regex `B0[A-Z0-9]{8}`) but absent from `products` table — added automatically.
- Total products: 117 → 136; titles scraped for 128 / 136 (8 are discontinued / 404 on amazon.de).

---

## [Unreleased] — 2026-04-06

### Added — Keyword Research (new section)

- **Amazon URL → ASIN parser** — paste any `amazon.*/dp/B0XXXXXXXX` URL; ASIN, TLD, marketplace profile, and target language are auto-detected and filled.
- **Multi-source discovery pipeline**: Amazon Ads keyword recommendations · Claude AI seed generation (native language) · Jungle Scout ASIN reverse lookup + AI-seed expansion.
- **Relevance scoring** — Claude AI scores and filters every keyword (threshold ≥ 50); result sorted by relevance + source priority.
- **Floating action bar** — appears when ≥1 keyword selected; supports per-row match-type override, bulk bid input, and one-click "Add to ad group".
- **Add-to-ad-group write-back** — deduplicates by `keyword_text + match_type` before INSERT, then pushes to Amazon Ads API asynchronously (non-blocking).
- **Jungle Scout not connected** notice shown in footer when `JUNGLE_SCOUT_API_KEY` absent.
- New backend routes: `POST /keyword-research/discover`, `POST /keyword-research/add-to-adgroup`.
- New services: `services/ai/keywordResearch.js`, `services/amazon/keywordRecommendations.js`.

### Added — KW Research i18n (EN / RU / DE)

- 50+ new translation keys under `kwr.*` namespace added to all three language files.
- Zero language mixing — every visible string in the section goes through `t("kwr.*")`.
- German typographic quotes (`„…"`) encoded as Unicode escapes to avoid JS parse errors.

### Changed — Keyword Research UX Redesign

- Sectioned card layout: **Product** (URL + ASINs + title) · **Settings** (profile / ad group / language) · **Sources + action**.
- Source pills with toggle on/off (Amazon Ads · Claude AI · Jungle Scout), tooltip descriptions.
- Results table with relevance progress bar, match-type badge switcher, search volume and suggested bid columns.
- `slideInFromBottom` animation on floating action bar.

### Fixed — Backend (reporting, workers, search terms)

- **SB keyword report field** — `"keyword"` → `"keywordText"` (Amazon Reporting API v3 schema; was causing 400 on all Sponsored Brands keyword-level reports).
- **Backfill deduplication** — `queueMetricsBackfillJobs` now checks `report_requests` for already-active records and skips duplicates.
- **Report worker concurrency** — reduced 2 → 1 to avoid Amazon 429 throttle cascades.
- **Stale report cleanup** — on worker startup, records stuck in `processing`/`requested` for >2 h are marked `failed`.
- **Search terms pagination** — `parseInt(page)` could yield negative offset on bad input; now clamped to `Math.max(1, …)`.
- **Search terms workspace filter** — keywords subquery was missing `WHERE k.workspace_id = $1`; could surface keywords from other workspaces in campaign-name resolution.
- **Search terms `metricsDays` NaN guard** — `isNaN()` check prevents `INTERVAL 'NaN days'` SQL error.
- **Add-negative ASIN routing** — `POST /search-terms/add-negative` now detects `B0[A-Z0-9]{8}` pattern and routes to `negative_targets` (ASIN) vs `negative_keywords` (text) automatically.
- **`applyParsedUrl` variable shadow** — `setProductTitle(t => …)` callback parameter renamed to `prev` to avoid shadowing the i18n `t` function.

---

## [Unreleased] — 2026-04-01

### Added — Products & BSR Page

- **118 ASINs auto-populated** from `fact_metrics_daily` (entity_type=`advertised_product`) — no manual entry needed.
- **Client-side search** — filters by ASIN, title, or brand in real time.
- **Brand filter dropdown** — shows all unique brands (EVOCAMP, Björn&Schiller, WEST & EAST, farosun); hidden when only one brand present.
- **Sort options**: BSR rank (best rank first), Title (A→Z), ASIN (A→Z), Last updated (newest first).
- **Product count badge** — shows `X / total` when filter is active.
- **"No matches" empty state** with "Clear filters" shortcut.
- **In-place refresh** — clicking ⟳ on a product card updates only that row via `mutate()` (no full-list reload, scroll position and filters preserved).
- **In-place delete** — removes row from list via `mutate()` without reload.

### Added — BSR Sync: Rate-limit Recovery

- `spSync.js` `syncBsr` — on SP-API 429 (rate limit) pauses 10 s then continues remaining ASINs instead of skipping them silently.
  Inter-request delay increased from 200 ms → 600 ms to reduce rate-limit frequency.

### Security — Invite-only Access & Brute-force Protection

- **Registration disabled** — `POST /auth/register` returns `403` with invite message; open sign-up removed from UI.
  New users can only join via email invitation sent by an owner or admin (Settings → Members).
- **Login brute-force limit tightened** — reduced from 20 → **5 failed attempts per IP per 15 minutes** (`skipSuccessfulRequests: true` so legitimate logins don't consume quota).
  6th attempt returns HTTP 429.
- **Login page** — registration tab removed; replaced with "Access by invitation only" notice.

### Security — Infrastructure Hardening

- **Redis (6379) and PostgreSQL (5432) removed from public port bindings** on production server.
  Both services are now reachable only within the internal Docker bridge network; no external exposure.
  Backend connects via Docker service names (`redis:6379`, `postgres:5432`).

---

## [Unreleased] — 2026-03-31

### Added — Keyword Rank Tracker (new section)

- **Migration `016_keyword_rank_tracking.sql`** — two new tables:
  - `tracked_keywords (id, workspace_id, asin, keyword, marketplace_id, is_active)` — unique per workspace+asin+keyword+marketplace.
  - `keyword_rank_snapshots (id, tracked_keyword_id, position, page, found, blocked, captured_at)` — one row per check per keyword.
- **`rankScraper.js`** (new service) — scrapes Amazon search results for organic keyword positions.
  Scans up to 3 pages (~48 results), skips sponsored slots (`data-component-type="s-sponsored-result"`),
  rotates 7 User-Agent strings, random 5-12 s delay between pages, 20-50 s between keywords,
  detects CAPTCHA / 503 / 429 → stops batch immediately and marks snapshot `blocked=true`.
  Supports 6 marketplaces: DE, US, UK, FR, IT, ES.
- **`routes/keywordRanks.js`** (new) — REST endpoints:
  - `GET /keyword-ranks` — list with LATERAL JOIN for latest + previous positions (delta calculation).
  - `POST /keyword-ranks` — add keyword (asin + keyword + marketplaceId), ON CONFLICT upsert.
  - `DELETE /keyword-ranks/:id` — soft delete (`is_active = false`).
  - `GET /keyword-ranks/:id/history?days=7|30` — snapshot history for chart (up to 90 days).
  - `POST /keyword-ranks/:id/check` — manual single-keyword scrape.
  - `POST /keyword-ranks/check-all` — queues full workspace rank check (async, responds immediately).
- **BullMQ `rank-check` queue** — `queueRankCheck(workspaceId)` with `jobId` deduplication
  (one job per workspace), concurrency 1, 1-hour rate limiter.
- **Scheduler** — `rankCheckJob` cron `0 3 * * *` (daily 03:00 UTC) queues rank checks for all
  workspaces with active tracked keywords.
- **Frontend `RankTrackerPage`** — new standalone section "Позиции" / "Rank Tracker" / "Rankings":
  - Add form: ASIN + keyword text input, Enter support.
  - List grouped by ASIN. Each keyword row: colour-coded position badge (#1-3 gold, #4-10 green,
    #11-20 teal, #21-48 amber, >48 red), delta arrow (↑↑↓ vs prev snapshot), last-checked timestamp.
  - Expandable history: bar chart with week / month toggle (7 / 30 days).
  - "Check now" button per keyword (real-time scrape), "Check all" workspace button.
  - SVG sparkline + HistoryBars components, no external chart library needed.
- **NAV** — new entry `{ id: "rankings", icon: LineChartIcon }` between Keywords and Reports.
- **i18n** — `rankings.*` keys added to `en.js` / `ru.js` / `de.js`.

### Added — Keyword Filters: Exclude Paused & Disabled Campaigns

- **Backend `keywords.js`** — two new query params:
  - `excludePaused=true` → adds `k.state != 'paused'` condition.
  - `excludeDisabledCampaigns=true` → adds `c.state = 'enabled'` condition.
- **Frontend** — two toggle buttons in Keywords filter bar: "Без паузы" / "Только акт. кампании".
  State stored in `useSavedFilters` (persists across sessions). Active buttons highlighted in primary colour.
- **`KEYWORD_DEFAULT_FILTERS`** — extended with `excludePaused: false, excludeDisabledCampaigns: false`.
- **i18n** — `keywords.excludePaused` / `keywords.excludeDisabledCampaigns` in all three locales.

### Added — Negative ASINs Feature

- **Migration (in `010_sp_api.sql`)** — `negative_targets` table with `expression JSONB` column
  storing `[{type:"asinSameAs",value:"B00XXX"}]`.
- **`routes/negativeAsins.js`** (new) — CRUD:
  - `GET /negative-asins` — paginated list with campaign name via LEFT JOIN.
  - `POST /negative-asins` — add single ASIN to campaign.
  - `POST /negative-asins/bulk` — add multiple ASINs × multiple campaigns.
  - `DELETE /negative-asins/:id` — single delete.
  - `DELETE /negative-asins/bulk` — bulk delete by `{ ids }` array.
- **`writeback.js`** — `pushNegativeAsin()` — posts `{expression, expressionType:"manual", state:"enabled"}`
  to SP-API `/sp/negativeTargets`, updates local DB with real Amazon negative target ID.
- **Rule engine** — new action type `add_negative_asin`: pre-checks for duplicate expression,
  inserts `negative_targets` row, calls `pushNegativeAsin()` async; respects `dry_run` flag.
- **Frontend** — `NegativesTab` split into sub-tabs: "Neg. Keywords" | "Neg. ASINs".
  `NegativeAsinsTab`: table with ASIN column (monospace), campaign name, level badge;
  single-add modal; bulk-add modal with campaign picker; bulk delete.
- **Rule builder** — `add_negative_asin` action added to `ACT_TYPES` with ASIN unit label.
- **Tests** — `test_negative_asins.js`: 8 tests, 24 assertions — all passing.

### Added — Search Terms: Campaign Name Resolution

- **Migration `014_search_term_amazon_campaign_id.sql`** — adds `amazon_campaign_id TEXT` and
  `amazon_ad_group_id TEXT` columns to `search_term_metrics`. Back-fills from campaigns table
  (pass 1: by UUID, pass 2: by keyword text+match_type where unique).
- **Migration `015_search_term_dedup.sql`** — removes duplicate rows for `campaign_id IS NULL`
  (kept row with max impressions per group). Adds partial unique index
  `idx_stm_null_campaign_unique` to prevent future duplicates. Result: 7 787 → 1 961 rows.
- **`reporting.js`** — dynamic `ON CONFLICT` clause: uses `campaign_id`-based index when UUID
  resolved, `(workspace_id, query, keyword_text, match_type, date_start, date_end)` partial
  index when `campaign_id IS NULL`. Stores `amazon_campaign_id` text on every ingestion.
- **`searchTerms.js` route** — upgraded JOIN strategy for `campaign_name` resolution:
  `COALESCE(c1.name, c2.name, stm.campaign_name, kw_c.campaign_name)` where `kw_c` is a
  keyword-based subquery matching `keyword_text + match_type` case-insensitively.

### Fixed — Security: axios pinned to safe version

- `axios` pinned from `^1.7.2` to `1.14.0` (exact) in both `backend/package.json` and
  `frontend/package.json` following supply-chain attack on `1.14.1` / `0.30.4`
  (malicious `plain-crypto-js` dependency, RAT dropper, March 2026).

---

## [Unreleased] — 2026-03-30

### Added — Search Terms Pipeline

- **`spSearchTerm` report config** added to `reporting.js` — `REPORT_CONFIGS` now includes
  `SP.searchTerm` with groupBy `["searchTerm"]` and full metrics set.
- **`ingestSearchTermData()`** — new function in `reporting.js`: resolves campaign/adGroup/keyword
  UUIDs by Amazon ID, upserts per-day rows into `search_term_metrics`, handles missing entities
  gracefully. Called by `runReportingPipeline` when `reportLevel === "searchTerm"`.
- **`queueMetricsBackfillJobs`** now includes `["SP", "searchTerm"]` — backfill syncs search
  term data alongside keyword/campaign metrics.
- **Daily scheduler** — `reportSyncJob` extended with `["SP", "searchTerm"]` report pair.
- **`POST /api/v1/search-terms/sync`** — manual trigger endpoint, queues `queueMetricsBackfill`
  for last 30 days for the current workspace.

### Added — Search Terms UI

- **Campaign type filter** (SP / SB / SD) — filter buttons above the table, maps to
  `campaignType` query param; backend filters via `campaigns` join subquery.
- **Multi-select checkboxes** — select-all header checkbox + per-row checkbox, same pattern as
  Keywords tab. `stSelected` Set state, cleared on reload.
- **Bulk panel** — appears when ≥1 row selected: "Add as keyword" and "Add as negative" bulk
  actions, count badge.
- **Harvest modal** — supports 3 levels:
  - *Account* — applies query to all campaigns (uses `campaignIds[]` bulk API)
  - *Campaign* — picker with live search across workspace campaigns + ad groups
  - *Ad group* — nested ad group picker within selected campaign
  - Configurable match type and bid; totals `added`/`skipped` across all targets.
- **`GET /api/v1/search-terms/campaigns`** — new endpoint returns campaigns with nested
  `ad_groups` JSON array for the harvest modal picker.

### Added — Negatives Tab: Full Rebuild

- **Filters** — search text, match type (Exact / Phrase / All), level (Campaign / Ad Group / All),
  campaign type (SP / SB / SD). All filters combined server-side.
- **Sort** — by keyword text, match type, level, campaign, date (asc/desc toggle).
- **Pagination** — page size selector (25/50/100/200), prev/next navigation, total count.
- **Inline edit** — double-click any keyword text to edit in-place; Enter to save, Escape to cancel.
- **Match type toggle** — click Exact/Phrase badge to flip match type in one click.
- **Bulk select** — select-all + per-row checkboxes; bulk panel shows count + actions.
- **Bulk delete** — `DELETE /api/v1/negative-keywords/bulk` with `{ ids }`.
- **Add single modal** — campaign picker + keyword text + match type.
- **Bulk add modal** — multi-line textarea (one keyword per line), campaign multi-select,
  match type selector. Uses `POST /api/v1/negative-keywords/bulk`.
- **Copy to campaigns modal** — copies selected negatives to one or more other campaigns.
- **Export CSV** — `GET /api/v1/negative-keywords/export.csv` streams CSV with auth header.
- **Response fields** — `ad_group_name`, `campaign_type`, `campaign_name` included in all
  GET responses via LEFT JOIN.
- **Match type normalisation** — backend accepts and stores both `negativeExact`/`negativePhrase`
  (camelCase) and `negative_exact`/`negative_phrase` (snake_case); GET filter uses
  `ANY(['negativeExact','negative_exact'])` to match either format.
- **`PATCH /api/v1/negative-keywords/:id`** — update `keyword_text` and/or `match_type`;
  validates both camelCase and snake_case formats; writes audit log.

### Added — Auth: Password Reset Flow

- **Migration `012_password_reset.sql`** — `password_reset_tokens` table with expiry and
  `used_at` tracking.
- **`POST /api/v1/auth/forgot-password`** — generates token, sends reset email via `email.js`.
- **`POST /api/v1/auth/reset-password`** — validates token, updates password hash, marks
  token used.
- **`email.js`** extended — `sendPasswordResetEmail()` with HTML + text templates.

### Fixed — CampaignMultiSelect dropdown overflow

- Dropdown was opening off-screen to the right when the trigger button is near the right edge.
  Fixed: `right: 0` anchor (was `left: 0`), `width: 320px` fixed width (was `minWidth: 260px`).

### Added — i18n

- New keys in `en.js` / `ru.js` / `de.js`: `searchTerms.harvestModal.*`,
  `negatives.addModal.*`, `negatives.bulkAdd.*`, `negatives.copyTo.*`,
  `negatives.filters.*`, `negatives.export` covering all new UI strings.

---

## [Unreleased] — 2026-03-28

### Added — SP-API Infrastructure (BSR / Inventory / Orders / Financials / Pricing)

- **Migration `010_sp_api.sql`** — new tables: `products`, `bsr_snapshots`, `sp_inventory`,
  `sp_orders`, `sp_order_items`, `sp_financials`, `sp_pricing`, `sp_sync_log`.
  Partition `fact_metrics_daily_2027` added. All tables with indexes and `updated_at` triggers.
- **`spClient.js`** rewritten — added `_spRequest()` helper with 429 retry/backoff.
  New methods: `getInventory()`, `getOrders()`, `getOrderItems()`, `getFinancialEvents()`,
  `getCompetitivePricing()` — all with pagination loops.
- **`spSync.js`** (new) — `syncBsr()`, `syncInventory()`, `syncOrders()`, `syncFinancials()`,
  `syncPricing()`. Each writes to `sp_sync_log`, handles incremental sync, upserts data.
- **SP_SYNC BullMQ queue** — `queueSpSync(workspaceId, marketplaceId, syncTypes, priority)`,
  `spSyncWorker` (concurrency 2) added to `workers.js`.
- **Scheduler** — `spSyncJob` (every 4h: bsr+inventory+pricing), `spDailyJob` (05:00 UTC: orders+financials).
- **`GET/POST /api/v1/sp/*`** routes — inventory, inventory/summary, orders, orders/summary,
  orders/:id/items, financials, financials/summary, pricing/current, pricing/:asin,
  sync (manual trigger), sync/status.

### Added — Full Report Coverage (SB + SD ad_group/target)

- **`reporting.js`** — added SB section (`sbCampaigns`, `sbKeywords`, `sbAdGroups`) and SD
  `sdAdGroups` + `sdTargeting` to `REPORT_CONFIGS`. Daily scheduler now queues all 10 report
  type/level combinations (SP×4, SB×3, SD×3).

### Added — UI: Light Theme + Dark/Light Toggle

- **Light theme** — `[data-theme="light"]` CSS variable overrides: neutral `#F0F4F8` background,
  white surfaces, `#0F172A` text (contrast 16:1), adjusted accent/semantic colors for light bg.
- **Theme toggle** button (Sun/Moon icon) in sidebar footer; state persisted in `localStorage`
  (`af_theme`). Applied via `data-theme` attribute on `<html>`.

### Added — UI: Collapsible Sidebar

- **Sidebar collapse** to 56px icon-only rail. Nav items show `title` tooltip on hover.
  Workspace chip + user name hidden when collapsed.
- **Fixed edge toggle button** (`position: fixed`, `left` transitions with sidebar) — stays at
  the sidebar/content boundary regardless of collapsed state. Pattern matches Linear/Notion.
- State persisted in `localStorage` (`af_sidebar`). `<main>` margin transitions synchronously.

### Added — UI: Avatar Profile Dropdown (logout protection)

- **Avatar dropdown** — logout button removed from direct access. Clicking avatar opens portal
  dropdown (rendered via `createPortal` to escape `overflow: hidden`): user info, language,
  theme toggle, sign out. Portal uses `getBoundingClientRect` for `position: fixed` placement.
- Prevents accidental logout (requires 2 deliberate clicks). Pattern: Linear / Vercel / GitHub.

### Fixed — UI: Bid Input Decimal Precision

- Bid editor now initialises with `parseFloat(bid).toFixed(2)` — always 2 decimal places,
  never shows raw DB values like `1.5000`.

### Fixed — UI: "Edit Bid" Button Hover Persistence

- Replaced CSS `.tbl-row:hover .act-cell` approach (which persisted after cursor left) with
  React-controlled `hoveredKwId` state + inline `opacity`/`pointerEvents` style override.

### Fixed — UI: Rule Templates Collapsible Section

- Added expand/collapse toggle to "Start from template" section in Rules wizard step 1.
  State local to modal; arrow indicator rotates on toggle. Default: expanded.

---

## [Unreleased] — 2026-03-27

### Added — Sprint 3 · S3-2..S3-5 + Custom Date Range + Multi-Campaign Filter

#### S3-2 · Rule Execution History Modal
- **`GET /api/v1/rules/:id/runs`** — returns last 50 rows from `rule_executions` table (started_at,
  completed_at, dry_run, status, entities_evaluated, entities_matched, actions_taken, summary, error_message)
- **`RuleHistoryModal`** — portal modal triggered by new `History` icon button on every rule card.
  Shows per-run cards with timestamp, Live/Simulation badge, matched/actions counts, up to 3 summary
  items, error message on failure.

#### S3-3 · AI Suggested Prompts
- 6 prompt chips above AI textarea (zero-deps, no library). Click fills `prompt` state.
  Prompts: "Which campaigns are overspending budget?", "Where is ACOS too high?",
  "Which keywords should be paused?", "Show top performers this week",
  "Which search terms to add as keywords?", "Where are the most wasteful clicks?"

#### S3-4 · Negative Keywords Management
- **`GET/POST/DELETE /api/v1/negative-keywords`** — uses existing `negative_keywords` table
  (migration 004). POST auto-looks up `profile_id` from campaign, generates
  `manual_neg_<timestamp>_<6-char-random>` as `amazon_neg_keyword_id`. Supports multi-campaign
  `campaignIds[]` array filter.
- **`NegativesTab`** — new "Negatives" tab in Keywords page (alongside Keywords / Search Terms).
  Toolbar: text search + campaign select dropdown + "Add negative" button + count.
  Inline add form: campaign select / keyword input / match type (negativeExact|negativePhrase).
  Table: Keyword / Type badge / Level / Campaign / Delete action.

#### Custom Date Range in Keywords & Search Terms
- **Backend `keywords.js`**: removed static `metricsInterval`, replaced with `dateFrom`/`dateTo`
  (ISO `YYYY-MM-DD`, regex-validated) that override `metricsDays` fallback. Date params are
  passed as SQL parameters (`$N::date`) — no string interpolation of user input.
- **Backend `searchTerms.js`**: same pattern; filters by `date_start >= dateFrom AND date_end <= dateTo`
  (columns that exist in `search_term_metrics`). Default fallback filters by `date_start >= NOW()-Ndays`.
- **Frontend `DateRangePicker`** — reusable component: 4 preset buttons (7d/14d/30d/90d) +
  "Range" toggle showing two native `<input type="date">` fields. Zero external dependencies.
  Active preset highlighted with `btn-primary`.

#### Multi-Campaign Filter in Keywords & Search Terms
- **Backend**: both routes accept `campaignIds[]` (Express array) or `campaignIds` (comma-separated
  string). Uses `= ANY($N)` parameterized — SQL-injection safe.
- **Frontend `CampaignMultiSelect`** — dropdown with checkbox list, search input, lazy-load of campaigns
  on first open via `apiFetch('/campaigns?limit=500')`. Shows campaign type badge (SP/SB/SD).
  "Clear (N)" button when selection active. Overlay click-away to close.

#### i18n
- Added `negatives.*`, `rulesHistory.*`, `metrics.tacos/tacosTooltip` keys to EN / RU / DE.

---

## [Unreleased] — 2026-03-26

### Security — Production Hardening

- **OAuth CSRF state → Redis** — `buildAuthUrl` / `validateState` in `lwa.js` migrated from
  in-memory `Map` to Redis (`oauth:state:<token>`, TTL 10 min). Tokens consumed atomically
  (`GET` + `DEL`). Survives server restarts; safe for multi-instance deployments.

- **Auth rate limiting** — Dedicated `express-rate-limit` limiter (20 req / 15 min per IP)
  applied to `POST /auth/login`, `POST /auth/register`, `POST /auth/accept-invite`. Prevents
  brute-force and credential stuffing attacks. Global API limiter (300 req/min) still applies.

- **Token leak prevention** — Removed `tokenPreview` field from `getValidAccessToken` logs
  (was logging first 20 chars of decrypted access token).

### Added — User Invitation System

- **Email invitations via Brevo SMTP** — `backend/src/services/email.js` with nodemailer +
  smtp-relay.brevo.com:587. `sendInviteEmail()` sends branded HTML invite with role, workspace
  name, and one-click accept link (7-day TTL). Non-fatal: invite saved to DB even if email fails.

- **`workspace_invitations` table** (migration `007_invitations.sql`) — UUID PK, unique token
  (64-char hex), `is_new_user` flag, `accepted_at`, `expires_at` (default +7 days).

- **Invite flow** — `POST /settings/workspaces/:id/invite` generates token + sends email.
  Existing users added to workspace immediately; new users register via invite link.
  `GET /auth/invite/:token` returns invite info. `POST /auth/accept-invite/:token` sets
  password (new users), adds to `workspace_members`, returns JWT for auto-login.

- **`InvitePage` frontend** — Auto-detected via `/invite/[64-char-hex]` path pattern.
  Shows workspace name, inviter, role. Password field for new users. Auto-logs in after accept.

### Added — Logout

- **Logout button** — `LogOut` icon in sidebar (bottom-right). Clears `af_token` +
  `af_workspace` from localStorage, resets all React state.

### Added — Sprint 3 · S3-1 Search Term Harvesting

- **S3-1 · Search Term Harvesting** — Full-stack implementation. New "Search Terms" tab in
  Keywords page (beside Ключевые слова / Таргеты). Backend: `search_term_metrics` table
  (migration `009_search_terms.sql`) with workspace/campaign/keyword FKs, unique constraint,
  4 indexes. Three endpoints: `GET /api/v1/search-terms` (paginated, 5 filters, server-side
  ACOS), `POST /search-terms/add-keyword` (harvest query → enabled keyword, profile_id +
  ad_group_id lookup, dedup, audit), `POST /search-terms/add-negative` (campaign-level negative,
  fallback ad_group lookup via `amazon_keyword_id = 'harvest_neg_' + uuid`). `spSearchTerm`
  report type added to reporting pipeline. Frontend: toolbar with search + All/🟢 Harvest/🔴
  Negate filters + count; sortable table (Query/Campaign/Impr./Clicks/Orders/Spend/ACOS/
  Suggestion/Actions); `stRecommendation()` auto-classifies rows (harvest: orders≥1 + ACOS<40%,
  or orders≥2 + ACOS<30%; negate: clicks≥10 + orders=0); row tints rgba(green,0.04) /
  rgba(red,0.04); "+ Exact KW" and "− Negate" action buttons per row; empty state with
  spSearchTerm explanation + 24-48h data lag note.

### Added — Sprint 2 · Group C (Architecture)

- **S2-4 · Campaign drill-down slide panel** — Click campaign name (turns blue/underlined on hover)
  → 520px slide-in panel from right (200ms `slideInRight` animation, `ReactDOM.createPortal`).
  Header shows: full name + KPI chips (Type / Status / Budget / Spend / ACOS / ROAS).
  Body: keywords table with Keyword / Match / Bid / Clicks / ACOS / Spend columns, sorted by spend.
  Fetches `GET /keywords?limit=200&campaignId=X` — server-side filtered (campaignId param in
  keywords.js was already implemented; fix was docker container rebuild with stale code).
  Escape key + backdrop click close the panel. `@keyframes slideInRight` added to CSS.

- **S2-5 · Dayparting in rule wizard** — `DAYPARTING` section in Step 1, below dry_run/is_active.
  7 toggle buttons (Mo–Su) + "Run at hour" dropdown (Any / 00:00–23:00) with live cron preview
  (`→ 0 * * * 1,2,3`) and Clear button. `dayparthingToCron()` / `cronToDayparting()` helpers.
  `DP_DAYS` constant. Stored in `scope.dayparting` + `schedule` field. `openEdit` restores
  dayparting from `scope.dayparting` or parses existing cron. Rule cards show teal
  `⏰ Mo,Tu,We · 14:00` badge when custom cron schedule exists.

### Added — Sprint 2 · Group B (Logic + UI)

- **S2-1 · Keyword performance metrics** — 4 new sortable columns in Keywords table:
  Клики / Заказы / ACOS / Spend. API already returned these fields. `useResizableColumns`
  updated from 7 to 11 columns. ACOS uses `acosColor()` from S1-3. null/zero → `—`.
  Sort support added for all 4 new fields (float comparison).

- **S2-2 · AND/OR toggle between rule conditions** — `condOperators: string[]` state parallel
  to `conditions[]`. Static AND `<span>` replaced with clickable `<button>` — amber styling
  for OR, standard for AND. `addCond` appends `'AND'`; `remCond` removes adjacent operator.
  Live preview sentence uses `condOperators[i-1]` with amber color for OR.
  Save payload includes `nextOperator` field per condition gap.

- **S2-6 · Onboarding checklist on Overview** — 5-step widget above KPI grid.
  Auto-detects completion from existing state: connections, `last_refresh_at`, rulesCount
  (single `/rules?limit=1` fetch), `user?.settings?.target_acos`. Progress bar + ✓ circles
  + CTA buttons. × dismiss persists to `localStorage` (`af_checklist_done`). Auto-dismisses
  after 2s when all 5 steps complete. `onNavigate` prop from App → setActive.

### Added — Sprint 2 · Group A (Visual)

- **S2-3 · Budget utilization bar** — `budgetUtil(spend, budget, days)` helper in Campaigns
  table budget column: 3px colored bar below dollar value. Thresholds: gray <50%, green 50-84%,
  amber 85-99%, red ≥100%. `Tip` tooltip shows avg daily spend / budget / % utilized.
  Uses `campFilters.metricsDays` for avg daily calculation.

- **S2-7 · AI recommendation params** — `renderAiParams()` + `AI_PARAM_LABELS` map.
  Parses JSON from recommendation `params` object, renders as key:value pills in styled box.
  Graceful fallback if no params or invalid JSON.

- **S2-8 · Target ACOS on dashboard** — `KPICard` gets optional extra slot. Overview ACOS card
  shows "✓ On target" (green) or "↑ Above target" (red) vs `user?.settings?.target_acos`.
  Settings → Workspace: TARGET ACOS (%) number input + `Tip` tooltip, saved via PATCH workspace.

### Added — Sprint 1 · Group C (Rules UX) — 2026-03-23

- **S1-1 · Rule templates** — 6 templates in 3×2 grid, Step 1 wizard, `!editRule?.id` condition
  (fix: was `!editRule`, `{}` is truthy). `applyTemplate()` fills form + jumps to Step 2.
- **S1-2 · Rule preview (Step 4)** — dry-run via `POST /rules/:id/run`, stat cards + sample table.
- **S1-6 · Tooltips** — `Tip` component (zero deps): COOLDOWN, Attribution Window, SIM, Data Period.
- **S1-8 · Readable audit events** — 14-entry label map, date separators, "Amazon Ads Account".
- **S1-9 · Products empty state** — guided empty state, removed dev error message.
- **S1-10 · Reports UX** — date presets (7d/14d/30d), readable period/type, failed tooltip.

### Changed — Sprint 1 · Group A+B — 2026-03-23

- **S1-3** `acosColor()`: green <15%, amber 15-30%, red >30%. Campaigns + Keywords + Overview.
- **S1-4** Status badge clickable → inline editor (Campaigns + Keywords).
- **S1-5** Hover-row actions: opacity 0→1 (150ms), always-on when selected, touch fallback.
- **S1-7** `fmtLastSync()`: `· X min ago` after Refresh in Overview/Campaigns/Keywords.

### Added — Documentation — 2026-03-23
- `docs/ROADMAP.md` — 4-sprint product roadmap, priority matrix
- `docs/UX_AUDIT.md` — full 12-section audit + competitive gap analysis

### Changed (UI — pre-Sprint 1)
- All unicode icon characters replaced with Lucide React SVG icons (strokeWidth 1.75)
- NAV icons: Activity, Megaphone, Tag, Package, Newspaper, Layers, Workflow, Bell, Sparkles, History, Cable, Cog
- Action icons: Edit2, Trash2, Play, Pause, Eye, Undo2, Power, Percent, Target, Ban, Filter, Archive, Hourglass
- Rule creation modal → 3-step wizard (Basics / Conditions / Actions) with step indicator and Вперёд/Назад navigation
- Rule wizard Step 2 — live sentence preview updates reactively as user edits conditions
- Rule conditions — metric select now has correct flex proportions (metric: flex:1, operator: 76px fixed, value: 130px fixed)
- Rule conditions — unit suffixes added after value input (€ for spend/sales/bid/cpc, % for acos/ctr, × for roas)
- Rule wizard Step 3 — two-column layout (Actions card + Scope card), campaign search filter, bid guardrails
- `svg[class*="lucide"]` CSS rule added for consistent vertical alignment across all icon usages

---

## [0.3.0] — 2026-03-06 · Stage 2: Automation & Alerts
**Commit:** `(pending push)` — `feat: Stage 2 — Rules engine, Alerts, Keywords, Bulk actions + modal fix`

### Added
- **Rule Engine** (`/rules`) — automated optimization rules evaluated every hour or daily
  - Conditions: `acos_gt`, `spend_gt`, `ctr_lt`, `impressions_lt`
  - Actions: `pause_campaign`, `adjust_bid_pct`, `adjust_budget_pct`, `add_negative_keyword`
  - Schedule: hourly (`0 * * * *`) or daily (`0 8 * * *`)
  - Dry-run mode: logs actions without applying changes
- **Alerts** (`/alerts`) — metric threshold notifications
  - Configurable metric, operator, threshold value
  - Channels: in-app and email
  - Cooldown period to prevent alert spam
  - Two tabs: Configs and Triggered instances
- **Keywords management** — full table with inline bid editing, bulk selection, bulk % bid adjustment
- **Bulk actions** on Campaigns — checkbox selection, toolbar: Pause / Enable / Archive / Adjust Budget %
- **BullMQ rule-engine worker** — evaluates active rules against current metrics on schedule
- **DB migration** `003_rules_alerts.sql` — `schedule_type` column on rules, `last_triggered_at` on alerts, 3 performance indexes
- New API routes: `POST/GET/PUT/DELETE /api/v1/rules`, `GET/POST /api/v1/alerts/configs`, `POST /api/v1/bulk/campaigns/status`, `POST /api/v1/bulk/campaigns/budget`, `POST /api/v1/bulk/keywords/bid`
- i18n keys added to `en.js` and `ru.js` for all new UI strings (`rules.*`, `alerts.*`, `keywords.*`, `campaigns.*`)

### Fixed
- **Modal cut-off bug** — Rules create/edit modal was clipped at top; overlay now uses `align-items: flex-start` + `overflow-y: auto` + `padding: 20px`

---

## [0.2.0] — 2026-03-06 · i18n: Russian & English
**Commit:** `acae0d1` — `feat: add i18n support (RU/EN) with language switcher`

### Added
- `src/i18n/index.jsx` — `I18nProvider` context + `useI18n()` hook, locale persisted in `localStorage` as `af_locale`
- `src/i18n/ru.js` — Russian translations (~120 keys): nav, auth, dashboard, campaigns, keywords, reports, AI, settings, users, accounts, common, errors, notifications
- `src/i18n/en.js` — English translations (same key set)
- `src/components/LanguageSwitcher.jsx` — pill-style toggle 🇷🇺 RU / 🇺🇸 EN in sidebar footer
- `<App>` wrapped in `<I18nProvider>` in `main.jsx`
- All existing components updated to use `t()` calls instead of hardcoded strings
- Default locale: **Russian**

### Fixed
- `totals` variable name collision with `t` from `useI18n` in `OverviewPage`
- `typeLabel` arrow function param shadowing `t` in `CampaignsPage`
- `tabId` variable collision in `LoginPage`

---

## [0.1.1] — 2026-03-05 · Hotfixes
**Commit:** `fcc3f91` — `fix: correct module paths in workers.js and scheduler.js`  
**Commit:** `5c8b155` — `chore: remove env backup file`

### Fixed
- Incorrect relative module paths in `backend/src/jobs/workers.js` and `scheduler.js` that caused startup errors
- Removed accidentally staged `.env` backup file from repository

### Security
- Ensured `.env` is not tracked by git

---

## [0.1.0] — 2026-03-05 · MVP Initial Release
**Commit:** `8088bdc` — `feat: AdsFlow MVP initial commit`

### Added
**Backend (Express.js)**
- JWT authentication with RBAC (roles: Owner, Admin, Analyst, Media Buyer, AI Operator, Read Only)
- Amazon Login with Amazon (LwA) OAuth 2.0 integration
- AES-256-GCM encryption for stored OAuth tokens
- Profile & marketplace sync from Amazon Ads API
- Campaigns, Ad Groups, Keywords entity sync (Sponsored Products, Brands, Display)
- Reporting API v3 pipeline with S3 storage
- BullMQ workers: `entity-sync`, `report-pipeline`, `bulk-operations`
- Cron scheduler for automated sync
- Audit log (append-only, PostgreSQL trigger prevents UPDATE/DELETE)
- Rate limiting (300 req/min per IP on `/api/`)
- Routes: `/auth`, `/connections`, `/profiles`, `/campaigns`, `/ad-groups`, `/keywords`, `/reports`, `/metrics`, `/rules` (stub), `/alerts` (stub), `/audit`, `/ai` (stub), `/jobs`

**Frontend (React + Vite)**
- Single-page application: Login → Connect → Overview → Campaigns → Keywords → Reports → Audit Log → Connections → Settings
- Dark theme with CSS variables
- Overview dashboard: Total Spend, Total Sales, ACoS, ROAS, Clicks, Impressions with 7d/14d/30d periods
- Campaigns table with status, budget, metrics, status toggle
- Keywords table
- Reports page
- Audit log viewer
- Connections / Amazon OAuth flow
- AI Assistant placeholder

**Infrastructure**
- Docker Compose: `frontend` (Node/Vite), `backend` (Node/Express), `postgres`, `redis`
- Separate Dockerfiles for frontend and backend
- `.env.example` with full configuration reference
- Health check endpoint `GET /health`

**Database**
- Migration `001_initial.sql` — full schema: organizations, workspaces, users, amazon_connections, profiles, campaigns, ad_groups, keywords, targets, reports, audit_logs, rules, alert_configs, alert_instances, ai_recommendations

---

## Rollback Reference

| Version | Commit SHA | Safe to rollback |
|---------|-----------|-----------------|
| 0.3.0   | `(pending)` | ✅ DB migration is additive only |
| 0.2.0   | `acae0d1` | ✅ No DB changes |
| 0.1.1   | `fcc3f91` | ✅ No DB changes |
| 0.1.0   | `8088bdc` | ⚠️ Requires fresh DB |

> See `docs/ROLLBACK.md` for step-by-step rollback instructions.

---

[Unreleased]: https://github.com/pavelmelnikme-coder3/AmazonADS/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/pavelmelnikme-coder3/AmazonADS/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/pavelmelnikme-coder3/AmazonADS/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/pavelmelnikme-coder3/AmazonADS/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/pavelmelnikme-coder3/AmazonADS/releases/tag/v0.1.0
