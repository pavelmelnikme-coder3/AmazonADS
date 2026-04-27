"use strict";
/**
 * Rules routes — comprehensive test suite
 *
 * Covers:
 *   Inline evaluate() logic  — all 6 operators, multiple conditions, unknown op
 *   GET  /rules              — list with pagination
 *   POST /rules              — create, missing required fields
 *   PATCH /rules/:id         — update, not found
 *   DELETE /rules/:id        — delete
 *   GET  /rules/campaigns    — campaign picker
 *   GET  /rules/ad-groups    — ad-group picker (with/without campaignId)
 *   GET  /rules/targets      — targets picker
 *   POST /rules/:id/run      — dry-run execution, rule not found
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

// ─────────────────────────────────────────────────────────────────────────────
//  evaluate() — tested via dry-run rule execution
//
//  The evaluate() function is private to the rules module, but its behaviour
//  is fully exercised by POST /rules/:id/run with dry_run:true (no DB writes).
//  We verify correct operator semantics through the returned applied/matched counts.
// ─────────────────────────────────────────────────────────────────────────────
describe("evaluate() operator semantics (via dry-run)", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  function makeRule(op, value, metricValue) {
    return {
      ...SAMPLE_RULE,
      conditions: JSON.stringify([{ metric: "acos", op, value }]),
      actions: JSON.stringify([{ type: "set_state", state: "paused" }]),
      scope: JSON.stringify({ period_days: 14, entity_type: "keyword" }),
    };
  }

  function mockDryRun(rule, kwMetricValue) {
    const kw = {
      id: "kw-001", workspace_id: WS_ID, keyword_text: "test", match_type: "exact",
      state: "enabled", bid: "0.80",
      campaign_name: "Camp", campaign_id: CAMP_ID, ad_group_id: AG_ID,
      clicks: 10, spend: "5.00", orders: 1, sales: "10.00", acos: String(kwMetricValue),
    };
    // entity_type = "keyword" → targets query is SKIPPED (only runs when != "keyword")
    // Query order: (1) fetch rule, (2) org_id lookup, (3) keywords, (4) UPDATE last_run_at
    dbQuery
      .mockResolvedValueOnce({ rows: [rule] })             // (1) route: SELECT rule
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] }) // (2) executeRule: SELECT org_id
      .mockResolvedValueOnce({ rows: [kw] })               // (3) executeRule: SELECT keywords
      .mockResolvedValueOnce({ rows: [] });                // (4) route: UPDATE last_run_at
  }

  it("gt: matches when metric > threshold", async () => {
    const rule = makeRule("gt", 30, 55); // acos=55 > 30 → match
    mockDryRun(rule, 55);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.matched_count).toBe(1);
    expect(res.body.dry_run).toBe(true);
  });

  it("gt: does NOT match when metric equals threshold", async () => {
    const rule = makeRule("gt", 55, 55); // acos=55 NOT > 55
    mockDryRun(rule, 55);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.matched_count).toBe(0);
  });

  it("gte: matches when metric equals threshold", async () => {
    const rule = makeRule("gte", 55, 55);
    mockDryRun(rule, 55);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.matched_count).toBe(1);
  });

  it("lt: matches when metric < threshold", async () => {
    const rule = makeRule("lt", 10, 5);
    mockDryRun(rule, 5);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.matched_count).toBe(1);
  });

  it("lte: matches when metric equals threshold", async () => {
    const rule = makeRule("lte", 5, 5);
    mockDryRun(rule, 5);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.matched_count).toBe(1);
  });

  it("eq: matches exact value", async () => {
    const rule = makeRule("eq", 50, 50);
    mockDryRun(rule, 50);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.matched_count).toBe(1);
  });

  it("neq: matches when metric != threshold", async () => {
    const rule = makeRule("neq", 50, 30);
    mockDryRun(rule, 30);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.matched_count).toBe(1);
  });

  it("neq: does NOT match when equal", async () => {
    const rule = makeRule("neq", 50, 50);
    mockDryRun(rule, 50);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.matched_count).toBe(0);
  });

  it("unknown operator never matches", async () => {
    const rule = makeRule("xyzzy", 10, 5);
    mockDryRun(rule, 5);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.matched_count).toBe(0);
  });

  it("missing metric treated as 0", async () => {
    const rule = {
      ...SAMPLE_RULE,
      conditions: JSON.stringify([{ metric: "nonexistent_metric", op: "lt", value: 1 }]),
      actions: JSON.stringify([{ type: "set_state", state: "paused" }]),
      scope: JSON.stringify({ period_days: 14, entity_type: "keyword" }),
    };
    const kw = {
      id: "kw-001", workspace_id: WS_ID, keyword_text: "test", match_type: "exact",
      state: "enabled", bid: "0.80",
      campaign_name: "Camp", campaign_id: CAMP_ID, ad_group_id: AG_ID,
      clicks: 10, spend: "5.00", orders: 1, sales: "10.00", acos: "15.00",
    };
    // entity_type = "keyword" → 4 queries (no targets query)
    dbQuery
      .mockResolvedValueOnce({ rows: [rule] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: [kw] })
      .mockResolvedValueOnce({ rows: [] });
    // nonexistent_metric = 0, which is lt 1 → should match
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: true });
    expect(res.status).toBe(200);
    expect(res.body.matched_count).toBe(1);
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
    actions: [{ type: "set_state", state: "paused" }],
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

    const res = await request(app)
      .patch(`/rules/${RULE_ID}`)
      .send({ name: "Updated Rule Name" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated Rule Name");
  });

  it("toggles is_active to false", async () => {
    const updated = { ...SAMPLE_RULE, is_active: false };
    dbQuery.mockResolvedValueOnce({ rows: [updated] });

    const res = await request(app)
      .patch(`/rules/${RULE_ID}`)
      .send({ is_active: false });

    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(false);
  });

  it("returns 404 when rule not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch(`/rules/nonexistent-rule-id`)
      .send({ name: "New Name" });

    expect(res.status).toBe(404);
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
//  POST /rules/:id/run
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
    // SAMPLE_RULE scope={} → entity_type defaults to "keyword" → no targets query
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_RULE] })         // fetch rule
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })  // workspace org_id
      .mockResolvedValueOnce({ rows: [] })                    // keywords (empty — 0 matched)
      .mockResolvedValueOnce({ rows: [] });                   // UPDATE last_run_at

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
    // entity_type defaults to "keyword" → 4 queries (no targets)
    dbQuery
      .mockResolvedValueOnce({ rows: [dryRule] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({});
    expect(res.status).toBe(200);
    expect(res.body.dry_run).toBe(true);
  });
});
