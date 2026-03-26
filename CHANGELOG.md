# Changelog

All notable changes to AdsFlow are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).  
Versioning follows [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`

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
