"use strict";
/**
 * Analytics Report Routes — comprehensive test suite
 *
 * Covers:
 *   GET  /analytics-report/config        — returns list; empty array when none
 *   POST /analytics-report/config        — 400 when asin missing; upserts and returns row
 *   GET  /analytics-report/data          — returns {rows, summary, start, end};
 *                                          calls buildReportData (4 DB queries)
 *   POST /analytics-report/sync-products — seeds sku_mapping from products; returns count
 *   POST /analytics-report/config/bulk   — 400 when rows missing; inserts each row
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID   = "ws---0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";

const SAMPLE_SKU_ROW = {
  id: "sku-001",
  asin: "B01MFAUXDD",
  sku: "SKU-001",
  label: 1,
  product_name: "Test Product",
  cogs_per_unit: 5.00,
  shipping_per_unit: 1.50,
  amazon_fee_pct: -0.15,
  vat_pct: -0.19,
  google_ads_weekly: 0,
  facebook_ads_weekly: 0,
  sellable_quota: 0,
  workspace_id: WS_ID,
  is_active: true,
};

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("exceljs", () => {
  const mockWorksheet = {
    addRow: jest.fn(),
    getRow: jest.fn(() => ({
      eachCell: jest.fn(),
      height: 0,
    })),
    getColumn: jest.fn(() => ({ width: 0 })),
    views: [],
    autoFilter: null,
  };
  return {
    Workbook: jest.fn().mockImplementation(() => ({
      addWorksheet: jest.fn(() => mockWorksheet),
      creator: "",
      created: null,
      xlsx: { write: jest.fn().mockResolvedValue(undefined) },
    })),
  };
});
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
const analyticsRouter   = require("../src/routes/analyticsReport");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/analytics-report", analyticsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

/**
 * Mock the 4 DB calls made by buildReportData():
 *   1. sku_mapping SELECT
 *   2. fact_metrics_daily JOIN campaigns (ASIN regex)
 *   3. bsr_snapshots LATERAL JOIN
 *   4. products SELECT
 */
function mockBuildReportData({
  skuRows    = [],
  metrics    = [],
  bsr        = [],
  products   = [],
} = {}) {
  dbQuery
    .mockResolvedValueOnce({ rows: skuRows })   // sku_mapping
    .mockResolvedValueOnce({ rows: metrics })   // fact_metrics_daily
    .mockResolvedValueOnce({ rows: bsr })       // bsr_snapshots
    .mockResolvedValueOnce({ rows: products }); // products
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /analytics-report/config
// ═════════════════════════════════════════════════════════════════════════════
describe("GET /analytics-report/config", () => {
  test("returns list of active SKU mappings for workspace", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_SKU_ROW] });

    const res = await request(buildApp()).get("/analytics-report/config");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].asin).toBe("B01MFAUXDD");

    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/sku_mapping/);
    expect(params[0]).toBe(WS_ID);
  });

  test("returns empty array when no mappings configured", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp()).get("/analytics-report/config");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("propagates DB errors as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("DB error"));
    const res = await request(buildApp()).get("/analytics-report/config");
    expect(res.status).toBe(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  POST /analytics-report/config
// ═════════════════════════════════════════════════════════════════════════════
describe("POST /analytics-report/config", () => {
  test("returns 400 when asin is missing", async () => {
    const res = await request(buildApp())
      .post("/analytics-report/config")
      .send({ sku: "SKU-001", label: 1 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/asin required/i);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  test("upserts and returns the created/updated row", async () => {
    const returnedRow = { ...SAMPLE_SKU_ROW, updated_at: new Date().toISOString() };
    dbQuery.mockResolvedValueOnce({ rows: [returnedRow] });

    const payload = {
      asin: "B01MFAUXDD",
      sku: "SKU-001",
      label: 1,
      product_name: "Test Product",
      cogs_per_unit: 5.00,
      shipping_per_unit: 1.50,
      amazon_fee_pct: -0.15,
      vat_pct: -0.19,
      google_ads_weekly: 0,
      facebook_ads_weekly: 0,
      sellable_quota: 0,
    };

    const res = await request(buildApp())
      .post("/analytics-report/config")
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.asin).toBe("B01MFAUXDD");
    expect(res.body.sku).toBe("SKU-001");

    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO sku_mapping/);
    expect(sql).toMatch(/ON CONFLICT.*DO UPDATE/s);
    expect(params[0]).toBe(WS_ID);
    expect(params[1]).toBe("B01MFAUXDD");
  });

  test("uses default values for optional numeric fields", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_SKU_ROW] });

    await request(buildApp())
      .post("/analytics-report/config")
      .send({ asin: "B01MFAUXDD" });

    const params = dbQuery.mock.calls[0][1];
    // cogs_per_unit default = 0, amazon_fee_pct default = -0.15, vat_pct default = -0.19
    expect(params[5]).toBe(0);      // cogs_per_unit
    expect(params[6]).toBe(0);      // shipping_per_unit
    expect(params[7]).toBe(-0.15);  // amazon_fee_pct
    expect(params[8]).toBe(-0.19);  // vat_pct
  });

  test("propagates DB errors as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("constraint error"));
    const res = await request(buildApp())
      .post("/analytics-report/config")
      .send({ asin: "B01MFAUXDD" });
    expect(res.status).toBe(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /analytics-report/data
// ═════════════════════════════════════════════════════════════════════════════
describe("GET /analytics-report/data", () => {
  test("returns {rows, summary, start, end} shape with no data", async () => {
    mockBuildReportData(); // all empty

    const res = await request(buildApp()).get("/analytics-report/data");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("rows");
    expect(res.body).toHaveProperty("summary");
    expect(res.body).toHaveProperty("start");
    expect(res.body).toHaveProperty("end");
    expect(Array.isArray(res.body.rows)).toBe(true);
    expect(Array.isArray(res.body.summary)).toBe(true);
  });

  test("aggregates SP/SD/SB spend correctly per ASIN", async () => {
    mockBuildReportData({
      skuRows: [
        {
          asin: "B01MFAUXDD",
          sku: "SKU-001",
          label: 1,
          product_name: "Mushroom Gummies",
          cogs_per_unit: 5,
          shipping_per_unit: 1,
          amazon_fee_pct: -0.15,
          vat_pct: -0.19,
          google_ads_weekly: 0,
          facebook_ads_weekly: 0,
          sellable_quota: 0,
        },
      ],
      metrics: [
        {
          asin: "B01MFAUXDD",
          campaign_type: "sponsoredProducts",
          spend: "100",
          sales: "500",
          units: "50",
          clicks: "200",
          impressions: "10000",
        },
        {
          asin: "B01MFAUXDD",
          campaign_type: "sponsoredDisplay",
          spend: "20",
          sales: "80",
          units: "8",
          clicks: "40",
          impressions: "2000",
        },
      ],
    });

    const res = await request(buildApp()).get("/analytics-report/data");
    expect(res.status).toBe(200);
    const row = res.body.rows.find(r => r.asin === "B01MFAUXDD");
    expect(row).toBeDefined();
    expect(row.sp_spend).toBeCloseTo(100);
    expect(row.sd_spend).toBeCloseTo(20);
    expect(row.total_ads).toBeCloseTo(120);
    expect(row.sales).toBeCloseTo(580);
  });

  test("derives product_name from products table when sku_mapping has none", async () => {
    mockBuildReportData({
      products: [{ asin: "B0NEWPRODUCT", title: "A Great Product" }],
    });

    const res = await request(buildApp()).get("/analytics-report/data");
    expect(res.status).toBe(200);
    const row = res.body.rows.find(r => r.asin === "B0NEWPRODUCT");
    expect(row).toBeDefined();
    expect(row.product_name).toBe("A Great Product");
  });

  test("passes date range from query params to buildReportData", async () => {
    mockBuildReportData();

    await request(buildApp())
      .get("/analytics-report/data?startDate=2026-04-01&endDate=2026-04-30");

    // The second DB call is the metrics query with date range
    const metricsCall = dbQuery.mock.calls[1];
    expect(metricsCall[1][1]).toBe("2026-04-01");
    expect(metricsCall[1][2]).toBe("2026-04-30");
  });

  test("builds label summary grouped by label field", async () => {
    mockBuildReportData({
      skuRows: [
        {
          asin: "B01MFAUXDD", sku: "S1", label: 1, product_name: "P1",
          cogs_per_unit: 5, shipping_per_unit: 0,
          amazon_fee_pct: -0.15, vat_pct: -0.19,
          google_ads_weekly: 0, facebook_ads_weekly: 0, sellable_quota: 0,
        },
        {
          asin: "B0BBBBBBBB", sku: "S2", label: 1, product_name: "P2",
          cogs_per_unit: 3, shipping_per_unit: 0,
          amazon_fee_pct: -0.15, vat_pct: -0.19,
          google_ads_weekly: 0, facebook_ads_weekly: 0, sellable_quota: 0,
        },
      ],
      metrics: [
        { asin: "B01MFAUXDD", campaign_type: "sponsoredProducts", spend: "10", sales: "100", units: "10", clicks: "50", impressions: "1000" },
        { asin: "B0BBBBBBBB", campaign_type: "sponsoredProducts", spend: "5",  sales: "50",  units: "5",  clicks: "20", impressions: "500" },
      ],
    });

    const res = await request(buildApp()).get("/analytics-report/data");
    expect(res.status).toBe(200);
    // Both ASINs have label=1, so summary should have one entry
    expect(res.body.summary).toHaveLength(1);
    expect(res.body.summary[0].label).toBe("1");
    expect(res.body.summary[0].products).toBe(2);
  });

  test("propagates DB errors as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("query failed"));
    const res = await request(buildApp()).get("/analytics-report/data");
    expect(res.status).toBe(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  POST /analytics-report/sync-products
// ═════════════════════════════════════════════════════════════════════════════
describe("POST /analytics-report/sync-products", () => {
  test("inserts new products into sku_mapping and returns counts", async () => {
    const products = [
      { asin: "B01MFAUXDD", title: "Mushroom Gummies" },
      { asin: "B0BBBBBBBB", title: "Vitamin C" },
    ];
    // 1. SELECT products
    dbQuery.mockResolvedValueOnce({ rows: products });
    // 2. INSERT per product — first is new (rowCount=1), second is duplicate (rowCount=0)
    dbQuery.mockResolvedValueOnce({ rowCount: 1 });
    dbQuery.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(buildApp()).post("/analytics-report/sync-products");
    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(2);
    expect(res.body.inserted).toBe(1);

    // Verify the INSERT uses ON CONFLICT DO NOTHING
    const insertCalls = dbQuery.mock.calls.filter(([sql]) =>
      sql.includes("INSERT INTO sku_mapping") && sql.includes("ON CONFLICT")
    );
    expect(insertCalls).toHaveLength(2);
    expect(insertCalls[0][1][1]).toBe("B01MFAUXDD");
    expect(insertCalls[0][1][2]).toBe("Mushroom Gummies");
  });

  test("returns synced=0, inserted=0 when no active products", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(buildApp()).post("/analytics-report/sync-products");
    expect(res.status).toBe(200);
    expect(res.body.synced).toBe(0);
    expect(res.body.inserted).toBe(0);
  });

  test("truncates long product titles to 120 chars", async () => {
    const longTitle = "A".repeat(200);
    dbQuery.mockResolvedValueOnce({ rows: [{ asin: "B0XXXXXXXX", title: longTitle }] });
    dbQuery.mockResolvedValueOnce({ rowCount: 1 });

    await request(buildApp()).post("/analytics-report/sync-products");

    const insertCall = dbQuery.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO sku_mapping")
    );
    expect(insertCall[1][2].length).toBe(120);
  });

  test("uses asin as product_name when title is null", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ asin: "B0XXXXXXXX", title: null }] });
    dbQuery.mockResolvedValueOnce({ rowCount: 1 });

    await request(buildApp()).post("/analytics-report/sync-products");

    const insertCall = dbQuery.mock.calls.find(([sql]) =>
      sql.includes("INSERT INTO sku_mapping")
    );
    expect(insertCall[1][2]).toBe("B0XXXXXXXX");
  });

  test("propagates DB errors as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("DB error"));
    const res = await request(buildApp()).post("/analytics-report/sync-products");
    expect(res.status).toBe(500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  POST /analytics-report/config/bulk
// ═════════════════════════════════════════════════════════════════════════════
describe("POST /analytics-report/config/bulk", () => {
  test("returns 400 when rows array is missing", async () => {
    const res = await request(buildApp())
      .post("/analytics-report/config/bulk")
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/rows array required/i);
  });

  test("returns 400 when rows is an empty array", async () => {
    const res = await request(buildApp())
      .post("/analytics-report/config/bulk")
      .send({ rows: [] });
    expect(res.status).toBe(400);
  });

  test("inserts each valid row and returns inserted count", async () => {
    const rows = [
      { asin: "B01MFAUXDD", sku: "S1", label: 1, product_name: "P1" },
      { asin: "B0BBBBBBBB", sku: "S2", label: 2, product_name: "P2" },
    ];
    dbQuery.mockResolvedValue({ rowCount: 1 });

    const res = await request(buildApp())
      .post("/analytics-report/config/bulk")
      .send({ rows });
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(2);
    expect(dbQuery).toHaveBeenCalledTimes(2);
  });

  test("skips rows without asin", async () => {
    const rows = [
      { sku: "S1", label: 1 },         // no asin — skip
      { asin: "B01MFAUXDD", sku: "S2" }, // valid
    ];
    dbQuery.mockResolvedValue({ rowCount: 1 });

    const res = await request(buildApp())
      .post("/analytics-report/config/bulk")
      .send({ rows });
    expect(res.status).toBe(200);
    expect(res.body.inserted).toBe(1);
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });
});
