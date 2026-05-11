"use strict";
/**
 * Campaigns routes — comprehensive unit test suite
 *
 * Endpoints:
 *   GET    /campaigns              — list with pagination, filtering, sorting
 *   GET    /campaigns/:id         — single campaign
 *   GET    /campaigns/:id/placement — placement bid adjustments
 *   GET    /campaigns/:id/metrics  — time-series metrics
 *   POST   /campaigns             — create SP/SB/SD campaign
 *   PATCH  /campaigns/:id         — update state/budget/bidding/placements
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID   = "ws---0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const CAMP_ID = "camp-0001-0000-0000-000000000001";
const PROF_ID = "prof-0001-0000-0000-000000000001";

// Shape returned by GET /campaigns list
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
  marketplace_id: "A1PA6795UKMFR9",
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

// Shape returned by DB for PATCH / GET /:id (includes join columns)
const CAMPAIGN_DB_ROW = {
  id: CAMP_ID,
  amazon_campaign_id: "AMZ001",
  name: "Test Campaign SP",
  campaign_type: "sponsoredProducts",
  state: "enabled",
  daily_budget: "50.00",
  bidding_strategy: "legacyForSales",
  amazon_profile_id: "123456789",
  marketplace_id: "A1PA6795UKMFR9",
  connection_id: "conn-0001",
  marketplace: "DE",
  country_code: "DE",
  currency_code: "EUR",
};

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock("../src/routes/audit", () => ({
  writeAudit: jest.fn().mockResolvedValue(undefined),
  updateAuditStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/amazon/adsClient", () => ({
  post: jest.fn().mockResolvedValue({ campaigns: [{ campaignId: 9999 }] }),
  put:  jest.fn().mockResolvedValue({}),
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
const { put: apiPut }    = require("../src/services/amazon/adsClient");
const { writeAudit }     = require("../src/routes/audit");
const campaignsRouter    = require("../src/routes/campaigns");

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

  it("filters by spend range", async () => {
    mockList();
    const res = await request(app).get("/campaigns?spendMin=5&spendMax=200");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(5);
    expect(params).toContain(200);
  });

  it("filters by ACOS range", async () => {
    mockList();
    const res = await request(app).get("/campaigns?acosMin=10&acosMax=30");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(10);
    expect(params).toContain(30);
  });

  it("filters by ROAS range", async () => {
    mockList();
    const res = await request(app).get("/campaigns?roasMin=2&roasMax=8");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(2);
    expect(params).toContain(8);
  });

  it("filters by ordersMin and clicksMin", async () => {
    mockList();
    const res = await request(app).get("/campaigns?ordersMin=5&clicksMin=50");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(5);
    expect(params).toContain(50);
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

  it("falls back to spend sort for unknown sortBy", async () => {
    mockList();
    const res = await request(app).get("/campaigns?sortBy=unknown");
    expect(res.status).toBe(200);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toContain("COALESCE(m.cost,0)");
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

  it("calculates correct page offset", async () => {
    mockList([SAMPLE_CAMPAIGN], 100);
    const res = await request(app).get("/campaigns?page=3&limit=25");
    expect(res.status).toBe(200);
    // offset = (3-1)*25 = 50
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(50);
  });

  it("respects metricsDays parameter (clamps 1–365)", async () => {
    mockList();
    const res = await request(app).get("/campaigns?metricsDays=7");
    expect(res.status).toBe(200);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toContain("8 days");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /campaigns/:id
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /campaigns/:id", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); dbQuery.mockReset(); });

  it("returns campaign when found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [CAMPAIGN_DB_ROW] });
    const res = await request(app).get(`/campaigns/${CAMP_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(CAMP_ID);
    expect(res.body.name).toBe("Test Campaign SP");
  });

  it("returns 404 when campaign not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/campaigns/nonexistent-id`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("enforces workspace isolation (workspace_id in query)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [CAMPAIGN_DB_ROW] });
    await request(app).get(`/campaigns/${CAMP_ID}`);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(WS_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /campaigns/:id/placement
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /campaigns/:id/placement", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); dbQuery.mockReset(); });

  it("reads v3 placement format (dynamicBidding.placementBidding)", async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{
        bidding_strategy: "legacyForSales",
        raw_data: {
          dynamicBidding: {
            placementBidding: [
              { placement: "PLACEMENT_TOP", percentage: 50 },
              { placement: "PLACEMENT_PRODUCT_PAGE", percentage: 25 },
            ],
          },
        },
      }],
    });
    const res = await request(app).get(`/campaigns/${CAMP_ID}/placement`);
    expect(res.status).toBe(200);
    expect(res.body.placementTop).toBe(50);
    expect(res.body.placementProductPage).toBe(25);
    expect(res.body.strategy).toBe("legacyForSales");
  });

  it("reads v2 placement format (bidding.adjustments)", async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{
        bidding_strategy: "legacyForSales",
        raw_data: {
          bidding: {
            adjustments: [
              { predicate: "placementTop", percentage: 30 },
              { predicate: "placementProductPage", percentage: 10 },
            ],
          },
        },
      }],
    });
    const res = await request(app).get(`/campaigns/${CAMP_ID}/placement`);
    expect(res.status).toBe(200);
    expect(res.body.placementTop).toBe(30);
    expect(res.body.placementProductPage).toBe(10);
  });

  it("returns zeros when no placement data exists", async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{ bidding_strategy: "legacyForSales", raw_data: {} }],
    });
    const res = await request(app).get(`/campaigns/${CAMP_ID}/placement`);
    expect(res.status).toBe(200);
    expect(res.body.placementTop).toBe(0);
    expect(res.body.placementProductPage).toBe(0);
  });

  it("prefers v3 format over v2 when both present", async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{
        bidding_strategy: "legacyForSales",
        raw_data: {
          dynamicBidding: {
            placementBidding: [{ placement: "PLACEMENT_TOP", percentage: 99 }],
          },
          bidding: {
            adjustments: [{ predicate: "placementTop", percentage: 1 }],
          },
        },
      }],
    });
    const res = await request(app).get(`/campaigns/${CAMP_ID}/placement`);
    expect(res.status).toBe(200);
    expect(res.body.placementTop).toBe(99);
  });

  it("returns 404 when campaign not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/campaigns/bad-id/placement`);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /campaigns/:id/metrics
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /campaigns/:id/metrics", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); dbQuery.mockReset(); });

  const METRIC_ROWS = [
    { date: "2026-04-01", impressions: 1000, clicks: 30, cost: "10.00", sales: "80.00", orders: 3 },
    { date: "2026-04-02", impressions: 1200, clicks: 40, cost: "12.00", sales: "100.00", orders: 4 },
  ];

  it("returns time-series metrics for found campaign", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ amazon_campaign_id: "AMZ001" }] })
      .mockResolvedValueOnce({ rows: METRIC_ROWS });
    const res = await request(app).get(`/campaigns/${CAMP_ID}/metrics?startDate=2026-04-01&endDate=2026-04-02`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].date).toBe("2026-04-01");
  });

  it("returns 404 when campaign not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/campaigns/bad-id/metrics`);
    expect(res.status).toBe(404);
  });

  it("passes date range to metrics query", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ amazon_campaign_id: "AMZ001" }] })
      .mockResolvedValueOnce({ rows: [] });
    await request(app).get(`/campaigns/${CAMP_ID}/metrics?startDate=2026-01-01&endDate=2026-03-31`);
    const params = dbQuery.mock.calls[1][1];
    expect(params).toContain("2026-01-01");
    expect(params).toContain("2026-03-31");
  });

  it("returns empty array when no metrics in range", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ amazon_campaign_id: "AMZ001" }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get(`/campaigns/${CAMP_ID}/metrics`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /campaigns
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /campaigns", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); dbQuery.mockReset(); });

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
      .mockResolvedValueOnce({ rows: [SAMPLE_PROFILE] })
      .mockResolvedValueOnce({ rows: [campRow] });
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
    expect(res.body.error).toMatch(/name required/i);
  });

  it("returns 400 when name is blank string", async () => {
    const res = await request(app).post("/campaigns").send({ ...SP_PAYLOAD, name: "   " });
    expect(res.status).toBe(400);
  });

  it("returns 400 when dailyBudget is missing", async () => {
    const res = await request(app).post("/campaigns").send({ ...SP_PAYLOAD, dailyBudget: undefined });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/dailyBudget/i);
  });

  it("returns 400 when dailyBudget < 1", async () => {
    const res = await request(app).post("/campaigns").send({ ...SP_PAYLOAD, dailyBudget: 0.5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least 1/i);
  });

  it("returns 400 when dailyBudget is not a number", async () => {
    const res = await request(app).post("/campaigns").send({ ...SP_PAYLOAD, dailyBudget: "free" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when profileId is missing", async () => {
    const res = await request(app).post("/campaigns").send({ ...SP_PAYLOAD, profileId: undefined });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/profileId/i);
  });

  it("returns 400 for invalid campaignType", async () => {
    const res = await request(app).post("/campaigns").send({ ...SP_PAYLOAD, campaignType: "INVALID" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid campaignType/i);
  });

  it("returns 404 when profile not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post("/campaigns").send(SP_PAYLOAD);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/profile not found/i);
  });

  it("creates SB campaign — uses /sb/campaigns endpoint", async () => {
    const created = { ...SAMPLE_CAMPAIGN, campaign_type: "sponsoredBrands" };
    mockCreate(created);
    const { post: apiPost } = require("../src/services/amazon/adsClient");
    const res = await request(app).post("/campaigns").send({ ...SP_PAYLOAD, campaignType: "sponsoredBrands" });
    expect(res.status).toBe(200);
    expect(apiPost.mock.calls[0][0].path).toBe("/sb/campaigns");
  });

  it("creates SD campaign — uses /sd/campaigns endpoint", async () => {
    const created = { ...SAMPLE_CAMPAIGN, campaign_type: "sponsoredDisplay" };
    mockCreate(created);
    const { post: apiPost } = require("../src/services/amazon/adsClient");
    const res = await request(app).post("/campaigns").send({ ...SP_PAYLOAD, campaignType: "sponsoredDisplay" });
    expect(res.status).toBe(200);
    expect(apiPost.mock.calls[0][0].path).toBe("/sd/campaigns");
  });

  it("SP payload uses v3 budget object shape", async () => {
    mockCreate(SAMPLE_CAMPAIGN);
    const { post: apiPost } = require("../src/services/amazon/adsClient");
    await request(app).post("/campaigns").send(SP_PAYLOAD);
    const sentData = apiPost.mock.calls[0][0].data;
    const camp = sentData.campaigns[0];
    expect(camp.budget).toEqual({ budgetType: "DAILY", budget: 30 });
  });

  it("state is sent UPPERCASE to Amazon API", async () => {
    mockCreate(SAMPLE_CAMPAIGN);
    const { post: apiPost } = require("../src/services/amazon/adsClient");
    await request(app).post("/campaigns").send({ ...SP_PAYLOAD, state: "paused" });
    const camp = apiPost.mock.calls[0][0].data.campaigns[0];
    expect(camp.state).toBe("PAUSED");
  });

  it("targetingType is sent UPPERCASE to Amazon API", async () => {
    mockCreate(SAMPLE_CAMPAIGN);
    const { post: apiPost } = require("../src/services/amazon/adsClient");
    await request(app).post("/campaigns").send({ ...SP_PAYLOAD, targetingType: "auto" });
    const camp = apiPost.mock.calls[0][0].data.campaigns[0];
    expect(camp.targetingType).toBe("AUTO");
  });

  it("uses real campaignId from Amazon response", async () => {
    const { post: apiPost } = require("../src/services/amazon/adsClient");
    apiPost.mockResolvedValueOnce({ campaigns: { success: [{ campaignId: 77777 }] } });
    mockCreate(SAMPLE_CAMPAIGN);
    await request(app).post("/campaigns").send(SP_PAYLOAD);
    const insertParams = dbQuery.mock.calls[1][1];
    expect(insertParams).toContain("77777");
  });

  it("Amazon failure is non-fatal — campaign still saved in DB", async () => {
    const { post: apiPost } = require("../src/services/amazon/adsClient");
    apiPost.mockRejectedValueOnce(new Error("Amazon 503"));
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_PROFILE] })
      .mockResolvedValueOnce({ rows: [SAMPLE_CAMPAIGN] });
    const res = await request(app).post("/campaigns").send(SP_PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it("writes audit event after create", async () => {
    mockCreate(SAMPLE_CAMPAIGN);
    await request(app).post("/campaigns").send(SP_PAYLOAD);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "campaign.created" })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PATCH /campaigns/:id
// ─────────────────────────────────────────────────────────────────────────────
describe("PATCH /campaigns/:id", () => {
  let app;
  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    // clearAllMocks does NOT clear the mockResolvedValueOnce queue — reset it explicitly
    dbQuery.mockReset();
    apiPut.mockReset();
    apiPut.mockResolvedValue({});
    writeAudit.mockResolvedValue(undefined);
  });

  function mockPatch(campRow = CAMPAIGN_DB_ROW) {
    dbQuery
      .mockResolvedValueOnce({ rows: [campRow] }) // SELECT campaign
      .mockResolvedValueOnce({ rows: [] });         // UPDATE campaign
  }

  // Helper for ops that don't trigger an UPDATE (biddingStrategy-only, placements-only)
  function mockPatchNoUpdate(campRow = CAMPAIGN_DB_ROW) {
    dbQuery.mockResolvedValueOnce({ rows: [campRow] }); // SELECT only
  }

  it("updates state — calls Amazon PUT and updates DB", async () => {
    mockPatch();
    const res = await request(app)
      .patch(`/campaigns/${CAMP_ID}`)
      .send({ state: "paused" });
    expect(res.status).toBe(200);
    expect(res.body.after.state).toBe("paused");
    expect(apiPut).toHaveBeenCalledTimes(1);
    expect(apiPut.mock.calls[0][0].path).toBe("/sp/campaigns");
  });

  it("sends uppercase state to Amazon API", async () => {
    mockPatch();
    await request(app).patch(`/campaigns/${CAMP_ID}`).send({ state: "paused" });
    const payload = apiPut.mock.calls[0][0].data[0];
    expect(payload.state).toBe("PAUSED");
  });

  it("updates dailyBudget — SP uses flat dailyBudget field", async () => {
    mockPatch();
    const res = await request(app).patch(`/campaigns/${CAMP_ID}`).send({ dailyBudget: 75 });
    expect(res.status).toBe(200);
    expect(res.body.after.dailyBudget).toBe(75);
    const payload = apiPut.mock.calls[0][0].data[0];
    expect(payload.dailyBudget).toBe(75);
    expect(payload.budget).toBeUndefined();
  });

  it("SB campaign — budget uses nested budget object", async () => {
    mockPatch({ ...CAMPAIGN_DB_ROW, campaign_type: "sponsoredBrands" });
    const res = await request(app).patch(`/campaigns/${CAMP_ID}`).send({ dailyBudget: 60 });
    expect(res.status).toBe(200);
    const payload = apiPut.mock.calls[0][0].data[0];
    expect(payload.budget).toEqual({ budget: 60, budgetType: "DAILY" });
    expect(payload.dailyBudget).toBeUndefined();
  });

  it("SD campaign — budget uses nested budget object", async () => {
    mockPatch({ ...CAMPAIGN_DB_ROW, campaign_type: "sponsoredDisplay" });
    const res = await request(app).patch(`/campaigns/${CAMP_ID}`).send({ dailyBudget: 40 });
    expect(res.status).toBe(200);
    const payload = apiPut.mock.calls[0][0].data[0];
    expect(payload.budget).toEqual({ budget: 40, budgetType: "DAILY" });
  });

  it("SB campaign — uses /sb/campaigns endpoint", async () => {
    mockPatch({ ...CAMPAIGN_DB_ROW, campaign_type: "sponsoredBrands" });
    await request(app).patch(`/campaigns/${CAMP_ID}`).send({ state: "paused" });
    expect(apiPut.mock.calls[0][0].path).toBe("/sb/campaigns");
  });

  it("SD campaign — uses /sd/campaigns endpoint", async () => {
    mockPatch({ ...CAMPAIGN_DB_ROW, campaign_type: "sponsoredDisplay" });
    await request(app).patch(`/campaigns/${CAMP_ID}`).send({ state: "paused" });
    expect(apiPut.mock.calls[0][0].path).toBe("/sd/campaigns");
  });

  it("updates biddingStrategy in Amazon payload", async () => {
    mockPatchNoUpdate(); // biddingStrategy alone does not trigger DB UPDATE
    await request(app).patch(`/campaigns/${CAMP_ID}`).send({ biddingStrategy: "autoForSales" });
    const payload = apiPut.mock.calls[0][0].data[0];
    expect(payload.bidding).toEqual({ strategy: "autoForSales" });
  });

  it("placements-only update is fire-and-forget (non-fatal path)", async () => {
    mockPatchNoUpdate(); // placements-only: no state/budget → no DB UPDATE
    const res = await request(app).patch(`/campaigns/${CAMP_ID}`).send({
      placements: [{ predicate: "placementTop", percentage: 50 }],
    });
    expect(res.status).toBe(200);
    expect(apiPut).toHaveBeenCalledTimes(1);
  });

  it("placements with biddingStrategy are included in bidding object", async () => {
    mockPatchNoUpdate(); // placements+strategy: no state/budget → no DB UPDATE
    await request(app).patch(`/campaigns/${CAMP_ID}`).send({
      biddingStrategy: "legacyForSales",
      placements: [{ predicate: "placementTop", percentage: 30 }],
    });
    const payload = apiPut.mock.calls[0][0].data[0];
    expect(payload.bidding.strategy).toBe("legacyForSales");
    expect(payload.bidding.adjustments[0].predicate).toBe("placementTop");
    expect(payload.bidding.adjustments[0].percentage).toBe(30);
  });

  it("placement percentage is clamped to 0–900", async () => {
    mockPatchNoUpdate();
    await request(app).patch(`/campaigns/${CAMP_ID}`).send({
      placements: [{ predicate: "placementTop", percentage: 9999 }],
    });
    const payload = apiPut.mock.calls[0][0].data[0];
    expect(payload.bidding.adjustments[0].percentage).toBe(900);
  });

  it("returns 400 for invalid state value", async () => {
    const res = await request(app).patch(`/campaigns/${CAMP_ID}`).send({ state: "INVALID" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/state must be/i);
  });

  it("returns 404 when campaign not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).patch(`/campaigns/${CAMP_ID}`).send({ state: "paused" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("Amazon failure propagates as 500 (required API call)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [CAMPAIGN_DB_ROW] });
    apiPut.mockRejectedValueOnce(new Error("Amazon 503"));
    const res = await request(app).patch(`/campaigns/${CAMP_ID}`).send({ state: "paused" });
    expect(res.status).toBe(500);
  });

  it("writes audit event after patch", async () => {
    mockPatch();
    await request(app).patch(`/campaigns/${CAMP_ID}`).send({ state: "paused" });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "campaign.update" })
    );
  });

  it("before/after shape is correct in response", async () => {
    mockPatch({ ...CAMPAIGN_DB_ROW, state: "enabled", daily_budget: "50.00" });
    const res = await request(app).patch(`/campaigns/${CAMP_ID}`).send({ state: "paused", dailyBudget: 60 });
    expect(res.status).toBe(200);
    expect(res.body.before).toEqual({ state: "enabled", dailyBudget: "50.00" });
    expect(res.body.after).toEqual({ state: "paused", dailyBudget: 60 });
  });

  it("does not call UPDATE when no mutable fields provided", async () => {
    mockPatchNoUpdate(); // biddingStrategy-only: SELECT but no UPDATE
    await request(app).patch(`/campaigns/${CAMP_ID}`).send({ biddingStrategy: "autoForSales" });
    // Only 1 DB call (SELECT), no UPDATE
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });
});
