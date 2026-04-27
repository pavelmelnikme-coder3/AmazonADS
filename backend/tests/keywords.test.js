"use strict";
/**
 * Keywords routes — comprehensive test suite
 *
 * Endpoints:
 *   GET   /keywords          — list with many filter combos
 *   PATCH /keywords/:id      — update bid / state
 *   POST  /keywords/bulk     — bulk update
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID   = "ws---0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const CAMP_ID = "camp-0001-0000-0000-000000000001";
const KW_ID   = "kw---0001-0000-0000-000000000001";

const SAMPLE_KW = {
  id: KW_ID,
  workspace_id: WS_ID,
  campaign_id: CAMP_ID,
  keyword_text: "feuerfeste matte",
  match_type: "exact",
  state: "enabled",
  bid: "0.85",
  clicks: 40,
  spend: "25.00",
  acos: "15.00",
  campaign_name: "Test Campaign",
};

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/routes/audit", () => ({
  writeAudit: jest.fn().mockResolvedValue(undefined),
  updateAuditStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/amazon/writeback", () => ({
  pushKeywordUpdates: jest.fn().mockResolvedValue({}),
  // loadKeywordContext must return a promise (route calls .then() on it)
  loadKeywordContext: jest.fn().mockResolvedValue([]),
  pushNewKeywords:    jest.fn().mockResolvedValue({}),
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
const keywordsRouter = require("../src/routes/keywords");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/keywords", keywordsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

function mockList(rows = [SAMPLE_KW], total = 1) {
  dbQuery
    .mockResolvedValueOnce({ rows })
    .mockResolvedValueOnce({ rows: [{ total: String(total) }] });
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /keywords
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /keywords", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns paginated keyword list with defaults", async () => {
    mockList();
    const res = await request(app).get("/keywords");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].keyword_text).toBe("feuerfeste matte");
  });

  it("accepts valid limit values", async () => {
    for (const limit of [25, 50, 100, 200, 500]) {
      mockList([SAMPLE_KW], 1);
      const res = await request(app).get(`/keywords?limit=${limit}`);
      expect(res.status).toBe(200);
    }
  });

  it("falls back to limit=100 for invalid limit", async () => {
    mockList();
    const res = await request(app).get("/keywords?limit=9999");
    expect(res.status).toBe(200);
    // keywords route embeds limit directly in SQL string (not as a param)
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toContain("LIMIT 100");
  });

  it("filters by campaignIds (array format)", async () => {
    mockList();
    const res = await request(app).get(`/keywords?campaignIds[]=${CAMP_ID}`);
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContainEqual([CAMP_ID]);
  });

  it("filters by campaignIds (comma-separated string)", async () => {
    mockList();
    const id2 = "camp-0002-0000-0000-000000000001";
    const res = await request(app).get(`/keywords?campaignIds=${CAMP_ID},${id2}`);
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    const found = params.some(p => Array.isArray(p) && p.includes(CAMP_ID));
    expect(found).toBe(true);
  });

  it("filters by state", async () => {
    mockList([{ ...SAMPLE_KW, state: "paused" }]);
    const res = await request(app).get("/keywords?state=paused");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("paused");
  });

  it("filters by search term", async () => {
    mockList();
    const res = await request(app).get("/keywords?search=feuer");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("%feuer%");
  });

  it("filters by match type", async () => {
    mockList();
    const res = await request(app).get("/keywords?matchType=broad");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("broad");
  });

  it("ignores matchType=all", async () => {
    mockList();
    const res = await request(app).get("/keywords?matchType=all");
    expect(res.status).toBe(200);
    // 'all' should NOT appear in params
    const params = dbQuery.mock.calls[0][1];
    expect(params).not.toContain("all");
  });

  it("filters by campaign type SP", async () => {
    mockList();
    const res = await request(app).get("/keywords?campaignType=SP");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("sponsoredProducts");
  });

  it("filters by bid range", async () => {
    mockList();
    const res = await request(app).get("/keywords?bidMin=0.5&bidMax=2.0");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(0.5);
    expect(params).toContain(2.0);
  });

  it("handles noSales=true filter", async () => {
    mockList();
    const res = await request(app).get("/keywords?noSales=true");
    expect(res.status).toBe(200);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toContain("orders_14d,0) = 0");
  });

  it("handles hasClicks=true filter", async () => {
    mockList();
    const res = await request(app).get("/keywords?hasClicks=true");
    expect(res.status).toBe(200);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toContain("clicks,0) > 0");
  });

  it("handles excludePaused=true filter", async () => {
    mockList();
    const res = await request(app).get("/keywords?excludePaused=true");
    expect(res.status).toBe(200);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toContain("k.state != 'paused'");
  });

  it("handles excludeDisabledCampaigns=true filter", async () => {
    mockList();
    const res = await request(app).get("/keywords?excludeDisabledCampaigns=true");
    expect(res.status).toBe(200);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toContain("c.state = 'enabled'");
  });

  it("filters by valid campaignState", async () => {
    mockList();
    const res = await request(app).get("/keywords?campaignState=paused");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("paused");
  });

  it("ignores invalid campaignState values", async () => {
    mockList();
    const res = await request(app).get("/keywords?campaignState=invalid_state");
    expect(res.status).toBe(200);
    // 'invalid_state' should NOT be in params
    const params = dbQuery.mock.calls[0][1];
    expect(params).not.toContain("invalid_state");
  });

  it("returns empty list when no results", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get("/keywords");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it("sorts by allowed field (bid desc)", async () => {
    mockList();
    const res = await request(app).get("/keywords?sortBy=bid&sortDir=desc");
    expect(res.status).toBe(200);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/ORDER BY.*DESC/i);
  });

  it("paginates correctly (page 2)", async () => {
    mockList([SAMPLE_KW], 50);
    const res = await request(app).get("/keywords?page=2&limit=25");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(25); // offset = (2-1)*25 = 25
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PATCH /keywords/:id
// ─────────────────────────────────────────────────────────────────────────────
describe("PATCH /keywords/:id", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("updates keyword bid", async () => {
    const updated = { ...SAMPLE_KW, bid: "1.20" };
    // Route does ONE UPDATE...RETURNING query
    dbQuery.mockResolvedValueOnce({ rows: [updated] });

    const res = await request(app)
      .patch(`/keywords/${KW_ID}`)
      .send({ bid: 1.20 });

    expect(res.status).toBe(200);
    expect(res.body.bid).toBe("1.20");
  });

  it("updates keyword state to paused", async () => {
    const updated = { ...SAMPLE_KW, state: "paused" };
    dbQuery.mockResolvedValueOnce({ rows: [updated] });

    const res = await request(app)
      .patch(`/keywords/${KW_ID}`)
      .send({ state: "paused" });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe("paused");
  });

  it("returns 400 when neither bid nor state is provided", async () => {
    const res = await request(app)
      .patch(`/keywords/${KW_ID}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/bid or state/i);
  });

  it("returns 404 when keyword not found (UPDATE returns no rows)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch(`/keywords/nonexistent-id`)
      .send({ bid: 1.0 });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});
