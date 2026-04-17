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
```

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
