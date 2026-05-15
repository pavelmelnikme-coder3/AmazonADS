"use strict";
const request = require("supertest");
const express = require("express");

const WS_ID   = "ws---0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const NT_ID   = "nt---0001-0000-0000-000000000001";
const CAMP_ID = "camp-0001-0000-0000-000000000001";

const SAMPLE_NT = {
  id: NT_ID, expression: [{ type: "ASIN_SAME_AS", value: "B08N5WRWNW" }],
  level: "campaign", campaign_id: CAMP_ID, ad_group_id: null,
  ad_type: "SP", created_at: "2026-01-01T00:00:00.000Z",
  campaign_name: "SP Auto", campaign_type: "sponsoredProducts", ad_group_name: null,
};

const CAMP_CTX = {
  profile_id: "prof-001", campaign_type: "sponsoredProducts",
  amazon_campaign_id: "AMZ001", amazon_profile_id: "12345",
  marketplace_id: "A1PA6795UKMFR9", connection_id: "conn-001",
  amazon_ad_group_id: "AG001",
};

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/routes/audit", () => ({
  writeAudit: jest.fn().mockResolvedValue("audit-id"),
  updateAuditStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/amazon/writeback", () => ({
  pushNegativeAsin: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: USER_ID, name: "Test User", role: "owner", org_id: ORG_ID };
    req.orgId = ORG_ID;
    next();
  },
  requireWorkspace: (req, _res, next) => {
    req.workspaceId = WS_ID; req.workspaceRole = "owner"; next();
  },
}));

const { query: dbQuery } = require("../src/db/pool");
const { pushNegativeAsin } = require("../src/services/amazon/writeback");
const router = require("../src/routes/negativeAsins");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/negative-asins", router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

function resetMocks() {
  jest.resetAllMocks();
  pushNegativeAsin.mockResolvedValue({ ok: true });
}

describe("GET /negative-asins", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns list with asin extracted from expression", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_NT] })
      .mockResolvedValueOnce({ rows: [{ total: "1" }] });
    const res = await request(app).get("/negative-asins");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].asin).toBe("B08N5WRWNW");
    expect(res.body.pagination.total).toBe(1);
  });

  it("filters by search term", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get("/negative-asins?search=B08");
    expect(res.status).toBe(200);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/ILIKE/i);
  });

  it("filters by campaignId", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get(`/negative-asins?campaignId=${CAMP_ID}`);
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(CAMP_ID);
  });

  it("returns empty data when no results", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get("/negative-asins");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe("POST /negative-asins", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("creates a negative ASIN target", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [CAMP_CTX] })
      .mockResolvedValueOnce({ rows: [SAMPLE_NT] });
    const res = await request(app).post("/negative-asins")
      .send({ campaignId: CAMP_ID, asin: "B08N5WRWNW" });
    expect(res.status).toBe(200);
    expect(res.body.data.asin).toBe("B08N5WRWNW");
  });

  it("normalizes ASIN to uppercase", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [CAMP_CTX] })
      .mockResolvedValueOnce({ rows: [SAMPLE_NT] });
    await request(app).post("/negative-asins")
      .send({ campaignId: CAMP_ID, asin: "b08n5wrwnw" });
    const insertParams = dbQuery.mock.calls[1][1];
    expect(JSON.stringify(insertParams)).toContain("B08N5WRWNW");
  });

  it("returns 400 when campaignId missing", async () => {
    const res = await request(app).post("/negative-asins").send({ asin: "B08N5WRWNW" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when asin missing", async () => {
    const res = await request(app).post("/negative-asins").send({ campaignId: CAMP_ID });
    expect(res.status).toBe(400);
  });

  it("returns 404 when campaign not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post("/negative-asins")
      .send({ campaignId: CAMP_ID, asin: "B08N5WRWNW" });
    expect(res.status).toBe(404);
  });

  it("returns null data on conflict", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [CAMP_CTX] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post("/negative-asins")
      .send({ campaignId: CAMP_ID, asin: "B08N5WRWNW" });
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });
});

describe("POST /negative-asins/bulk", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("adds ASINs to multiple campaigns", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [CAMP_CTX] })
      .mockResolvedValueOnce({ rows: [{ id: NT_ID }] });
    const res = await request(app).post("/negative-asins/bulk")
      .send({ asins: ["B08N5WRWNW"], campaignIds: [CAMP_ID] });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    expect(res.body.skipped).toBe(0);
  });

  it("returns 400 when asins missing", async () => {
    const res = await request(app).post("/negative-asins/bulk").send({ campaignIds: [CAMP_ID] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when campaignIds missing", async () => {
    const res = await request(app).post("/negative-asins/bulk").send({ asins: ["B08N5WRWNW"] });
    expect(res.status).toBe(400);
  });

  it("reports error for unknown campaign", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post("/negative-asins/bulk")
      .send({ asins: ["B08N5WRWNW"], campaignIds: [CAMP_ID] });
    expect(res.status).toBe(200);
    expect(res.body.errors).toHaveLength(1);
  });
});

describe("DELETE /negative-asins/bulk", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("deletes multiple negative targets", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_NT] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).delete("/negative-asins/bulk")
      .send({ ids: [NT_ID] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
  });

  it("returns 400 when ids missing", async () => {
    const res = await request(app).delete("/negative-asins/bulk").send({});
    expect(res.status).toBe(400);
  });
});

describe("DELETE /negative-asins/:id", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("deletes negative ASIN and returns success", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_NT] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).delete(`/negative-asins/${NT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("still returns success when not found", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).delete(`/negative-asins/${NT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
