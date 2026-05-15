"use strict";
const request = require("supertest");
const express = require("express");

const WS_ID  = "ws---0001-0000-0000-000000000001";
const ORG_ID = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/jobs/workers", () => ({
  queueSpSync: jest.fn().mockResolvedValue({ id: "job-sp-1" }),
}));
// sp.js uses req.workspace.id (not req.workspaceId)
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: USER_ID, name: "Test User", role: "owner", org_id: ORG_ID };
    req.orgId = ORG_ID; next();
  },
  requireWorkspace: (req, _res, next) => {
    req.workspaceId = WS_ID;
    req.workspace = { id: WS_ID };
    req.workspaceRole = "owner"; next();
  },
}));

const { query: dbQuery } = require("../src/db/pool");
const { queueSpSync } = require("../src/jobs/workers");
const router = require("../src/routes/sp");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/sp", router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

function resetMocks() {
  jest.resetAllMocks();
  queueSpSync.mockResolvedValue({ id: "job-sp-1" });
}

describe("GET /sp/inventory", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns inventory rows", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [
      { asin: "B08N5WRWNW", marketplace_id: "A1PA6795UKMFR9", quantity_sellable: 50 }
    ]});
    const res = await request(app).get("/sp/inventory");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].asin).toBe("B08N5WRWNW");
  });

  it("filters by asin", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/sp/inventory?asin=B08N5WRWNW");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("B08N5WRWNW");
  });

  it("returns empty array when no inventory", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/sp/inventory");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

describe("GET /sp/inventory/summary", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns inventory summary with product info", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [
      { asin: "B08N5WRWNW", fulfillment_channel: "AFN", quantity_sellable: 100, title: "Test Product" }
    ]});
    const res = await request(app).get("/sp/inventory/summary");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe("Test Product");
  });
});

describe("GET /sp/orders", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns paginated orders", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [
      { id: "ord-001", amazon_order_id: "123-456", order_status: "Shipped", total_count: "1" }
    ]});
    const res = await request(app).get("/sp/orders");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination).toBeDefined();
  });

  it("filters by status", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/sp/orders?status=Shipped");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("Shipped");
  });

  it("filters by date range", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/sp/orders?startDate=2026-04-01&endDate=2026-04-30");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("2026-04-01");
    expect(params).toContain("2026-04-30");
  });
});

describe("GET /sp/orders/summary", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns daily order summary", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [
      { period: "2026-04-01", orders: "10", revenue: "500.00", avg_order_value: "50.00" }
    ]});
    const res = await request(app).get("/sp/orders/summary");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("groups by month when groupBy=month", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/sp/orders/summary?groupBy=month");
    expect(res.status).toBe(200);
    // DATE_TRUNC uses parameterized $1 for the truncation unit
    const params = dbQuery.mock.calls[0][1];
    expect(params[0]).toBe("month");
  });
});

describe("GET /sp/orders/:orderId/items", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns order items for given order id", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: "item-001", asin: "B08N5WRWNW", quantity: 2 }] });
    const res = await request(app).get("/sp/orders/123-456/items");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].asin).toBe("B08N5WRWNW");
  });
});

describe("GET /sp/financials", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns paginated financials", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [
      { id: "fin-001", event_type: "Order", amount: "50.00", total_count: "1" }
    ]});
    const res = await request(app).get("/sp/financials");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination).toBeDefined();
  });

  it("filters by eventType", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/sp/financials?eventType=Refund");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("Refund");
  });
});

describe("GET /sp/financials/summary", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns financial summary by event group", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [
      { event_group: "Order", event_type: "Order", count: "10", total_amount: "500.00", currency_code: "EUR" }
    ]});
    const res = await request(app).get("/sp/financials/summary");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });
});

describe("GET /sp/pricing/current", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns current pricing for all ASINs", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [
      { asin: "B08N5WRWNW", listing_price_amount: 29.99, buy_box_price_amount: 29.99 }
    ]});
    const res = await request(app).get("/sp/pricing/current");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].asin).toBe("B08N5WRWNW");
  });
});

describe("GET /sp/pricing/:asin", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns price history for ASIN", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [
      { asin: "B08N5WRWNW", listing_price_amount: 29.99, captured_at: "2026-04-20T00:00:00Z" }
    ]});
    const res = await request(app).get("/sp/pricing/B08N5WRWNW");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it("filters by marketplaceId", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/sp/pricing/B08N5WRWNW?marketplaceId=A1PA6795UKMFR9");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("A1PA6795UKMFR9");
  });
});

describe("POST /sp/sync", () => {
  let app;
  const origToken = process.env.SP_API_REFRESH_TOKEN;

  beforeEach(() => {
    app = buildApp();
    resetMocks();
    process.env.SP_API_REFRESH_TOKEN = "test-token";
  });
  afterEach(() => {
    if (origToken !== undefined) process.env.SP_API_REFRESH_TOKEN = origToken;
    else delete process.env.SP_API_REFRESH_TOKEN;
  });

  it("queues SP sync and returns jobId", async () => {
    const res = await request(app).post("/sp/sync")
      .send({ marketplaceId: "A1PA6795UKMFR9" });
    expect(res.status).toBe(200);
    expect(res.body.queued).toBe(true);
    expect(res.body.jobId).toBe("job-sp-1");
    expect(queueSpSync).toHaveBeenCalled();
  });

  it("returns 400 when marketplaceId missing", async () => {
    const res = await request(app).post("/sp/sync").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/marketplaceId/i);
  });

  it("returns 400 for invalid sync type", async () => {
    const res = await request(app).post("/sp/sync")
      .send({ marketplaceId: "A1PA6795UKMFR9", syncTypes: ["invalid"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid sync types/i);
  });

  it("returns 503 when SP_API_REFRESH_TOKEN not configured", async () => {
    delete process.env.SP_API_REFRESH_TOKEN;
    const res = await request(app).post("/sp/sync")
      .send({ marketplaceId: "A1PA6795UKMFR9" });
    expect(res.status).toBe(503);
  });
});

describe("GET /sp/sync/status", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns sync log entries", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [
      { sync_type: "bsr", status: "completed", records_fetched: 100, started_at: "2026-04-20T00:00:00Z" }
    ]});
    const res = await request(app).get("/sp/sync/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].sync_type).toBe("bsr");
  });

  it("returns empty array when no sync history", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/sp/sync/status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});
