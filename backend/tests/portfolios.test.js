"use strict";
/**
 * Portfolios routes — test suite
 *
 * Covers:
 *   GET / — returns portfolios with campaign counts, empty list, DB error 500
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID   = "ws---0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user      = { id: USER_ID, name: "Test User", role: "owner", org_id: ORG_ID };
    req.orgId     = ORG_ID;
    next();
  },
  requireWorkspace: (req, _res, next) => {
    req.workspaceId   = WS_ID;
    req.workspaceRole = "owner";
    next();
  },
}));

const { query: dbQuery }    = require("../src/db/pool");
const portfoliosRouter      = require("../src/routes/portfolios");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/portfolios", portfoliosRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /portfolios
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /portfolios", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns list of portfolios with campaign_count", async () => {
    const rows = [
      {
        amazon_portfolio_id: "port-111",
        name: "Summer Collection",
        state: "enabled",
        campaign_count: 5,
      },
      {
        amazon_portfolio_id: "port-222",
        name: "Portfolio port-222",  // COALESCE fallback name
        state: null,
        campaign_count: 2,
      },
    ];
    dbQuery.mockResolvedValueOnce({ rows });

    const res = await request(app).get("/portfolios");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);

    const first = res.body[0];
    expect(first.amazon_portfolio_id).toBe("port-111");
    expect(first.name).toBe("Summer Collection");
    expect(first.state).toBe("enabled");
    expect(first.campaign_count).toBe(5);

    const second = res.body[1];
    expect(second.name).toBe("Portfolio port-222");
    expect(second.campaign_count).toBe(2);
  });

  it("passes workspace_id to the query", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/portfolios");

    expect(dbQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/FROM campaigns/);
    expect(sql).toMatch(/LEFT JOIN portfolios/);
    expect(sql).toMatch(/COALESCE/);
    expect(params).toEqual([WS_ID]);
  });

  it("returns empty array when no portfolios exist", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/portfolios");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("returns portfolio with null state when portfolios table has no match", async () => {
    const rows = [
      {
        amazon_portfolio_id: "port-orphan",
        name: "Portfolio port-orphan",
        state: null,
        campaign_count: 1,
      },
    ];
    dbQuery.mockResolvedValueOnce({ rows });

    const res = await request(app).get("/portfolios");

    expect(res.status).toBe(200);
    expect(res.body[0].state).toBeNull();
  });

  it("propagates DB error as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("connection refused"));

    const res = await request(app).get("/portfolios");

    expect(res.status).toBe(500);
    expect(res.body.error).toBeDefined();
  });

  it("returns multiple portfolios ordered by name (as the query specifies)", async () => {
    // The DB query includes ORDER BY name; test that we return them in whatever order DB gives
    const rows = [
      { amazon_portfolio_id: "port-A", name: "Alpha", state: "enabled", campaign_count: 10 },
      { amazon_portfolio_id: "port-B", name: "Beta",  state: "enabled", campaign_count: 3  },
    ];
    dbQuery.mockResolvedValueOnce({ rows });

    const res = await request(app).get("/portfolios");

    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe("Alpha");
    expect(res.body[1].name).toBe("Beta");
  });
});
