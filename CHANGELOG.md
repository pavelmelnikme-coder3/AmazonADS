# Changelog

All notable changes to AdsFlow are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`

---

## [Unreleased] — 2026-03-23

### Added — Sprint 1 · Group C (Rules UX)
- **S1-1 · Rule templates** — 6 pre-built templates shown in 3×2 grid at
  top of wizard Step 1 for new rules. Templates: Pause losing keywords,
  Cut high ACOS bids, Boost top performers, Add wasted spend to negatives,
  Pause non-converting targets, Lower bids on low ROAS. Clicking a template
  pre-fills all form fields and advances directly to Step 2.
  `RULE_TEMPLATES` array + `applyTemplate()` function. Condition: `!editRule?.id`
  (hidden when editing existing rule with an id).
- **S1-2 · Rule preview (Step 4)** — Wizard extended to 4 steps. Step 3 footer
  now shows "Предпросмотр →" instead of Save. Calls `POST /rules/:id/run`
  with `{dry_run: true}` — creates a temporary rule for new ones, uses existing
  id for edits, then deletes the temp rule. Renders 3 stat cards
  (Entities matched / Actions planned / Mode) + sample matches table (up to 10 rows).
  Error fallback lets user save directly. Final Save button in Step 4.
- **S1-6 · Tooltips for technical terms** — `Tip` component: pure CSS,
  zero dependencies, hover-activated bubble above trigger with arrow.
  Applied to: COOLDOWN (Alerts table header), Attribution Window (Settings/Workspace),
  SIM badge (rule cards), ПЕРИОД ДАННЫХ (rule wizard Step 1).
  `HelpCircle` icon used as trigger.
- **S1-8 · Human-readable audit log events** — `AUDIT_ACTION_LABELS` map
  (14 entries): `connection.created` → "Account connected",
  `keyword.bid_change` → "Keyword bid updated",
  `keyword.bid_change.rollback` → "Bid change rolled back", etc.
  `auditLabel()` fallback formats unknown events by replacing dots/underscores
  with spaces. Action cell shows human label (bold) + original event type (small).
  Entity cell: `connection` with null name → "Amazon Ads Account" instead of UUID.
  `formatDateGroup()` date separators between rows: TODAY / YESTERDAY / 17 MARCH 2026.
- **S1-9 · Guided empty state for Products** — Subtitle changed from developer
  error message ("SP-API не настроен — добавьте SP_API_* в .env") to
  "Track BSR rankings and connect advertising spend to product performance".
  Empty state: Package icon (48px) + "Start tracking your products" headline +
  benefit row (BSR ranking history · P&L per ASIN · Ad spend attribution) +
  ASIN hint badge. ASIN input and button preserved.
- **S1-10 · Reports UX improvements** — Subtitle changed to
  "Download advertising performance data by campaign type and date range".
  Date presets (7d / 14d / 30d) added above date inputs. `fmtReportPeriod()`
  formats ISO timestamps to "22 Feb – 22 Mar". `fmtReportType()` converts
  snake_case to Title Case ("advertised_product" → "Advertised Product").
  `failed` status renders as badge with HelpCircle + `Tip` tooltip explaining
  the error. `completed` status renders as green badge.
- **docs/ROADMAP.md** — Updated: Sprint 1 items marked ✅ DONE.
  Priority matrix updated with completion status.
- **docs/UX_AUDIT.md** — Updated: competitive gap analysis table updated
  to reflect all Sprint 1 implementations.

### Changed — Sprint 1 · Group A+B (Tables & UX)
- **S1-3 · ACOS semantic colors** — `acosColor(pct)` helper: `< 15%` →
  `var(--grn)`, `15–30%` → `var(--amb)`, `> 30%` → `var(--red)`. Applied
  to ACOS columns in Overview top-campaigns, Overview by-type, and Campaigns
  table. ACOS stored as percentage 0–100 (confirmed).
- **S1-4 · Inline status toggle** — Status badges (`● enabled`, `● paused`)
  in Campaigns and Keywords tables now have `.status-clickable` class: pointer
  cursor, dotted underline on hover. onClick wires directly into existing
  `setEditId` inline editor flow — same as clicking "Изм." button.
  CSS: `.status-clickable:hover { opacity: 0.75; text-decoration: underline dotted; }`
- **S1-5 · Hover-row actions** — `.tbl-row .act-cell { opacity: 0; transition: opacity 150ms ease; }`
  Action buttons visible only on hover. Always visible when row is selected
  (`.row-selected`). `@media (hover: none)` fallback for touch devices.
  Applied to Campaigns and Keywords tables.
- **S1-7 · Last sync timestamp** — `fmtLastSync(iso)` helper: `< 1min` → "just now",
  `< 60min` → "X min ago", `< 24h` → "Xh ago", older → localized date+time.
  Each page (Overview, Campaigns, Keywords) fetches `/connections` once on mount,
  computes most-recent `last_refresh_at`, renders `· X min ago` after Refresh button.

### Added — Documentation (2026-03-23)
- `docs/ROADMAP.md` — 4-sprint product roadmap, 20 features, priority matrix
- `docs/UX_AUDIT.md` — Full UX audit of all 12 sections + competitive gap analysis

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
