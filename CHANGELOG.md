# Changelog

All notable changes to AdsFlow are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`

---

## [Unreleased] — 2026-06-26 — Ad-data integrity (per-ASIN + ad-group) & scheduled alert digests

### Fixed
- **Per-ASIN ad spend under-reported ~46%** (`services/amazon/reporting.js`). The `spAdvertisedProduct`
  report returns one row per *(campaign/ad group, ASIN, date)*, so a single ASIN appears in many rows
  per day. `ingestReportData` upserted each row to key `(profile_id, amazon_id, entity_type, date)`
  with `DO UPDATE = EXCLUDED` — an **overwrite**, so only the last campaign's row survived and the rest
  were silently dropped. The whole Products page (PPC/ACOS/TACOS/ROAS) therefore under-counted ad
  spend, and some advertised products showed €0. **Fix:** pre-aggregate report rows by
  `(amazon_id, date)` (sum metrics) and upsert once per group — idempotent, and a no-op for levels
  whose `amazon_id` is unique per day (campaign/ad_group/keyword/target). Verified on prod: window
  advertised_product cost €856 → **€1,580.58 = exactly the SP campaign total**. History re-backfilled.
- **SP ad-group metrics were stale/incomplete.** Two issues: (1) `["SP","ad_group"]` was missing from
  both the daily (`scheduler.js`) and backfill (`reporting.js`) report-level lists (SB/SD had it, SP
  didn't); (2) the SP ad-group config used `reportType: "spAdGroups"`, which Amazon rejects as invalid
  — SP ad-group metrics come from the **`spCampaigns`** report with `groupBy: ["adGroup"]` (and
  `campaignId/campaignName` are not valid columns at that grouping; the campaign link resolves from
  `adGroupId`). Added SP ad_group to both lists and corrected the config. History re-backfilled.

### Added
- **Per-alert delivery schedule** (`conditions.schedule = { weekday: 0-6 (0=Sun…5=Fri), hour: 0-23, tz }`).
  When set, the hourly alert cron only fires the alert during the matching weekday+hour in that timezone
  — e.g. a **Friday-08:00 Europe/Berlin weekly product-movers digest** instead of a daily one. No
  schedule → unchanged (cooldown still governs frequency). `evaluateWorkspaceAlerts({ force })` lets the
  manual "Check now" fire immediately regardless of schedule. `parseSchedule()` validates on POST/PUT and
  PUT preserves an existing schedule when the client omits it. Product-movers digest title now shows the
  comparison window (`· Nd vs prior Nd`) so the 7-day period is obvious at a glance.
- **Tests**: +3 ingest-aggregation, +4 schedule-gate. Full suite **929/929**.

## [Unreleased] — 2026-06-25 — Marketing email subsystem (Amazon SES, EU/GDPR)

A new **bulk/newsletter** email pipeline on **Amazon SES** (`eu-central-1`, Frankfurt), fully separate
from the transactional Brevo path so marketing complaints can't poison alert/invite deliverability.
Ships behind config — with `SES_*` unset, nothing sends.

### Added
- **Data model** (migration `037_email_marketing.sql`): `email_contacts` (with GDPR consent proof +
  opaque `unsubscribe_token`), `email_segments`, `email_campaigns` (+ counters), `email_sends`
  (`UNIQUE(campaign,contact)` → idempotent), `email_suppressions`.
- **SES adapter** (`services/email/ses.js`): SES v2, one Raw-MIME message per recipient carrying the
  RFC 8058 `List-Unsubscribe` / `List-Unsubscribe-Post` headers; `isConfigured()` gate.
- **Renderer** (`services/email/render.js`): `{{merge_tag}}` expansion + a mandatory footer (postal
  address + unsubscribe link) appended to every email.
- **Dispatch** (`services/email/dispatch.js`) + `email-dispatch` BullMQ queue: recipient resolution
  (segment + suppression filter), batching, idempotent per-batch send (skips non-queued on retry),
  counters, finish detection. Worker is rate-limited (~`SES_MAX_SEND_RATE` msg/s). A 5-min cron
  dispatches due scheduled campaigns (`FOR UPDATE SKIP LOCKED` → no double-fire).
- **API** (`/api/v1/email-marketing`, authed): contacts import (consent required) + CRUD, segments,
  campaigns CRUD + `test`/`send`/`schedule`/`pause`/`stats`, suppressions.
- **Public endpoints** (`/api/v1/email`, no auth): RFC 8058 one-click unsubscribe (GET page + POST
  one-click) and the SES→SNS webhook (signature-validated; permanent bounce/complaint → suppress +
  flag contact; delivery/open/click → counters; auto-confirms the SNS subscription).
- **Frontend**: new "Email" page — campaigns list + composer (subject / from / segment / HTML editor +
  live preview + test send), send/schedule, contacts (import with consent), suppressions, stats.
  i18n en/ru/de.
- **Tests**: +27 (render, SES adapter, dispatch idempotency, unsubscribe/webhook, route validation).
  Full suite **922/922**.

### Operator setup required before real sends
Verify domain + Easy DKIM/SPF/DMARC, request SES production access (Marketing), create a configuration
set + SNS topic, a public **HTTPS** domain (webhook + unsubscribe links), and fill the `SES_*` env.
See `docs/EMAIL_SES_SETUP.md`.

---

## [Unreleased] — 2026-06-24 — Alerts: ROAS-drop alerts, spend breakdown, attribution unification; keyword-research fixes; full test suite green

A run of alert audits (each verified against raw prod rows and Amazon's campaign manager before
shipping) added new alerting capability and closed several data-correctness gaps, plus a
keyword-research parsing pass and a cleanup of the test suite back to fully green.

### Added — percentage-change ("metric dropped/rose by N%") threshold alerts
New operators `drop_pct` / `rise_pct` on the standard threshold alert. When selected, the engine
compares the current `window_days` window to the immediately-preceding equal-length window and fires
when the metric fell / rose by ≥ the configured %. Covers "notify me if ROAS drops more than 30% over
7 days" and works for any perf metric. Perf-only (BSR is point-in-time); validated to reject BSR and
non-positive percentages. Frontend exposes the operators (hidden for BSR), a `%` suffix, and a
period-over-period hint; the list shows `↓% N / Nd`. E2E-verified on prod (cron fired
"ROAS dropped 12% (7.91× → 6.99×)", matching an independent SQL recompute).

### Added — per-campaign breakdown with health metrics on spend ("Перерасход") alerts
The account-level spend alert now answers *which* campaign drove the overspend: the fired instance and
the email carry `data.top_campaigns[]` — the top spenders over the window, each with `delta`/`delta_pct`
vs the prior window **and** a health snapshot (`sales`, `orders`, `roas`, `acos`, ROAS colour-coded). In
the live data this immediately separated a healthy ramp (a campaign at ROAS 20×) from a Sponsored Brands
campaign burning budget at ROAS ~2×. Spend instances are now expandable in the UI.

### Changed — alert metrics unified to 14-day attribution
All alert metric paths (`aggregateMetrics` account aggregate → ROAS/sales/orders thresholds and the new
change operators; `topSpendCampaigns`; `computeMoverFlags` ad metrics) now aggregate ad sales/orders on
the **14-day** attribution window instead of 1-day. Sponsored Brands report conversions only on the 14d
window, so 1d silently dropped all SB sales; Sponsored Products fill every window identically (unchanged).
Numbers now reconcile to the cent with Amazon's campaign-manager UI (e.g. account 7d ROAS 8.59× vs the old
7.82×). Supersedes the earlier "alerts kept on 1d" choice.

### Fixed — product-movers detected causes were inaccurate
- **False "out of stock".** Availability used `min(ERP, FBA)`, so a product with 100 units in the ERP
  warehouse but 0 in FBA read as out-of-stock; and a mapped item with no `wawi_stocks` row (the feed
  only stores positive quantities) had its ERP synthesised to `0`. Now availability is `max` of the
  **genuinely-known** sources; missing data is `n/a`, not `0`; out-of-stock is asserted only when every
  known source is empty (`stock_out`), with softer `fba_empty` / `erp_empty` when just one source is
  known empty.
- **Misleading "ad spend cut" on a ROAS drop.** `ad_cut` / `price_up` were attached regardless of which
  metric breached — but cutting spend *raises* ROAS, so it can't be the cause of a ROAS *drop*. These
  demand-side causes now attach only when the breached metric is one they can plausibly drive (volume /
  rank), never for efficiency ratios.

### Fixed — keyword research parsing
- Jungle Scout's own 0–100 relevance was written to `relevancy_score` but read everywhere as
  `relevance_score` → JS keywords showed `—`. Mapped correctly.
- AI scoring ran even when the AI source was deselected (billable Claude calls). Now gated on `sources`.
- Keywords the AI dropped (`keep:false` — forbidden/irrelevant) survived on a default score; now removed.
- Frontend source-filter chips weren't reactive (missing `useMemo` dep); fixed.

### Fixed — test suite back to 895/895 (was 868/895)
Repaired 27 stale-mock failures across `rules` / `campaigns` / `ai` / `strategies` (test-only; no
product code changed): DELETE routes now soft-delete to trash, the campaign PATCH payload is wrapped in
`{ campaigns: [...] }`, AI entity-name enrichment requires a valid UUID, target fixtures use the v3
`ASIN_SAME_AS` expression type, and a `dbQuery` queue-drain `afterEach` removed cross-test
`mockResolvedValueOnce` leakage. Suite now passes across repeated/independent runs.

---

## [Unreleased] — 2026-06-19 — Product-movers data integrity (FBA stock + phantom price spikes)

Routine "how did the alerts fire" review surfaced two bad signals on the **product-movers** alert,
both the same class of bug: incomplete/garbage source data leaking into the alert's detected causes.
Verified against raw rows on prod before and after each fix.

### Fixed — FBA stock always showed `n/a`

The "out of stock" badge surfaces FBA sellable stock from `sp_inventory.quantity_sellable`. Amazon
returned the data correctly (confirmed in `raw_data`), but `spSync.js`'s inventory mapper mangled it
on write:

- **`0 || null` dropped real zeros.** `quantity_sellable = inv.fulfillableQuantity || null` turned a
  genuine `0` (out of stock) into `NULL`, which the alert renders as `n/a`. So exactly the
  out-of-stock products — the ones the alert exists to catch — lost their FBA signal. Only **15 of
  305** rows had a non-null sellable value.
- **Wrong field paths.** `quantity_total`, `inbound_working/shipped/receiving` and
  `researching_quantity` read nested `obj?.quantity`, but the FBA Inventory API returns these as
  plain numbers (`item.totalQuantity`, `inv.inboundWorkingQuantity`, …) → those columns were `NULL`
  for **all** 305 rows.

Fix: a `num()` helper that coalesces only on `null`/`undefined` (preserving a real `0`), plus
corrected field paths against the actual API shape. The 305 existing rows were healed in place from
`raw_data` (coverage 15 → 305; 290 ASINs genuinely `0`). The alert now shows `FBA: 0` for
out-of-stock items instead of hiding it as `n/a`.

### Fixed — phantom "price rose +200%" causes

The price-rise cause computes avg unit price as `SUM(item_price_amount) / SUM(quantity_ordered)` over
a window. **Pending orders carry a `quantity_ordered` but a `NULL` `item_price_amount`** (Amazon hasn't
confirmed the price yet). Left in the denominator, they deflate the average: e.g. one shipped €20.99
unit plus two unpriced pending units → `20.99 / 3 ≈ €7.00`, a phantom drop — which then looked like a
+200% spike the following window. Reported live on `B0G1C9BDKC` (steady €20.99, flagged €7.00 → €20.99).

Fix: both price-window `FILTER`s in `evaluate.js` now require `item_price_amount IS NOT NULL`, so only
priced units count toward the average. Verified on prod: `B0G1C9BDKC` prev/cur €7.00/€13.99 → €20.99/€20.99
(0% change, no false cause); phantom `price_up` signals across active products dropped 7 → 4.

---

## [Unreleased] — 2026-06-09 — Ad-attribution data integrity, report-throttle resilience, Products UX

A data-reliability day: audited every product statistic against its source, found and fixed the
root causes of unreliable ACOS/ROAS, hardened report ingestion against Amazon throttling, and
extended the Products page UX.

### Fixed — Ad-attribution data integrity (ACOS / ROAS / ad-sales)

Audit verdict: BSR, total orders/revenue and price were reliable and fresh; **ad-performance
metrics were not**. Three root causes, all fixed:

- **Partial upsert rotted the attribution columns.** `ingestReportData` (`reporting.js`) `ON CONFLICT`
  refreshed only `sales_14d`/`orders_14d` (+cost/clicks/impressions); `sales_1d/7d/30d` and
  `orders_1d/7d/30d` were frozen at first insert. Because the 60-day backfill re-touches recent dates
  every run, those windows drifted (proof: matured rows with `sales_1d > sales_14d`, impossible within a
  single Amazon snapshot). Amazon **restates** conversions at 1/7/28 days, so re-ingest must refresh
  every window — the upsert now updates **all** sales/orders windows (and `campaign_type`).
- **Inconsistent attribution window.** The Products UI KPIs and timeseries computed ACOS/ROAS from
  `sales_1d` (1-day) while the export used `sales_14d`, and the rest of the app
  (campaigns/keywords/targets/ad-groups/rules/analytics/AI) uses `sales_14d`. Products now uses
  **`sales_14d` everywhere** (the app-wide standard), so per-product ACOS/ROAS match the other pages.
  Live effect: ACOS dropped to matured values (e.g. 7.7%→4.9%) and products whose `sales_1d` was 0 —
  which previously showed a **blank ACOS and gappy chart lines** — now show their real ACOS.
- **`campaign_type` was always `SP`.** `ingestReportData` read `row.campaignType`, a field Amazon never
  sends in report rows, so every row defaulted to `SP` — SB/SD spend was ingested but mislabeled. It now
  comes from the report-request parameter. History healed via SQL for campaign-level rows (632 rows →
  150 SB, 482 SD) and via a 30-day re-backfill for the remaining entity levels.

Note: per-product ad metrics remain **SP-only** by design — Sponsored Brands/Display have no
product-level report in the standard API (SB/SD per-product attribution is tracked as a separate task).
The alert engine (`evaluate.js`) intentionally keeps 1-day attribution: it compares a window against the
preceding one, and 1-day matures fast, avoiding false "drops".

### Fixed — Report ingestion resilience (429 throttling)

- **SB report creation no longer drops a day on a throttle.** `createReportRequest` retried 429s only 3×
  with a fixed 15s→30s backoff and ignored Amazon's `Retry-After`. It now retries up to 5× with
  exponential backoff (15→30→60→120s) **honoring `Retry-After`**, plus jitter — covering Amazon's short
  SB-creation burst limit that previously orphaned that day's report (self-healed later by backfill, but
  now avoided).

### Added — Products page UX

- **Per-listing "Expand all".** The global "expand all charts" toolbar button (which opened charts on
  *every* listing) is replaced by a per-listing **Expand all / Collapse all** that opens just that
  listing — its aggregate charts **plus every child ASIN and each ASIN's charts** — in one click.
- **Fixed date-range presets.** A "Range" dropdown (7 / 14 / 30 / 60 / 90 days) next to the date inputs;
  reflects the active preset or "custom".
- **Averages + period comparison left of the charts.** Each trend metric now shows its **period average**
  (instead of the min/max extreme); in Compare mode it also shows the **previous period's average with a
  ▲/▼ delta**, colored by whether the change is good for that metric (BSR/ACOS/TACOS down = good,
  orders/ROAS up = good). Hover still shows the per-day current/previous values.

---

## [Unreleased] — 2026-06-08 — Rule write-back idempotency, product-movers real causes, Products listing trends, dashboard currency

A day of correctness fixes and two feature areas: data-derived alert causes, and a listing-grouped Products page with daily trend charts.

### Fixed — Rule write-back (verified live on Amazon)

- **Duplicate negatives no longer log as errors.** Re-adding a negative keyword/target that already exists on Amazon returned a `duplicateValueError` (400) and was recorded as a failed write-back, re-failing every daily run. `pushNegativeAsin` / `pushNegativeKeyword` now detect the duplicate and return `{ ok: true, duplicate: true }` (adding an existing negative is idempotent — the desired end-state already holds). Verified live: a real POST for an existing negative → `{ok:true, duplicate:true}`.
- **`pause_keyword` / `enable_keyword` write-backs are now audit-tracked.** They fired via a bare `.catch()` that only logged, leaving `audit_events.amazon_status = NULL` (a masked-failure class). Now wired through `trackWriteback` so the audit row reflects the real Amazon result.
- **Partial keyword-update rejections surface.** `pushKeywordUpdates` returned `{ok:true}` even when Amazon rejected keywords in the `keywords.error` array; the first rejection now propagates so the audit shows the error.

### Added — Product-movers: real, data-derived causes

The alert's static "likely causes" checklist is now preceded by **detected** causes per product (chips in the email and the Triggered-tab row):

- **Out of stock / low stock** — Wawi ERP stock (`wawi_stocks` via `wawi_item_asins`) + FBA `sp_inventory`; both sources shown explicitly (`ERP: x · FBA: y`), flagged only on a known source (never invents OOS from a single missing source).
- **Price up** — order-derived avg selling price, current window vs prior.
- **Ad spend down** — ad spend (`fact_metrics_daily`), current vs prior window.
- Thresholds are **configurable per alert** (`conditions.cause_price_pct` / `cause_ad_pct` / `cause_low_stock`). `detectMoverCauses` in `services/alerts/evaluate.js` (+5 unit tests); rendered in `email.js` and the Alerts UI; existing fired instances backfilled.

### Added — Products: listing grouping + daily trend charts

- **Group by Amazon parent ASIN** (variation family). New `products.parent_asin` column (migration `036`), populated from SP-API Catalog `relationships`; the UI groups `parent_asin || asin` into listing cards with aggregate KPIs, expandable to child ASINs.
- **Stacked, synchronized trend charts** per listing and per ASIN: BSR, Orders, Price, Ad spend, **ACOS, TACOS, ROAS** — one shared crosshair across all charts, an "expand/collapse all charts" toggle, and **compare-to-previous-period** overlay (faded dashed line). `GET /products/timeseries` (lazy-loaded, ≤60 ASINs, `compare=1`).
- **Sort by orders for the selected period** — `GET /products/period-orders`; surfaces the top revenue-driving listings.
- **Fixed per-ASIN ad spend.** Header `PPC`/`Profit` summed a campaign-level spend that was repeated on every ASIN in the campaign (e.g. €327.20 × 9 ≈ €3007 across one listing's variations). Now uses `advertised_product`-level spend (e.g. €3.12 / €1.52 / … ≈ €6.34 true) in both the grouped and flat views, fixing the listing PPC/Profit and enabling correct ACOS/TACOS.

### Fixed — Dashboard data accuracy (Overview + Campaigns)

- **Currency was hardcoded `$` but the data is EUR** (amazon.de). `GET /metrics/summary` now returns `currency` (the marketplace currency of the profiles with spend in the period) and `currencyMixed` (true when >1 currency contributed — totals then sum across currencies, surfaced as a "⚠ Mixed currencies" badge). The frontend renders the real symbol via `curSym()`; Campaigns uses per-row `currency_code`. (This workspace has attached USD + EUR profiles — the USD one has no data, so current totals are pure EUR.)
- **"Orders" mixed total and ad scope.** The card showed ad orders (`orders_14d`) next to total sales. It now shows **total orders** (`totalOrders` from `sp_orders`) to match "Total sales", relabeling to "Ad orders" when only ad data is available.

### Notes

- Tests: `detectMoverCauses` +5 (alertEvaluate suite 30/30). Full suite 843 pass / 27 fail — the 27 are pre-existing stale-mock failures (ai/strategies/campaigns/rules), identical on clean HEAD; **zero new failures**.
- Verified on prod: timeseries correctness harness (11 ASINs × 14d + compare) — formulas, aggregation, NaN/∞ all clean; `period-orders` matches raw; summary ACOS/ROAS consistent at 7d & 30d; duplicate-negative idempotency confirmed against live Amazon.

---

## [Unreleased] — 2026-06-04 — Stage 22: Amazon reconnect recovery, SD write-back format, product-movers dedup

An incident audit (rules failing to write to Amazon since 06-03) traced to the production DE advertiser profile losing Ads API access; recovering it required a re-auth, which surfaced several latent bugs. Plus a noise-reduction feature for the product-movers alert.

### Fixed — Amazon connection & write-back

- **Rule write-backs returned 401 from 06-03 — the DE profile lost Ads API access.** The stored token still refreshed fine (account-level), but its Amazon identity had lost access to *all* advertiser profiles (`/v2/profiles` → `200 []`), so every per-profile call 401'd and the read sync went stale after 06-02. Stage 20's `amazon_status` instrumentation is what made it visible. Recovered by re-authorizing with an account that has advertiser access and re-pointing the data-bearing profile row to the new connection (UUID preserved → all 1,158 campaigns / 33,865 keywords intact); the old connection was revoked.
- **CORS blocked the tunnel-based OAuth re-auth.** `app.js` set the CORS `origin` to a single string (`FRONTEND_URL`). The LwA OAuth return URL is `http://localhost:3000` (Amazon only permits `http` on localhost), reached via SSH tunnel — but that origin was rejected, so login failed with "Load failed". `origin` is now an array (comma-split `FRONTEND_URL` + `http://localhost:3000`); the prod IP origin still works.
- **`upsertProfiles` 500'd on reconnect (duplicate key).** `UPDATE … WHERE profile_id = $2` matched duplicate profile rows across old/revoked connections and re-pointed them all to one connection → `duplicate key (connection_id, profile_id)`, aborting the callback after the connection was already created. The UPDATE is now scoped to a single best row (attached / most-recent).
- **Sponsored Display write-backs rejected (422 / 400).** SD campaign mutations (`PUT /sd/campaigns`) are v2-style: a **bare top-level array** with a **flat** `budget` + lowercase `budgetType: "daily"`, and a **lowercase** `state` — not the SP/SB `{ campaigns: [{ budget: { budget, budgetType: "DAILY" } }] }` / uppercase-state shape. Verified empirically against a live SD campaign: bare-array → `207 SUCCESS`, every wrapped/nested variant → `422`, bare-array + `"ENABLED"` → `400 "Unrecognized state"`, bare-array + `"enabled"` → `207`. Fixed the budget + pause/enable write-backs in `routes/rules.js` (rule engine), the UI `PATCH /campaigns/:id` in `routes/campaigns.js`, and the legacy `services/rules/engine.js` (used by strategies). SD **create** (POST) keeps the `{ campaigns: [...] }` wrapper — only PUT differs.

### Added — Product-movers dedup (per-ASIN cooldown + escalation + New/Worsening split)

Cuts repeat noise: the same products were re-firing the product-movers digest on every daily run (e.g. 7 of 9 products repeated across two consecutive days).

- **Per-product cooldown** (`conditions.product_cooldown_days`, default 7, `0` = off) — an ASIN already alerted within the window is **suppressed** from new alerts.
- **Escalation override** (`conditions.escalation_pct`, default 25) — a suppressed ASIN re-surfaces ("escalated") only if its worst single-metric move grew by ≥ that many points since the last alert. The cooldown is time-based and auto-resets on expiry.
- **Quiet when nothing is new.** If every flagged product is suppressed, the alert fires nothing (no instance, no email). Otherwise the instance/email split products into **New** vs **Worsening** and append a `+N suppressed` line; `data` now also carries `fresh_count` / `escalated_count` / `suppressed_count`.
- Pure, unit-tested helpers in `services/alerts/evaluate.js` — `moverWorstPct` / `partitionMovers` / `getRecentMoverHistory` (prior-alert history read from `alert_instances` — **no migration**). `buildAlertConfig` validates the two new fields; `email.js` + the Alerts → Triggered tab render the split. 6 new `alerts.*` i18n keys (en/ru/de).

### Fixed — Product-movers dedup self-review

- A throwing `product_movers` config no longer aborts evaluation of the other workspace alerts — `evaluateProductMovers` is wrapped in a non-fatal `try/catch`, matching the threshold-alert path.
- The digest email no longer renders an empty "New · 0" section header when every notified product is escalated.

### Notes

- Tests: `backend/tests/productMovers.test.js` (15 cases) — cooldown off/on, no history, suppress, escalate at the inclusive boundary, `escalation_pct = 0`, auto-reset after expiry, case-insensitive ASIN match, mixed batch, history most-recent-per-ASIN + JSON-string tolerance, and error isolation. **66 / 66** alert suite green. Dedup verified on live prod: the config's 9 currently-flagged products are all repeats within 7 days and unworsened → **0 would fire** (it would otherwise have been a 3rd duplicate digest).
- Known trade-offs (by design, not bugs): when every flagged product is suppressed the heavy `computeMoverFlags` scan re-runs hourly until something becomes new/worse (no `last_triggered_at` update on a no-fire); the cooldown is time-based, not recovery-based (a product that recovers and re-drops within the window is still suppressed).
- Prototyped a **read-only** JTL-Wawi REST API connection (OnPrem app registration, scope `all.read`, JTL-Wawi 1.11.7). Wawi items already carry Amazon identifiers (`AmazonFnsku` / `Asins` / `AmazonPrice`) — a natural ASIN bridge and a future source of **total** (organic + ad) orders. No AdsFlow code changed; the connection is strictly read-only.

---

## [Unreleased] — 2026-06-03 — Stage 21: Product-movers alert (BSR + total orders, multi-metric)

A new alert type that scans **all products** and flags those whose metrics moved beyond a configurable threshold when comparing a rolling N-day window against the immediately preceding N-day window. Built for catching demand/rank declines that the existing single-threshold alerts miss. No DB migration — rides on the existing `alert_configs.alert_type` + JSONB `conditions`/`channels` and `alert_instances.data`.

### Added — Product-movers alert type (`alert_type = "product_movers"`)

- **Period-over-period comparison.** For each active product, compares the last `window_days` days against the preceding equal window. BSR uses the **median** `best_rank` (robust to the hourly jitter); order/ad metrics use period sums.
- **Configurable multi-metric constructor.** `conditions = { window_days, match: "any"|"all", min_orders_prev, metrics: [{ metric, direction: "up"|"down", change_pct }] }`. Add any number of conditions; `match` combines them (OR / AND). A condition fires when the metric moved by ≥ `change_pct` % in the chosen direction.
- **Metric catalog (14).** `bsr` (median rank); **`orders` / `units` / `sales` = total (organic + ads)** from SP-API `sp_order_items` ⋈ `sp_orders` (excludes `Canceled`); `ad_orders` / `ad_sales` (ad-attributed); `spend` / `clicks` / `impressions` / `acos` / `ctr` / `cpc` / `cvr` / `roas` from `advertised_product`. Derived ad ratios (acos/cvr/roas) use ad-side denominators.
- **`min_orders_prev` noise floor** — order/total-derived metrics are only evaluated when the product had enough orders in the prior window (gated by total orders for total metrics, ad orders for ad metrics; BSR is never gated).
- **Single digest per fire.** Writes one `alert_instances` row (`entity_type = "product_movers"`, full breached-product list in `data.products[]`) and sends **one email** listing every breached product with photo (`products.image_url`), Amazon `/dp/` link (marketplace→domain map, default `amazon.de`), per-metric `prev → cur (±%)`, and a shared "likely causes — check in this order" checklist (Inventory → Buy Box → Price → Reviews → Ads → Listing → Market). `email.js → sendProductMoversEmail`.
- **Expandable triggered-alert rows.** In the Alerts → Triggered tab, a product-movers instance row expands in-place to show the same content as the email (product cards + causes checklist). `GET /alerts` already returned the `data` JSONB.
- **Frontend.** Alert modal gains a type toggle (Threshold / Product movers) and a dynamic condition builder (metric select auto-picks the sensible direction, `+ Add metric`, per-row remove, ANY/ALL toggle shown with ≥2 conditions, `min_orders_prev`). ~30 new `alerts.*` i18n keys across en/ru/de.

### Changed

- **`orders` / `sales` now mean TOTAL, not ad-attributed.** The product-movers metrics use SP-API total orders (organic + ads). Most real declines are invisible to ad data alone (e.g. a product with 39 → 0 total orders had 0 ad-attributed orders). `ad_orders` / `ad_sales` remain available for ad-specific conditions. Legacy `{ bsr_change_pct, orders_change_pct, require_both }` configs are auto-converted (`require_both` → `match: "all"`) and continue to work.

### Fixed

- **`require_both` with a single enabled metric never fired.** When only one metric was set but "both conditions" was on, the AND could never be satisfied. `require_both` / `match: "all"` now only applies when ≥2 conditions are enabled (degrades to OR otherwise).
- **Absurd % on ACOS-to-infinity.** A product that kept spending with zero ad sales hits the ACOS sentinel (∞), which produced display values like `+666396%`. The shown `pct` is now clamped to ±9999 % (breach detection still uses the raw value; real moves like BSR `+1300%` are untouched).

### Notes

- **Correctness verified** with a throwaway harness that independently recomputes every metric from raw SQL (explicit date-literal windows) and compares ASIN sets against the engine: **255 / 255 pass** across 14 metrics × 2 directions × 3 thresholds over window sizes `N ∈ {1, 7, 14}`, plus `match = all` (= set intersection), the noise-floor gate, and flag integrity. The live fired instance was independently confirmed 10/10.
- Backend computation is split into a pure `computeMoverFlags(workspaceId, cond)` (no side effects, used by the evaluator and tests) and `evaluateProductMovers` (cooldown + instance + email).
- Limitation: a metric going `0 → positive` can't yield a %, so it never fires (only proportional moves from a non-zero baseline are detected). Amazon spells the cancelled status `Canceled` (one "l").

---

## [Unreleased] — 2026-06-01 — Stage 20: Rule write-back correctness & audit visibility

Audit of the last 3 days of rule execution surfaced silent divergence between the local DB and Amazon: rules logged actions as "applied" while several write-backs were actually being rejected by the Amazon Ads API and swallowed by non-fatal `.catch()` handlers.

### Fixed

- **Negative-keyword archive rejected by Amazon (400 INVALID_ARGUMENT).** `services/amazon/writeback.js → archiveNegativeKeyword` sent `state: "archived"`, but the Amazon Ads negative-keyword `state` field only accepts `ENABLED | PROPOSED | PAUSED`. This failed ~24 times over 3 days — the negative was removed locally but left **active** on Amazon (the reconciled search term stayed blocked). Now sends `state: "PAUSED"`, mirroring the already-correct negative-**target** path; the local row is still marked `archived` for our own bookkeeping.
- **`audit_events.amazon_status` never populated for rule actions.** Every rule write-back went through `.catch(warn)` with no status recorded, so failures (including a budget `422`) were masked as "0 errors" in the journal. Added `updateAuditStatus` propagation via a new `trackWriteback(auditId, promise, msg)` helper in `routes/rules.js → executeRule`, wired into all negative add/archive and budget/set_budget write-backs. The journal now records `success` / `error` plus the Amazon error text per action. (Bid/state write-back branches are intentionally left uninstrumented — no current rule uses them; the helper is ready to extend.)
- **Sponsored Brands campaign sync returned 404 daily.** `services/amazon/entities.js` listed SB campaigns via the removed `GET /sb/v4/campaigns` route. Switched to `POST /sb/v4/campaigns/list` with media type `application/vnd.sbcampaignresource.v4+json`, mirroring the SP `…/list` block. Remains non-fatal (returns `[]` on error), so a wrong contract is no worse than today.

### Changed

- **Rule run telemetry now persisted.** Both run paths (manual `POST /rules/:id/run` and the scheduled `executeAllDueRules`) now set `last_run_status`, increment `run_count`, and insert a row into `rule_executions` (best-effort) — previously these were never written, so `GET /rules/:id/runs` always returned an empty history and `run_count` was stuck at 0.

### Notes

- The single budget `422` (1 of 29 campaigns) is **not** a payload-format bug — the SP `dailyBudget` shape matches the UI path in `routes/campaigns.js`. It is a single-campaign rejection that is now diagnosable via the captured `amazon_status` / `amazon_error`.
- Tests in the changed suites: **156 passed / 16 failed**. The 16 failures are pre-existing stale-mock assertions (exact `mock.calls` indices), unchanged by this work. Test-only fix: the `routes/audit` mock in `tests/rules.test.js` now also exports `updateAuditStatus`.

---

## [Unreleased] — 2026-05-29 — Stage 19: KWR history, Alerts engine, Products catalog, Team

### Added — Keyword Research search history (workspace-shared)

- **`kwr_search_history` table** (migration `032_kwr_search_history.sql`): stores each discovery run's inputs + a full snapshot of the results, workspace-shared, pruned to the latest 50 per workspace on insert.
- **`POST /keyword-research/discover`** now auto-saves a history row (non-fatal) with the input ASINs/title/URL/profile/sources/locale/organicTopN + result snapshot.
- New routes: **`GET /keyword-research/history`** (lightweight list), **`GET /keyword-research/history/:id`** (full snapshot for restore), **`DELETE /keyword-research/history/:id`**, **`DELETE /keyword-research/history`** (clear all).
- **UI**: collapsible bar above the input card (collapsed = one row; expanded = horizontal compact cards). Clicking a card instantly restores the form + results from the snapshot — **no re-query** (saves paid Jungle Scout / Claude calls). 13 new `kwr.hist*` i18n keys (en/ru/de).

### Added — Keyword Research multi-format export

- Old "↓ CSV" button (actually wrote `.tsv`, 9 columns with 2 always blank, only the filtered view) replaced with a **format dropdown: CSV · Excel (.xlsx) · TSV · JSON**, **12 full columns** (incl. source, match type, organic rank, top position, search volume, impressions share, ease, placement), exporting **all** keywords (or the current selection) — not just the filtered view.
- New **`POST /keyword-research/export`** builds a real `.xlsx` via `exceljs` from a generic `{ columns, rows }` payload (bold header, auto width, frozen header row).
- All three product-input textareas are now **`resize: vertical`** (were fixed-height).

### Added — AI keyword prompt guardrails

- `services/ai/keywordResearch.js`: shared `KEYWORD_EXCLUSIONS` injected into **both** the generation and scoring prompts — never output competitor brands (Amazon policy), the seller's own brand, subjective/promo claims (best/cheapest/premium/…), ASIN codes, or misleading off-topic terms. The scoring prompt sets `keep:false` so such terms coming from Jungle Scout / Amazon are filtered out too.

### Added — Products: full catalog + availability/advertising filters

- Bulk-loaded all advertised ASINs into the Products watchlist and enriched title/BSR via SP-API. (Of the previously-untracked advertised ASINs, ~67 % returned catalog 404 — delisted listings accumulated from old campaigns.)
- **`GET /products`** gains `availability` (`all|available|unavailable`) and `advertising` (`all|advertised|not_advertised`) query params, plus per-row `is_available` and `is_advertised` flags.
- **UI**: two toolbar filters — "Listing availability" (Available / Delisted) and "Advertising" (Advertised / Not advertised). Count label shows `filtered / total`.

### Added — Team: pending invitees + role editing

- **`GET /settings/members`** now includes pending invitees (invited, not yet accepted) with a `status` field (`active` / `pending`) — previously new-user invitations were invisible until accepted.
- A pending member's role can be changed **before** they accept (updates the invitation; applied on accept). **`DELETE /settings/members/:userId`** cancels a pending invitation. UI shows a "Pending" badge.

### Added — Alerts: evaluation engine + email + more metrics + BSR

- **The alerts feature had no evaluation engine** — the `alert-check` queue name existed but nothing evaluated thresholds, so **no alert ever fired**. Implemented `services/alerts/evaluate.js evaluateWorkspaceAlerts()`: evaluates active configs, respects the `suppression_hours` cooldown, writes `alert_instances`, and fires channels.
- **Hourly cron** (`scheduler.js`, at :15) + **`POST /alerts/check`** for an on-demand/manual run (UI "Check now" button).
- **Email channel** via `email.js sendAlertEmail` (Brevo SMTP). Recipients: `channels.email_to` (comma-separated) or, if empty, workspace owners & admins. Channels JSON: `{ in_app, email, email_to }`.
- **Metrics expanded 6 → 11**: `acos, roas, spend, sales, orders, clicks, impressions, ctr, cpc, cvr` (account aggregate from `fact_metrics_daily`, campaign-level) + **`bsr`** (latest Best-Sellers Rank for a specific `asin` from `bsr_snapshots`).
- **Configurable look-back window** (`conditions.window_days`, 1–90, default 7) for performance metrics; BSR uses the latest snapshot. conditions JSON: `{ metric, operator, value, window_days, asin }`.

### Fixed

- **Alerts ACOS edge case**: spend with zero sales (ACOS effectively infinite) was skipped (`!isFinite`) so an "ACOS > X" alert never fired in the worst case. Now mapped to a large finite value (9999) so it correctly triggers `>` thresholds.
- **Invite modal & Delete-workspace modal** used a hardcoded dark background (`#1a1d2e`) → unreadable in light theme. Switched to theme variables (`var(--s1)`, border, shadow, `var(--tx)`).
- Removed a stale active diagnostic rule `__verify_keyword_metrics__` (dry-run, clicks≥1 → pause) from production; all rules in the workspace are now real, active rules.
- Test hygiene: fixed a stale `DELETE /alerts/configs/:id` test mock (out of date since the Stage 15 trash flow added a pre-delete SELECT).

---

## [Unreleased] — 2026-05-11

### Added — Full test coverage: campaigns wizard, rules engine

- **Unit tests** — `campaigns.test.js` fully rewritten (+4 new describe blocks, 68 tests total): `PATCH /campaigns/:id` (16 tests — state/budget/bidding/placements for SP/SB/SD, UPPERCASE enforcement, fire-and-forget placement path, 400/404/500), `GET /campaigns/:id` (404 + workspace isolation), `GET /campaigns/:id/placement` (v3 format, v2 format, empty, v3-priority), `GET /campaigns/:id/metrics` (time-series, date range).
- **`adGroups.test.js`** new file (26 tests): `GET`, `POST`, `PATCH` for ad groups — SP/SB/SD endpoint routing, bid clamping ≥ 0.02, Amazon failure non-fatal, limit clamped to 1000.
- **`keywords.test.js`** extended (+21 tests): `POST /keywords` (create single: all match types, 409 dedup, bid clamping, pushNewKeywords UPPERCASE), `PATCH /keywords/bulk` (single/multi update, skip not-found, loadKeywordContext).
- **`campaigns.integration.test.js`** new file (48 integration tests with real PostgreSQL): full wizard flow campaign→ad-group→keywords with FK-hierarchy verification, state transitions in DB, audit events written, bulk keyword update, PATCH non-fatal Amazon failure.
- **`jest.config.js`** new default config that excludes `tests/integration/` from `npm test` — prevents integration tests running without Docker.
- **`seed.js` `cleanMutable()`** extended: now deletes dynamically created campaigns/ad_groups/keywords (not seeded) between tests; resets seeded campaigns/ad_groups to initial state.

### Fixed — Integration tests: audit_events trigger

- `globalSetup.js` was disabling trigger `prevent_audit_modification` (wrong name). Actual trigger is `audit_immutable`. Fixed → `cleanMutable` DELETE FROM audit_events now works between test runs.

---

## [Unreleased] — 2026-05-07

### Added — Rank Tracker: portfolio (group) support for ASINs

- **`rank_portfolios` table** (migration `025_rank_portfolios.sql`): `id, workspace_id, name, display_order, created_at`. Unique constraint on `(workspace_id, name)`.
- **`asin_labels.portfolio_id`** column added (FK → `rank_portfolios.id ON DELETE SET NULL`).
- **`GET/POST/PATCH/DELETE /rank-portfolios`** new route (`rankPortfolios.js`). POST uses `ON CONFLICT DO UPDATE` so duplicate names are idempotent.
- **`GET /keyword-ranks`** now returns `asin_portfolio_id` (from `asin_labels.portfolio_id`) and `display_order` (keyword-level) for sorting.
- **`PATCH /keyword-ranks/labels/:asin`** extended to accept optional `portfolio_id` (updates only when key is present in request body, preserving existing label).
- **`PATCH /keyword-ranks/kw-order`** new endpoint — saves per-keyword `display_order` within an ASIN group.
- **RankTrackerPage UI**: portfolio cards rendered above ungrouped ASINs. Each card collapses/expands with chevron. Folder-icon dropdown on each ASIN header assigns or removes from a group. "+ New group" inline form with Enter/Escape keyboard support. Ungrouped label shown when at least one portfolio exists. DnD reorder applies only to ungrouped ASINs; portfolio ASINs show a spacer in place of the drag handle.

### Added — Rank Tracker: keyword position 7-day sparkline on hover

- **`KwRankMiniChart` component**: 180×56 SVG sparkline, inverted Y-axis (lower position = top). Series: latest snapshot per day over the last 7 days. Interactive crosshair — hover shows `#position · DD MMM` tooltip.
- Trend badge: `▲N` green (rank improved) / `▼N` red (worsened) / `−` flat.
- Lazy fetch on first hover (200 ms delay): `GET /keyword-ranks/:id/history?days=7`. `kwHoverFetching` ref dedupes concurrent fetches. Portal-rendered popup follows the badge with viewport-edge clamping.
- Hover card stays open when cursor moves from badge to card (close-timer pattern, same as BSR sparkline).

### Added — Search Terms: hide already-negated terms

- **`GET /search-terms` LEFT JOIN `negative_keywords nk_check`** on `(workspace_id, campaign_id, keyword_text/query, match_type)`. Match types covered: `negativeExact`, `negative_exact` (exact match), `negativePhrase`, `negative_phrase` (phrase/contains match).
- `BOOL_OR(nk_check.id IS NOT NULL) AS is_negated` aggregated per search-term group.
- `?hideNegated=true` adds `HAVING BOOL_OR(nk_check.id IS NOT NULL) = FALSE` — hides terms already negated in that campaign.
- **Frontend**: `stHideNegated` state (default `true`). Toggle button "Негативы скрыты / Показать негативы" with Ban icon. Negated rows (when visible) rendered with red strikethrough, 0.6 opacity, and a red `NEG` badge.

### Fixed — Rules simulation preview: wrong field names (preview never showed data)

- Frontend preview step read `previewData.actions_planned` (backend returns `applied_count`) → "Actions planned" always showed "—".
- Frontend read `previewData.sample_matches` (backend returns `applied[]`) → matches table never rendered.
- Frontend read `m.action_type` (backend returns `m.action`) → action column was blank.
- Frontend read `m.action_value` (non-existent) for the value column → always showed "—". Now resolves `new_state ?? match_type ?? change_pct ?? new_bid+"€"` depending on action type.
- Entity column displayed `m.target_text` (non-existent) for targets → now uses `expression[0].value` pattern consistent with run-result modal.

### Fixed — Search Terms negated detection: wrong match type values

- `nk_check` JOIN used `IN ('negativeExact','exact')` / `IN ('negativePhrase','phrase')` — `'exact'` and `'phrase'` are positive match types that don't exist in `negative_keywords`, so rows stored as `negative_exact` / `negative_phrase` were never detected as negated. Corrected to `IN ('negativeExact','negative_exact')` / `IN ('negativePhrase','negative_phrase')`.

### Fixed — Portfolio dropdown stays open after clicking outside

- Folder-icon ASIN assignment dropdown had no outside-click handler. Now a `document.addEventListener("click", close)` effect is added/removed whenever `assigningAsin` is non-null, closing the dropdown on any outside click.

### Fixed — Duplicate portfolio entry in UI on conflict

- Creating a portfolio with a name that already exists (server `ON CONFLICT DO UPDATE` returns the existing row) caused a duplicate entry in the local `portfolios` list. Now deduplicates by `id` before appending.

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
