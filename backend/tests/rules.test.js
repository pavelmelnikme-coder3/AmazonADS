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
  updateAuditStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/amazon/writeback", () => ({
  pushNegativeKeyword:    jest.fn().mockResolvedValue({}),
  pushNegativeAsin:       jest.fn().mockResolvedValue({}),
  pushKeywordUpdates:     jest.fn().mockResolvedValue({}),
  archiveNegativeKeyword: jest.fn().mockResolvedValue({ ok: true }),
  archiveNegativeTarget:  jest.fn().mockResolvedValue({ ok: true }),
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
const { pushKeywordUpdates, pushNegativeKeyword, pushNegativeAsin,
        archiveNegativeKeyword } = require("../src/services/amazon/writeback");
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
    // Amazon Ads v3 uses SCREAMING_SNAKE expression types (ASIN_SAME_AS); only these
    // are negatable. (The old v2 camelCase asinSameAs is no longer what sync stores.)
    expression: [{ type: "ASIN_SAME_AS", value: "B0TESTPRODUCT" }],
    expression_type: "ASIN_SAME_AS",
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

// Drain the dbQuery mockResolvedValueOnce queue after every test. jest.clearAllMocks()
// (used in each describe's beforeEach) clears call history but NOT queued once-values,
// so a test that queues more responses than the route consumes would leak leftovers
// into the next test — shifting query indices and the rule read at call 0. Resetting
// here keeps each test's fixed-index assertions (e.g. calls[3]) reliable.
afterEach(() => { dbQuery.mockReset(); });

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

  it("soft-deletes rule to trash and returns ok:true", async () => {
    // Route: SELECT rule → INSERT trash snapshot → DELETE FROM rules
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: RULE_ID, name: "Rule", workspace_id: WS_ID }] }) // SELECT
      .mockResolvedValueOnce({ rows: [] })            // INSERT trash
      .mockResolvedValueOnce({ rows: [], rowCount: 1 }); // DELETE

    const res = await request(app).delete(`/rules/${RULE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const sqls = dbQuery.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => /INSERT INTO trash/.test(s))).toBe(true);
    expect(sqls.some((s) => /DELETE FROM rules/.test(s))).toBe(true);
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
      { rows: [{ id: "neg-001", state: "enabled" }] }, // dedup → found ENABLED → skip
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(0);
    expect(res.body.skipped[0].reason).toBe("already_negative");
  });

  it("dry-run: an ARCHIVED row for the same negative does not count as already_negative", async () => {
    // An archived row means the negative is inactive on Amazon — the rule must be free to
    // re-apply it (by re-owning that row), not skip as though it were still in place.
    const kw = makeKeyword({ state: "enabled", acos: "80" });
    mockKeywordRun(negRule("exact"), [kw], [
      { rows: [{ id: "neg-001", state: "archived" }] },
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(1);
    expect(res.body.skipped).toHaveLength(0);
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
      { rows: [{ id: "nt-existing", state: "enabled" }] }, // dedup → found ENABLED
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
      { rows: [{ id: "nt-001", state: "enabled" }] }, // dedup → found ENABLED
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

// ─── Reconciliation: un-negating previously negated search terms ──────────────
//
// Regression cover for a live oscillation: the add path grouped search terms by
// (query, campaign, ad_group, match_type) while reconciliation re-aggregated the whole
// campaign, so the two paths judged the same term differently and the rule removed on one
// run exactly what it re-added on the next — every day, indefinitely. Observed on prod:
// "outdoor fussmatte wetterfest" was added and removed 30 times in 30 days.
describe("Reconciliation — negative keywords", () => {
  let app;
  beforeEach(() => { jest.clearAllMocks(); app = buildApp(); });
  afterEach(() => { dbQuery.mockReset(); });

  // Conditions taken from the live rule that oscillated: [ST]-12cl-1or-60d (neg key)
  const stRule = makeRule({
    actions: JSON.stringify([{ type: "add_negative_keyword", value: "exact" }]),
    scope: JSON.stringify({ entity_type: "search_term", period_days: 60 }),
    conditions: JSON.stringify([
      { metric: "clicks", op: "gte", value: "12" },
      { metric: "orders", op: "eq",  value: "1"  },
      { metric: "acos",   op: "gte", value: "25" },
    ]),
  });

  const negKwRow = (overrides = {}) => ({
    id: "negkw-001",
    keyword_text: "campingstuhl 150 kg",
    campaign_id: CAMP_ID,
    ad_group_id: AG_ID,
    amazon_neg_keyword_id: "AZ_NEG_001",
    match_type: "negative_exact",
    level: "ad_group",
    source_entity_type: "search_term",
    amazon_profile_id: "123456789",
    connection_id: "conn-001",
    marketplace_id: "ATVPDKIKX0DER",
    campaign_type: "sponsoredProducts",
    campaign_name: "Campaign A",
    ...overrides,
  });

  // Rule run that fetches no entities but has one existing negative to reconcile.
  function mockReconcileRun(rule, negKws, sliceRows) {
    dbQuery
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: [] })          // campaign_exemptions
      .mockResolvedValueOnce({ rows: [] });         // search_term entities → none matched
    dbQuery.mockResolvedValueOnce({ rows: negKws }); // reconcile: negative_keywords
    negKws.forEach(() => dbQuery.mockResolvedValueOnce({ rows: sliceRows }));
    dbQuery
      .mockResolvedValueOnce({ rows: [] })          // reconcile: negative_targets
      .mockResolvedValueOnce({ rows: [] });         // UPDATE rules
  }

  it("keeps the negative when one ad-group/match-type slice still qualifies", async () => {
    // Live numbers for "campingstuhl 150 kg": the BROAD slice the add path saw still
    // matches (25 clicks / 1 order / ACOS 88.5), while the campaign-wide aggregate the old
    // code used — 29 clicks / 2 orders — fails `orders = 1` and would have removed it.
    mockReconcileRun(stRule, [negKwRow()], [
      { clicks: "25", spend: "88.50", orders: "1", sales: "100.00", impressions: "900" },
      { clicks: "4",  spend: "3.10",  orders: "1", sales: "17.60",  impressions: "120" },
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.removed_count).toBe(0);
  });

  it("removes the negative only when no slice qualifies any more", async () => {
    // Both slices now convert well below the ACOS threshold → nothing justifies the negative.
    mockReconcileRun(stRule, [negKwRow()], [
      { clicks: "25", spend: "10.00", orders: "1", sales: "500.00", impressions: "900" },
      { clicks: "4",  spend: "1.00",  orders: "1", sales: "80.00",  impressions: "120" },
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.removed_count).toBe(1);
    expect(res.body.removed[0].action).toBe("remove_negative_reconcile");
  });

  it("KEEPS the negative when the term has no metrics left at all", async () => {
    // No rows means the term stopped receiving traffic — which is what the negative is for.
    // Releasing on absent data is circular: the negative suppresses the very data being read.
    mockReconcileRun(stRule, [negKwRow()], []);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.removed_count).toBe(0);
  });

  it("re-evaluates at the add path's granularity, scoped to the negative's ad group", async () => {
    mockReconcileRun(stRule, [negKwRow()], [
      { clicks: "25", spend: "88.50", orders: "1", sales: "100.00", impressions: "900" },
    ]);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    const sliceCall = dbQuery.mock.calls.find(c =>
      /FROM search_term_metrics/.test(c[0]) && /GROUP BY ad_group_id, match_type/.test(c[0]));
    expect(sliceCall).toBeDefined();
    expect(sliceCall[0]).toMatch(/ad_group_id = \$6/);
    expect(sliceCall[1]).toContain(AG_ID);
  });

  it("matches the stored (normalized) negative against Amazon's raw report text", async () => {
    // negative_keywords holds normalized text; search_term_metrics.query keeps Amazon's
    // original U+00A0. Without normalizing both sides the lookup finds nothing and the
    // negative is dropped as though the term had stopped receiving traffic.
    mockReconcileRun(stRule, [negKwRow()], [
      { clicks: "25", spend: "88.50", orders: "1", sales: "100.00", impressions: "900" },
    ]);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    const sliceCall = dbQuery.mock.calls.find(c =>
      /FROM search_term_metrics/.test(c[0]) && /GROUP BY ad_group_id, match_type/.test(c[0]));
    expect(sliceCall[0]).toMatch(/regexp_replace/);
    expect(sliceCall[0]).toContain("\\u00A0");
  });

  it("does not remove a negative whose ad group is unknown but whose metrics still qualify", async () => {
    mockReconcileRun(stRule, [negKwRow({ ad_group_id: null })], [
      { clicks: "25", spend: "88.50", orders: "1", sales: "100.00", impressions: "900" },
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.removed_count).toBe(0);
    const sliceCall = dbQuery.mock.calls.find(c =>
      /FROM search_term_metrics/.test(c[0]) && /GROUP BY ad_group_id, match_type/.test(c[0]));
    expect(sliceCall[0]).not.toMatch(/ad_group_id = \$6/);
  });
});

// ─── Amazon write-back failures must surface in the run result ────────────────
//
// Write-backs are deliberately non-fatal: the local DB is updated regardless, so a
// rejection never reaches `errors` and the run used to report "completed / 0 failures".
// On prod that hid a keyword Amazon rejected on every single run for 10 days straight.
describe("Write-back failures in the run result", () => {
  let app;
  beforeEach(() => { jest.clearAllMocks(); app = buildApp(); });
  afterEach(() => { dbQuery.mockReset(); });

  const pauseRule = makeRule({ actions: JSON.stringify([{ type: "pause_keyword" }]) });

  it("counts an Amazon rejection and names the entity that failed", async () => {
    pushKeywordUpdates.mockResolvedValueOnce({ ok: false, error: "PATTERN_NOT_MATCHED" });
    mockKeywordRun(pauseRule, [makeKeyword({ acos: "80", state: "enabled" })], [
      { rows: [] },  // UPDATE keywords
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(res.body.writeback_error_count).toBe(1);
    expect(res.body.writeback_errors[0]).toMatchObject({
      action: "pause_keyword",
      entity_id: "kw-001",
      stage: "amazon_writeback",
    });
    expect(res.body.writeback_errors[0].error).toMatch(/PATTERN_NOT_MATCHED/);
  });

  it("counts a write-back that rejects outright", async () => {
    pushKeywordUpdates.mockRejectedValueOnce(new Error("connection reset"));
    mockKeywordRun(pauseRule, [makeKeyword({ acos: "80", state: "enabled" })], [
      { rows: [] },
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(res.body.writeback_error_count).toBe(1);
    expect(res.body.writeback_errors[0].error).toMatch(/connection reset/);
  });

  it("reports no write-back errors when Amazon accepts the change", async () => {
    pushKeywordUpdates.mockResolvedValueOnce({ ok: true });
    mockKeywordRun(pauseRule, [makeKeyword({ acos: "80", state: "enabled" })], [
      { rows: [] },
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(res.body.writeback_error_count).toBe(0);
    expect(res.body.writeback_errors).toHaveLength(0);
  });

  it("still applies the change locally — a rejection stays non-fatal", async () => {
    pushKeywordUpdates.mockResolvedValueOnce({ ok: false, error: "rejected" });
    mockKeywordRun(pauseRule, [makeKeyword({ acos: "80", state: "enabled" })], [
      { rows: [] },
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(res.status).toBe(200);
    expect(res.body.applied_count).toBe(1);
  });
});

// ─── runStatusFromResult / rule_executions bookkeeping ────────────────────────
describe("Run status derivation", () => {
  const { __test } = require("../src/routes/rules");

  it("marks a run partial when Amazon rejected a write-back", () => {
    expect(__test.runStatusFromResult({ errors: [], writeback_error_count: 1 })).toBe("partial");
  });

  it("marks a run partial when an action threw locally", () => {
    expect(__test.runStatusFromResult({ errors: [{ error: "x" }], writeback_error_count: 0 })).toBe("partial");
  });

  it("marks a clean run completed", () => {
    expect(__test.runStatusFromResult({ errors: [], writeback_error_count: 0 })).toBe("completed");
  });

  it("treats a result without the write-back field as completed", () => {
    expect(__test.runStatusFromResult({ errors: [] })).toBe("completed");
  });
});

// ─── add_negative_keyword: text normalization and row re-use ──────────────────
describe("add_negative_keyword — normalization and archived-row re-use", () => {
  let app;
  beforeEach(() => { jest.clearAllMocks(); app = buildApp(); });
  afterEach(() => { dbQuery.mockReset(); });

  const stRule = makeRule({
    actions: JSON.stringify([{ type: "add_negative_keyword", value: "exact" }]),
    scope: JSON.stringify({ entity_type: "search_term", period_days: 60 }),
    conditions: JSON.stringify([{ metric: "acos", op: "gte", value: "25" }]),
  });

  // Exactly the text Amazon's report returns for the term that failed daily on prod:
  // U+00A0 between "150" and "kg".
  const NBSP_TERM = "campingstuhl 150 kg";
  const CLEAN_TERM = "campingstuhl 150 kg";

  function mockAddRun(stRows, dedupRows, writeRow) {
    dbQuery
      .mockResolvedValueOnce({ rows: [makeRule(stRule)] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: [] })            // campaign_exemptions
      .mockResolvedValueOnce({ rows: stRows })        // search_term entities
      .mockResolvedValueOnce({ rows: dedupRows })     // dedup SELECT
      .mockResolvedValueOnce({ rows: writeRow })      // INSERT ... RETURNING id / UPDATE
      .mockResolvedValueOnce({ rows: [] })            // reconcile: negative_keywords
      .mockResolvedValueOnce({ rows: [] })            // reconcile: negative_targets
      .mockResolvedValueOnce({ rows: [] });           // UPDATE rules
  }

  it("sends Amazon the normalized text, not the raw report text", async () => {
    mockAddRun([makeSearchTerm({ keyword_text: NBSP_TERM, acos: "80" })], [], [{ id: "neg-new" }]);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(pushNegativeKeyword).toHaveBeenCalledWith(
      expect.objectContaining({ keywordText: CLEAN_TERM }));
  });

  it("stores the normalized text so later runs recognise the same negative", async () => {
    mockAddRun([makeSearchTerm({ keyword_text: NBSP_TERM, acos: "80" })], [], [{ id: "neg-new" }]);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    const insert = dbQuery.mock.calls.find(c => /INSERT INTO negative_keywords/.test(c[0]));
    expect(insert[1]).toContain(CLEAN_TERM);
    expect(insert[1]).not.toContain(NBSP_TERM);
  });

  it("looks the negative up on normalized text on both sides", async () => {
    mockAddRun([makeSearchTerm({ keyword_text: NBSP_TERM, acos: "80" })], [], [{ id: "neg-new" }]);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    const dedup = dbQuery.mock.calls.find(c => /FROM negative_keywords/.test(c[0]) && /SELECT id, state, ad_group_id/.test(c[0]));
    expect(dedup[0]).toMatch(/regexp_replace/);
    expect(dedup[1]).toContain(CLEAN_TERM);
  });

  it("re-activates and re-owns an archived row instead of inserting a second one", async () => {
    // This is what stops the daily add/remove loop: the row moves to the rule that now
    // justifies the negative, so the rule that archived it no longer sees it next run.
    mockAddRun(
      [makeSearchTerm({ keyword_text: CLEAN_TERM, acos: "80" })],
      [{ id: "neg-old", state: "archived", ad_group_id: AG_ID,
         amazon_neg_keyword_id: "archived-1750000000000-neg-old" }],
      [],
    );
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(res.body.applied_count).toBe(1);

    const update = dbQuery.mock.calls.find(c => /UPDATE negative_keywords/.test(c[0]) && /state='enabled'/.test(c[0]));
    expect(update).toBeDefined();
    expect(update[0]).toMatch(/source_rule_id=\$1/);
    expect(update[1].slice(0, 4)).toEqual([RULE_ID, "search_term", CLEAN_TERM, "neg-old"]);
    expect(dbQuery.mock.calls.some(c => /INSERT INTO negative_keywords/.test(c[0]))).toBe(false);
  });

  it("resets a re-used row's synthetic id to a fresh placeholder keyed on its own uuid", async () => {
    // "archived-…" must not survive re-activation: reconciliation would later treat it as a
    // real Amazon id and try to archive a record that does not exist there.
    mockAddRun(
      [makeSearchTerm({ keyword_text: CLEAN_TERM, acos: "80" })],
      [{ id: "neg-old", state: "archived", ad_group_id: AG_ID,
         amazon_neg_keyword_id: "archived-1750000000000-neg-old" }],
      [],
    );
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    const update = dbQuery.mock.calls.find(c => /UPDATE negative_keywords/.test(c[0]) && /state='enabled'/.test(c[0]));
    expect(update[0]).toMatch(/amazon_neg_keyword_id=\$5/);
    expect(update[1][4]).toBe("rule-neg-old-negativeExact");
  });

  it("leaves a real Amazon id untouched when re-using a row", async () => {
    mockAddRun(
      [makeSearchTerm({ keyword_text: CLEAN_TERM, acos: "80" })],
      [{ id: "neg-old", state: "archived", ad_group_id: AG_ID,
         amazon_neg_keyword_id: "146042279233035" }],
      [],
    );
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    const update = dbQuery.mock.calls.find(c => /UPDATE negative_keywords/.test(c[0]) && /state='enabled'/.test(c[0]));
    expect(update[0]).not.toMatch(/amazon_neg_keyword_id/);
    expect(update[1]).toHaveLength(4);
  });

  it("pushes the re-used row's id to Amazon so the write-back updates the right record", async () => {
    mockAddRun(
      [makeSearchTerm({ keyword_text: CLEAN_TERM, acos: "80" })],
      [{ id: "neg-old", state: "archived", ad_group_id: AG_ID,
         amazon_neg_keyword_id: "archived-1750000000000-neg-old" }],
      [],
    );
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(pushNegativeKeyword).toHaveBeenCalledWith(
      expect.objectContaining({ localId: "neg-old" }));
  });

  it("re-uses a PAUSED row too — archiving deactivates via state=PAUSED on Amazon", async () => {
    mockAddRun(
      [makeSearchTerm({ keyword_text: CLEAN_TERM, acos: "80" })],
      [{ id: "neg-paused", state: "paused", ad_group_id: AG_ID }],
      [],
    );
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(res.body.applied_count).toBe(1);
    expect(pushNegativeKeyword).toHaveBeenCalledWith(
      expect.objectContaining({ localId: "neg-paused" }));
  });

  it("keeps 'already negative' campaign-wide — an enabled row in another ad group still skips", async () => {
    // Re-use is ad-group scoped, but the already_negative check must stay campaign-wide as
    // it always was; narrowing it would make rules create a burst of extra negatives.
    mockAddRun(
      [makeSearchTerm({ keyword_text: CLEAN_TERM, acos: "80" })],
      [{ id: "neg-other-ag", state: "enabled", ad_group_id: "ag---9999" }],
      [],
    );
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(res.body.applied_count).toBe(0);
    expect(res.body.skipped[0].reason).toBe("already_negative");
  });

  it("does not re-use an inactive row belonging to a different ad group", async () => {
    mockAddRun(
      [makeSearchTerm({ keyword_text: CLEAN_TERM, acos: "80" })],
      [{ id: "neg-other-ag", state: "archived", ad_group_id: "ag---9999" }],
      [{ id: "neg-new" }],
    );
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(dbQuery.mock.calls.some(c => /INSERT INTO negative_keywords/.test(c[0]))).toBe(true);
    expect(pushNegativeKeyword).toHaveBeenCalledWith(
      expect.objectContaining({ localId: "neg-new" }));
  });

  it("skips a search term whose text normalizes away to nothing", async () => {
    mockAddRun([makeSearchTerm({ keyword_text: "​  ", acos: "80" })], [], []);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(0);
    expect(res.body.skipped[0].reason).toBe("empty_keyword_text");
  });
});

// ─── Synthetic negative ids must never be sent to Amazon ─────────────────────
//
// A negative that has no Amazon id yet carries a locally-invented one: "rule-…" before the
// write-back lands, "archived-…" once reconciliation frees the placeholder for re-use.
// The keyword branch only recognised the "rule-" form, so a re-archived negative could be
// handed an "archived-…" string as though it were an Amazon entity id.
describe("Synthetic negative ids", () => {
  const { __test } = require("../src/routes/rules");

  it("treats rule- and archived- placeholders as synthetic", () => {
    expect(__test.isSyntheticNegId("rule-abc-negativeExact")).toBe(true);
    expect(__test.isSyntheticNegId("archived-1750000000000-uuid")).toBe(true);
  });

  it("treats a missing id as synthetic", () => {
    expect(__test.isSyntheticNegId(null)).toBe(true);
    expect(__test.isSyntheticNegId(undefined)).toBe(true);
    expect(__test.isSyntheticNegId("")).toBe(true);
  });

  it("treats a real Amazon id as genuine", () => {
    expect(__test.isSyntheticNegId("146042279233035")).toBe(false);
  });
});

describe("Reconciliation — synthetic ids are not archived on Amazon", () => {
  let app;
  beforeEach(() => { jest.clearAllMocks(); app = buildApp(); });
  afterEach(() => { dbQuery.mockReset(); });

  const stRule = makeRule({
    actions: JSON.stringify([{ type: "add_negative_keyword", value: "exact" }]),
    scope: JSON.stringify({ entity_type: "search_term", period_days: 60 }),
    conditions: JSON.stringify([{ metric: "acos", op: "gte", value: "25" }]),
  });

  function mockReconcile(negKwRow) {
    dbQuery
      .mockResolvedValueOnce({ rows: [stRule] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })            // no entities
      .mockResolvedValueOnce({ rows: [negKwRow] })    // reconcile: negative_keywords
      // The term now converts (2 orders) and its ACOS is far under the rule's 25 threshold,
      // so the conditions genuinely no longer hold → removal, which is what these tests need.
      .mockResolvedValueOnce({ rows: [{ clicks: "30", spend: "10", orders: "2", sales: "500", impressions: "900" }] })
      .mockResolvedValueOnce({ rows: [] })            // UPDATE negative_keywords
      .mockResolvedValueOnce({ rows: [] })            // reconcile: negative_targets
      .mockResolvedValueOnce({ rows: [] });           // UPDATE rules
  }

  const baseRow = {
    id: "negkw-001", keyword_text: "campingstuhl 150 kg",
    campaign_id: CAMP_ID, ad_group_id: AG_ID, match_type: "negative_exact",
    level: "ad_group", source_entity_type: "search_term",
    amazon_profile_id: "123456789", connection_id: "conn-001",
    marketplace_id: "ATVPDKIKX0DER", campaign_type: "sponsoredProducts",
    campaign_name: "Campaign A",
  };

  it("does not call Amazon for a negative whose id is an archived- placeholder", async () => {
    mockReconcile({ ...baseRow, amazon_neg_keyword_id: "archived-1750000000000-negkw-001" });
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(res.body.removed_count).toBe(1);
    expect(archiveNegativeKeyword).not.toHaveBeenCalled();
  });

  it("does call Amazon for a negative that has a real id", async () => {
    mockReconcile({ ...baseRow, amazon_neg_keyword_id: "146042279233035" });
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(archiveNegativeKeyword).toHaveBeenCalledWith(
      expect.objectContaining({ amazonNegKeywordId: "146042279233035" }));
  });
});

// A masked ASIN carrying an invisible character must still auto-route to a negative
// TARGET — negating it as a keyword would not exclude the product on Amazon.
describe("ASIN auto-routing is normalization-aware", () => {
  let app;
  beforeEach(() => { jest.clearAllMocks(); app = buildApp(); });
  afterEach(() => { dbQuery.mockReset(); });

  it("routes a zero-width-padded ASIN query to add_negative_target", async () => {
    const rule = makeRule({
      actions: JSON.stringify([{ type: "add_negative_keyword", value: "exact" }]),
      scope: JSON.stringify({ entity_type: "search_term", period_days: 60 }),
      conditions: JSON.stringify([{ metric: "acos", op: "gte", value: "25" }]),
    });
    dbQuery
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [makeSearchTerm({ keyword_text: "​b076j8j3w5", acos: "80" })] })
      .mockResolvedValueOnce({ rows: [] })   // active positive target lookup
      .mockResolvedValueOnce({ rows: [] })   // negative_targets dedup
      .mockResolvedValueOnce({ rows: [] })   // reconcile: negative_keywords
      .mockResolvedValueOnce({ rows: [] })   // reconcile: negative_targets
      .mockResolvedValueOnce({ rows: [] });  // UPDATE rules
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.body.applied[0].action).toBe("add_negative_target");
    expect(res.body.applied[0].auto_routed).toBe(true);
    expect(res.body.applied[0].expression[0].value).toBe("B076J8J3W5");
  });
});

// ─── The add path and reconciliation must judge a term identically ───────────
//
// Live regression (2026-08-03, caught on prod after the first fix): reconciliation matched
// negatives on NORMALIZED text while the entity query still grouped by the RAW query, so
// Amazon's two spellings of "campingstuhl 150 kg" (U+00A0 vs plain space) were one entity
// for reconciliation and two for the add path. Add scored the U+00A0 spelling alone
// (25 clicks / 1 order → matched) while reconcile scored the merged total
// (36 clicks / 2 orders → failed `orders = 1`), so the rule added and removed it in the
// same run. Both paths must normalize, or the oscillation returns in a new disguise.
describe("Add path and reconciliation agree on term identity", () => {
  let app;
  beforeEach(() => { jest.clearAllMocks(); app = buildApp(); });
  afterEach(() => { dbQuery.mockReset(); });

  const stRule = makeRule({
    actions: JSON.stringify([{ type: "add_negative_keyword", value: "exact" }]),
    scope: JSON.stringify({ entity_type: "search_term", period_days: 60 }),
    conditions: JSON.stringify([{ metric: "acos", op: "gte", value: "25" }]),
  });

  function runQueries() {
    dbQuery
      .mockResolvedValueOnce({ rows: [stRule] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })   // entities
      .mockResolvedValueOnce({ rows: [] })   // reconcile: negative_keywords
      .mockResolvedValueOnce({ rows: [] })   // reconcile: negative_targets
      .mockResolvedValueOnce({ rows: [] });  // UPDATE rules
  }

  it("groups search-term entities by normalized query, not raw text", async () => {
    runQueries();
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    const entityQuery = dbQuery.mock.calls.find(c => /FROM search_term_metrics stm/.test(c[0]));
    expect(entityQuery[0]).toMatch(/GROUP BY btrim\(regexp_replace/);
    expect(entityQuery[0]).not.toMatch(/GROUP BY stm\.query/);
  });

  it("selects the normalized query as keyword_text so negatives are stored normalized", async () => {
    runQueries();
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    const entityQuery = dbQuery.mock.calls.find(c => /FROM search_term_metrics stm/.test(c[0]));
    expect(entityQuery[0]).toMatch(/regexp_replace[\s\S]*AS keyword_text/);
  });

  it("uses the identical normalization expression in both the entity and reconcile queries", async () => {
    // Stronger than checking each side separately: if the two ever drift apart, the add and
    // remove decisions can disagree again even though both "normalize".
    const { sqlNormalizeKeywordText } = require("../src/services/amazon/keywordText");
    const expected = sqlNormalizeKeywordText("stm.query");
    const reconcileForm = sqlNormalizeKeywordText("query");

    dbQuery
      .mockResolvedValueOnce({ rows: [stRule] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: "negkw-1", keyword_text: "campingstuhl 150 kg", campaign_id: CAMP_ID,
        ad_group_id: AG_ID, amazon_neg_keyword_id: "AZ1", match_type: "negative_exact",
        level: "ad_group", source_entity_type: "search_term", amazon_profile_id: "1",
        connection_id: "c1", marketplace_id: "m1", campaign_type: "sponsoredProducts",
        campaign_name: "A",
      }] })
      .mockResolvedValueOnce({ rows: [{ clicks: "25", spend: "88.5", orders: "1", sales: "100", impressions: "900" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });

    const entityQuery   = dbQuery.mock.calls.find(c => /FROM search_term_metrics stm/.test(c[0]));
    const reconcileQuery = dbQuery.mock.calls.find(c =>
      /FROM search_term_metrics/.test(c[0]) && /GROUP BY ad_group_id, match_type/.test(c[0]));

    expect(entityQuery[0]).toContain(expected);
    expect(reconcileQuery[0]).toContain(reconcileForm);
    // Same normalizer, differing only in the column reference it wraps.
    expect(expected.replace(/stm\.query/g, "query")).toBe(reconcileForm);
  });
});

// ─── negative_targets get the same re-ownership treatment as keywords ────────
//
// Without it the target path kept inserting a second row, whose placeholder the write-back's
// duplicate-recovery then deleted on the unique-index conflict — leaving the archived row
// owned by the rule that removed it, which is the same loop the keyword path had.
describe("add_negative_target — archived-row re-use", () => {
  let app;
  beforeEach(() => { jest.clearAllMocks(); app = buildApp(); });
  afterEach(() => { dbQuery.mockReset(); });

  const asinRule = makeRule({
    actions: JSON.stringify([{ type: "add_negative_keyword", value: "exact" }]),
    scope: JSON.stringify({ entity_type: "search_term", period_days: 60 }),
    conditions: JSON.stringify([{ metric: "acos", op: "gte", value: "25" }]),
  });
  const asinST = () => makeSearchTerm({ keyword_text: "b076j8j3w5", acos: "80" });

  function mockRun(dedupRows, insertRows) {
    dbQuery
      .mockResolvedValueOnce({ rows: [asinRule] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [asinST()] })
      .mockResolvedValueOnce({ rows: [] })            // activeTgt → none
      .mockResolvedValueOnce({ rows: dedupRows })     // negative_targets dedup
      .mockResolvedValueOnce({ rows: insertRows })    // UPDATE (re-use) or INSERT
      .mockResolvedValueOnce({ rows: [] })            // reconcile: negative_keywords
      .mockResolvedValueOnce({ rows: [] })            // reconcile: negative_targets
      .mockResolvedValueOnce({ rows: [] });           // UPDATE rules
  }

  it("re-activates and re-owns an archived target row instead of inserting", async () => {
    mockRun([{ id: "nt-old", state: "archived", ad_group_id: AG_ID,
               amazon_neg_target_id: "archived-1750000000000-nt-old" }], []);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    const update = dbQuery.mock.calls.find(c => /UPDATE negative_targets/.test(c[0]) && /state='enabled'/.test(c[0]));
    expect(update).toBeDefined();
    expect(update[1].slice(0, 3)).toEqual([RULE_ID, "search_term", "nt-old"]);
    expect(dbQuery.mock.calls.some(c => /INSERT INTO negative_targets/.test(c[0]))).toBe(false);
    expect(pushNegativeAsin).toHaveBeenCalledWith(expect.objectContaining({ localId: "nt-old" }));
  });

  it("resets a synthetic target id to a placeholder keyed on the row's own uuid", async () => {
    mockRun([{ id: "nt-old", state: "archived", ad_group_id: AG_ID,
               amazon_neg_target_id: "archived-1750000000000-nt-old" }], []);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    const update = dbQuery.mock.calls.find(c => /UPDATE negative_targets/.test(c[0]) && /state='enabled'/.test(c[0]));
    expect(update[0]).toMatch(/amazon_neg_target_id=\$4/);
    expect(update[1][3]).toBe("rule-neg-nt-old");
  });

  it("leaves a real Amazon target id untouched on re-use", async () => {
    mockRun([{ id: "nt-old", state: "archived", ad_group_id: AG_ID,
               amazon_neg_target_id: "229495617374260" }], []);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    const update = dbQuery.mock.calls.find(c => /UPDATE negative_targets/.test(c[0]) && /state='enabled'/.test(c[0]));
    expect(update[0]).not.toMatch(/amazon_neg_target_id/);
    expect(update[1]).toHaveLength(3);
  });

  it("inserts when the only inactive row belongs to a different ad group", async () => {
    mockRun([{ id: "nt-other", state: "archived", ad_group_id: "ag---9999",
               amazon_neg_target_id: "archived-1-x" }], [{ id: "nt-new" }]);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(dbQuery.mock.calls.some(c => /INSERT INTO negative_targets/.test(c[0]))).toBe(true);
    expect(pushNegativeAsin).toHaveBeenCalledWith(expect.objectContaining({ localId: "nt-new" }));
  });

  it("still skips campaign-wide when an enabled target row exists in another ad group", async () => {
    mockRun([{ id: "nt-other", state: "enabled", ad_group_id: "ag---9999" }], []);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(res.body.applied_count).toBe(0);
    expect(res.body.skipped[0].reason).toBe("already_negative");
  });
});

// ─── A negative is released only on evidence the term converts ───────────────
//
// The threshold that creates a negative used to release it too, with no deadband. A negated
// term stops receiving traffic, so its clicks age out of the rolling window and the count
// shrinks on its own — the negative suppresses the very data used to judge it. Live case:
// "footrest under desk" was negated at 8 clicks and released at 7, repeatedly (2026-06-22/23,
// 07-25/28, 08-02/04). Across 30 days, 216 of 438 releases (49%) freed terms that had never
// produced a single order, at an average 6.6 clicks against thresholds of 6 and 8.
describe("negativeStillJustified — conversion evidence required to release", () => {
  const { __test } = require("../src/routes/rules");
  const { negativeStillJustified } = __test;

  // [ST]-8cl-0or-60d (neg key)
  const zeroOrderRule = [
    { metric: "clicks", op: "gte", value: "8" },
    { metric: "orders", op: "eq",  value: "0" },
  ];
  const agg = (clicks, orders) => ({ clicks, orders, spend: "5", sales: orders > 0 ? "50" : "0", impressions: "100" });

  it("keeps a zero-order negative whose clicks decayed below the threshold", () => {
    // The exact live case: negated at 8 clicks, measured at 7 on the next run.
    expect(negativeStillJustified(zeroOrderRule, agg("7", "0"), null)).toBe(true);
  });

  it("keeps a zero-order negative that has no traffic left at all", () => {
    expect(negativeStillJustified(zeroOrderRule, agg("0", "0"), null)).toBe(true);
  });

  it("keeps a zero-order negative that still meets the threshold", () => {
    expect(negativeStillJustified(zeroOrderRule, agg("12", "0"), null)).toBe(true);
  });

  it("releases once the term actually converts", () => {
    // orders > 0 → the rule's own `orders = 0` condition fails → release. This is the only
    // way a negative comes off, and it is real conversion evidence rather than data decay.
    expect(negativeStillJustified(zeroOrderRule, agg("20", "3"), null)).toBe(false);
  });

  it("respects the rule's conditions once orders exist — an orders=1 rule holds at exactly 1", () => {
    const oneOrderRule = [
      { metric: "clicks", op: "gte", value: "12" },
      { metric: "orders", op: "eq",  value: "1"  },
      { metric: "acos",   op: "gte", value: "25" },
    ];
    const stillBad = { clicks: "25", orders: "1", spend: "88.5", sales: "100", impressions: "900" };
    withDerived(stillBad);
    expect(negativeStillJustified(oneOrderRule, stillBad, null)).toBe(true);

    const nowGood = { clicks: "25", orders: "4", spend: "10", sales: "500", impressions: "900" };
    withDerived(nowGood);
    expect(negativeStillJustified(oneOrderRule, nowGood, null)).toBe(false);
  });

  it("with slices, zero total orders keeps the negative even if no slice matches", () => {
    const slices = [
      { clicks: "3", orders: "0", spend: "2", sales: "0", impressions: "50" },
      { clicks: "4", orders: "0", spend: "3", sales: "0", impressions: "60" },
    ];
    expect(negativeStillJustified(zeroOrderRule, agg("7", "0"), slices)).toBe(true);
  });

  it("with slices and orders present, a single still-qualifying slice holds the negative", () => {
    const slices = [
      { clicks: "12", orders: "0", spend: "9", sales: "0", impressions: "200" }, // matches
      { clicks: "2",  orders: "2", spend: "1", sales: "40", impressions: "30" }, // does not
    ];
    expect(negativeStillJustified(zeroOrderRule, agg("14", "2"), slices)).toBe(true);
  });

  it("with slices and orders present, releases when no slice qualifies", () => {
    const slices = [
      { clicks: "3", orders: "1", spend: "1", sales: "40", impressions: "30" },
      { clicks: "4", orders: "1", spend: "1", sales: "50", impressions: "40" },
    ];
    expect(negativeStillJustified(zeroOrderRule, agg("7", "2"), slices)).toBe(false);
  });

  function withDerived(m) { return __test.withDerivedMetrics(m); }
});

// Audit correlation: an ASIN negated and later released must carry the SAME entity_name, or
// add/remove pairs for one ASIN look unrelated. The raw search term arrives lower-cased while
// the reconcile event records the upper-case ASIN — a churn check without LOWER() then reports
// a false zero, which is exactly what happened while reviewing the 2026-08-04 run.
describe("ASIN audit events use a consistent entity name", () => {
  let app;
  beforeEach(() => { jest.clearAllMocks(); app = buildApp(); });
  afterEach(() => { dbQuery.mockReset(); });

  it("records the upper-case ASIN when auto-routing a lower-case search term", async () => {
    const rule = makeRule({
      actions: JSON.stringify([{ type: "add_negative_keyword", value: "exact" }]),
      scope: JSON.stringify({ entity_type: "search_term", period_days: 60 }),
      conditions: JSON.stringify([{ metric: "acos", op: "gte", value: "25" }]),
    });
    dbQuery
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [makeSearchTerm({ keyword_text: "b09zpwbxj2", acos: "80" })] })
      .mockResolvedValueOnce({ rows: [] })          // activeTgt
      .mockResolvedValueOnce({ rows: [] })          // negative_targets dedup
      .mockResolvedValueOnce({ rows: [{ id: "nt-1" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    const audit = writeAudit.mock.calls.find(c => c[0].action === "search_term.add_negative_target_auto");
    expect(audit[0].entityName).toBe("B09ZPWBXJ2");
  });
});
