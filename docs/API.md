# API Reference

Base URL: `http://localhost:4000/api/v1`  
All endpoints (except `/auth/*`) require: `Authorization: Bearer <jwt_token>`

---

## Authentication

### POST /auth/register
Register a new organization and owner user.
```json
// Request
{ "email": "user@example.com", "password": "min8chars", "name": "Pavel", "orgName": "West&East" }

// Response 201
{ "token": "eyJ...", "user": { "id": 1, "email": "...", "role": "owner" } }
```

### POST /auth/login
```json
// Request
{ "email": "user@example.com", "password": "..." }

// Response 200
{ "token": "eyJ...", "user": { "id": 1, "role": "owner" } }
```

---

## Amazon Connections

### GET /connections/amazon/init
Returns the Amazon OAuth URL to redirect the user to.
```json
{ "url": "https://www.amazon.com/ap/oa?..." }
```

### POST /connections/amazon/callback
Exchange OAuth code for tokens and start initial sync.
```json
// Request
{ "code": "ANB...", "state": "csrf_token" }
// Response 200
{ "connection": { "id": 1, "status": "connected" } }
```

### POST /connections/:id/profiles/attach
Attach Amazon profiles to a workspace after OAuth.
```json
// Request
{ "profileIds": [12345, 67890], "workspaceId": 1 }
```

### DELETE /connections/:id
Disconnect Amazon account (destroys tokens, stops sync jobs).

---

## Campaigns

### GET /campaigns
List campaigns with current metrics.
```
Query: ?status=enabled&type=sponsoredProducts&search=brand&page=1&limit=50
```
```json
// Response
{ "campaigns": [...], "total": 42 }
```

### PATCH /campaigns/:id
Update campaign status or budget.
```json
{ "state": "paused" }
{ "dailyBudget": 50.00 }
```

---

## Keywords

### GET /keywords
```
Query: ?adGroupId=123&search=keyword&status=enabled
```

### PATCH /keywords/:id
Update bid or status.
```json
{ "bid": 1.25 }
{ "state": "paused" }
```

### PATCH /keywords/bulk
Bulk bid or status update.
```json
{ "ids": [1, 2, 3], "bid_change_pct": 10 }
{ "ids": [1, 2, 3], "state": "paused" }
```

---

## Bulk Operations

### POST /bulk/campaigns/status
```json
{ "ids": [1, 2, 3], "state": "paused" }
// state: "enabled" | "paused" | "archived"
```

### POST /bulk/campaigns/budget
```json
{ "ids": [1, 2], "change_pct": -10 }
// change_pct: -50 to +200, floor $1/day enforced
```

### POST /bulk/keywords/bid
```json
{ "ids": [10, 11], "change_pct": 15 }
{ "ids": [10, 11], "bid": 0.75 }
// Bid range: $0.02 – $1000 enforced
```

---

## Rules

### GET /rules
List all automation rules for the current workspace.

### POST /rules
Create a new rule.
```json
{
  "name": "Pause high ACoS campaigns",
  "conditions": [
    { "metric": "acos", "operator": "gt", "value": 40 }
  ],
  "actions": [
    { "type": "pause_campaign" }
  ],
  "schedule_type": "daily",
  "dry_run": false
}
```

### PUT /rules/:id
Update rule (same body as POST).

### DELETE /rules/:id

### PATCH /rules/:id/toggle
Toggle `is_active` on/off.
```json
{ "is_active": true }
```

---

## Alerts

### GET /alerts/configs
List alert configurations.

### POST /alerts/configs
```json
{
  "name": "High ACoS alert",
  "metric": "acos",
  "operator": "gt",
  "threshold": 35,
  "channels": ["inapp", "email"],
  "cooldown_hours": 24
}
```
Metrics: `acos`, `spend`, `ctr`, `roas`, `impressions`, `clicks`  
Operators: `gt`, `lt`, `gte`, `lte`

### PUT /alerts/configs/:id
### DELETE /alerts/configs/:id
### PATCH /alerts/configs/:id/toggle

### GET /alerts
List triggered alert instances.

### PATCH /alerts/:id/acknowledge
Mark a triggered alert as acknowledged.

---

## Metrics

### GET /metrics/summary
KPI aggregation for the workspace.
```
Query: ?period=7d   (7d | 14d | 30d)
```
```json
{
  "totalSpend": 1250.50,
  "totalSales": 5200.00,
  "acos": 24.05,
  "roas": 4.16,
  "clicks": 3420,
  "impressions": 185000
}
```

### GET /metrics/top-campaigns
```
Query: ?limit=10&orderBy=spend
```

---

## Reports

### POST /reports
Queue a report generation job.
```json
{
  "type": "campaigns",
  "dateFrom": "2026-03-01",
  "dateTo": "2026-03-06",
  "granularity": "daily"
}
```

### GET /reports
List generated reports.

### GET /reports/:id/download
Download report CSV/JSON.

---

## Audit Log

### GET /audit
```
Query: ?entityType=campaign&action=status_change&page=1&limit=50
```
```json
{
  "entries": [
    {
      "id": 1,
      "userId": 1,
      "userName": "Pavel",
      "entityType": "campaign",
      "entityId": "AMZ_123",
      "action": "status_change",
      "oldValue": "enabled",
      "newValue": "paused",
      "source": "rule_engine",
      "createdAt": "2026-03-06T14:00:00Z"
    }
  ],
  "total": 150
}
```

---

## Error Responses

All errors follow this format:
```json
{ "error": "Human-readable message" }
```

| Status | Meaning |
|--------|---------|
| 400 | Bad request / validation error |
| 401 | Missing or invalid JWT token |
| 403 | Insufficient role/permissions |
| 404 | Resource not found |
| 429 | Rate limit exceeded (300 req/min) |
| 500 | Internal server error |
