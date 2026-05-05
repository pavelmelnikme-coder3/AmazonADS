# Changelog

All notable changes to AdsFlow are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`

---

## [Unreleased] — 2026-05-05

### Added — Search Terms tab inside the campaign drill-down modal

- **`CampaignDetailModal` → new `Поисковые запросы` (Search Terms) tab**, available in both the campaign-level view (filters `campaignIds=<id>`) and the ad-group-level view (filters `adGroupId=<id>`). Renders a sortable read-only table — Query, Match Type, Keyword, Impr, Clicks, Orders, Spend, Sales, ACOS — over the period selected in the modal header (`localDays`). Plain `t("rules.colSearchTerm")` / `keywords.col*` keys reused for headers; only `campaigns.detail.searchTerms` + `noSearchTerms` are new in RU/EN/DE i18n. Eager fetch on modal open (consistent with adjacent tabs); client-side filter on the search box across the loaded rows (limit 200).
- **`GET /search-terms` accepts `?adGroupId=<uuid>`**. Single-AG predicate added before the existing `campaignIds = ANY(...)` clause. Used by the modal's ad-group view; the dedicated `/search-terms` page still passes `campaignIds`. Parameterised — no SQL-injection vector.
- **`GET /search-terms` response now carries `campaign_type` and `marketplace_id`** (joined via `amazon_profiles ap ON ap.id = COALESCE(c1.profile_id, c2.profile_id)`). Both are needed by the frontend `amazonAdsCampaignUrl(term)` helper to build region-aware Amazon Ads console deep links — without `marketplace_id` a DE seller's session would be lost on `.com` redirect to the public registration page (Stage 9 lesson). Rows that resolve to no campaign in our DB (orphan search terms) get `null` for both fields and the icon hides.

### Added — Drill-down on campaign columns in three places

- **`CampaignsPage` row** — inline `ExternalLink` icon next to each campaign name (region-aware, via `amazonAdsCampaignUrl(c)`). The column is `display: flex` with `flex: 1, minWidth: 0` on the name span so the name truncates first and the icon never gets clipped. `onClick` on the icon `stopPropagation()`s so it doesn't trigger the row's `setDetailCampaign` handler.
- **`KeywordsPage / Search Terms` tab — `CAMPAIGN` column** — campaign name is now an `<a target="_blank">` to `/?page=campaigns&search=<encoded>`, plus the same `ExternalLink` Amazon icon. Both elements share a `flex` wrapper so the layout collapses gracefully when the row width is constrained.
- All three drill-down patterns (this row, AI Assistant cards, rule simulation modal) use the same URL shape — `?page=campaigns&search=NAME` opened in a new tab — so the deep-link handler in `App.jsx` is the single source of truth.

### Fixed — Race condition: stale data after deep-link to Campaigns page

- A new tab opened from rules / Search Terms / AI Assistant (`?page=campaigns&search=NAME`) used to show **the right name in the search input but the wrong rows in the table**.
- Root cause: `useSavedFilters("af:campaigns", …)` lazy-initialises from `localStorage` (old saved search) → first `useAsync` fetch fires with the **stale** filter → only **then** does the mount `useEffect` read `sessionStorage["af:pending_search:campaigns"]` and call `setCampFilter("search", pending)` → a second fetch fires with the **new** filter. With BullMQ-style late-resolving HTTP requests, whichever fetch resolved last won — usually the stale one.
- Fix: a `useMemo([], …)` block runs **before** `useSavedFilters` is called and migrates `sessionStorage["af:pending_search:campaigns"]` directly into `localStorage["af:campaigns:active"].search`, so the very first render of `useSavedFilters` already has the right value. Idempotent under React StrictMode (second invocation finds `null` and no-ops). The post-mount fallback `useEffect` is removed (no longer needed; was the source of the race).

### Fixed — BSR hover sparkline closed when moving the cursor onto it

- The 7-day sparkline tooltip on the Products page sat 6 px above the BSR badge. Crossing that gap counted as `mouseleave` on the wrapper, which dropped `bsrHover` state. Reaching a specific data point on the chart was therefore frame-perfect.
- Fix follows the Floating UI `safePolygon` / Radix Tooltip / Mantine HoverCard pattern:
  1. Tooltip moved to `bottom: 100%` (no gap — the tooltip touches the badge).
  2. `onMouseEnter` / `onMouseLeave` mounted on the **tooltip itself** as well as the wrapper, so hovering the chart cancels close.
  3. Close is deferred via a 120 ms `setTimeout` (`bsrHoverCloseTimer` ref); `cancelBsrClose()` aborts the timer when the cursor lands on either the badge or the tooltip, and `scheduleBsrClose()` re-arms it on leave. 120 ms is the same delay Radix and Mantine use for hover cards.

### Fixed — SP search-term metrics frozen at orders=0 (sync window too narrow)

- The hourly cron `Cron: Queuing daily metrics backfill` was re-fetching only the **last 2 days** (`scheduler.js`). Amazon SP attributes purchases up to **14 days** after the click via `purchases14d` / `sales14d` (the only attribution fields we ingest). A click on day N might receive an attributed purchase on day N+5, but our row was last fetched on day N+1 with `orders=0` and was never re-pulled — the row stayed at zero forever, even after Amazon finalised its attribution.
- Reproduction: in production data, 14 / 15 search-term rows for `query='footrest', ad_group_id=91a6c9e8-…` over 04-04..04-22 had `updated_at` 1-2 days after `date_start` and `orders=0`, while Amazon Ads UI for the same period showed 1 purchase / €23.99 sales — the canonical late-attribution signature.
- Fix: backfill window in `scheduler.js` raised from 2 days to 14 days (matches `purchases14d`). Daily cron at 06:30 UTC now re-fetches the entire attribution window for **all 11 report-type/level combinations** (SP campaign / keyword / target / searchTerm / advertised_product, SB campaign / keyword / ad_group, SD campaign / ad_group / target). Each row is now re-pulled 14 times across its attribution lifetime, so any late-arriving order lands in our DB. `fact_metrics_daily` (campaign-/keyword-/target-level) and `search_term_metrics` both benefit because they're upserted from the same report stream.
- Operational note: Amazon's report-pipeline runs at concurrency 1 (Amazon throttles concurrent report-create calls). Daily volume rises from 11 → 11 × 1 chunk-of-14-days. Each chunk is one report (Amazon's max date range is 31 days), so total reports/day stays at 11 — only the date span widens. Backfill processing time ≈ 1-2 hours/day.
- One-time recovery: 30-day backfill (`POST /jobs/backfill-metrics`) queued for the affected workspace to repair the existing zero-attribution rows.

### Fixed — Rank-check cron silently skipped after first run (BullMQ jobId dedup)

- `tracked_keywords` were only getting rank snapshots on **7 of the last 30 days** despite the `Cron: Rank check queued` log line firing daily. The chart on the Rankings page therefore showed **2 dots over 30 days** (start + end) instead of a daily curve.
- Root cause: `queueRankCheck(workspaceId)` and `queueProductMetaSync(workspaceId)` used a static `jobId = "${prefix}_${workspaceId}"`. BullMQ deduplicates by `jobId`: once the first day's job moved to `completed`, every subsequent `queue.add(..., { jobId })` call returned the cached completed job without enqueueing anything. With `removeOnComplete: { count: 100 }`, the dedup record never expired. The only days that produced snapshots were the days the queue was cleared by a backend restart or by a manual `/keyword-ranks/check-all` POST (which calls `jsCheckWorkspaceRanks` directly, bypassing BullMQ).
- Fix: jobIds now carry a UTC date suffix — `rank_${workspaceId}_YYYYMMDD`. Within a single day they still deduplicate (cron + a manual trigger don't double-fire); each new day creates a fresh job. Same fix in `queueProductMetaSync`. Verified: triggering the cron path inserted 28 fresh `keyword_rank_snapshots` rows within 10 minutes; the previously-stuck `gasbrenner B0CQK96CV5` keyword went from 2 historical snapshots to 3 (added 2026-05-05 #20).
- Note: the rule-execution queue intentionally keeps a static `jobId` so concurrent triggers within the same hour collapse — that dedup is desired and was left untouched.

---

## [Unreleased] — 2026-04-30

### Added — Server-side campaign search for picker selectors

- **`GET /rules/campaigns`** now accepts `?q=<substring>`. Previously the endpoint hardcoded `LIMIT 200 ORDER BY name ASC`, so on workspaces with 1 000+ active campaigns any campaign whose name sorted past the first 200 was unreachable — the rule wizard's picker silently filtered an incomplete list. Frontend (`RulesPage`) hoists `campSearch` to parent and debounces 300 ms before requesting `?q=`.
- **`GET /search-terms/campaigns`** now accepts `?q=<substring>` and `?ids=<csv UUIDs>`. The "Add as Negative / Keyword" modal in Search Terms had the same picker-truncation bug at `LIMIT 500`. The new `?ids=` mode lets the modal explicitly pull a preselected campaign by ID even when it sorts past the first 500 — needed because the modal pre-fills the campaign that the source search term lives in. UUIDs in `ids` are validated against a regex before reaching `pg`, so malformed input returns 200 with the unfiltered list instead of 500.
- Modal preserves the picker chip and the ad-group sub-picker for a preselected campaign via a new `stHarvestPreselCampaign` state — no longer dependent on whether the campaign is in the loaded top-N list.

### Added — Clickable campaign names + Rankings ASIN hover card

- **AI Assistant recommendation cards**: campaign entity name (when `entity_type === "campaign"`) is now an `<a target="_blank">` deep-link to `/?page=campaigns&search=<encoded-name>`, mirroring the Stage 9 simulation pattern. Keyword entities remain plain text (no deep-link target page).
- **Rankings page ASIN**: replaced the static click-to-open card with a hover-on-anchor card pattern (Radix `HoverCard`-style, vanilla React, no extra deps). Click on the ASIN now opens `https://www.amazon.{tld}/dp/{ASIN}` in a new tab; hovering for ≥ 250 ms shows a portal-rendered card with image, ASIN, brand, title, anchored to the link's `getBoundingClientRect()` with auto-flip on viewport edges. Note editing keeps its existing inline `+ Примечание` UI — no duplicate-edit surface.
- The old `productPopup` state and click-modal in `RankingsPage` are removed.

### Fixed — AI Assistant generated no-op recommendations (defense in depth)

- **Prompt-level constraint**: `buildSystemPrompt` (`backend/src/routes/ai.js`) now contains a `CRITICAL CONSTRAINTS` section explicitly forbidding `pause` for already-paused, `enable` for already-enabled, bid/budget values equal to current, or `bid_adjustment_pct: 0`. The `state` field is already in the per-campaign and per-keyword JSON sent to Claude — the constraints just teach the model to read it.
- **Post-process validation**: every action returned by Claude is now verified against the live DB row before saving to `ai_recommendations`. No-ops are dropped (counted in a `dropped_actions` log line); recommendations that end up with zero valid actions are dropped entirely. Catch-block logs the entity_id on validation-query failure for debuggability.
- Symptom this fixes: cards like "приостановить кампанию X — Статус: paused" where X was already in `paused` state.

### Fixed — `Статус: paused` UI label was misread as current state

- `AI_PARAM_DISPLAY.state` in `frontend/src/App.jsx` renamed `'Статус'` → `'Новый статус'`. The value rendered next to it comes from `action.params.state` (the **target** state after applying), not the entity's current state — the old label encouraged users to read it as the current status. Mirrors the existing `'Новая ставка'` / `'Новый бюджет/день'` pattern.

### Fixed — Deep-link `?page=campaigns&search=` redirected to source page in dev

- The `useState(active)` initializer in `App` was non-idempotent: on first call it returned `urlPage` and **also** ran `window.history.replaceState({}, "", pathname)` to clear the query string. Under `<StrictMode>` (dev), React calls the initializer twice — the second call saw an already-cleaned URL and fell through to `localStorage.af_page`, so users opening `?page=campaigns&search=…` from another tab landed on whatever page they last visited (e.g. AI Assistant → AI Assistant).
- URL cleanup moved to a one-shot `useEffect`. `replaceState` is idempotent, so StrictMode's double-invoke of the effect is harmless. Initializer is now pure-read.
- Side-effect: this also retroactively fixes the simulation-modal deep-link from Stage 9 in dev (the bug was masked there because users typically opened the link from the same page they were navigating to).

---

## [Unreleased] — 2026-04-28

### Fixed — Amazon Ads API v3 migration for SP entity sync

- **`fetchTargets()` SP** rewritten to `POST /sp/targets/list` with media type `application/vnd.spTargetingClause.v3+json`. Legacy `GET /sp/targets` (v2) silently dropped AUTO-targeting expressions (close-/loose-match, substitutes, complements) — that bug left **197/201 (98%) of AUTO campaigns** without targets in our DB. SD continues to use legacy `GET /sd/targets` (v3 list endpoint returns 405 in EU region).
- **`fetchProductAds()`** rewritten to `POST /sp/productAds/list` (`application/vnd.spProductAd.v3+json`). The legacy GET endpoint was returning 403 in EU and our `product_ads` table was completely empty (0 rows) for the West&East profile. After migration: **3 864 product ads** synced for one profile.
- **`fetchNegativeTargets()` SP** rewritten to `POST /sp/negativeTargets/list` (same v2-deprecation issue). DB went from **6 → 5 121** SP negative targets.
- **`syncTargets()` / `syncProductAds()`** normalize v3 response shape: state lowercased (`ENABLED` → `enabled`) to match schema; `bid` accepts both plain numbers and v3 `{value, currency}` objects.
- Coverage on `West&East GmbH` profile after re-sync: SP MANUAL `293 → 9` empty (those 9 are campaigns with zero ad groups), SP AUTO `197 → 5`, SD unchanged at `0`.

### Fixed — Rule engine: ASIN-shaped search terms produced ineffective negatives

- Search terms like `b076j8j3w5` are masked ASIN queries Amazon shows when a buyer arrives via product-page traffic. Adding them as `negative_keyword` is useless — Amazon matches ASIN traffic against `negative_targets`, not keywords.
- New duplicate check in `add_negative_keyword` action (`backend/src/routes/rules.js`): if `entity_type === "search_term"` and `keyword_text` matches `/^b0[a-z0-9]{8}$/i`, query `negative_targets` for an existing `[{type:"ASIN_SAME_AS", value:"<UPPER>"}]` expression in the same campaign. Hit → `recordSkip(reason: "already_negative")`.
- **Auto-routing**: when no existing target dedup is found, the rule now writes a `negative_target` instead of a `negative_keyword`. Reuses `pushNegativeAsin()` writeback (POST v3, uppercase `ASIN_SAME_AS`, `state: "ENABLED"`, real-id update on success). Single negation regardless of `action.value` (phrase/both/exact) — phrase match doesn't apply to ASIN queries.
- Frontend simulation table: auto-routed rows show badge `NEG ASIN ↻` (vs plain `NEG TGT`) with hover tooltip explaining the conversion.
- Validated on prod: 9/13 (query, campaign) pairs from a real customer rule were correctly classified as duplicates after the fix; the remaining 4 will be added as new negative_targets on next live run.

### Fixed — Search Terms list returned 13 daily rows for one query

- `GET /search-terms` was selecting `stm.*` from `search_term_metrics`, which stores **one row per `(campaign, ad_group, query, date_start, date_end)`**. A 30-day window with daily reports therefore showed each query 13–30 times with per-day metrics — confusing and inconsistent with Amazon's UI which always shows aggregated totals.
- Query rewritten to `GROUP BY (query, campaign_id, ad_group_id, keyword_text, match_type, ...)` with `SUM(impressions/clicks/spend/orders/sales)` and recomputed ACOS from the aggregates. Adds `day_rows` field for future "13 days" UI hints.
- Per-period filters (`minClicks`, `minSpend`, `hasOrders`, `noOrders`) moved from `WHERE` to `HAVING` — `min_clicks=10` now means "≥10 clicks across the period" instead of "≥10 in any single day".
- COUNT for pagination wraps the aggregated query in a subquery.
- Validated against Amazon Ads UI: our `b0bl22bp1k` row shows 24,448 imp / 492 clicks / €701.19 spend; Amazon shows 24,533 / 496 / €706.36 — discrepancy is attribution-window related (7d vs 14d), not data loss.

### Added — Open campaign in Amazon Ads console (region-aware)

- New button in `CampaignDetailModal` header: opens `https://advertising.amazon.{tld}/cm/{sp|sb|sd}/campaigns/{amazon_campaign_id}` in a new tab, where `tld` is derived from `marketplace_id` via the existing `AMAZON_DOMAIN` map (DE → `.de`, US → `.com`, UK → `.co.uk`, etc.).
- Earlier hardcoded `.com` redirected DE sellers to the public registration page because session cookies live per-region. Region-aware URL reuses the user's existing session.
- `marketplace_id` added to `GET /campaigns` and `GET /campaigns/:id` SELECT (`p.marketplace_id` join from `amazon_profiles`).
- New i18n keys `campaigns.detail.openInAmazonAds` + `openInAmazonAdsTip` in EN/RU/DE.

### Added — Open campaign in new tab from rule simulation

- Click on a campaign-name link in the rule-simulation modal now opens the campaigns page in a **new browser tab** instead of replacing the simulation. Implementation: `<a href="?page=campaigns&search=NAME" target="_blank">`.
- App-level deep-link reader added to the `active` page state initializer: parses `?page=` and `?search=` from URL on mount, queues the search via `sessionStorage`, then `history.replaceState({}, "", pathname)` so reload doesn't re-trigger.

### Added — 7-day BSR sparkline on hover (Products page)

- New `BsrHoverChart` component renders a 180×80 inline SVG tooltip above each BSR badge in the product list. Shows up to 7 points (one per day, latest snapshot of that day) with a trend indicator (▼ green / ▲ red) and per-day rank on hover.
- Category-aware: badge for `Sport & Freizeit` shows that category's history; primary badge falls back to `best_rank` if its category isn't present in some snapshots.
- Lazy fetch: first hover on a product fires `GET /products/:id/history`; cached in the existing `history` state. `bsrHoverFetching` ref dedupes concurrent fetches.

### Added — Clicks column in Campaigns table

- Inserted between `Бюджет/д` and `Spend`. Sortable (backend already accepted `sortBy=clicks`), toggleable via `Cols` dropdown, default width 70px. Existing `useResizableColumns` saved widths gracefully fall back to defaults when the column count changes (length-mismatch check in the hook).

### Added — Context-aware label for the entity column in rule simulation

- The `Будет изменено` / `Пропущено` tables in the rule run modal previously hardcoded `Ключевое слово` even when rows were search terms or targets. New helper `entityColLabel(items)` reads `entity_type` from each row and picks the right header: `Ключевой запрос` (search_term) / `Ключевое слово` (keyword) / `Таргет` (target). Mixed → `Ключевое слово / Запрос / Таргет`.
- Backend now passes `entity_type` in every `applied.push()` (9 spots in `executeRule`) and in `recordSkip`.
- New i18n keys `rules.colKeyword` / `colSearchTerm` / `colTarget` in EN/RU/DE; `colKeywordTarget` updated to include search term.

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
