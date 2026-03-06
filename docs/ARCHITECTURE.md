# Architecture

## System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser (React SPA)                                            │
│  Login → Connect → Overview → Campaigns → Keywords →           │
│  Reports → Rules → Alerts → AI → Audit → Connections           │
│                    i18n: RU / EN                                │
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
| Brute force | Rate limiting 300 req/min per IP |
| Privilege escalation | RBAC checked on every protected route |
| Audit tampering | PostgreSQL trigger blocks UPDATE/DELETE on audit_logs |
| Secret leakage | `.env` in `.gitignore`, secrets never logged |
