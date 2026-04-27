"use strict";
/**
 * Alerts routes — comprehensive test suite
 *
 * Endpoints:
 *   GET    /alerts/configs          — list with pagination
 *   POST   /alerts/configs          — create config
 *   PUT    /alerts/configs/:id      — update config
 *   DELETE /alerts/configs/:id      — delete config
 *   PATCH  /alerts/configs/:id/toggle — toggle is_active
 *   GET    /alerts                  — list alert instances
 *   PATCH  /alerts/:id/acknowledge  — acknowledge alert
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID   = "ws---0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const CFG_ID  = "cfg--0001-0000-0000-000000000001";
const INST_ID = "inst-0001-0000-0000-000000000001";

const SAMPLE_CONFIG = {
  id: CFG_ID,
  workspace_id: WS_ID,
  name: "High ACOS Alert",
  alert_type: "acos",
  conditions: JSON.stringify({ metric: "acos", operator: "gt", value: 50 }),
  channels: JSON.stringify({ in_app: true }),
  suppression_hours: 24,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
};

const SAMPLE_INSTANCE = {
  id: INST_ID,
  workspace_id: WS_ID,
  config_id: CFG_ID,
  config_name: "High ACOS Alert",
  status: "open",
  created_at: "2026-04-22T10:00:00.000Z",
};

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
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
const alertsRouter = require("../src/routes/alerts");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/alerts", alertsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /alerts/configs
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /alerts/configs", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns paginated alert configs", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_CONFIG] })
      .mockResolvedValueOnce({ rows: [{ total: "1" }] });

    const res = await request(app).get("/alerts/configs");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].name).toBe("High ACOS Alert");
  });

  it("accepts valid limit values (10, 25, 50, 100)", async () => {
    for (const limit of [10, 25, 50, 100]) {
      dbQuery
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ total: "0" }] });
      const res = await request(app).get(`/alerts/configs?limit=${limit}`);
      expect(res.status).toBe(200);
    }
  });

  it("falls back to limit=25 for invalid limit", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });

    const res = await request(app).get("/alerts/configs?limit=999");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(25);
  });

  it("returns empty list when no configs", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });

    const res = await request(app).get("/alerts/configs");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it("paginates correctly", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "30" }] });

    const res = await request(app).get("/alerts/configs?page=2&limit=10");
    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(2);
    expect(res.body.pagination.limit).toBe(10);
    expect(res.body.pagination.pages).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /alerts/configs
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /alerts/configs", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const VALID_PAYLOAD = { name: "New Alert", metric: "acos", operator: "gt", value: 50 };

  it("creates alert config and returns 201", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_CONFIG] });

    const res = await request(app).post("/alerts/configs").send(VALID_PAYLOAD);
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(CFG_ID);
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app).post("/alerts/configs").send({ ...VALID_PAYLOAD, name: undefined });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/i);
  });

  it("returns 400 when metric is missing", async () => {
    const res = await request(app).post("/alerts/configs").send({ ...VALID_PAYLOAD, metric: undefined });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/metric/i);
  });

  it("returns 400 when operator is missing", async () => {
    const res = await request(app).post("/alerts/configs").send({ ...VALID_PAYLOAD, operator: undefined });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/operator/i);
  });

  it("returns 400 when value is missing", async () => {
    const res = await request(app).post("/alerts/configs").send({ ...VALID_PAYLOAD, value: undefined });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/value/i);
  });

  it("uses default cooldown_hours=24 when not provided", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_CONFIG] });
    await request(app).post("/alerts/configs").send(VALID_PAYLOAD);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(24);
  });

  it("uses provided cooldown_hours", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_CONFIG] });
    await request(app).post("/alerts/configs").send({ ...VALID_PAYLOAD, cooldown_hours: 48 });
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(48);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PUT /alerts/configs/:id
// ─────────────────────────────────────────────────────────────────────────────
describe("PUT /alerts/configs/:id", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const VALID_PAYLOAD = { name: "Updated Alert", metric: "spend", operator: "gt", value: 100, channels: { in_app: true } };

  it("updates alert config and returns it", async () => {
    const updated = { ...SAMPLE_CONFIG, name: "Updated Alert" };
    dbQuery.mockResolvedValueOnce({ rows: [updated] });

    const res = await request(app).put(`/alerts/configs/${CFG_ID}`).send(VALID_PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated Alert");
  });

  it("returns 404 when config not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).put(`/alerts/configs/nonexistent`).send(VALID_PAYLOAD);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 400 when required fields missing", async () => {
    const res = await request(app).put(`/alerts/configs/${CFG_ID}`).send({ name: "X" });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /alerts/configs/:id
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /alerts/configs/:id", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("deletes config and returns ok:true", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete(`/alerts/configs/${CFG_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("returns 404 when config not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const res = await request(app).delete(`/alerts/configs/nonexistent`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PATCH /alerts/configs/:id/toggle
// ─────────────────────────────────────────────────────────────────────────────
describe("PATCH /alerts/configs/:id/toggle", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("toggles is_active from true to false", async () => {
    const toggled = { ...SAMPLE_CONFIG, is_active: false };
    dbQuery.mockResolvedValueOnce({ rows: [toggled] });

    const res = await request(app).patch(`/alerts/configs/${CFG_ID}/toggle`);
    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(false);
  });

  it("toggles is_active from false to true", async () => {
    const toggled = { ...SAMPLE_CONFIG, is_active: true };
    dbQuery.mockResolvedValueOnce({ rows: [toggled] });

    const res = await request(app).patch(`/alerts/configs/${CFG_ID}/toggle`);
    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(true);
  });

  it("returns 404 when config not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).patch(`/alerts/configs/nonexistent/toggle`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /alerts
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /alerts", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns open alert instances by default", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_INSTANCE] })
      .mockResolvedValueOnce({ rows: [{ total: "1" }] });

    const res = await request(app).get("/alerts");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe("open");
    expect(res.body.pagination.total).toBe(1);
  });

  it("filters by status=acknowledged", async () => {
    const acked = { ...SAMPLE_INSTANCE, status: "acknowledged" };
    dbQuery
      .mockResolvedValueOnce({ rows: [acked] })
      .mockResolvedValueOnce({ rows: [{ total: "1" }] });

    const res = await request(app).get("/alerts?status=acknowledged");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("acknowledged");
  });

  it("returns empty list when no alerts", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });

    const res = await request(app).get("/alerts");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.total).toBe(0);
  });

  it("paginates correctly", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_INSTANCE] })
      .mockResolvedValueOnce({ rows: [{ total: "25" }] });

    const res = await request(app).get("/alerts?page=2&limit=10");
    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(2);
    expect(res.body.pagination.pages).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PATCH /alerts/:id/acknowledge
// ─────────────────────────────────────────────────────────────────────────────
describe("PATCH /alerts/:id/acknowledge", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("acknowledges alert instance and returns ok:true", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).patch(`/alerts/${INST_ID}/acknowledge`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toContain("acknowledged");
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(INST_ID);
    expect(params).toContain(WS_ID);
  });
});
