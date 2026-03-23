# AdsFlow — Product Roadmap

> Last updated: March 2026
> Based on: Live UX audit of all 12 sections, competitor analysis (Pacvue / Helium10 Ads / Scale Insights / Intentwise / Adbrew) + Nielsen Norman Group research

---

## 🎯 Core Principles

- **Zero feature loss** — every change adds, never removes
- **Amazon-first UX** — users familiar with Seller Central navigate without instructions
- **Progressive disclosure** — simple for beginners, deep for power users (NNg: reduces task time by 20–40%)
- **Inline first** — minimize modals, maximize in-context actions

---

## 🗓 Sprint 1 — Quick Wins (1–2 days each)

### S1-1 · Rule Templates ⭐ HIGH PRIORITY
**Source:** Pacvue, Scale Insights, Helium10 — all list templates as a top-requested feature
**Problem:** New users don't know where to start when creating a rule

Implementation:
- When clicking "+ New Rule" — offer choice: `📋 From Template` / `⚙️ From Scratch`
- 6 starter templates pre-filled in the wizard:
  - 🔥 Pause losing KWs — `Clicks ≥ 20 AND ACOS > 40% → Pause`
  - 📈 Boost top performers — `ROAS > 5× AND Orders ≥ 3 → Bid +15%`
  - 💸 Cut wasted spend — `Spend > €50 AND Orders = 0 → Bid −30%`
  - 🎯 Add to negatives — `Clicks ≥ 15 AND Orders = 0 (30d) → Negative Exact`
  - ⏸ Pause zero targets — `Clicks ≥ 10 AND Orders = 0 → pause_target`
  - 🔄 Revive historical KWs — `bid < 0.30 AND historical orders > 0 → bid +20%`

---

### S1-2 · Rule Preview Before Saving ⭐ HIGH PRIORITY
**Source:** Scale Insights — *"preview actions and calculations before they are implemented — full transparency"*

After Step 3 — add an intermediate confirmation screen:

---

### S1-3 · ACOS Color Coding in Tables ⭐ HIGH PRIORITY
**Source:** All competitors — color-coded ACOS is an industry standard

- `< 15%` → green text
- `15–30%` → yellow/amber
- `> 30%` → red
- Apply to ACOS columns in Campaigns and Keywords tables

---

### S1-4 · Inline Status Toggle in Tables
**Source:** Intentwise, Pacvue — click status dot to change it without a modal

- `● paused` on hover → mini-dropdown `Enable / Pause / Archive`
- After change: toast `Campaign enabled` + `Undo` button (5 sec)
- Writes audit event

---

### S1-5 · Hover-Row Actions Instead of Permanent Buttons
**Source:** NN/g Data Tables — action buttons on hover free up table space

- `Edit` button only visible on row hover
- Frees ~80px per row → more space for data metrics

---

### S1-6 · Tooltips for All Technical Terms
**Source:** NNg — *"brief and highly contextual tooltips explain why, not just what"*

Add `?` icon + tooltip for:
- `COOLDOWN` → `Minimum interval between repeated notifications for the same condition`
- `Attribution Window` → `Conversion tracking period after an ad click. Affects ACOS/ROAS calculation`
- `SIM / Dry-run` → `Simulation mode — changes are not applied to Amazon`
- `TACoS` → `Total ACoS = Ad Spend / Total Sales (organic + paid)`
- `BSR` → `Best Seller Rank — product position within an Amazon category`

---

### S1-7 · "Last Updated" Next to Refresh Button
**Source:** NNg — *"Always indicate when data was last updated — users need to trust the data"*

`⟳ Refresh` → `⟳ Refresh  ·  data from Mar 20, 13:42`

---

### S1-8 · Human-Readable Events in Audit Log
**Source:** UX audit — currently shows `keyword.bid_change.rollback`, UUIDs instead of names

Mapping:
- `keyword.bid_change` → `Keyword bid updated`
- `connection.created` → `Amazon Ads account connected`
- `keyword.bid_change.rollback` → `Bid change rolled back`
- Entity: show name + type instead of UUID
- Group by date: `Today / Yesterday / Mar 17`

---

### S1-9 · Guided Empty State for Products
**Source:** Research — *"84% of users abandon blank states without contextual help"*

Remove `"SP-API not configured — add SP_API_* to .env"`. Replace with guided empty state explaining value proposition + CTA to configure SP-API.

---

## 🗓 Sprint 2 — Depth Features (3–5 days each)

### S2-1 · Performance Metrics in Keywords Table
**Source:** All competitors — Clicks/Orders/ACOS/Spend are primary keyword signals

Add columns: Clicks / Orders / ACOS / Spend (with period selector matching Campaigns page)

---

### S2-2 · AND/OR Logic in Rule Conditions
**Source:** Scale Insights, Pacvue — advanced rule logic

- Toggle `AND` / `OR` between condition rows
- Mixed mode: `(A AND B) OR C`

---

### S2-3 · Budget Utilization Bar in Campaigns
**Source:** Pacvue — visual budget health at a glance

Mini progress bar below budget value: `$289 / $300` → 96% bar (red when >90%)

---

### S2-4 · Drill-Down Panel for Campaigns
**Source:** Intentwise — top-tier UX, intuitive drill-down

Click campaign name → slide-in panel with:
- Keyword list for that campaign
- Last 7d spend trend sparkline
- Quick actions (pause, edit budget)

---

### S2-5 · Dayparting / Hourly Scheduling
**Source:** Scale Insights, Helium10 Ads, Adbrew — featured as a key differentiator

Heatmap-style schedule picker (24h × 7d) for rule execution windows.
Rules only fire during selected hours.

---

### S2-6 · Onboarding Checklist Widget
**Source:** NNg — *"progress bars and checklists increase completion rates (Zeigarnik Effect)"*

Getting Started widget on Overview for new users:
- [ ] Connect Amazon Ads account
- [ ] Run first sync
- [ ] Create your first rule
- [ ] Set up an alert
- [ ] Review AI recommendations

Auto-hides when all steps complete.

---

### S2-7 · Hide Raw JSON in AI Recommendations
**Source:** UX audit — raw JSON visible in recommendation card

Parse and display human-readable parameter card:
`Target ACOS: 12% · Daily budget: €266 · Categories: EVOCAMP, Björn&Schiller`

---

### S2-8 · Target ACOS on Dashboard
**Source:** Helium10 Ads, Intentwise — *"simply set target ACoS, AI handles the rest"*

On ACOS KPI card — add line:
`Target: 20%` — green if below, red if above
Set in Workspace Settings

---

## 🗓 Sprint 3 — Professional Features (1–2 weeks)

### S3-1 · Search Term Harvesting ⭐⭐ CRITICAL FOR COMPETITIVENESS
**Source:** Pacvue, Helium10, Adbrew, Intentwise — ALL call this a core feature

New tab `Search Terms` in Keywords section:
- Table: search term / impressions / clicks / orders / ACOS / spend
- Color-coded rows: green = harvest candidate, red = negate candidate
- Quick actions: `+ Add as keyword` / `✗ Add as negative`
- Bulk harvest workflow

---

### S3-2 · Rule Execution History Modal
**Source:** Scale Insights — full audit trail per rule

Click rule card → history tab showing:
- When the rule ran
- How many entities were affected
- What changed (diff)
- Dry-run vs live execution

---

### S3-3 · Suggested AI Prompts
**Source:** UX audit — blank AI textarea with no guidance

Suggested prompt chips below input:
- `[Which campaigns are overspending?]`
- `[Where is ACOS too high?]`
- `[Which keywords should be paused?]`
- `[Show top performers this week]`

---

### S3-4 · Negative Keywords Management
**Source:** Scale Insights Blacklist/Whitelist, Helium10 Auto Negation

`Negatives` tab in Keywords section
Quick add, filter by campaign

---

### S3-5 · TACoS Metric
**Source:** Scale Insights, Helium10 — *"correlations between organic sales, PPC and promotions"*

On ACOS KPI card — toggle `ACOS ↕ TACoS`
TACoS = Ad Spend / Total Sales (organic + paid)

---

### S3-6 · Keyboard Shortcuts
**Source:** Pacvue, Intentwise — power users work for hours

- `/` → focus search
- `R` → refresh data
- `N` → new rule/campaign
- `Esc` → close modal
- `Ctrl+Enter` → save form
- `?` → show shortcuts list

---

### S3-7 · User-Saved Filters
**Source:** Pacvue — enterprise PPC platform standard

`+ Save filter` button in filter panel → name it → appears in saved list
(Stored in localStorage / backend user settings)

---

### S3-8 · Column Resize & Visibility
**Source:** NNg Data Tables, enterprise UX standard

- Drag-to-resize columns
- `⚙ Columns` — show/hide, saved to user settings

---

## 🗓 Sprint 4 — Architecture (2–4 weeks)

### S4-1 · Write-Back to Amazon API ⭐⭐ CRITICAL
**Source:** Current README limitation — all changes apply to local DB only

Implement:
- `PUT /sp/keywords` — bid and status updates
- `PUT /sp/campaigns` — budget and status updates
- `POST /sp/negativeKeywords` — add negatives
- Retry logic, conflict resolution on next sync

---

### S4-2 · Algorithm Stacking / Rule Chains
**Source:** Scale Insights — *"like building LEGOs"* — their main USP

- "Strategy" = a named set of rules executed in sequence
- E.g. `Strategy "Product Launch"` = 3 chained rules

---

### S4-3 · Per-Row Change History on Hover
**Source:** Pacvue — full audit trail per entity

On row hover in Campaigns → `🕐` icon → mini-popup with last 3 changes for that campaign

---

### S4-4 · SB Keyword-Level Reports
**Source:** README Known Issues

After Reporting API v3 GA for SB — add keyword-level metrics for Sponsored Brands

---

### S4-5 · Negative Keywords Sync
**Source:** README TODO

Migrate to `POST /sp/negativeKeywords/list` for negative keyword sync

---

## 📊 Priority Matrix

| Feature | Sprint | Impact | Effort | Source |
|---------|--------|--------|--------|--------|
| Rule templates | S1 | 🔴 Critical | Medium | Pacvue, Scale Insights |
| Rule preview | S1 | 🔴 Critical | Low | Scale Insights |
| ACOS color coding | S1 | 🔴 Critical | Low | All competitors |
| Inline status toggle | S1 | 🔴 Critical | Low | Intentwise, NNg |
| Hover-row actions | S1 | 🟡 Important | Low | NNg |
| Tooltips | S1 | 🟡 Important | Low | NNg |
| Metrics in Keywords | S2 | 🟡 Important | Medium | All |
| AND/OR rule logic | S2 | 🟡 Important | Low | Scale Insights |
| Budget utilization bar | S2 | 🟡 Important | Low | Pacvue |
| Search Term Harvesting | S3 | 🔴 Critical | High | All competitors |
| Dayparting | S3 | 🟡 Important | Medium | Scale Insights |
| Onboarding checklist | S3 | 🟡 Important | Medium | NNg Research |
| Write-back to Amazon | S4 | 🔴 Critical | High | README TODO |
| Algorithm stacking | S4 | 🟢 Nice to have | High | Scale Insights |

---

## 🔗 Related Documents

- [UX_AUDIT.md](./UX_AUDIT.md) — Full audit of all sections + best practices
- [ARCHITECTURE.md](./ARCHITECTURE.md) — Technical architecture
- [API.md](./API.md) — API reference
- [CHANGELOG.md](../CHANGELOG.md) — Change history
