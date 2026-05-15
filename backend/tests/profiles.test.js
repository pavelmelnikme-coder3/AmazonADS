"use strict";
const request = require("supertest");
const express = require("express");

const ORG_ID    = "org--0001-0000-0000-000000000001";
const USER_ID   = "user-0001-0000-0000-000000000001";
const WS_ID     = "ws---0001-0000-0000-000000000001";
const PROF_ID   = "prof-0001-0000-0000-000000000001";

const SAMPLE_PROFILE = {
  id: PROF_ID, profile_id: "12345678901234",
  marketplace: "amazon.de", country_code: "DE",
  currency_code: "EUR", account_name: "Test Account",
  account_type: "seller", is_attached: true,
  sync_status: "completed", last_synced_at: "2026-01-01T00:00:00.000Z",
  connection_id: "conn-001", connection_status: "active",
};

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/jobs/workers", () => ({
  queueEntitySync: jest.fn().mockResolvedValue({}),
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
const { queueEntitySync } = require("../src/jobs/workers");
const router = require("../src/routes/profiles");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/profiles", router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

describe("GET /profiles", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.resetAllMocks(); });

  it("returns list of profiles for org", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_PROFILE] });
    const res = await request(app).get("/profiles");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].country_code).toBe("DE");
  });

  it("filters by workspaceId when provided", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_PROFILE] });
    const res = await request(app).get(`/profiles?workspaceId=${WS_ID}`);
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(WS_ID);
  });

  it("queries without workspace filter when not provided", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/profiles");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).not.toContain(WS_ID);
    expect(params).toContain(ORG_ID);
  });

  it("returns empty array when no profiles", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/profiles");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });

  it("returns multiple profiles", async () => {
    const p2 = { ...SAMPLE_PROFILE, id: "prof-0002-0000-0000-000000000002", country_code: "US" };
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_PROFILE, p2] });
    const res = await request(app).get("/profiles");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

describe("POST /profiles/:id/sync", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.resetAllMocks(); });

  it("queues sync for valid profile", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: PROF_ID }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).post(`/profiles/${PROF_ID}/sync`);
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/queued/i);
    expect(queueEntitySync).toHaveBeenCalledWith(PROF_ID, expect.any(Array), 1);
  });

  it("returns 404 when profile not in org", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post(`/profiles/${PROF_ID}/sync`);
    expect(res.status).toBe(404);
  });

  it("updates sync_status to pending after queue", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: PROF_ID }] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await request(app).post(`/profiles/${PROF_ID}/sync`);
    const updateSql = dbQuery.mock.calls[1][0];
    expect(updateSql).toMatch(/sync_status.*=.*'pending'/);
  });
});
