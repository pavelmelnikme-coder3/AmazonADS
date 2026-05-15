"use strict";
/**
 * Rules engine — comprehensive test suite
 *
 * Covers:
 *   evaluate()                 — all 6 operators, multi-condition AND, unknown op, missing metric
 *   GET  /rules                — pagination, limit cap
 *   POST /rules                — create, validation
 *   PATCH /rules/:id           — update, empty-array guard, not found
 *   DELETE /rules/:id
 *   GET  /rules/campaigns      — picker, ?q= search
 *   GET  /rules/ad-groups      — picker, campaignId filter
 *   GET  /rules/targets        — picker, campaignId filter
 *   POST /rules/preview        — dry-run of unsaved rule, validation, no last_run_at update
 *   POST /rules/:id/run        — rule not found, dry_run flag, entity type routing
 *   GET  /rules/:id/runs       — execution history
 *   Actions (dry-run)          — pause_keyword, enable_keyword, adjust_bid_pct (+ safety clamp),
 *                                set_bid (+ clamp), pause_target, enable_target,
 *                                adjust_target_bid_pct, add_negative_keyword (exact/phrase/both),
 *                                add_negative_target
 *   Skip reasons               — already_paused, already_enabled, not_enabled, wrong_entity_type,
 *                                already_negative
 *   ASIN auto-routing          — search_term ASIN → negative_target, dedup
 *   Non-dry-run write-backs    — DB UPDATE, writeAudit, pushKeywordUpdates, pushNegativeKeyword
 *   Scope filters              — campaign_name_contains (include/exclude), campaign_targeting_type,
 *                                match_types, period_days=1, campaign_ids, entity types
 *   Multiple conditions        — AND logic: all-pass / one-fail
 *   Entity types               — keyword, product_target, search_term routing
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID   = "ws---0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const RULE_ID = "rule-0001-0000-0000-000000000001";
const CAMP_ID = "camp-0001-0000-0000-000000000001";
const AG_ID   = "ag---0001-0000-0000-000000000001";

const SAMPLE_RULE = {
  id: RULE_ID,
  workspace_id: WS_ID,
  name: "Pause high-ACOS keywords",
  description: "",
  conditions: JSON.stringify([{ metric: "acos", op: "gt", value: 50 }]),
  actions: JSON.stringify([{ type: "set_state", state: "paused" }]),
  schedule: "0 8 * * *",
  scope: JSON.stringify({}),
  safety: JSON.stringify({ min_bid: 0.02, max_bid: 50 }),
  dry_run: false,
  is_active: true,
  created_by: USER_ID,
};

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/routes/audit", () => ({
  writeAudit: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/amazon/writeback", () => ({
  pushNegativeKeyword: jest.fn().mockResolvedValue({}),
  pushNegativeAsin:    jest.fn().mockResolvedValue({}),
  pushKeywordUpdates:  jest.fn().mockResolvedValue({}),
}));
jest.mock("../src/services/amazon/adsClient", () => ({
  put: jest.fn().mockResolvedValue({}),
}));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("../src/config/redis", () => ({
  getRedis: jest.fn().mockReturnValue({
    get: jest.fn().mockResolvedValue(null),   // no existing lock
    set: jest.fn().mockResolvedValue("OK"),   // lock acquired
    del: jest.fn().mockResolvedValue(1),
  }),
}));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user  = { id: USER_ID, name: "Test User", role: "owner", org_id: ORG_ID };
    req.orgId = ORG_ID;
    next();
  },
  requireWorkspace: (req, _res, next) => {
    req.workspaceId   = WS_ID;
    req.workspaceRole = "owner";
    next();
  },
}));

const { query: dbQuery } = require("../src/db/pool");
const { writeAudit }         = require("../src/routes/audit");
const { pushKeywordUpdates, pushNegativeKeyword, pushNegativeAsin } =
  require("../src/services/amazon/writeback");
const { put: apiPut } = require("../src/services/amazon/adsClient");

const rulesRouter = require("../src/routes/rules");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/rules", rulesRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

// ─── Entity builders ──────────────────────────────────────────────────────────
function makeKeyword(overrides = {}) {
  return {
    id: "kw-001", keyword_text: "running shoes", match_type: "exact",
    state: "enabled", bid: "1.00",
    campaign_id: CAMP_ID, ad_group_id: AG_ID,
    campaign_name: "Campaign A", campaign_type: "sponsoredProducts",
    amazon_campaign_id: "AZ_CAMP_001", amazon_keyword_id: "AZ_KW_001",
    ad_group_name: "Ad Group 1", amazon_ad_group_id: "AZ_AG_001",
    profile_db_id: "prof-001", amazon_profile_id: "123456789",
    connection_id: "conn-001", marketplace_id: "ATVPDKIKX0DER",
    clicks: 20, spend: "10.00", orders: 0, sales: "0", acos: "50",
    impressions: 500, entity_type: "keyword",
    ...overrides,
  };
}

function makeTarget(overrides = {}) {
  return {
    id: "tgt-001", amazon_target_id: "AZ_TGT_001",
    expression: [{ type: "asinSameAs", value: "B0TESTPRODUCT" }],
    expression_type: "asinSameAs",
    state: "enabled", bid: "0.80",
    campaign_id: CAMP_ID, ad_group_id: AG_ID,
    campaign_name: "Campaign A", campaign_type: "sponsoredProducts",
    amazon_campaign_id: "AZ_CAMP_001",
    ad_group_name: "Ad Group 1", amazon_ad_group_id: "AZ_AG_001",
    amazon_profile_id: "123456789", connection_id: "conn-001",
    marketplace_id: "ATVPDKIKX0DER", profile_id: "prof-001",
    clicks: 5, spend: "4.00", orders: 0, sales: "0", acos: "0",
    impressions: 100, entity_type: "target",
    ...overrides,
  };
}

function makeSearchTerm(overrides = {}) {
  return {
    id: "st-001",
    keyword_text: "red sneakers",
    state: "enabled",
    campaign_id: CAMP_ID, ad_group_id: AG_ID,
    campaign_name: "Campaign A", campaign_type: "sponsoredProducts",
    amazon_campaign_id: "AZ_CAMP_001",
    ad_group_name: "Ad Group 1", amazon_ad_group_id: "AZ_AG_001",
    profile_db_id: "prof-001", amazon_profile_id: "123456789",
    connection_id: "conn-001", marketplace_id: "ATVPDKIKX0DER",
    clicks: 15, spend: "8.00", orders: 0, sales: "0", acos: "50",
    impressions: 300, entity_type: "search_term",
    ...overrides,
  };
}

// Build a rule DB row with JSON-stringified fields
function makeRule(overrides = {}) {
  return {
    ...SAMPLE_RULE,
    conditions: JSON.stringify([{ metric: "acos", op: "gt", value: 30 }]),
    scope: JSON.stringify({ entity_type: "keyword", period_days: 14 }),
    safety: JSON.stringify({ min_bid: 0.02, max_bid: 50 }),
    ...overrides,
  };
}

// Mock the standard /run DB sequence for keyword entities
//   1. SELECT rule
//   2. SELECT org_id
//   3. SELECT campaign_exemptions → []
//   4. SELECT keywords → kwRows
//   [extraMocks] — action-specific queries
//   N-2. SELECT negative_keywords (reconciliation) → []
//   N-1. SELECT negative_targets  (reconciliation) → []
//   N.   UPDATE rules SET last_run_result
function mockKeywordRun(rule, kwRows, extraMocks = []) {
  dbQuery
    .mockResolvedValueOnce({ rows: [rule] })
    .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
    .mockResolvedValueOnce({ rows: [] })           // campaign_exemptions
    .mockResolvedValueOnce({ rows: kwRows });
  extraMocks.forEach(m => dbQuery.mockResolvedValueOnce(m));
  dbQuery
    .mockResolvedValueOnce({ rows: [] })           // reconcile: negative_keywords
    .mockResolvedValueOnce({ rows: [] })           // reconcile: negative_targets
    .mockResolvedValueOnce({ rows: [] });          // UPDATE rules SET last_run_result
}

// Mock the standard /run DB sequence for target entities
function mockTargetRun(rule, tgtRows, extraMocks = []) {
  dbQuery
    .mockResolvedValueOnce({ rows: [rule] })
    .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
    .mockResolvedValueOnce({ rows: [] })           // campaign_exemptions
    .mockResolvedValueOnce({ rows: tgtRows });
  extraMocks.forEach(m => dbQuery.mockResolvedValueOnce(m));
  dbQuery
    .mockResolvedValueOnce({ rows: [] })           // reconcile: negative_keywords
    .mockResolvedValueOnce({ rows: [] })           // reconcile: negative_targets
    .mockResolvedValueOnce({ rows: [] });          // UPDATE
}

// Mock the standard /run DB sequence for search_term entities
function mockSearchTermRun(rule, stRows, extraMocks = []) {
  dbQuery
    .mockResolvedValueOnce({ rows: [rule] })
    .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
    .mockResolvedValueOnce({ rows: [] })           // campaign_exemptions
    .mockResolvedValueOnce({ rows: stRows });
  extraMocks.forEach(m => dbQuery.mockResolvedValueOnce(m));
  dbQuery
    .mockResolvedValueOnce({ rows: [] })           // reconcile: negative_keywords
    .mockResolvedValueOnce({ rows: [] })           // reconcile: negative_targets
    .mockResolvedValueOnce({ rows: [] });          // UPDATE
}

// ─────────────────────────────────────────────────────────────────────────────
//  evaluate() — tested via dry-run rule execution
// ─────────────────────────────────────────────────────────────────────────────
describe("evaluate() operator semantics (via dry-run)", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  function makeOpRule(op, value) {
    return makeRule({
      conditions: JSON.stringify([{ metric: "acos", op, value }]),
      actions: JSON.stringify([{ type: "set_state", state: "paused" }]),
    });
  }

  it("gt: matches when metric > threshold", async () => {
    mockKeywordRun(makeOpRule("gt", 30), [makeKeyword({ acos: "55" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.matched_count).toBe(1);
  });

  it("gt: does NOT match when metric equals threshold", async () => {
    mockKeywordRun(makeOpRule("gt", 55), [makeKeyword({ acos: "55" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(0);
  });

  it("gte: matches when metric equals threshold", async () => {
    mockKeywordRun(makeOpRule("gte", 55), [makeKeyword({ acos: "55" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(1);
  });

  it("lt: matches when metric < threshold", async () => {
    mockKeywordRun(makeOpRule("lt", 10), [makeKeyword({ acos: "5" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(1);
  });

  it("lte: matches when metric equals threshold", async () => {
    mockKeywordRun(makeOpRule("lte", 5), [makeKeyword({ acos: "5" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(1);
  });

  it("eq: matches exact value", async () => {
    mockKeywordRun(makeOpRule("eq", 50), [makeKeyword({ acos: "50" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(1);
  });

  it("neq: matches when metric != threshold", async () => {
    mockKeywordRun(makeOpRule("neq", 50), [makeKeyword({ acos: "30" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(1);
  });

  it("neq: does NOT match when equal", async () => {
    mockKeywordRun(makeOpRule("neq", 50), [makeKeyword({ acos: "50" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(0);
  });

  it("unknown operator never matches", async () => {
    mockKeywordRun(makeOpRule("xyzzy", 10), [makeKeyword({ acos: "5" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(0);
  });

  it("missing metric treated as 0", async () => {
    const rule = makeRule({
      conditions: JSON.stringify([{ metric: "nonexistent_metric", op: "lt", value: 1 }]),
    });
    mockKeywordRun(rule, [makeKeyword()]);
    // nonexistent = 0 < 1 → matches
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Multiple conditions — AND logic
// ─────────────────────────────────────────────────────────────────────────────
describe("Multiple conditions — AND logic", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("matches only when ALL conditions pass", async () => {
    const rule = makeRule({
      conditions: JSON.stringify([
        { metric: "acos",   op: "gt",  value: 30 },
        { metric: "clicks", op: "gte", value: 10 },
      ]),
    });
    // acos=50>30 AND clicks=20>=10 → match
    mockKeywordRun(rule, [makeKeyword({ acos: "50", clicks: 20 })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(1);
  });

  it("does NOT match when one condition fails", async () => {
    const rule = makeRule({
      conditions: JSON.stringify([
        { metric: "acos",   op: "gt",  value: 30 },
        { metric: "clicks", op: "gte", value: 50 },
      ]),
    });
    // acos=50>30 BUT clicks=5<50 → no match
    mockKeywordRun(rule, [makeKeyword({ acos: "50", clicks: 5 })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /rules
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /rules", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns paginated rules", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_RULE] })
      .mockResolvedValueOnce({ rows: [{ count: 1 }] });

    const res = await request(app).get("/rules");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
  });

  it("respects page and limit params", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: 50 }] });

    const res = await request(app).get("/rules?page=3&limit=10");
    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(3);
    expect(res.body.pagination.limit).toBe(10);
  });

  it("caps limit at 100", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });

    const res = await request(app).get("/rules?limit=500");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(100);
  });

  it("returns empty data when no rules", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ count: 0 }] });

    const res = await request(app).get("/rules");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /rules
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /rules", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const VALID_PAYLOAD = {
    name: "New Rule",
    conditions: [{ metric: "acos", op: "gt", value: 50 }],
    actions: [{ type: "pause_keyword" }],
  };

  it("creates a rule and returns 201", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_RULE] });
    const res = await request(app).post("/rules").send(VALID_PAYLOAD);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(RULE_ID);
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app).post("/rules").send({ ...VALID_PAYLOAD, name: undefined });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it("returns 400 when conditions is empty", async () => {
    const res = await request(app).post("/rules").send({ ...VALID_PAYLOAD, conditions: [] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when actions is empty", async () => {
    const res = await request(app).post("/rules").send({ ...VALID_PAYLOAD, actions: [] });
    expect(res.status).toBe(400);
  });

  it("uses default schedule when not provided", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_RULE] });
    await request(app).post("/rules").send(VALID_PAYLOAD);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("0 8 * * *");
  });

  it("accepts custom schedule", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_RULE] });
    await request(app).post("/rules").send({ ...VALID_PAYLOAD, schedule: "0 12 * * *" });
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("0 12 * * *");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PATCH /rules/:id
// ─────────────────────────────────────────────────────────────────────────────
describe("PATCH /rules/:id", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("updates rule name and returns updated rule", async () => {
    const updated = { ...SAMPLE_RULE, name: "Updated Rule Name" };
    dbQuery.mockResolvedValueOnce({ rows: [updated] });

    const res = await request(app).patch(`/rules/${RULE_ID}`).send({ name: "Updated Rule Name" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated Rule Name");
  });

  it("toggles is_active to false", async () => {
    const updated = { ...SAMPLE_RULE, is_active: false };
    dbQuery.mockResolvedValueOnce({ rows: [updated] });

    const res = await request(app).patch(`/rules/${RULE_ID}`).send({ is_active: false });
    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(false);
  });

  it("returns 404 when rule not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).patch(`/rules/nonexistent-rule-id`).send({ name: "New Name" });
    expect(res.status).toBe(404);
  });

  it("returns 400 when conditions provided as empty array", async () => {
    const res = await request(app).patch(`/rules/${RULE_ID}`).send({ conditions: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/conditions/i);
  });

  it("returns 400 when actions provided as empty array", async () => {
    const res = await request(app).patch(`/rules/${RULE_ID}`).send({ actions: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/actions/i);
  });

  it("allows partial update with no conditions/actions keys", async () => {
    const updated = { ...SAMPLE_RULE, name: "Only name changed" };
    dbQuery.mockResolvedValueOnce({ rows: [updated] });
    const res = await request(app).patch(`/rules/${RULE_ID}`).send({ name: "Only name changed" });
    expect(res.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /rules/:id
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /rules/:id", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("deletes rule and returns ok:true", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete(`/rules/${RULE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /rules/campaigns
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /rules/campaigns", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns campaign list for picker", async () => {
    const campaigns = [
      { id: CAMP_ID, name: "Campaign A", campaign_type: "sponsoredProducts", state: "enabled" },
    ];
    dbQuery.mockResolvedValueOnce({ rows: campaigns });

    const res = await request(app).get("/rules/campaigns");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("Campaign A");
  });

  it("returns empty array when no campaigns", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/rules/campaigns");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("applies ?q= search filter — ILIKE param in SQL", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get("/rules/campaigns?q=TestCamp");
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("%TestCamp%");
  });

  it("returns all campaigns when ?q= is empty string", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get("/rules/campaigns?q=");
    // Empty q → no ILIKE param added, only workspaceId
    const params = dbQuery.mock.calls[0][1];
    expect(params).toHaveLength(1);
    expect(params[0]).toBe(WS_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /rules/ad-groups
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /rules/ad-groups", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const AG_SAMPLE = { id: AG_ID, name: "Ad Group 1", campaign_id: CAMP_ID, campaign_name: "Campaign A" };

  it("returns all ad-groups when no filter", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [AG_SAMPLE] });
    const res = await request(app).get("/rules/ad-groups");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("filters by campaignId", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [AG_SAMPLE] });
    const res = await request(app).get(`/rules/ad-groups?campaignId=${CAMP_ID}`);
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(CAMP_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /rules/targets
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /rules/targets", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns targets list", async () => {
    const target = { id: "t-001", expression: "asin=B000001", expression_type: "asinSameAs", state: "enabled" };
    dbQuery.mockResolvedValueOnce({ rows: [target] });
    const res = await request(app).get("/rules/targets");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("filters targets by campaignId", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/rules/targets?campaignId=${CAMP_ID}`);
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(CAMP_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /rules/preview
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /rules/preview", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const PREVIEW_BODY = {
    name: "Test Preview",
    conditions: [{ metric: "acos", op: "gt", value: 30 }],
    actions: [{ type: "pause_keyword" }],
    scope: { entity_type: "keyword", period_days: 14 },
    safety: { min_bid: 0.02, max_bid: 50 },
  };

  it("returns 400 when conditions missing", async () => {
    const res = await request(app).post("/rules/preview").send({
      actions: [{ type: "pause_keyword" }],
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when conditions is empty array", async () => {
    const res = await request(app).post("/rules/preview").send({
      ...PREVIEW_BODY, conditions: [],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/condition/i);
  });

  it("returns 400 when actions is empty array", async () => {
    const res = await request(app).post("/rules/preview").send({
      ...PREVIEW_BODY, actions: [],
    });
    expect(res.status).toBe(400);
  });

  it("returns dry-run result shape without updating last_run_at", async () => {
    // Preview calls executeRule directly — no rule SELECT, no UPDATE last_run_at
    dbQuery
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] }) // org_id
      .mockResolvedValueOnce({ rows: [] })                   // campaign_exemptions
      .mockResolvedValueOnce({ rows: [] })                   // keywords (empty)
      .mockResolvedValueOnce({ rows: [] })                   // reconcile: negative_keywords
      .mockResolvedValueOnce({ rows: [] });                  // reconcile: negative_targets

    const res = await request(app).post("/rules/preview").send(PREVIEW_BODY);
    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(true);
    expect(res.body.matched_count).toBe(0);
    expect(dbQuery).toHaveBeenCalledTimes(5); // org_id + exemptions + keywords + 2 reconcile
  });

  it("shows applied action for a matching keyword", async () => {
    const kw = makeKeyword({ acos: "80", state: "enabled" });
    dbQuery
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: [] })  // campaign_exemptions
      .mockResolvedValueOnce({ rows: [kw] })
      .mockResolvedValueOnce({ rows: [] })  // reconcile: negative_keywords
      .mockResolvedValueOnce({ rows: [] }); // reconcile: negative_targets

    const res = await request(app).post("/rules/preview").send(PREVIEW_BODY);
    expect(res.status).toBe(200);
    expect(res.body.matched_count).toBe(1);
    expect(res.body.applied_count).toBe(1);
    expect(res.body.applied[0].action).toBe("pause_keyword");
    expect(res.body.applied[0].keyword_text).toBe("running shoes");
  });

  it("shows period info in result", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: [] })  // campaign_exemptions
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })  // reconcile: negative_keywords
      .mockResolvedValueOnce({ rows: [] }); // reconcile: negative_targets

    const res = await request(app).post("/rules/preview").send(PREVIEW_BODY);
    expect(res.body.period).toHaveProperty("start");
    expect(res.body.period).toHaveProperty("end");
    expect(res.body.period.days).toBe(14);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /rules/:id/runs
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /rules/:id/runs", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns execution history list", async () => {
    const run = {
      id: "run-001", started_at: new Date().toISOString(), dry_run: true,
      status: "completed", entities_evaluated: 10, entities_matched: 2,
      actions_taken: 2, actions_failed: 0, summary: {}, error_message: null,
    };
    dbQuery.mockResolvedValueOnce({ rows: [run] });
    const res = await request(app).get(`/rules/${RULE_ID}/runs`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe("run-001");
  });

  it("returns empty data array when no runs", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/rules/${RULE_ID}/runs`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /rules/:id/run — basic
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /rules/:id/run", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns 404 when rule not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post(`/rules/nonexistent/run`).send({ dry_run: true });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns dry-run result with correct shape", async () => {
    mockKeywordRun(SAMPLE_RULE, []);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      matched_count:   0,
      total_evaluated: 0,
      applied_count:   0,
      dry_run:         true,
    });
    expect(res.body.period).toHaveProperty("start");
    expect(res.body.period).toHaveProperty("end");
    expect(res.body.period).toHaveProperty("days");
  });

  it("uses rule.dry_run when request body does not override", async () => {
    const dryRule = { ...SAMPLE_RULE, dry_run: true };
    mockKeywordRun(dryRule, []);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({});
    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Action: pause_keyword
// ─────────────────────────────────────────────────────────────────────────────
describe("Action: pause_keyword", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const pauseRule = () => makeRule({ actions: JSON.stringify([{ type: "pause_keyword" }]) });

  it("dry-run: enabled keyword matching conditions → applied, no DB write", async () => {
    mockKeywordRun(pauseRule(), [makeKeyword({ state: "enabled", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(1);
    expect(res.body.applied[0].action).toBe("pause_keyword");
    expect(res.body.applied[0].new_state).toBe("paused");
    expect(res.body.applied[0].previous_state).toBe("enabled");
    // No UPDATE keywords — dry_run
    const calls = dbQuery.mock.calls.map(c => c[0]);
    expect(calls.some(s => s.includes("UPDATE keywords"))).toBe(false);
  });

  it("dry-run: already-paused keyword → skipped with 'already_paused'", async () => {
    mockKeywordRun(pauseRule(), [makeKeyword({ state: "paused", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(0);
    expect(res.body.skipped_count).toBe(1);
    expect(res.body.skipped[0].reason).toBe("already_paused");
  });

  it("dry-run: target entity with pause_keyword action → wrong_entity_type skip", async () => {
    const rule = makeRule({
      actions: JSON.stringify([{ type: "pause_keyword" }]),
      scope: JSON.stringify({ entity_type: "product_target", period_days: 14 }),
    });
    mockTargetRun(rule, [makeTarget({ acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(0);
    expect(res.body.skipped_count).toBe(1);
    expect(res.body.skipped[0].reason).toBe("wrong_entity_type");
  });

  it("non-dry-run: DB UPDATE issued + writeAudit + pushKeywordUpdates called", async () => {
    const kw = makeKeyword({ state: "enabled", acos: "80" });
    mockKeywordRun(pauseRule(), [kw], [
      { rows: [] },  // UPDATE keywords SET state='paused'
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(res.status).toBe(200);
    expect(res.body.applied_count).toBe(1);

    const updateCall = dbQuery.mock.calls.find(c => c[0].includes("UPDATE keywords SET state"));
    expect(updateCall).toBeDefined();
    expect(updateCall[1]).toContain("kw-001");

    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(pushKeywordUpdates).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ state: "paused", amazonKeywordId: "AZ_KW_001" }),
    ]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Action: enable_keyword
// ─────────────────────────────────────────────────────────────────────────────
describe("Action: enable_keyword", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const enableRule = () => makeRule({ actions: JSON.stringify([{ type: "enable_keyword" }]) });

  it("dry-run: paused keyword → applied with new_state=enabled", async () => {
    mockKeywordRun(enableRule(), [makeKeyword({ state: "paused", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(1);
    expect(res.body.applied[0].action).toBe("enable_keyword");
    expect(res.body.applied[0].new_state).toBe("enabled");
  });

  it("dry-run: already-enabled keyword → already_enabled skip", async () => {
    mockKeywordRun(enableRule(), [makeKeyword({ state: "enabled", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(0);
    expect(res.body.skipped[0].reason).toBe("already_enabled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Action: adjust_bid_pct
// ─────────────────────────────────────────────────────────────────────────────
describe("Action: adjust_bid_pct", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const adjustRule = (pct, safety = {}) => makeRule({
    actions: JSON.stringify([{ type: "adjust_bid_pct", value: pct }]),
    safety: JSON.stringify({ min_bid: 0.02, max_bid: 50, ...safety }),
  });

  it("dry-run: increases bid by 50%", async () => {
    // bid=1.00 * 1.5 = 1.50
    mockKeywordRun(adjustRule(50), [makeKeyword({ bid: "1.00", state: "enabled", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(1);
    expect(res.body.applied[0].previous_bid).toBe(1.00);
    expect(res.body.applied[0].new_bid).toBe(1.50);
    expect(res.body.applied[0].change_pct).toBe("50.0%");
  });

  it("dry-run: clamps to max_bid", async () => {
    // bid=1.00 * 51 = 51 → clamped to max_bid=10
    mockKeywordRun(adjustRule(5000, { max_bid: 10 }), [makeKeyword({ bid: "1.00", state: "enabled", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied[0].new_bid).toBe(10.00);
  });

  it("dry-run: clamps to min_bid when bid decreases too much", async () => {
    // bid=1.00 * (1-0.99) = 0.01 → clamped to min_bid=0.10
    mockKeywordRun(adjustRule(-99, { min_bid: 0.10 }), [makeKeyword({ bid: "1.00", state: "enabled", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied[0].new_bid).toBe(0.10);
  });

  it("dry-run: paused keyword → not_enabled skip", async () => {
    mockKeywordRun(adjustRule(20), [makeKeyword({ state: "paused", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(0);
    expect(res.body.skipped[0].reason).toBe("not_enabled");
  });

  it("non-dry-run: DB UPDATE bid + pushKeywordUpdates called with new bid", async () => {
    const kw = makeKeyword({ bid: "1.00", state: "enabled", acos: "80" });
    mockKeywordRun(adjustRule(20), [kw], [
      { rows: [] }, // UPDATE keywords SET bid
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(res.status).toBe(200);

    const updateCall = dbQuery.mock.calls.find(c => c[0].includes("UPDATE keywords SET bid"));
    expect(updateCall).toBeDefined();
    expect(updateCall[1][0]).toBeCloseTo(1.20, 2); // new bid

    expect(pushKeywordUpdates).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ bid: 1.20 }),
    ]));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Action: set_bid
// ─────────────────────────────────────────────────────────────────────────────
describe("Action: set_bid", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const setRule = (val, safety = {}) => makeRule({
    actions: JSON.stringify([{ type: "set_bid", value: val }]),
    safety: JSON.stringify({ min_bid: 0.02, max_bid: 50, ...safety }),
  });

  it("dry-run: sets bid to exact value", async () => {
    mockKeywordRun(setRule(2.50), [makeKeyword({ bid: "1.00", state: "enabled", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied[0].new_bid).toBe(2.50);
  });

  it("dry-run: clamps below min_bid", async () => {
    // Requested 0.001, min=0.05 → clamped to 0.05
    mockKeywordRun(setRule(0.001, { min_bid: 0.05 }), [makeKeyword({ bid: "1.00", state: "enabled", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied[0].new_bid).toBe(0.05);
  });

  it("dry-run: clamps above max_bid", async () => {
    // Requested 100, max=10 → clamped to 10
    mockKeywordRun(setRule(100, { max_bid: 10 }), [makeKeyword({ bid: "1.00", state: "enabled", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied[0].new_bid).toBe(10.00);
  });

  it("dry-run: paused keyword → not_enabled skip", async () => {
    mockKeywordRun(setRule(1.50), [makeKeyword({ state: "paused", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.skipped[0].reason).toBe("not_enabled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Action: pause_target / enable_target
// ─────────────────────────────────────────────────────────────────────────────
describe("Action: pause_target / enable_target", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const targetRule = (actionType) => makeRule({
    actions: JSON.stringify([{ type: actionType }]),
    scope: JSON.stringify({ entity_type: "product_target", period_days: 14 }),
  });

  it("pause_target: enabled target → applied with new_state=paused", async () => {
    mockTargetRun(targetRule("pause_target"), [makeTarget({ state: "enabled", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(1);
    expect(res.body.applied[0].action).toBe("pause_target");
    expect(res.body.applied[0].new_state).toBe("paused");
  });

  it("pause_target: already-paused target → already_paused skip", async () => {
    mockTargetRun(targetRule("pause_target"), [makeTarget({ state: "paused", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.skipped[0].reason).toBe("already_paused");
  });

  it("pause_target: keyword entity → wrong_entity_type skip", async () => {
    // Using keyword entity but pause_target action — scope overrides entity type check
    const rule = makeRule({
      actions: JSON.stringify([{ type: "pause_target" }]),
      scope: JSON.stringify({ entity_type: "keyword", period_days: 14 }),
    });
    mockKeywordRun(rule, [makeKeyword({ state: "enabled", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.skipped[0].reason).toBe("wrong_entity_type");
  });

  it("enable_target: paused target → applied with new_state=enabled", async () => {
    mockTargetRun(targetRule("enable_target"), [makeTarget({ state: "paused", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(1);
    expect(res.body.applied[0].new_state).toBe("enabled");
  });

  it("enable_target: enabled target → already_enabled skip", async () => {
    mockTargetRun(targetRule("enable_target"), [makeTarget({ state: "enabled", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.skipped[0].reason).toBe("already_enabled");
  });

  it("non-dry-run pause_target: apiPut called with PAUSED state", async () => {
    const tgt = makeTarget({ state: "enabled", acos: "80" });
    mockTargetRun(targetRule("pause_target"), [tgt], [
      { rows: [] }, // UPDATE targets SET state='paused'
    ]);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(apiPut).toHaveBeenCalledWith(expect.objectContaining({
      path: "/sp/targets",
      data: expect.objectContaining({
        targets: expect.arrayContaining([
          expect.objectContaining({ state: "PAUSED" }),
        ]),
      }),
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Action: adjust_target_bid_pct
// ─────────────────────────────────────────────────────────────────────────────
describe("Action: adjust_target_bid_pct", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("dry-run: adjusts target bid by 25%", async () => {
    const rule = makeRule({
      actions: JSON.stringify([{ type: "adjust_target_bid_pct", value: 25 }]),
      scope: JSON.stringify({ entity_type: "product_target", period_days: 14 }),
      safety: JSON.stringify({ min_bid: 0.02, max_bid: 50 }),
    });
    // bid=0.80 * 1.25 = 1.00
    mockTargetRun(rule, [makeTarget({ bid: "0.80", state: "enabled", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(1);
    expect(res.body.applied[0].previous_bid).toBe(0.80);
    expect(res.body.applied[0].new_bid).toBe(1.00);
  });

  it("dry-run: paused target → not_enabled skip", async () => {
    const rule = makeRule({
      actions: JSON.stringify([{ type: "adjust_target_bid_pct", value: 10 }]),
      scope: JSON.stringify({ entity_type: "product_target", period_days: 14 }),
    });
    mockTargetRun(rule, [makeTarget({ state: "paused", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.skipped[0].reason).toBe("not_enabled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Action: add_negative_keyword
// ─────────────────────────────────────────────────────────────────────────────
describe("Action: add_negative_keyword", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const negRule = (val = "exact") => makeRule({
    actions: JSON.stringify([{ type: "add_negative_keyword", value: val }]),
  });

  it("dry-run exact: not a dup → applied (dedup SELECT still runs)", async () => {
    const kw = makeKeyword({ state: "enabled", acos: "80" });
    mockKeywordRun(negRule("exact"), [kw], [
      { rows: [] }, // dedup SELECT from negative_keywords → not found
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(1);
    expect(res.body.applied[0].action).toBe("add_negative_keyword");
    expect(res.body.applied[0].match_type).toBe("negativeExact");
    expect(res.body.applied[0].level).toBe("ad_group");
  });

  it("dry-run phrase: applied with negativePhrase match type", async () => {
    const kw = makeKeyword({ state: "enabled", acos: "80" });
    mockKeywordRun(negRule("phrase"), [kw], [
      { rows: [] }, // dedup
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied[0].match_type).toBe("negativePhrase");
  });

  it("dry-run both: creates two negatives (exact + phrase)", async () => {
    const kw = makeKeyword({ state: "enabled", acos: "80" });
    mockKeywordRun(negRule("both"), [kw], [
      { rows: [] }, // dedup negativeExact
      { rows: [] }, // dedup negativePhrase
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(2);
    const matchTypes = res.body.applied.map(a => a.match_type);
    expect(matchTypes).toContain("negativeExact");
    expect(matchTypes).toContain("negativePhrase");
  });

  it("dry-run: already exists in negative_keywords → already_negative skip", async () => {
    const kw = makeKeyword({ state: "enabled", acos: "80" });
    mockKeywordRun(negRule("exact"), [kw], [
      { rows: [{ id: "neg-001" }] }, // dedup → found → skip
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(0);
    expect(res.body.skipped[0].reason).toBe("already_negative");
  });

  it("dry-run: paused keyword → not_enabled skip", async () => {
    mockKeywordRun(negRule("exact"), [makeKeyword({ state: "paused", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.skipped[0].reason).toBe("not_enabled");
  });

  it("non-dry-run: INSERT into negative_keywords + pushNegativeKeyword called", async () => {
    const kw = makeKeyword({ state: "enabled", acos: "80" });
    mockKeywordRun(negRule("exact"), [kw], [
      { rows: [] },                    // dedup SELECT → not found
      { rows: [{ id: "neg-ins-001" }] }, // INSERT RETURNING id
    ]);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    const insertCall = dbQuery.mock.calls.find(c => c[0].includes("INSERT INTO negative_keywords"));
    expect(insertCall).toBeDefined();
    expect(insertCall[1]).toContain("running shoes"); // keyword_text

    expect(pushNegativeKeyword).toHaveBeenCalledWith(expect.objectContaining({
      keywordText: "running shoes",
      matchType: "negativeExact",
      level: "ad_group",
    }));
    expect(writeAudit).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Action: add_negative_keyword — ASIN auto-routing
// ─────────────────────────────────────────────────────────────────────────────
describe("Action: add_negative_keyword — ASIN auto-routing", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const asinRule = () => makeRule({
    actions: JSON.stringify([{ type: "add_negative_keyword", value: "exact" }]),
    scope: JSON.stringify({ entity_type: "search_term", period_days: 14 }),
  });

  const asinSearchTerm = (overrides = {}) =>
    makeSearchTerm({ keyword_text: "b076j8j3w5", acos: "80", ...overrides });

  it("ASIN-shaped search term → routes to add_negative_target (auto_routed=true)", async () => {
    mockSearchTermRun(asinRule(), [asinSearchTerm()], [
      { rows: [] }, // activeTgt check → not an active positive target
      { rows: [] }, // dedup SELECT from negative_targets → not found
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(1);
    expect(res.body.applied[0].action).toBe("add_negative_target");
    expect(res.body.applied[0].auto_routed).toBe(true);
    expect(res.body.applied[0].expression[0].type).toBe("ASIN_SAME_AS");
    expect(res.body.applied[0].expression[0].value).toBe("B076J8J3W5"); // uppercased
  });

  it("ASIN already in negative_targets → already_negative skip", async () => {
    mockSearchTermRun(asinRule(), [asinSearchTerm()], [
      { rows: [] },                      // activeTgt check → not an active target
      { rows: [{ id: "nt-existing" }] }, // dedup → found
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(0);
    expect(res.body.skipped[0].reason).toBe("already_negative");
  });

  it("non-ASIN search term is not auto-routed", async () => {
    const regularST = makeSearchTerm({ keyword_text: "blue running shoes", acos: "80" });
    mockSearchTermRun(asinRule(), [regularST], [
      { rows: [] }, // dedup for negativeExact (regular path)
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied[0].action).toBe("add_negative_keyword");
    expect(res.body.applied[0].auto_routed).toBeUndefined();
  });

  it("non-dry-run ASIN auto-route: INSERT into negative_targets + pushNegativeAsin called", async () => {
    mockSearchTermRun(asinRule(), [asinSearchTerm()], [
      { rows: [] },                       // activeTgt check → not an active target
      { rows: [] },                       // dedup → not found
      { rows: [{ id: "nt-ins-001" }] },   // INSERT into negative_targets RETURNING id
    ]);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    const insertCall = dbQuery.mock.calls.find(c => c[0].includes("INSERT INTO negative_targets"));
    expect(insertCall).toBeDefined();
    expect(pushNegativeAsin).toHaveBeenCalledWith(expect.objectContaining({
      asinValue: "B076J8J3W5",
      level: "ad_group",
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Action: add_negative_target
// ─────────────────────────────────────────────────────────────────────────────
describe("Action: add_negative_target", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const negTargetRule = () => makeRule({
    actions: JSON.stringify([{ type: "add_negative_target" }]),
    scope: JSON.stringify({ entity_type: "product_target", period_days: 14 }),
  });

  it("dry-run: enabled target not in negatives → applied", async () => {
    mockTargetRun(negTargetRule(), [makeTarget({ state: "enabled", acos: "80" })], [
      { rows: [] }, // dedup SELECT from negative_targets
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(1);
    expect(res.body.applied[0].action).toBe("add_negative_target");
  });

  it("dry-run: already in negative_targets → already_negative skip", async () => {
    mockTargetRun(negTargetRule(), [makeTarget({ state: "enabled", acos: "80" })], [
      { rows: [{ id: "nt-001" }] }, // dedup → found
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(0);
    expect(res.body.skipped[0].reason).toBe("already_negative");
  });

  it("dry-run: paused target → not_enabled skip", async () => {
    mockTargetRun(negTargetRule(), [makeTarget({ state: "paused", acos: "80" })]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.skipped[0].reason).toBe("not_enabled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Scope filters
// ─────────────────────────────────────────────────────────────────────────────
describe("Scope filters", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("campaign_name_contains include mode → ILIKE param in SQL", async () => {
    const rule = makeRule({
      scope: JSON.stringify({
        entity_type: "keyword", period_days: 14,
        campaign_name_contains: "TestCamp",
        campaign_name_mode: "include",
      }),
    });
    mockKeywordRun(rule, []);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    // keywords query is the 4th call (index 3) — after rule, org_id, exemptions
    const kwParams = dbQuery.mock.calls[3][1];
    expect(kwParams).toContain("%TestCamp%");
    expect(dbQuery.mock.calls[3][0]).not.toMatch(/NOT ILIKE/i);
  });

  it("campaign_name_contains exclude mode → NOT ILIKE in SQL", async () => {
    const rule = makeRule({
      scope: JSON.stringify({
        entity_type: "keyword", period_days: 14,
        campaign_name_contains: "BadCamp",
        campaign_name_mode: "exclude",
      }),
    });
    mockKeywordRun(rule, []);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    const kwSql = dbQuery.mock.calls[3][0];
    const kwParams = dbQuery.mock.calls[3][1];
    expect(kwParams).toContain("%BadCamp%");
    expect(kwSql).toMatch(/NOT ILIKE/i);
  });

  it("campaign_targeting_type → LOWER(c.targeting_type) = $N in SQL", async () => {
    const rule = makeRule({
      scope: JSON.stringify({
        entity_type: "keyword", period_days: 14,
        campaign_targeting_type: "manual",
      }),
    });
    mockKeywordRun(rule, []);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    const kwParams = dbQuery.mock.calls[3][1];
    expect(kwParams).toContain("manual");
    expect(dbQuery.mock.calls[3][0]).toMatch(/LOWER\(c\.targeting_type\)/i);
  });

  it("match_types filter → ANY array param in SQL", async () => {
    const rule = makeRule({
      scope: JSON.stringify({
        entity_type: "keyword", period_days: 14,
        match_types: ["exact", "phrase"],
      }),
    });
    mockKeywordRun(rule, []);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    const kwParams = dbQuery.mock.calls[3][1];
    expect(kwParams).toContainEqual(["exact", "phrase"]);
  });

  it("campaign_ids filter → campaign_id = ANY in SQL params", async () => {
    const rule = makeRule({
      scope: JSON.stringify({
        entity_type: "keyword", period_days: 14,
        campaign_ids: [CAMP_ID],
      }),
    });
    mockKeywordRun(rule, []);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    const kwParams = dbQuery.mock.calls[3][1];
    expect(kwParams).toContainEqual([CAMP_ID]);
  });

  it("period_days=1 → startDate equals endDate (yesterday window)", async () => {
    const rule = makeRule({
      scope: JSON.stringify({ entity_type: "keyword", period_days: 1 }),
    });
    mockKeywordRun(rule, []);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    const kwParams = dbQuery.mock.calls[3][1];
    // Last two params are [startDate, endDate]
    const startDate = kwParams[kwParams.length - 2];
    const endDate   = kwParams[kwParams.length - 1];
    expect(startDate).toBe(endDate);
    // Both should be yesterday's date
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    expect(startDate).toBe(yesterday);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Entity type routing
// ─────────────────────────────────────────────────────────────────────────────
describe("Entity type routing", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("entity_type=product_target → queries targets table, not keywords", async () => {
    const rule = makeRule({
      scope: JSON.stringify({ entity_type: "product_target", period_days: 14 }),
    });
    mockTargetRun(rule, []);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.status).toBe(200);
    // The 4th query (index 3) should be the targets SELECT
    expect(dbQuery.mock.calls[3][0]).toMatch(/FROM targets/i);
  });

  it("entity_type=search_term → queries search_term_metrics table", async () => {
    const rule = makeRule({
      scope: JSON.stringify({ entity_type: "search_term", period_days: 14 }),
    });
    mockSearchTermRun(rule, []);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(dbQuery.mock.calls[3][0]).toMatch(/FROM search_term_metrics/i);
  });

  it("default entity_type (keyword) → queries keywords table", async () => {
    // SAMPLE_RULE scope = {} → entity_type defaults to "keyword"
    mockKeywordRun(SAMPLE_RULE, []);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(dbQuery.mock.calls[3][0]).toMatch(/FROM keywords/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Result shape — totals, period, counts
// ─────────────────────────────────────────────────────────────────────────────
describe("Result shape — totals and metadata", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("total_evaluated counts all entities fetched, matched_count counts only those passing conditions", async () => {
    const rule = makeRule({
      conditions: JSON.stringify([{ metric: "acos", op: "gt", value: 50 }]),
      actions: JSON.stringify([{ type: "pause_keyword" }]),
    });
    // 3 keywords, only 2 have acos > 50
    const kws = [
      makeKeyword({ id: "kw-1", acos: "80", state: "enabled" }),
      makeKeyword({ id: "kw-2", acos: "60", state: "enabled" }),
      makeKeyword({ id: "kw-3", acos: "20", state: "enabled" }),
    ];
    mockKeywordRun(rule, kws);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.total_evaluated).toBe(3);
    expect(res.body.matched_count).toBe(2);
    expect(res.body.applied_count).toBe(2);
  });

  it("skipped + applied counts are both returned", async () => {
    const rule = makeRule({ actions: JSON.stringify([{ type: "pause_keyword" }]) });
    const kws = [
      makeKeyword({ id: "kw-1", acos: "80", state: "enabled" }),  // → applied
      makeKeyword({ id: "kw-2", acos: "80", state: "paused" }),   // → skipped already_paused
    ];
    mockKeywordRun(rule, kws);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(1);
    expect(res.body.skipped_count).toBe(1);
    expect(res.body.skipped[0].reason).toBe("already_paused");
  });

  it("empty rule conditions → 400 from executeRule safety guard", async () => {
    // Engine refuses empty conditions even if they somehow arrive via /run
    const badRule = makeRule({ conditions: JSON.stringify([]) });
    dbQuery.mockResolvedValueOnce({ rows: [badRule] });
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.status).toBe(500); // executeRule throws, caught by error middleware
    expect(res.body.error).toMatch(/condition/i);
  });
});
