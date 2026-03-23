# AdsFlow UX Audit — World-Class Standards

> Date: 23 March 2026
> Sprint 1 complete — 10/10 items delivered
> Methodology: Live audit of all 12 sections + analysis of Pacvue, Helium10, Scale Insights, Intentwise, Adbrew + Nielsen Norman Group research

---

## Research Methodology

### Competitors Analyzed
| Platform | Users | Key Differentiator |
|----------|-------|--------------------|
| Pacvue | 70k+ brands | Enterprise, $150B GMV, AI Copilot, natural language queries |
| Helium10 Ads | 400k+ sellers | Pacvue technology for SMB, pre-built templates |
| Scale Insights | 9-figure sellers | Algorithm stacking "like LEGOs", dayparting heatmap |
| Intentwise | 1k+ brands | Top-tier UX, intuitive drill-down, analytics-first |
| Adbrew | Mid-market | User-friendly, strong dayparting, rule-based |

### UX Research Sources
- **Nielsen Norman Group** — Data Tables (4 user tasks), Bulk Actions (3 guidelines), Empty States
- **NNg Progressive Disclosure** — reduces task completion time by 20–40%, 35% fewer support tickets
- **SaaS Activation Research** — 84% abandon blank states without contextual help (first session)
- **Zeigarnik Effect** — progress bars and checklists increase completion rates
- **Eleken UX** — inline editing reduces friction, maintains table context

---

## Section 1: Overview

### ✅ Working Well
- 9 KPI cards with sparklines — correct approach, all competitors do this
- Date range picker (7d/14d/30d/90d/Custom)
- Quick/Full sync split button
- Global progress bar in bottom-right corner

### ⚠️ Issues Found
1. **"Spend by day" bar chart** — no hover tooltip, no Y-axis, no values on bars
2. **Quick vs Full sync** — difference is unclear to new users; no explanation
3. **"Last updated"** — not shown next to the Refresh button

### 💡 Recommendations
- Hover tooltip: `Tue Mar 18 · Spend: €164 · Sales: €2,100 · ACOS: 7.8%`
- Tooltip on each sync mode button explaining what it does and how long it takes
- `data from Mar 20, 13:42` next to Refresh button

---

## Section 2: Campaigns

### ✅ Working Well
- Slide-in filter panel with saved presets — competitive feature vs Pacvue
- Bulk actions bar (pause/enable/archive/edit budget)
- Sort by all columns with direction indicator

### ⚠️ Issues Found
1. **No drill-down** — clicking a campaign name does nothing
2. **Permanent `Edit` button** on every row — wastes space, clutters table
3. **Budget vs Spend** — `$30 budget / $289 spend` with no visual context
4. **No inline status change** — requires checkbox + bulk action (extra step)

### 💡 Recommendations
- Expandable row or slide-panel on campaign name click
- Hover-row actions instead of permanent per-row buttons (NNg standard)
- Budget utilization mini-bar below budget value
- Click status dot → inline toggle dropdown

---

## Section 3: Keywords

### ✅ Working Well
- Match type filter (Exact/Phrase/Broad)
- Quick "Edit bid" button

### ⚠️ Issues Found
1. **No performance metrics** — only Bid + Campaign, missing Clicks/Orders/ACOS/Spend
2. **No Search Term Harvesting** — missing core feature present in ALL competitors
3. **No Negative Keywords section**
4. **Campaign name truncated** — no tooltip with full name on hover

### 💡 Recommendations
- Add columns: Clicks / Orders / ACOS / Spend (with period selector)
- `Search Terms` tab with harvesting workflow (green = harvest, red = negate)
- `Negatives` tab with quick-add
- `title` attribute or custom tooltip on truncated campaign names

---

## Section 4: Products

### ❌ Critical Issues
1. **Technical error in subtitle**: `"SP-API not configured — add SP_API_* to .env"` — developer message shown to end user
2. **Blank screen** without any guided CTA or explanation of value

### 💡 Recommendations
Guided empty state explaining the value proposition + CTA to add first ASIN.
Follow ProductLed pattern: illustration + benefit statement + primary action button.

---

## Section 5: Reports

### ❌ Critical Issues
1. **10+ rows showing `failed`** — no explanation of cause or resolution steps
2. **Technical subtitle**: `"Amazon Ads Reporting API v3 · Async pipeline"` — internal jargon
3. **Empty date fields** instead of quick presets (7d/14d/30d)
4. **Raw sheet description**: `Sheet_1: All SKUs → SP/SD/SB spend, sales, units...`

### 💡 Recommendations
- Inline error: `API error — check your connection →` (links to Connections page)
- Subtitle: `"Automated reports for your campaigns"`
- Date presets: 7d / 14d / 30d (same UX as Overview)
- Human-readable file description: what each sheet contains and why it's useful

---

## Section 6: Analytics

### ✅ Working Well
- P&L XLSX report with exceljs — unique feature vs competitors
- Per-ASIN cost config (COGS, shipping, fees, VAT)

### ⚠️ Issues Found
1. **Nearly empty page** — value proposition not immediately obvious
2. **Collapsed cost config section** — no prompt to fill it, users miss it

### 💡 Recommendations
- Preview description of what the file contains before downloading
- Auto-expand cost config section on first visit with CTA: `Fill in your costs for accurate P&L`
- Show last download date + file size after download

---

## Section 7: Rules Engine

### ✅ Working Well
- 3-step wizard structure — right approach
- Live sentence preview (IF...THEN) — unique and intuitive
- AND-badge between conditions
- Condition row layout: metric / operator / value properly proportioned
- Unit suffixes (€, %, ×) on value input

### ⚠️ Issues Found
1. **No templates** — new users don't know where to start (Scale Insights solved this with "Mass Campaigns")
2. **No preview** — user doesn't know how many objects the rule will affect
3. **AND only** — no OR logic between conditions (Scale Insights, Pacvue support AND/OR)
4. **No dayparting** — hourly scheduling (key feature in all top competitors)
5. **No algorithm stacking** — no rule chains (Scale Insights' main USP)

### 💡 Recommendations
See ROADMAP.md S1-1, S1-2, S2-2, S3-2, S4-2

---

## Section 8: Alerts

### ✅ Working Well
- Configurations/Triggers tab structure
- Active/inactive toggle
- Metric-based thresholds

### ⚠️ Issues Found
1. **"COOLDOWN"** — technical term without explanation
2. **"in-app"** channel label — unclear what other channels might exist

### 💡 Recommendations
- Tooltip on COOLDOWN column header
- Expand channel options or add tooltip explaining current options

---

## Section 9: AI Assistant

### ✅ Working Well
- Claude Sonnet integration
- Structured recommendations with risk levels (high/other)
- Apply / Preview / Dismiss action buttons

### ⚠️ Issues Found
1. **Raw JSON in recommendation card** — `{"target_acos":"12%","product_categories":"EVOCAMP..."}`
2. **No suggested prompts** — blank textarea with no guidance
3. **No conversation history** — only most recent session shown
4. **"Apply" button** — no preview of what exactly will change

### 💡 Recommendations
- Parse JSON and render human-readable parameter card
- Suggested prompts below input: `[Which campaigns overspend?]` `[Where is ACOS too high?]`
- Apply → show preview of changes before executing
- Pacvue Copilot benchmark: *"little to no product knowledge required"*

---

## Section 10: Audit Log

### ✅ Working Well
- Rollback button with undo icon
- Diff column `bid: 1.5 → 1.55` with color coding
- Filters (action, entity, source, date range)

### ⚠️ Issues Found
1. **Technical event names**: `keyword.bid_change.rollback` — not readable by non-technical users
2. **UUID instead of entity names** — `b2d89d8d-f281-4efd...` instead of keyword/campaign name
3. **No date grouping** — flat list instead of Today / Yesterday / March 17

### 💡 Recommendations
- Map `event_type` → human-readable action string
- Show keyword/campaign name instead of UUID (join with entity table)
- Group rows by date with sticky section headers

---

## Section 11: Connections

### ✅ Working Well
- Lock/Zap/Repeat icons for security/speed/auto-sync badges
- Region selector (NA/EU/FE)
- Active status indicator

### ⚠️ Issues Found
1. No guidance on what to do if a connection fails or expires

### 💡 Recommendations
- Inline status with `Reconnect` CTA when token expires
- Tooltip explaining what happens during each sync type

---

## Section 12: Settings

### ✅ Working Well
- Clear sub-navigation (Profile / Workspace / Team / Notifications / Security)
- Organization info card

### ⚠️ Issues Found
1. **Attribution Window: 1d** — no explanation of what this means or available options
2. **Mix of English/Russian labels** — `WORKSPACE NAME`, `DESCRIPTION`, `TIMEZONE`, `ATTRIBUTION WINDOW`, `CURRENCY`

### 💡 Recommendations
- Description under Attribution Window field: `Conversion tracking period after an ad click. Affects ACOS and ROAS calculations.`
- Available options: `1d / 7d / 14d / 30d` with brief explanation of each
- Localize all field labels through i18n system

---

## Global Recommendations

### Onboarding Flow
**Research:** 25% of users abandon an app after one use without effective onboarding (Appcues)
**Research:** Products using progressive disclosure see 35% fewer support tickets (NNg)

Add Getting Started checklist widget on Overview for new users. Close automatically when all steps complete.

### Keyboard Shortcuts
**Source:** Pacvue, Intentwise — power users (agencies) work for hours daily

Add global shortcut layer:
- `/` → focus search
- `R` → refresh current page data
- `N` → new rule / campaign (context-aware)
- `Esc` → close modal or panel
- `Ctrl+Enter` → submit current form
- `?` → open shortcuts reference overlay

### Saved Filters (User-Created)
**Source:** Pacvue — enterprise PPC platform standard

Beyond the existing saved presets — allow users to name and save their own filter combinations. Store in user settings (already JSONB in DB).

### ACOS Color Coding (Global Standard)
Every competitor (Pacvue, Helium10, Scale Insights, Adbrew, Intentwise) uses color-coded ACOS.
This is the single highest-signal metric for Amazon PPC health — green/yellow/red should be visible at a glance everywhere ACOS appears.

---

## Competitive Gap Analysis

| Feature | AdsFlow | Pacvue | Helium10 | Scale Insights | Intentwise |
|---------|---------|--------|----------|----------------|------------|
| Rule templates | ✅ S1 Done | ✅ | ✅ | ✅ | ❌ |
| Rule preview (object count) | ✅ S1 Done | ✅ | ✅ | ✅ | ❌ |
| ACOS color coding | ✅ S1 Done | ✅ | ✅ | ✅ | ✅ |
| Inline status toggle | ✅ S1 Done | ✅ | ✅ | ❌ | ✅ |
| Search term harvesting | ❌ S3 | ✅ | ✅ | ✅ | ✅ |
| Dayparting | ❌ S2 | ✅ | ✅ | ✅ | ❌ |
| AND/OR rule logic | ❌ S2 | ✅ | ❌ | ✅ | ✅ |
| Drill-down in tables | ❌ S2 | ✅ | ✅ | ❌ | ✅ |
| Budget utilization bar | ❌ S2 | ✅ | ❌ | ❌ | ❌ |
| Write-back to Amazon | ❌ S4 | ✅ | ✅ | ✅ | ✅ |
| Algorithm stacking | ❌ S4 | ❌ | ❌ | ✅ | ❌ |
| Hover-row actions | ✅ S1 Done | ✅ | ✅ | ❌ | ✅ |
| Tooltips on technical terms | ✅ S1 Done | ❌ | ❌ | ❌ | ❌ |
| Last sync timestamp | ✅ S1 Done | ✅ | ❌ | ❌ | ❌ |
| Readable audit log | ✅ S1 Done | ✅ | ❌ | ✅ | ❌ |
| Guided empty states | ✅ S1 Done | ✅ | ✅ | ❌ | ❌ |
| Saved filter presets | ✅ Existing | ✅ | ❌ | ❌ | ❌ |
| 3/4-step rule wizard | ✅ Existing | ❌ | ❌ | ❌ | ❌ |
| Live rule preview sentence | ✅ Existing | ❌ | ❌ | ❌ | ❌ |
| AI recommendations | ✅ Existing | ✅ | ✅ | ❌ | ❌ |

---

*Full roadmap with priorities and implementation details: [ROADMAP.md](./ROADMAP.md)*
