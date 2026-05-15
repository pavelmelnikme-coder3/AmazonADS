"use strict";
const request = require("supertest");
const express = require("express");

const WS_ID   = "ws---0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const TGT_ID  = "tgt--0001-0000-0000-000000000001";
const AG_ID   = "ag---0001-0000-0000-000000000001";
const CAMP_ID = "camp-0001-0000-0000-000000000001";

const SAMPLE_TARGET = {
  id: TGT_ID, amazon_target_id: "AZ-TGT-001",
  ad_type: "SP", expression_type: "asinSameAs",
  expression: [{ type: "asinSameAs", value: "B08N5WRWNW" }],
  resolved_expression: [{ type: "asinSameAs", value: "B08N5WRWNW" }],
  state: "enabled", bid: 0.75,
  campaign_id: CAMP_ID, ad_group_id: AG_ID,
  ad_group_name: "Test AG", campaign_type: "sponsoredProducts",
  amazon_profile_id: "12345", marketplace_id: "A1PA6795UKMFR9",
  connection_id: "conn-001",
  impressions: 1000, clicks: 50, spend: 20.0, sales: 80.0, orders: 3,
  acos: 25.0, roas: 4.0, cpc: 0.4,
};

const AG_ROW = {
  id: AG_ID, amazon_ag_id: "AZ-AG-001", campaign_id: CAMP_ID,
  amazon_campaign_id: "AMZ001", campaign_type: "sponsoredProducts",
  profile_db_id: "prof-001", amazon_profile_id: "12345",
  connection_id: "conn-001", marketplace_id: "A1PA6795UKMFR9",
};

const FULL_TGT_ROW = {
  ...SAMPLE_TARGET,
  ad_type: "SP",
};

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/routes/audit", () => ({
  writeAudit: jest.fn().mockResolvedValue("audit-id"),
}));
jest.mock("../src/services/amazon/adsClient", () => ({
  put: jest.fn().mockResolvedValue({}),
  post: jest.fn().mockResolvedValue({ targets: { success: [{ targetId: "AZ-NEW-001" }] } }),
}));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: USER_ID, name: "Test User", role: "owner", org_id: ORG_ID };
    req.orgId = ORG_ID; next();
  },
  requireWorkspace: (req, _res, next) => {
    req.workspaceId = WS_ID; req.workspaceRole = "owner"; next();
  },
}));

const { query: dbQuery } = require("../src/db/pool");
const { put: apiPut, post: apiPost } = require("../src/services/amazon/adsClient");
const router = require("../src/routes/targets");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/targets", router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

function resetMocks() {
  jest.resetAllMocks();
  apiPut.mockResolvedValue({});
  apiPost.mockResolvedValue({ targets: { success: [{ targetId: "AZ-NEW-001" }] } });
}

describe("GET /targets", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns targets list with pagination", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_TARGET] })
      .mockResolvedValueOnce({ rows: [{ total: "1" }] });
    const res = await request(app).get("/targets");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
  });

  it("filters by campaignId", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get(`/targets?campaignId=${CAMP_ID}`);
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(CAMP_ID);
  });

  it("filters by expressionType", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get("/targets?expressionType=asinSameAs");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("asinSameAs");
  });

  it("filters by state", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get("/targets?state=paused");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("paused");
  });

  it("returns empty array when no targets", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get("/targets");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe("POST /targets", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("creates a target and returns it", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [AG_ROW] })
      .mockResolvedValueOnce({ rows: [SAMPLE_TARGET] });
    const res = await request(app).post("/targets")
      .send({ adGroupId: AG_ID, expressionValue: "B08N5WRWNW" });
    expect(res.status).toBe(200);
    expect(res.body.data).toBeDefined();
  });

  it("returns 400 when adGroupId missing", async () => {
    const res = await request(app).post("/targets").send({ expressionValue: "B08N5WRWNW" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when expressionValue missing", async () => {
    const res = await request(app).post("/targets").send({ adGroupId: AG_ID });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid expressionType", async () => {
    const res = await request(app).post("/targets")
      .send({ adGroupId: AG_ID, expressionValue: "B08N5WRWNW", expressionType: "invalidType" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when ad group not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post("/targets")
      .send({ adGroupId: AG_ID, expressionValue: "B08N5WRWNW" });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /targets/bulk", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("bulk-updates targets state", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: TGT_ID }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).patch("/targets/bulk")
      .send({ updates: [{ id: TGT_ID, state: "paused" }] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
  });

  it("returns 400 when updates missing", async () => {
    const res = await request(app).patch("/targets/bulk").send({});
    expect(res.status).toBe(400);
  });

  it("skips unknown target ids", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).patch("/targets/bulk")
      .send({ updates: [{ id: TGT_ID, state: "paused" }] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
  });
});

describe("PATCH /targets/:id", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("updates target state", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [FULL_TGT_ROW] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).patch(`/targets/${TGT_ID}`)
      .send({ state: "paused" });
    expect(res.status).toBe(200);
    expect(res.body.after.state).toBe("paused");
  });

  it("updates target bid", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [FULL_TGT_ROW] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).patch(`/targets/${TGT_ID}`)
      .send({ bid: 1.25 });
    expect(res.status).toBe(200);
    expect(res.body.after.bid).toBe(1.25);
  });

  it("returns 400 for invalid state", async () => {
    const res = await request(app).patch(`/targets/${TGT_ID}`)
      .send({ state: "invalid" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for bid below 0.02", async () => {
    const res = await request(app).patch(`/targets/${TGT_ID}`)
      .send({ bid: 0.01 });
    expect(res.status).toBe(400);
  });

  it("returns 404 when target not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).patch(`/targets/${TGT_ID}`)
      .send({ state: "paused" });
    expect(res.status).toBe(404);
  });
});
