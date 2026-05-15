"use strict";
/**
 * Connections routes — comprehensive test suite
 *
 * Endpoints tested (OAuth flows skipped — too complex to unit test):
 *   GET    /connections                 — list connections for org
 *   GET    /connections/:id/profiles    — list profiles for a connection
 *   PATCH  /connections/:id/schedule   — requireWorkspace + requireRole("owner","admin"); updates sync schedule
 *   DELETE /connections/:id            — requireRole("owner","admin"); 404 if not found
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID   = "ws---0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const CONN_ID = "conn-0001-0000-0000-000000000001";
const PROF_ID = "prof-0001-0000-0000-000000000001";

const SAMPLE_CONNECTION = {
  id: CONN_ID,
  status: "active",
  amazon_email: "seller@example.com",
  created_at: "2026-01-01T00:00:00.000Z",
  last_refresh_at: "2026-05-01T00:00:00.000Z",
  error_count: 0,
  last_error: null,
  sync_schedule: "hourly",
  profile_count: "2",
};

const SAMPLE_PROFILE = {
  id: PROF_ID,
  profile_id: "123456789",
  marketplace: "Amazon.de",
  country_code: "DE",
  currency_code: "EUR",
  account_name: "Test Seller DE",
  account_type: "vendor",
  is_attached: true,
  sync_status: "synced",
  last_synced_at: "2026-05-14T10:00:00.000Z",
  workspace_id: WS_ID,
};

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("../src/routes/audit", () => ({
  writeAudit: jest.fn().mockResolvedValue(undefined),
}));

// LWA service — only revokeConnection matters for DELETE
jest.mock("../src/services/amazon/lwa", () => ({
  buildAuthUrl:         jest.fn(),
  exchangeCodeForTokens: jest.fn(),
  refreshAccessToken:   jest.fn().mockResolvedValue(undefined),
  saveConnection:       jest.fn(),
  revokeConnection:     jest.fn().mockResolvedValue(undefined),
  validateState:        jest.fn(),
}));

jest.mock("../src/services/amazon/entities", () => ({
  fetchProfiles:            jest.fn().mockResolvedValue([]),
  upsertProfiles:           jest.fn().mockResolvedValue([]),
  attachProfileToWorkspace: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../src/jobs/workers", () => ({
  queueEntitySync: jest.fn().mockResolvedValue({ id: "job-1" }),
}));

// Mutable user role — prefixed "mock" so Jest's hoisted factory can reference it.
// Tests that need an unprivileged role set mockUserRole before issuing the request.
let mockUserRole = "owner";

// Auth middleware — requireRole checks req.user.role.
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user          = { id: USER_ID, name: "Test User", role: mockUserRole, org_id: ORG_ID };
    req.orgId         = ORG_ID;
    next();
  },
  requireWorkspace: (req, _res, next) => {
    req.workspaceId   = WS_ID;
    req.workspaceRole = mockUserRole;
    next();
  },
  requireRole: (...roles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Requires role: ${roles.join(" or ")}. Your role: ${req.user.role}`,
      });
    }
    next();
  },
}));

const { query: dbQuery }      = require("../src/db/pool");
const { revokeConnection }    = require("../src/services/amazon/lwa");
const connectionsRouter       = require("../src/routes/connections");

// ─── App builder ──────────────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/connections", connectionsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

let app;

beforeEach(() => {
  // resetAllMocks clears mockResolvedValueOnce queues between tests.
  jest.resetAllMocks();
  // Restore default mocks that resetAllMocks removes.
  const { revokeConnection: rc } = require("../src/services/amazon/lwa");
  rc.mockResolvedValue(undefined);
  const { writeAudit } = require("../src/routes/audit");
  writeAudit.mockResolvedValue(undefined);
  // Reset role to owner for each test.
  mockUserRole = "owner";
  app = buildApp();
});

// ─── GET /connections ─────────────────────────────────────────────────────────
describe("GET /connections", () => {
  test("returns list of connections", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_CONNECTION] });

    const res = await request(app).get("/connections");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe(CONN_ID);
    expect(res.body[0].amazon_email).toBe("seller@example.com");
    expect(res.body[0].sync_schedule).toBe("hourly");
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("FROM amazon_connections"),
      [ORG_ID]
    );
  });

  test("returns empty array when no connections exist", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/connections");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("returns multiple connections", async () => {
    const conn2 = { ...SAMPLE_CONNECTION, id: "conn-0002", amazon_email: "seller2@example.com" };
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_CONNECTION, conn2] });

    const res = await request(app).get("/connections");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
  });
});

// ─── GET /connections/:id/profiles ───────────────────────────────────────────
describe("GET /connections/:id/profiles", () => {
  test("returns profiles for the connection", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_PROFILE] });

    const res = await request(app).get(`/connections/${CONN_ID}/profiles`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe(PROF_ID);
    expect(res.body[0].account_name).toBe("Test Seller DE");
    expect(res.body[0].country_code).toBe("DE");
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("FROM amazon_profiles p"),
      [CONN_ID, ORG_ID]
    );
  });

  test("returns empty array when connection has no profiles", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get(`/connections/${CONN_ID}/profiles`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("returns multiple profiles", async () => {
    const prof2 = { ...SAMPLE_PROFILE, id: "prof-0002", country_code: "US", account_name: "Test Seller US" };
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_PROFILE, prof2] });

    const res = await request(app).get(`/connections/${CONN_ID}/profiles`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[1].country_code).toBe("US");
  });
});

// ─── PATCH /connections/:id/schedule ─────────────────────────────────────────
describe("PATCH /connections/:id/schedule", () => {
  test("updates sync schedule to daily", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: CONN_ID, sync_schedule: "daily" }] });

    const res = await request(app)
      .patch(`/connections/${CONN_ID}/schedule`)
      .send({ schedule: "daily" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(CONN_ID);
    expect(res.body.sync_schedule).toBe("daily");
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE amazon_connections"),
      expect.arrayContaining(["daily", CONN_ID, ORG_ID])
    );
  });

  test("updates sync schedule to weekly", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: CONN_ID, sync_schedule: "weekly" }] });

    const res = await request(app)
      .patch(`/connections/${CONN_ID}/schedule`)
      .send({ schedule: "weekly" });

    expect(res.status).toBe(200);
    expect(res.body.sync_schedule).toBe("weekly");
  });

  test("returns 400 for invalid schedule value", async () => {
    const res = await request(app)
      .patch(`/connections/${CONN_ID}/schedule`)
      .send({ schedule: "minutely" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/schedule must be/i);
  });

  test("returns 404 when connection not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch(`/connections/${CONN_ID}/schedule`)
      .send({ schedule: "daily" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test("returns 403 for analyst role (not owner/admin)", async () => {
    mockUserRole = "analyst"; // analyst is not in requireRole("owner","admin")
    const res = await request(app)
      .patch(`/connections/${CONN_ID}/schedule`)
      .send({ schedule: "daily" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/requires role/i);
  });
});

// ─── DELETE /connections/:id ──────────────────────────────────────────────────
describe("DELETE /connections/:id", () => {
  test("deletes connection and returns ok message", async () => {
    // SELECT connection → found
    dbQuery.mockResolvedValueOnce({ rows: [{ id: CONN_ID }] });
    // writeAudit (mocked at module level, not a dbQuery call)

    const res = await request(app).delete(`/connections/${CONN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/revoked/i);
    expect(revokeConnection).toHaveBeenCalledWith(CONN_ID, USER_ID);
  });

  test("returns 404 when connection not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete(`/connections/${CONN_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
    expect(revokeConnection).not.toHaveBeenCalled();
  });

  test("returns 403 for analyst role (not owner/admin)", async () => {
    mockUserRole = "analyst"; // analyst is not in requireRole("owner","admin")
    const res = await request(app).delete(`/connections/${CONN_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/requires role/i);
    expect(revokeConnection).not.toHaveBeenCalled();
  });

  test("calls writeAudit after successful delete", async () => {
    const { writeAudit } = require("../src/routes/audit");
    dbQuery.mockResolvedValueOnce({ rows: [{ id: CONN_ID }] });

    await request(app).delete(`/connections/${CONN_ID}`);

    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "connection.revoked",
        entityType: "connection",
        entityId: CONN_ID,
        orgId: ORG_ID,
        actorId: USER_ID,
      })
    );
  });
});
