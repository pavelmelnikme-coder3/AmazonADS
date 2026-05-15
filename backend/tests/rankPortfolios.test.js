"use strict";
const request = require("supertest");
const express = require("express");

const WS_ID  = "ws---0001-0000-0000-000000000001";
const ORG_ID = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const PF_ID  = "rpf--0001-0000-0000-000000000001";

const SAMPLE_PF = {
  id: PF_ID, name: "Running Shoes", display_order: 1,
  created_at: "2026-01-01T00:00:00.000Z",
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
const router = require("../src/routes/rankPortfolios");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/rank-portfolios", router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

describe("GET /rank-portfolios", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.resetAllMocks(); });

  it("returns list of rank portfolios", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_PF] });
    const res = await request(app).get("/rank-portfolios");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("Running Shoes");
  });

  it("returns empty array when none exist", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/rank-portfolios");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("passes workspace_id to query", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get("/rank-portfolios");
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(WS_ID);
  });
});

describe("POST /rank-portfolios", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.resetAllMocks(); });

  it("creates a portfolio and returns it", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_PF] });
    const res = await request(app).post("/rank-portfolios")
      .send({ name: "Running Shoes" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Running Shoes");
  });

  it("returns 400 when name is empty", async () => {
    const res = await request(app).post("/rank-portfolios").send({ name: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app).post("/rank-portfolios").send({});
    expect(res.status).toBe(400);
  });

  it("uses ON CONFLICT DO UPDATE (upsert)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_PF] });
    await request(app).post("/rank-portfolios").send({ name: "Running Shoes" });
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/ON CONFLICT/i);
  });
});

describe("PATCH /rank-portfolios/:id", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.resetAllMocks(); });

  it("renames portfolio", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ ...SAMPLE_PF, name: "New Name" }] });
    const res = await request(app).patch(`/rank-portfolios/${PF_ID}`)
      .send({ name: "New Name" });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("New Name");
  });

  it("returns 400 when name is empty", async () => {
    const res = await request(app).patch(`/rank-portfolios/${PF_ID}`).send({ name: "" });
    expect(res.status).toBe(400);
  });

  it("returns 404 when portfolio not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).patch(`/rank-portfolios/${PF_ID}`)
      .send({ name: "New Name" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /rank-portfolios/:id", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.resetAllMocks(); });

  it("deletes portfolio and returns ok:true", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).delete(`/rank-portfolios/${PF_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("passes id and workspace_id to delete query", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await request(app).delete(`/rank-portfolios/${PF_ID}`);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(PF_ID);
    expect(params).toContain(WS_ID);
  });
});
