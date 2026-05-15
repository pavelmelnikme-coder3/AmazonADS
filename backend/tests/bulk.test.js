"use strict";
const request = require("supertest");
const express = require("express");

const WS_ID  = "ws---0001-0000-0000-000000000001";
const ORG_ID = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const CAMP_ID = "camp-0001-0000-0000-000000000001";
const KW_ID   = "kw---0001-0000-0000-000000000001";

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/services/amazon/writeback", () => ({
  pushKeywordUpdates: jest.fn().mockResolvedValue({ ok: true }),
  loadKeywordContext: jest.fn().mockResolvedValue([]),
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
const { pushKeywordUpdates, loadKeywordContext } = require("../src/services/amazon/writeback");
const router = require("../src/routes/bulk");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/bulk", router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

function resetMocks() {
  jest.resetAllMocks();
  pushKeywordUpdates.mockResolvedValue({ ok: true });
  loadKeywordContext.mockResolvedValue([]);
}

describe("POST /bulk/campaigns/status", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("bulk-updates campaign state to paused", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    const res = await request(app).post("/bulk/campaigns/status")
      .send({ ids: [CAMP_ID, "camp-002"], state: "paused" });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
  });

  it("bulk-updates campaign state to enabled", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).post("/bulk/campaigns/status")
      .send({ ids: [CAMP_ID], state: "enabled" });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
  });

  it("returns 400 when ids is empty", async () => {
    const res = await request(app).post("/bulk/campaigns/status")
      .send({ ids: [], state: "paused" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid state", async () => {
    const res = await request(app).post("/bulk/campaigns/status")
      .send({ ids: [CAMP_ID], state: "invalid" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/state/i);
  });

  it("returns 400 when ids missing", async () => {
    const res = await request(app).post("/bulk/campaigns/status")
      .send({ state: "paused" });
    expect(res.status).toBe(400);
  });

  it("passes workspace_id to query", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await request(app).post("/bulk/campaigns/status")
      .send({ ids: [CAMP_ID], state: "paused" });
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(WS_ID);
  });
});

describe("POST /bulk/campaigns/budget", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("adjusts budget by percentage", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 3 });
    const res = await request(app).post("/bulk/campaigns/budget")
      .send({ ids: [CAMP_ID], adjustPct: 10 });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(3);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/daily_budget.*\*.*\(1.*\+/);
  });

  it("adjusts budget by negative percentage (decrease)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).post("/bulk/campaigns/budget")
      .send({ ids: [CAMP_ID], adjustPct: -20 });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
  });

  it("returns 400 when ids missing", async () => {
    const res = await request(app).post("/bulk/campaigns/budget")
      .send({ adjustPct: 10 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when adjustPct missing", async () => {
    const res = await request(app).post("/bulk/campaigns/budget")
      .send({ ids: [CAMP_ID] });
    expect(res.status).toBe(400);
  });

  it("uses GREATEST(0.01, ...) to floor budget", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await request(app).post("/bulk/campaigns/budget")
      .send({ ids: [CAMP_ID], adjustPct: -99 });
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/GREATEST\(0\.01/i);
  });
});

describe("POST /bulk/keywords/bid", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("adjusts keyword bids by percentage", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    const res = await request(app).post("/bulk/keywords/bid")
      .send({ ids: [KW_ID], adjustPct: 15 });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/bid.*\*.*\(1.*\+/);
  });

  it("sets absolute bid value", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).post("/bulk/keywords/bid")
      .send({ ids: [KW_ID], absoluteBid: 0.75 });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/bid = \$1/);
  });

  it("returns 400 when ids missing", async () => {
    const res = await request(app).post("/bulk/keywords/bid")
      .send({ adjustPct: 10 });
    expect(res.status).toBe(400);
  });

  it("returns 400 when neither adjustPct nor absoluteBid provided", async () => {
    const res = await request(app).post("/bulk/keywords/bid")
      .send({ ids: [KW_ID] });
    expect(res.status).toBe(400);
  });

  it("clamps bid between 0.02 and 50", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await request(app).post("/bulk/keywords/bid")
      .send({ ids: [KW_ID], adjustPct: 999 });
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/LEAST\(50/i);
    expect(sql).toMatch(/GREATEST\(0\.02/i);
  });
});
