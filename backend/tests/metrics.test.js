"use strict";
const request = require("supertest");
const express = require("express");

const WS_ID  = "ws---0001-0000-0000-000000000001";
const ORG_ID = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";

const SAMPLE_TOTALS = {
  impressions: "50000", clicks: "1000", spend: "500.00",
  sales_14d: "2000.00", orders_14d: "80",
  ctr: "0.02", cpc: "0.50", acos_14d: "25.00", roas_14d: "4.00",
};
const SAMPLE_TREND = [
  { date: "2026-04-20", impressions: "7000", clicks: "140", spend: "70.00",
    sales_14d: "280.00", orders_14d: "12", ctr: "0.02", cpc: "0.50", acos: "25.00", roas: "4.00",
    total_revenue: null, tacos: null },
];
const SAMPLE_PREV = { spend: "450.00", sales_14d: "1800.00", acos_14d: "25.00", roas_14d: "4.00" };

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/jobs/workers", () => ({
  queueMetricsBackfill: jest.fn().mockResolvedValue({ id: "job-backfill-1" }),
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
const { queueMetricsBackfill } = require("../src/jobs/workers");
const router = require("../src/routes/metrics");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/metrics", router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

function resetMocks() {
  jest.resetAllMocks();
  queueMetricsBackfill.mockResolvedValue({ id: "job-backfill-1" });
}

describe("GET /metrics/summary", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  function mockSummaryQueries({ spInfo = null } = {}) {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_TOTALS] })    // totals
      .mockResolvedValueOnce({ rows: SAMPLE_TREND })        // trend
      .mockResolvedValueOnce({ rows: [SAMPLE_PREV] })       // prev period
      .mockResolvedValueOnce({ rows: [spInfo || { total_revenue: null }] }); // sp_orders for tacos
  }

  it("returns totals, trend, deltas", async () => {
    mockSummaryQueries();
    const res = await request(app).get("/metrics/summary?startDate=2026-04-14&endDate=2026-04-20");
    expect(res.status).toBe(200);
    expect(res.body.totals).toBeDefined();
    expect(res.body.trend).toHaveLength(1);
    expect(res.body.deltas).toBeDefined();
    expect(res.body.period).toEqual({ start: "2026-04-14", end: "2026-04-20" });
  });

  it("returns tacos when sp_orders data available", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_TOTALS] })
      .mockResolvedValueOnce({ rows: SAMPLE_TREND })
      .mockResolvedValueOnce({ rows: [SAMPLE_PREV] })
      .mockResolvedValueOnce({ rows: [{ total_revenue: "5000.00", last_rev_date: new Date("2026-04-20"), coverage_days: "7" }] })
      .mockResolvedValueOnce({ rows: [{ spend: "500.00" }] }); // aligned spend
    const res = await request(app).get("/metrics/summary?startDate=2026-04-14&endDate=2026-04-20");
    expect(res.status).toBe(200);
    expect(res.body.totals.tacos).not.toBeNull();
    expect(res.body.totals.tacosSource).toBe("sp_api");
  });

  it("uses default date range when not provided", async () => {
    mockSummaryQueries();
    const res = await request(app).get("/metrics/summary");
    expect(res.status).toBe(200);
    expect(res.body.period).toBeDefined();
  });

  it("handles empty totals (no metrics)", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ impressions: null, clicks: null, spend: null, sales_14d: null }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{}] })
      .mockResolvedValueOnce({ rows: [{ total_revenue: null }] });
    const res = await request(app).get("/metrics/summary");
    expect(res.status).toBe(200);
    expect(parseFloat(res.body.totals.spend)).toBe(0);
  });
});

describe("GET /metrics/top-campaigns", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns top campaigns by spend", async () => {
    const campRow = {
      id: "camp-001", name: "Best Campaign", campaign_type: "sponsoredProducts",
      state: "enabled", impressions: "10000", clicks: "200",
      spend: "100.00", sales: "400.00", cpc: "0.50", acos: "25.00", roas: "4.00",
    };
    dbQuery.mockResolvedValueOnce({ rows: [campRow] });
    const res = await request(app).get("/metrics/top-campaigns?limit=5");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("Best Campaign");
  });

  it("accepts metric=sales", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/metrics/top-campaigns?metric=sales");
    expect(res.status).toBe(200);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/SUM\(m\.sales_14d\)/i);
  });

  it("returns empty array when no metrics", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/metrics/top-campaigns");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

describe("GET /metrics/by-type", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns breakdown by campaign type", async () => {
    const rows = [
      { campaign_type: "sponsoredProducts", spend: "400.00", sales: "1600.00", acos: "25.00", roas: "4.00" },
      { campaign_type: "sponsoredBrands",   spend: "100.00", sales: "400.00",  acos: "25.00", roas: "4.00" },
    ];
    dbQuery.mockResolvedValueOnce({ rows });
    const res = await request(app).get("/metrics/by-type");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].campaign_type).toBe("sponsoredProducts");
  });

  it("returns empty array when no data", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/metrics/by-type");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

describe("POST /metrics/backfill", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("queues backfill with provided dates", async () => {
    const res = await request(app).post("/metrics/backfill")
      .send({ dateFrom: "2026-01-01", dateTo: "2026-03-01" });
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(true);
    expect(res.body.jobId).toBe("job-backfill-1");
    expect(queueMetricsBackfill).toHaveBeenCalledWith(WS_ID, "2026-01-01", "2026-03-01");
  });

  it("uses default dates when not provided", async () => {
    const res = await request(app).post("/metrics/backfill").send({});
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(true);
    expect(queueMetricsBackfill).toHaveBeenCalled();
  });
});
