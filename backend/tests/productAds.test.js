"use strict";
const request = require("supertest");
const express = require("express");

const WS_ID   = "ws---0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const AD_ID   = "ad---0001-0000-0000-000000000001";
const CAMP_ID = "camp-0001-0000-0000-000000000001";
const AG_ID   = "ag---0001-0000-0000-000000000001";

const SAMPLE_AD = {
  id: AD_ID, amazon_ad_id: "AZ-AD-001",
  asin: "B08N5WRWNW", sku: "SKU-001", state: "enabled",
  ad_group_id: AG_ID, campaign_id: CAMP_ID,
  ad_group_name: "Test AG", product_title: "Test Product",
  brand: "TestBrand", image_url: "https://example.com/img.jpg",
};

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
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
const router = require("../src/routes/productAds");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/product-ads", router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

describe("GET /product-ads", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.resetAllMocks(); });

  it("returns list with pagination", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_AD] })
      .mockResolvedValueOnce({ rows: [{ total: "1" }] });
    const res = await request(app).get("/product-ads");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].asin).toBe("B08N5WRWNW");
  });

  it("filters by campaignId", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get(`/product-ads?campaignId=${CAMP_ID}`);
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(CAMP_ID);
  });

  it("filters by adGroupId", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get(`/product-ads?adGroupId=${AG_ID}`);
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(AG_ID);
  });

  it("filters by state", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get("/product-ads?state=paused");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("paused");
  });

  it("returns empty array when no ads", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get("/product-ads");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it("returns multiple ads", async () => {
    const ad2 = { ...SAMPLE_AD, id: "ad---0002-0000-0000-000000000002", asin: "B07XYZ12345" };
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_AD, ad2] })
      .mockResolvedValueOnce({ rows: [{ total: "2" }] });
    const res = await request(app).get("/product-ads");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
  });
});
