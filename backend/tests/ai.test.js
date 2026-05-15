"use strict";
/**
 * AI Assistant Routes — comprehensive test suite
 *
 * Covers:
 *   GET  /ai/settings             — returns settings row; returns null when none exist
 *   PATCH /ai/settings            — upserts and returns updated settings
 *   GET  /ai/recommendations      — returns list; status filter; entity-name enrichment
 *   POST /ai/analyze              — saves recommendations from Claude; strips no-ops;
 *                                   handles axios 401/429; handles parse error (422)
 *   POST /ai/recommendations/:id/preview — 404, bid_adjustment preview, budget preview,
 *                                          state preview, keyword bid/state preview
 *   POST /ai/recommendations/:id/apply   — 404, applies campaign state; applies keyword bid;
 *                                          applies bid_adjustment_pct; writeAudit called
 *   POST /ai/recommendations/:id/dismiss — 404, marks dismissed
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID   = "ws---0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const REC_ID  = "rec--0001-0000-0000-000000000001";
const CAMP_ID = "camp-0001-0000-0000-000000000001";
const KW_ID   = "kw---0001-0000-0000-000000000001";

// Realistic Claude response (a single recommendation)
const CLAUDE_REC = {
  type: "bid_adjustment",
  title: "Reduce bids on high-ACOS campaign",
  rationale: "ACOS 85% far exceeds target 30%",
  expected_effect: "Lower wasted spend",
  risk_level: "low",
  priority: 1,
  actions: [
    {
      action_type: "adjust_bid",
      entity_type: "campaign",
      entity_id: CAMP_ID,
      entity_name: "Campaign Alpha",
      params: { bid_adjustment_pct: -20 },
    },
  ],
};

const SAVED_REC = {
  id: REC_ID,
  workspace_id: WS_ID,
  run_id: "run-abc",
  type: "bid_adjustment",
  title: "Reduce bids on high-ACOS campaign",
  rationale: "ACOS 85%",
  expected_effect: "Lower wasted spend",
  risk_level: "low",
  status: "pending",
  actions: JSON.stringify(CLAUDE_REC.actions),
  context_snapshot: "{}",
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  created_at: new Date().toISOString(),
};

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/routes/audit", () => ({
  writeAudit: jest.fn().mockResolvedValue("audit-id-001"),
}));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("axios", () => ({ post: jest.fn() }));
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

// Ensure ANTHROPIC_API_KEY is set so callClaude() doesn't throw early
process.env.ANTHROPIC_API_KEY = "test-key-xxx";

const { query: dbQuery } = require("../src/db/pool");
const { writeAudit }     = require("../src/routes/audit");
const axios              = require("axios");

const aiRouter = require("../src/routes/ai");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/ai", aiRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Return a mock axios.post response that wraps JSON in Claude's content format */
function claudeResponse(payload) {
  return {
    data: {
      content: [{ text: JSON.stringify(payload) }],
    },
  };
}

/** Seed the sequence of DB calls made by POST /analyze */
function mockAnalyzeSequence({ settings = null, campaigns = [], keywords = [] } = {}) {
  // 1. ai_workspace_settings
  dbQuery.mockResolvedValueOnce({ rows: settings ? [settings] : [] });
  // 2. campaign metrics query
  dbQuery.mockResolvedValueOnce({ rows: campaigns });
  // 3. keyword query
  dbQuery.mockResolvedValueOnce({ rows: keywords });
  // After Claude responds, no-op validation per action entity:
  //   campaign state check
  dbQuery.mockResolvedValueOnce({ rows: [{ state: "enabled", daily_budget: 50 }] });
  // 4. UPDATE ai_recommendations SET status='expired'
  dbQuery.mockResolvedValueOnce({ rowCount: 0 });
  // 5. INSERT INTO ai_recommendations RETURNING *
  dbQuery.mockResolvedValueOnce({ rows: [SAVED_REC] });
  // 6. UPSERT ai_workspace_settings (last_run_at)
  dbQuery.mockResolvedValueOnce({ rows: [] });
}

beforeEach(() => {
  jest.resetAllMocks();
  // Re-apply any default mock implementations cleared by resetAllMocks
  writeAudit.mockResolvedValue("audit-id-001");
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /ai/settings
// ═════════════════════════════════════════════════════════════════════════════
describe("GET /ai/settings", () => {
  test("returns settings row when one exists", async () => {
    const settings = {
      workspace_id: WS_ID,
      target_acos: 30,
      max_acos: 50,
      response_language: "de",
    };
    dbQuery.mockResolvedValueOnce({ rows: [settings] });

    const res = await request(buildApp()).get("/ai/settings");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ target_acos: 30, response_language: "de" });
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("ai_workspace_settings"),
      [WS_ID]
    );
  });

  test("returns null when no settings configured", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp()).get("/ai/settings");
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  test("propagates DB errors as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("DB down"));
    const res = await request(buildApp()).get("/ai/settings");
    expect(res.status).toBe(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  PATCH /ai/settings
// ═════════════════════════════════════════════════════════════════════════════
describe("PATCH /ai/settings", () => {
  test("upserts and returns updated settings", async () => {
    const payload = {
      target_acos: 25,
      max_acos: 45,
      target_roas: 4,
      min_roas: 2,
      target_margin: 20,
      monthly_budget: 3000,
      business_notes: "Focus on branded terms",
      response_language: "en",
    };
    const returnedRow = { workspace_id: WS_ID, ...payload, updated_at: new Date().toISOString() };
    dbQuery.mockResolvedValueOnce({ rows: [returnedRow] });

    const res = await request(buildApp()).patch("/ai/settings").send(payload);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ target_acos: 25, response_language: "en" });
    // Should have called with all 9 params
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/s);
    expect(params[0]).toBe(WS_ID);
    expect(params[1]).toBe(25);
    expect(params[8]).toBe("en");
  });

  test("defaults response_language to 'ru' when not supplied", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ workspace_id: WS_ID, response_language: "ru" }] });

    const res = await request(buildApp()).patch("/ai/settings").send({ target_acos: 30 });
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params[8]).toBe("ru");
  });

  test("propagates DB errors as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("constraint violation"));
    const res = await request(buildApp()).patch("/ai/settings").send({ target_acos: 10 });
    expect(res.status).toBe(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /ai/recommendations
// ═════════════════════════════════════════════════════════════════════════════
describe("GET /ai/recommendations", () => {
  test("returns recommendation list without status filter", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAVED_REC] });
    // No enrichment needed — SAVED_REC already has entity_name in actions
    const rec = {
      ...SAVED_REC,
      actions: JSON.stringify([
        { ...CLAUDE_REC.actions[0], entity_name: "Campaign Alpha" },
      ]),
    };
    dbQuery.mockReset();
    dbQuery.mockResolvedValueOnce({ rows: [rec] });

    const res = await request(buildApp()).get("/ai/recommendations");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(REC_ID);
  });

  test("applies status filter in query", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp()).get("/ai/recommendations?status=applied");
    expect(res.status).toBe(200);
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/status = \$2/);
    expect(params).toContain("applied");
  });

  test("does not add status filter when status=all", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await request(buildApp()).get("/ai/recommendations?status=all");
    const [sql] = dbQuery.mock.calls[0];
    expect(sql).not.toMatch(/status = /);
  });

  test("enriches entity_name for campaign actions that lack it", async () => {
    const recWithoutName = {
      ...SAVED_REC,
      actions: JSON.stringify([
        {
          action_type: "adjust_bid",
          entity_type: "campaign",
          entity_id: CAMP_ID,
          // entity_name intentionally omitted
          params: { bid_adjustment_pct: -10 },
        },
      ]),
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [recWithoutName] })           // main query
      .mockResolvedValueOnce({ rows: [{ name: "Campaign Alpha" }] }); // enrichment

    const res = await request(buildApp()).get("/ai/recommendations");
    expect(res.status).toBe(200);
    expect(res.body[0].actions[0].entity_name).toBe("Campaign Alpha");
  });

  test("enriches entity_name for keyword actions that lack it", async () => {
    const recWithoutName = {
      ...SAVED_REC,
      actions: JSON.stringify([
        {
          action_type: "adjust_bid",
          entity_type: "keyword",
          entity_id: KW_ID,
          params: { bid: 0.45 },
        },
      ]),
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [recWithoutName] })
      .mockResolvedValueOnce({ rows: [{ keyword_text: "running shoes" }] });

    const res = await request(buildApp()).get("/ai/recommendations");
    expect(res.status).toBe(200);
    expect(res.body[0].actions[0].entity_name).toBe("running shoes");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  POST /ai/analyze
// ═════════════════════════════════════════════════════════════════════════════
describe("POST /ai/analyze", () => {
  test("returns recommendations when Claude replies with valid JSON", async () => {
    mockAnalyzeSequence({
      settings: { response_language: "en", target_acos: 30 },
      campaigns: [
        {
          id: CAMP_ID, name: "Campaign Alpha", campaign_type: "sponsoredProducts",
          state: "enabled", daily_budget: 50, spend: "42.00", sales: "50.00",
          clicks: 200, impressions: 4000, orders: 5, acos: "84.00", roas: "1.19",
        },
      ],
    });

    axios.post.mockResolvedValueOnce(claudeResponse([CLAUDE_REC]));

    const res = await request(buildApp())
      .post("/ai/analyze")
      .send({ startDate: "2026-05-01", endDate: "2026-05-14" });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("recommendations");
    expect(res.body.recommendations).toHaveLength(1);
    expect(res.body).toHaveProperty("runId");
    expect(res.body).toHaveProperty("period");
  });

  test("strips no-op actions that would pause already-paused campaign", async () => {
    // Settings
    dbQuery.mockResolvedValueOnce({ rows: [{ response_language: "ru" }] });
    // Campaigns
    dbQuery.mockResolvedValueOnce({ rows: [
      { id: CAMP_ID, name: "Alpha", state: "paused", daily_budget: 50,
        spend: "10.00", sales: "5.00", clicks: 50, impressions: 1000, orders: 1 },
    ]});
    // Keywords
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const noOpRec = {
      ...CLAUDE_REC,
      actions: [{
        action_type: "pause",
        entity_type: "campaign",
        entity_id: CAMP_ID,
        entity_name: "Alpha",
        params: { state: "paused" },
      }],
    };
    axios.post.mockResolvedValueOnce(claudeResponse([noOpRec]));

    // No-op validation: campaign is already paused
    dbQuery.mockResolvedValueOnce({ rows: [{ state: "paused", daily_budget: 50 }] });

    const res = await request(buildApp()).post("/ai/analyze").send({});
    // The no-op recommendation is stripped → 0 saved recs, but update + upsert settings still called
    expect(res.status).toBe(200);
    expect(res.body.recommendations).toHaveLength(0);
  });

  test("returns 422 when Claude returns invalid JSON", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });    // settings
    dbQuery.mockResolvedValueOnce({ rows: [] });    // campaigns
    dbQuery.mockResolvedValueOnce({ rows: [] });    // keywords

    axios.post.mockResolvedValueOnce({
      data: { content: [{ text: "Sorry, I cannot help with that." }] },
    });

    const res = await request(buildApp()).post("/ai/analyze").send({});
    expect(res.status).toBe(422);
    expect(res.body).toHaveProperty("error");
  });

  test("returns 401 when Anthropic rejects API key", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    dbQuery.mockResolvedValueOnce({ rows: [] });
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const err = new Error("Unauthorized");
    err.response = { status: 401 };
    axios.post.mockRejectedValueOnce(err);

    const res = await request(buildApp()).post("/ai/analyze").send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/ANTHROPIC_API_KEY/i);
  });

  test("returns 429 when Anthropic rate-limits the request", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    dbQuery.mockResolvedValueOnce({ rows: [] });
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const err = new Error("Too Many Requests");
    err.response = { status: 429 };
    axios.post.mockRejectedValueOnce(err);

    const res = await request(buildApp()).post("/ai/analyze").send({});
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/rate limit/i);
  });

  test("scopes campaign query to SP when scope=SP is provided", async () => {
    mockAnalyzeSequence({ campaigns: [] });
    axios.post.mockResolvedValueOnce(claudeResponse([]));

    await request(buildApp()).post("/ai/analyze").send({ scope: "sponsoredProducts" });

    const campaignQueryCall = dbQuery.mock.calls[1];
    expect(campaignQueryCall[1]).toContain("sponsoredProducts");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  POST /ai/recommendations/:id/preview
// ═════════════════════════════════════════════════════════════════════════════
describe("POST /ai/recommendations/:id/preview", () => {
  test("returns 404 when recommendation not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp()).post(`/ai/recommendations/${REC_ID}/preview`);
    expect(res.status).toBe(404);
  });

  test("returns bid_adjustment_pct preview for campaign with keywords", async () => {
    const rec = {
      ...SAVED_REC,
      actions: JSON.stringify([
        {
          action_type: "adjust_bid",
          entity_type: "campaign",
          entity_id: CAMP_ID,
          params: { bid_adjustment_pct: -20 },
        },
      ]),
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [rec] })                                // fetch rec
      .mockResolvedValueOnce({ rows: [{ id: CAMP_ID, name: "Alpha", state: "enabled", daily_budget: 50 }] }) // fetch campaign
      .mockResolvedValueOnce({ rows: [{ cnt: "5", avg_bid: "1.00" }] });     // keywords avg

    const res = await request(buildApp()).post(`/ai/recommendations/${REC_ID}/preview`);
    expect(res.status).toBe(200);
    expect(res.body.changes).toHaveLength(1);
    const change = res.body.changes[0];
    expect(change.field).toBe("bid_adjustment_pct");
    expect(change.entity_name).toBe("Alpha");
    expect(change.new_value).toContain("-20%");
  });

  test("falls back to ad_group default_bid when no keywords exist (auto campaign)", async () => {
    const rec = {
      ...SAVED_REC,
      actions: JSON.stringify([
        {
          action_type: "adjust_bid",
          entity_type: "campaign",
          entity_id: CAMP_ID,
          params: { bid_adjustment_pct: 10 },
        },
      ]),
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [rec] })
      .mockResolvedValueOnce({ rows: [{ id: CAMP_ID, name: "Auto Camp", state: "enabled", daily_budget: 30 }] })
      .mockResolvedValueOnce({ rows: [{ cnt: "0", avg_bid: null }] })         // no keywords
      .mockResolvedValueOnce({ rows: [{ cnt: "2", avg_bid: "0.75" }] });      // ad groups

    const res = await request(buildApp()).post(`/ai/recommendations/${REC_ID}/preview`);
    expect(res.status).toBe(200);
    expect(res.body.changes[0].current_value).toContain("0.75");
    expect(res.body.changes[0].current_value).toContain("ad groups");
  });

  test("returns daily_budget preview for campaign", async () => {
    const rec = {
      ...SAVED_REC,
      actions: JSON.stringify([
        {
          action_type: "adjust_budget",
          entity_type: "campaign",
          entity_id: CAMP_ID,
          params: { daily_budget: 75 },
        },
      ]),
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [rec] })
      .mockResolvedValueOnce({ rows: [{ id: CAMP_ID, name: "Alpha", state: "enabled", daily_budget: 50 }] });

    const res = await request(buildApp()).post(`/ai/recommendations/${REC_ID}/preview`);
    expect(res.status).toBe(200);
    const change = res.body.changes.find(c => c.field === "daily_budget");
    expect(change).toBeDefined();
    expect(change.current_value).toBe("€50.00");
    expect(change.new_value).toBe("€75.00");
  });

  test("infers state=paused from action_type=pause for campaign preview", async () => {
    const rec = {
      ...SAVED_REC,
      actions: JSON.stringify([
        {
          action_type: "pause",
          entity_type: "campaign",
          entity_id: CAMP_ID,
          params: {},
        },
      ]),
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [rec] })
      .mockResolvedValueOnce({ rows: [{ id: CAMP_ID, name: "Alpha", state: "enabled", daily_budget: 50 }] });

    const res = await request(buildApp()).post(`/ai/recommendations/${REC_ID}/preview`);
    expect(res.status).toBe(200);
    const stateChange = res.body.changes.find(c => c.field === "state");
    expect(stateChange?.new_value).toBe("paused");
  });

  test("returns bid and state preview for keyword actions", async () => {
    const rec = {
      ...SAVED_REC,
      actions: JSON.stringify([
        {
          action_type: "adjust_bid",
          entity_type: "keyword",
          entity_id: KW_ID,
          params: { bid: 0.65, state: "enabled" },
        },
      ]),
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [rec] })
      .mockResolvedValueOnce({ rows: [{ id: KW_ID, keyword_text: "running shoes", bid: "0.50", state: "paused" }] });

    const res = await request(buildApp()).post(`/ai/recommendations/${REC_ID}/preview`);
    expect(res.status).toBe(200);
    const bidChange   = res.body.changes.find(c => c.field === "bid");
    const stateChange = res.body.changes.find(c => c.field === "state");
    expect(bidChange?.current_value).toBe("€0.50");
    expect(bidChange?.new_value).toBe("€0.65");
    expect(stateChange?.new_value).toBe("enabled");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  POST /ai/recommendations/:id/apply
// ═════════════════════════════════════════════════════════════════════════════
describe("POST /ai/recommendations/:id/apply", () => {
  test("returns 404 when recommendation not found or not pending", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(buildApp()).post(`/ai/recommendations/${REC_ID}/apply`);
    expect(res.status).toBe(404);
  });

  test("applies campaign state change and marks rec as applied", async () => {
    const rec = {
      ...SAVED_REC,
      actions: JSON.stringify([
        {
          action_type: "pause_campaign",
          entity_type: "campaign",
          entity_id: CAMP_ID,
          params: { state: "paused" },
        },
      ]),
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [rec] })   // fetch rec
      .mockResolvedValueOnce({ rowCount: 1 })   // UPDATE campaigns SET state
      .mockResolvedValueOnce({ rowCount: 1 })   // UPDATE ai_recommendations SET status='applied'

    const res = await request(buildApp()).post(`/ai/recommendations/${REC_ID}/apply`);
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(res.body.actionsExecuted).toBeGreaterThanOrEqual(1);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.recommendation.applied",
        entityId: REC_ID,
      })
    );
  });

  test("applies keyword bid change", async () => {
    const rec = {
      ...SAVED_REC,
      actions: JSON.stringify([
        {
          action_type: "adjust_bid",
          entity_type: "keyword",
          entity_id: KW_ID,
          params: { bid: 0.45 },
        },
      ]),
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [rec] })   // fetch rec
      .mockResolvedValueOnce({ rowCount: 1 })   // UPDATE keywords SET bid
      .mockResolvedValueOnce({ rowCount: 1 })   // UPDATE ai_recommendations

    const res = await request(buildApp()).post(`/ai/recommendations/${REC_ID}/apply`);
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    const kwUpdateCall = dbQuery.mock.calls.find(([sql]) =>
      sql.includes("UPDATE keywords") && sql.includes("bid =")
    );
    expect(kwUpdateCall).toBeDefined();
    expect(kwUpdateCall[1][0]).toBe(0.45);
  });

  test("applies keyword state change", async () => {
    const rec = {
      ...SAVED_REC,
      actions: JSON.stringify([
        {
          action_type: "pause",
          entity_type: "keyword",
          entity_id: KW_ID,
          params: { state: "paused" },
        },
      ]),
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [rec] })
      .mockResolvedValueOnce({ rowCount: 1 })   // UPDATE keywords SET state
      .mockResolvedValueOnce({ rowCount: 1 });   // UPDATE ai_recommendations

    const res = await request(buildApp()).post(`/ai/recommendations/${REC_ID}/apply`);
    expect(res.status).toBe(200);
    const stateUpdateCall = dbQuery.mock.calls.find(([sql]) =>
      sql.includes("UPDATE keywords") && sql.includes("state =")
    );
    expect(stateUpdateCall).toBeDefined();
    expect(stateUpdateCall[1][0]).toBe("paused");
  });

  test("applies bid_adjustment_pct via keyword UPDATE", async () => {
    const rec = {
      ...SAVED_REC,
      actions: JSON.stringify([
        {
          action_type: "adjust_bid",
          entity_type: "campaign",
          entity_id: CAMP_ID,
          params: { bid_adjustment_pct: 15 },
        },
      ]),
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [rec] })
      .mockResolvedValueOnce({ rowCount: 3 })   // UPDATE keywords (bid * multiplier)
      .mockResolvedValueOnce({ rowCount: 1 });   // UPDATE ai_recommendations

    const res = await request(buildApp()).post(`/ai/recommendations/${REC_ID}/apply`);
    expect(res.status).toBe(200);
    const bidAdjCall = dbQuery.mock.calls.find(([sql]) =>
      sql.includes("UPDATE keywords") && sql.includes("bid * $1")
    );
    expect(bidAdjCall).toBeDefined();
    // multiplier = 1 + 15/100 = 1.15
    expect(bidAdjCall[1][0]).toBeCloseTo(1.15, 5);
  });

  test("falls back to ad_group default_bid update when no keywords matched", async () => {
    const rec = {
      ...SAVED_REC,
      actions: JSON.stringify([
        {
          action_type: "adjust_bid",
          entity_type: "campaign",
          entity_id: CAMP_ID,
          params: { bid_adjustment_pct: -10 },
        },
      ]),
    };
    dbQuery
      .mockResolvedValueOnce({ rows: [rec] })
      .mockResolvedValueOnce({ rowCount: 0 })   // UPDATE keywords → 0 rows matched
      .mockResolvedValueOnce({ rowCount: 2 })   // UPDATE ad_groups
      .mockResolvedValueOnce({ rowCount: 1 });  // UPDATE ai_recommendations

    const res = await request(buildApp()).post(`/ai/recommendations/${REC_ID}/apply`);
    expect(res.status).toBe(200);
    const agCall = dbQuery.mock.calls.find(([sql]) =>
      sql.includes("UPDATE ad_groups") && sql.includes("default_bid")
    );
    expect(agCall).toBeDefined();
  });

  test("writeAudit is called with correct payload", async () => {
    const rec = { ...SAVED_REC, actions: JSON.stringify([]) };
    dbQuery
      .mockResolvedValueOnce({ rows: [rec] })
      .mockResolvedValueOnce({ rowCount: 1 });

    await request(buildApp()).post(`/ai/recommendations/${REC_ID}/apply`);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: ORG_ID,
        workspaceId: WS_ID,
        actorId: USER_ID,
        action: "ai.recommendation.applied",
        entityType: "ai_recommendation",
        entityId: REC_ID,
        source: "ai",
      })
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  POST /ai/recommendations/:id/dismiss
// ═════════════════════════════════════════════════════════════════════════════
describe("POST /ai/recommendations/:id/dismiss", () => {
  test("returns 404 when not found or already actioned", async () => {
    dbQuery.mockResolvedValueOnce({ rowCount: 0 });
    const res = await request(buildApp()).post(`/ai/recommendations/${REC_ID}/dismiss`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found|already actioned/i);
  });

  test("marks recommendation as dismissed", async () => {
    dbQuery.mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(buildApp()).post(`/ai/recommendations/${REC_ID}/dismiss`);
    expect(res.status).toBe(200);
    expect(res.body.dismissed).toBe(true);

    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/status='dismissed'/);
    expect(params[0]).toBe(REC_ID);
    expect(params[1]).toBe(WS_ID);
  });

  test("propagates DB errors as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("DB error"));
    const res = await request(buildApp()).post(`/ai/recommendations/${REC_ID}/dismiss`);
    expect(res.status).toBe(500);
  });
});
