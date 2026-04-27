"use strict";
/**
 * Campaigns routes — comprehensive test suite
 *
 * Endpoints:
 *   GET  /campaigns          — list with pagination, filtering, sorting
 *   POST /campaigns          — create SP/SB/SD campaign
 *   PATCH /campaigns/:id     — update campaign state/budget
 *   DELETE /campaigns/:id    — soft-delete
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID   = "ws---0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const CAMP_ID = "camp-0001-0000-0000-000000000001";
const PROF_ID = "prof-0001-0000-0000-000000000001";

const SAMPLE_CAMPAIGN = {
  id: CAMP_ID,
  workspace_id: WS_ID,
  amazon_campaign_id: "AMZ001",
  name: "Test Campaign SP",
  campaign_type: "sponsoredProducts",
  state: "enabled",
  daily_budget: "50.00",
  bidding_strategy: "legacyForSales",
  marketplace: "A1PA6795UKMFR9",
  country_code: "DE",
  currency_code: "EUR",
  impressions: 10000,
  clicks: 300,
  spend: "45.00",
  sales: "350.00",
  orders: 12,
  acos: "12.86",
  roas: "7.78",
};

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock("../src/routes/audit", () => ({
  writeAudit: jest.fn().mockResolvedValue(undefined),
  updateAuditStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/amazon/adsClient", () => ({
  post:  jest.fn().mockResolvedValue({ campaigns: [{ campaignId: 9999 }] }),
  patch: jest.fn().mockResolvedValue({}),
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
const campaignsRouter = require("../src/routes/campaigns");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/campaigns", campaignsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /campaigns
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /campaigns", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  function mockList(rows = [SAMPLE_CAMPAIGN], total = 1) {
    dbQuery
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [{ total: String(total) }] });
  }

  it("returns paginated campaigns with default params", async () => {
    mockList();
    const res = await request(app).get("/campaigns");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].name).toBe("Test Campaign SP");
  });

  it("accepts valid limit values (25, 50, 100, 200)", async () => {
    for (const limit of [25, 50, 100, 200]) {
      mockList([SAMPLE_CAMPAIGN], 1);
      const res = await request(app).get(`/campaigns?limit=${limit}`);
      expect(res.status).toBe(200);
    }
  });

  it("falls back to limit=100 for invalid limit", async () => {
    mockList();
    const res = await request(app).get("/campaigns?limit=999");
    expect(res.status).toBe(200);
    // query should have been called with params including limit=100
    const callArgs = dbQuery.mock.calls[0][1];
    expect(callArgs).toContain(100);
  });

  it("filters by status when provided", async () => {
    mockList([{ ...SAMPLE_CAMPAIGN, state: "paused" }]);
    const res = await request(app).get("/campaigns?status=paused");
    expect(res.status).toBe(200);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toContain("c.state");
  });

  it("filters by campaign type SP", async () => {
    mockList();
    const res = await request(app).get("/campaigns?type=SP");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("sponsoredProducts");
  });

  it("filters by campaign type SB", async () => {
    mockList();
    const res = await request(app).get("/campaigns?type=SB");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("sponsoredBrands");
  });

  it("filters by campaign type SD", async () => {
    mockList();
    const res = await request(app).get("/campaigns?type=SD");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("sponsoredDisplay");
  });

  it("filters by search term", async () => {
    mockList();
    const res = await request(app).get("/campaigns?search=Test");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("%Test%");
  });

  it("filters by budget range", async () => {
    mockList();
    const res = await request(app).get("/campaigns?budgetMin=10&budgetMax=100");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(10);
    expect(params).toContain(100);
  });

  it("ignores undefined filter values gracefully", async () => {
    mockList();
    const res = await request(app).get("/campaigns?status=undefined&type=all&search=undefined");
    expect(res.status).toBe(200);
  });

  it("returns empty list when no campaigns", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get("/campaigns");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it("sorts by allowed fields (name asc)", async () => {
    mockList();
    const res = await request(app).get("/campaigns?sortBy=name&sortDir=asc");
    expect(res.status).toBe(200);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/ORDER BY.*ASC/i);
  });

  it("handles noSales=true filter", async () => {
    mockList();
    const res = await request(app).get("/campaigns?noSales=true");
    expect(res.status).toBe(200);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toContain("orders_14d,0) = 0");
  });

  it("handles hasMetrics=true filter", async () => {
    mockList();
    const res = await request(app).get("/campaigns?hasMetrics=true");
    expect(res.status).toBe(200);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toContain("clicks,0) > 0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /campaigns
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /campaigns", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const SAMPLE_PROFILE = {
    id: PROF_ID,
    amazon_profile_id: "123456789",
    marketplace_id: "A1PA6795UKMFR9",
    connection_id: "conn-0001",
  };

  const SP_PAYLOAD = {
    profileId: PROF_ID,
    name: "New SP Campaign",
    campaignType: "sponsoredProducts",
    targetingType: "manual",
    dailyBudget: 30,
    startDate: "2026-04-22",
    biddingStrategy: "legacyForSales",
  };

  function mockCreate(campRow) {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_PROFILE] }) // profile lookup
      .mockResolvedValueOnce({ rows: [campRow] });        // INSERT campaign
  }

  it("creates an SP campaign and returns it", async () => {
    const created = { ...SAMPLE_CAMPAIGN, id: "new-camp-id" };
    mockCreate(created);

    const res = await request(app).post("/campaigns").send(SP_PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe("new-camp-id");
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app).post("/campaigns").send({ ...SP_PAYLOAD, name: undefined });
    expect(res.status).toBe(400);
  });

  it("returns 400 when dailyBudget is missing", async () => {
    const res = await request(app).post("/campaigns").send({ ...SP_PAYLOAD, dailyBudget: undefined });
    expect(res.status).toBe(400);
  });

  it("returns 400 when profileId is missing", async () => {
    const res = await request(app).post("/campaigns").send({ ...SP_PAYLOAD, profileId: undefined });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid campaignType", async () => {
    const res = await request(app).post("/campaigns").send({ ...SP_PAYLOAD, campaignType: "INVALID" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when profile not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] }); // profile not found
    const res = await request(app).post("/campaigns").send(SP_PAYLOAD);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/profile not found/i);
  });

  it("creates SB campaign type", async () => {
    const created = { ...SAMPLE_CAMPAIGN, campaign_type: "sponsoredBrands" };
    mockCreate(created);

    const res = await request(app).post("/campaigns").send({ ...SP_PAYLOAD, campaignType: "sponsoredBrands" });
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBeDefined();
  });

  it("creates SD campaign type", async () => {
    const created = { ...SAMPLE_CAMPAIGN, campaign_type: "sponsoredDisplay" };
    mockCreate(created);

    const res = await request(app).post("/campaigns").send({ ...SP_PAYLOAD, campaignType: "sponsoredDisplay" });
    expect(res.status).toBe(200);
  });
});
