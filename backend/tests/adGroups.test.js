"use strict";
/**
 * Ad Groups routes — comprehensive unit test suite
 *
 * Endpoints:
 *   GET   /ad-groups        — list with metrics, filters, sorting
 *   POST  /ad-groups        — create ad group in a campaign
 *   PATCH /ad-groups/:id    — update state and/or defaultBid
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID   = "ws---0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const CAMP_ID = "camp-0001-0000-0000-000000000001";
const AG_ID   = "ag---0001-0000-0000-000000000001";

const SAMPLE_AG = {
  id: AG_ID,
  workspace_id: WS_ID,
  amazon_ag_id: "AZ-AG-001",
  name: "Test Ad Group",
  state: "enabled",
  default_bid: "0.80",
  campaign_id: CAMP_ID,
  campaign_name: "Test Campaign SP",
  campaign_type: "sponsoredProducts",
  targeting_type: "MANUAL",
  keyword_count: 5,
  target_count: 0,
  spend: "30.00",
  sales: "120.00",
  clicks: 100,
  impressions: 5000,
  orders: 4,
  acos: "25.00",
  roas: "4.00",
};

// Campaign row returned when creating an ad group
const CAMP_DB_ROW = {
  id: CAMP_ID,
  amazon_campaign_id: "AMZ001",
  campaign_type: "sponsoredProducts",
  profile_db_id: "prof-0001",
  amazon_profile_id: "123456789",
  connection_id: "conn-0001",
  marketplace_id: "A1PA6795UKMFR9",
};

// Ad group row returned by PATCH SELECT
const AG_DB_ROW = {
  id: AG_ID,
  amazon_ag_id: "AZ-AG-001",
  name: "Test Ad Group",
  state: "enabled",
  default_bid: "0.80",
  campaign_type: "sponsoredProducts",
  amazon_profile_id: "123456789",
  marketplace_id: "A1PA6795UKMFR9",
  connection_id: "conn-0001",
};

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn(), withTransaction: jest.fn() }));
jest.mock("../src/routes/audit", () => ({
  writeAudit: jest.fn().mockResolvedValue(undefined),
  updateAuditStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/amazon/adsClient", () => ({
  post: jest.fn().mockResolvedValue({ adGroups: { success: [{ adGroupId: 8888 }] } }),
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
const { post: apiPost, put: apiPut } = require("../src/services/amazon/adsClient");
const { writeAudit } = require("../src/routes/audit");
const adGroupsRouter = require("../src/routes/adGroups");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/ad-groups", adGroupsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /ad-groups
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /ad-groups", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  function mockList(rows = [SAMPLE_AG], total = 1) {
    // GET /ad-groups does Promise.all([listQuery, countQuery])
    dbQuery
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [{ total: String(total) }] });
  }

  it("returns paginated ad groups with defaults", async () => {
    mockList();
    const res = await request(app).get("/ad-groups");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].name).toBe("Test Ad Group");
  });

  it("filters by campaignId", async () => {
    mockList();
    const res = await request(app).get(`/ad-groups?campaignId=${CAMP_ID}`);
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(CAMP_ID);
  });

  it("filters by state", async () => {
    mockList([{ ...SAMPLE_AG, state: "paused" }]);
    const res = await request(app).get("/ad-groups?state=paused");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("paused");
  });

  it("ignores state=all", async () => {
    mockList();
    const res = await request(app).get("/ad-groups?state=all");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).not.toContain("all");
  });

  it("filters by search term (ILIKE)", async () => {
    mockList();
    const res = await request(app).get("/ad-groups?search=Alpha");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("%Alpha%");
  });

  it("returns empty list when no ad groups", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get("/ad-groups");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it("sorts by name asc", async () => {
    mockList();
    const res = await request(app).get("/ad-groups?sortBy=name&sortDir=asc");
    expect(res.status).toBe(200);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/ORDER BY.*ag\.name.*ASC/i);
  });

  it("paginates correctly (page 2, limit 10)", async () => {
    mockList([SAMPLE_AG], 50);
    const res = await request(app).get("/ad-groups?page=2&limit=10");
    expect(res.status).toBe(200);
    // offset = (2-1)*10 = 10
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(10);
  });

  it("clamps limit at 1000", async () => {
    mockList();
    const res = await request(app).get("/ad-groups?limit=9999");
    expect(res.status).toBe(200);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toContain("LIMIT 1000");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /ad-groups
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /ad-groups", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const AG_PAYLOAD = {
    campaignId: CAMP_ID,
    name: "New Ad Group",
    defaultBid: 0.75,
  };

  function mockCreate(agRow = SAMPLE_AG) {
    dbQuery
      .mockResolvedValueOnce({ rows: [CAMP_DB_ROW] }) // campaign SELECT
      .mockResolvedValueOnce({ rows: [agRow] });        // INSERT ad_group
  }

  it("creates an ad group and returns it", async () => {
    mockCreate();
    const res = await request(app).post("/ad-groups").send(AG_PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe("Test Ad Group");
    expect(res.body.data.keyword_count).toBe(0);
    expect(res.body.data.target_count).toBe(0);
  });

  it("returns 400 when campaignId is missing", async () => {
    const res = await request(app).post("/ad-groups").send({ name: "Test" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/campaignId.*name required/i);
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app).post("/ad-groups").send({ campaignId: CAMP_ID });
    expect(res.status).toBe(400);
  });

  it("returns 400 when name is blank", async () => {
    const res = await request(app).post("/ad-groups").send({ campaignId: CAMP_ID, name: "  " });
    expect(res.status).toBe(400);
  });

  it("returns 404 when campaign not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post("/ad-groups").send(AG_PAYLOAD);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/campaign not found/i);
  });

  it("clamps defaultBid to minimum 0.02", async () => {
    mockCreate();
    await request(app).post("/ad-groups").send({ ...AG_PAYLOAD, defaultBid: 0.001 });
    const insertParams = dbQuery.mock.calls[1][1];
    expect(insertParams).toContain(0.02);
  });

  it("defaults defaultBid to 0.50 when not provided", async () => {
    mockCreate();
    await request(app).post("/ad-groups").send({ campaignId: CAMP_ID, name: "Test" });
    const insertParams = dbQuery.mock.calls[1][1];
    expect(insertParams).toContain(0.5);
  });

  it("SP campaign uses /sp/adGroups endpoint", async () => {
    mockCreate();
    await request(app).post("/ad-groups").send(AG_PAYLOAD);
    expect(apiPost.mock.calls[0][0].path).toBe("/sp/adGroups");
  });

  it("SB campaign uses /sb/adGroups endpoint", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ ...CAMP_DB_ROW, campaign_type: "sponsoredBrands" }] })
      .mockResolvedValueOnce({ rows: [SAMPLE_AG] });
    await request(app).post("/ad-groups").send(AG_PAYLOAD);
    expect(apiPost.mock.calls[0][0].path).toBe("/sb/adGroups");
  });

  it("SD campaign uses /sd/adGroups endpoint", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ ...CAMP_DB_ROW, campaign_type: "sponsoredDisplay" }] })
      .mockResolvedValueOnce({ rows: [SAMPLE_AG] });
    await request(app).post("/ad-groups").send(AG_PAYLOAD);
    expect(apiPost.mock.calls[0][0].path).toBe("/sd/adGroups");
  });

  it("Amazon payload has state=ENABLED", async () => {
    mockCreate();
    await request(app).post("/ad-groups").send(AG_PAYLOAD);
    const agPayload = apiPost.mock.calls[0][0].data.adGroups[0];
    expect(agPayload.state).toBe("ENABLED");
  });

  it("uses real adGroupId from Amazon response", async () => {
    apiPost.mockResolvedValueOnce({ adGroups: { success: [{ adGroupId: 55555 }] } });
    dbQuery
      .mockResolvedValueOnce({ rows: [CAMP_DB_ROW] })
      .mockResolvedValueOnce({ rows: [SAMPLE_AG] });
    await request(app).post("/ad-groups").send(AG_PAYLOAD);
    const insertParams = dbQuery.mock.calls[1][1];
    expect(insertParams).toContain("55555");
  });

  it("Amazon failure is non-fatal — ad group still saved in DB", async () => {
    apiPost.mockRejectedValueOnce(new Error("Amazon 503"));
    dbQuery
      .mockResolvedValueOnce({ rows: [CAMP_DB_ROW] })
      .mockResolvedValueOnce({ rows: [SAMPLE_AG] });
    const res = await request(app).post("/ad-groups").send(AG_PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it("writes audit event after create", async () => {
    mockCreate();
    await request(app).post("/ad-groups").send(AG_PAYLOAD);
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ad_group.created" })
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PATCH /ad-groups/:id
// ─────────────────────────────────────────────────────────────────────────────
describe("PATCH /ad-groups/:id", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  function mockPatch(agRow = AG_DB_ROW) {
    dbQuery
      .mockResolvedValueOnce({ rows: [agRow] }) // SELECT ag
      .mockResolvedValueOnce({ rows: [] });       // UPDATE ag
  }

  it("updates state to paused", async () => {
    mockPatch();
    const res = await request(app).patch(`/ad-groups/${AG_ID}`).send({ state: "paused" });
    expect(res.status).toBe(200);
    expect(res.body.after.state).toBe("paused");
  });

  it("sends uppercase state to Amazon API", async () => {
    mockPatch();
    await request(app).patch(`/ad-groups/${AG_ID}`).send({ state: "paused" });
    const payload = apiPut.mock.calls[0][0].data.adGroups[0];
    expect(payload.state).toBe("PAUSED");
  });

  it("updates defaultBid", async () => {
    mockPatch();
    const res = await request(app).patch(`/ad-groups/${AG_ID}`).send({ defaultBid: 1.20 });
    expect(res.status).toBe(200);
    expect(res.body.after.defaultBid).toBe(1.20);
    const payload = apiPut.mock.calls[0][0].data.adGroups[0];
    expect(payload.defaultBid).toBe(1.20);
  });

  it("updates both state and defaultBid in one call", async () => {
    mockPatch();
    const res = await request(app).patch(`/ad-groups/${AG_ID}`).send({ state: "paused", defaultBid: 0.60 });
    expect(res.status).toBe(200);
    expect(res.body.after.state).toBe("paused");
    expect(res.body.after.defaultBid).toBe(0.60);
  });

  it("returns 400 for invalid state", async () => {
    const res = await request(app).patch(`/ad-groups/${AG_ID}`).send({ state: "INVALID" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/state must be/i);
  });

  it("returns 400 when defaultBid < 0.02", async () => {
    const res = await request(app).patch(`/ad-groups/${AG_ID}`).send({ defaultBid: 0.01 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/0\.02/);
  });

  it("returns 400 when defaultBid is not a number", async () => {
    const res = await request(app).patch(`/ad-groups/${AG_ID}`).send({ defaultBid: "free" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when ad group not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).patch(`/ad-groups/${AG_ID}`).send({ state: "paused" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("SB ad group uses /sb/adGroups endpoint", async () => {
    mockPatch({ ...AG_DB_ROW, campaign_type: "sponsoredBrands" });
    await request(app).patch(`/ad-groups/${AG_ID}`).send({ state: "paused" });
    expect(apiPut.mock.calls[0][0].path).toBe("/sb/adGroups");
  });

  it("SD ad group uses /sd/adGroups endpoint", async () => {
    mockPatch({ ...AG_DB_ROW, campaign_type: "sponsoredDisplay" });
    await request(app).patch(`/ad-groups/${AG_ID}`).send({ state: "paused" });
    expect(apiPut.mock.calls[0][0].path).toBe("/sd/adGroups");
  });

  it("Amazon failure is non-fatal — response is still 200 ok", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [AG_DB_ROW] })
      .mockResolvedValueOnce({ rows: [] });
    apiPut.mockRejectedValueOnce(new Error("Amazon timeout"));
    const res = await request(app).patch(`/ad-groups/${AG_ID}`).send({ state: "paused" });
    expect(res.status).toBe(200);
  });

  it("before/after shape is correct", async () => {
    mockPatch({ ...AG_DB_ROW, state: "enabled", default_bid: "0.80" });
    const res = await request(app).patch(`/ad-groups/${AG_ID}`).send({ state: "paused", defaultBid: 1.00 });
    expect(res.status).toBe(200);
    expect(res.body.before).toEqual({ state: "enabled", defaultBid: "0.80" });
    expect(res.body.after).toEqual({ state: "paused", defaultBid: 1.00 });
  });

  it("writes audit event after patch", async () => {
    mockPatch();
    await request(app).patch(`/ad-groups/${AG_ID}`).send({ state: "paused" });
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "ad_group.update" })
    );
  });
});
