"use strict";
/**
 * Settings routes — comprehensive test suite
 *
 * Endpoints:
 *   GET    /settings/workspace              — returns workspace row
 *   PATCH  /settings/workspace              — requirePerm("write"); 403 for viewer
 *   GET    /settings/members               — returns member list
 *   POST   /settings/members/invite        — requirePerm("invite"); 400 missing email; 409 already member; 201 ok
 *   PATCH  /settings/members/:userId/role  — requirePerm("manage_roles"); updates role
 *   DELETE /settings/members/:userId       — requirePerm("remove"); removes member
 *   GET    /settings/profile               — returns user profile
 *   PATCH  /settings/profile              — updates name/email
 *   PATCH  /settings/profile/password     — changes password; 400 wrong current
 *   GET    /settings/notifications         — returns notification prefs
 *   PATCH  /settings/notifications         — updates notification prefs
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID    = "ws---0001-0000-0000-000000000001";
const ORG_ID   = "org--0001-0000-0000-000000000001";
const USER_ID  = "user-0001-0000-0000-000000000001";
const USER2_ID = "user-0002-0000-0000-000000000002";

const SAMPLE_WORKSPACE = {
  id: WS_ID,
  org_id: ORG_ID,
  name: "Test Workspace",
  description: "A workspace for testing",
  settings: {},
  org_name: "Test Org",
  plan: "pro",
  slug: "test-org",
};

const SAMPLE_MEMBER = {
  id: USER2_ID,
  name: "Jane Doe",
  email: "jane@example.com",
  org_role: "analyst",
  last_login_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  workspace_role: "analyst",
  is_active: true,
};

const SAMPLE_PROFILE = {
  id: USER_ID,
  name: "Test User",
  email: "test@example.com",
  role: "owner",
  last_login_at: null,
  created_at: "2026-01-01T00:00:00.000Z",
  avatar_url: null,
  timezone: "UTC",
  locale: "en",
};

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/services/email", () => ({
  sendInviteEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// bcryptjs — compare returns true by default (correct password), hash returns a fixed string
jest.mock("bcryptjs", () => ({
  compare: jest.fn().mockResolvedValue(true),
  hash:    jest.fn().mockResolvedValue("$2a$12$hashedpassword"),
}));

// Mutable workspace role — prefixed "mock" so Jest's hoisted factory can reference it.
// Tests that need a viewer role set mockWorkspaceRole before issuing the request.
let mockWorkspaceRole = "owner";

jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user          = { id: USER_ID, name: "Test User", role: "owner", org_id: ORG_ID };
    req.orgId         = ORG_ID;
    next();
  },
  // Reads mockWorkspaceRole at call time so tests can override it per-scenario.
  requireWorkspace: (req, _res, next) => {
    req.workspaceId   = WS_ID;
    req.workspaceRole = mockWorkspaceRole;
    next();
  },
}));

const { query: dbQuery }       = require("../src/db/pool");
const { sendInviteEmail }      = require("../src/services/email");
const bcrypt                   = require("bcryptjs");
const settingsRouter           = require("../src/routes/settings");

// ─── App builder ──────────────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/settings", settingsRouter);
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
  bcrypt.compare.mockResolvedValue(true);
  bcrypt.hash.mockResolvedValue("$2a$12$hashedpassword");
  sendInviteEmail.mockResolvedValue(undefined);
  // Reset workspaceRole to default "owner" for each test.
  mockWorkspaceRole = "owner";
  app = buildApp();
});

// ─── GET /settings/workspace ──────────────────────────────────────────────────
describe("GET /settings/workspace", () => {
  test("returns workspace data", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_WORKSPACE] });

    const res = await request(app).get("/settings/workspace");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(WS_ID);
    expect(res.body.name).toBe("Test Workspace");
    expect(res.body.org_name).toBe("Test Org");
  });

  test("returns 404 when workspace not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/settings/workspace");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ─── PATCH /settings/workspace ────────────────────────────────────────────────
describe("PATCH /settings/workspace", () => {
  test("updates workspace settings and returns updated row", async () => {
    const updated = { ...SAMPLE_WORKSPACE, name: "Updated Name" };
    dbQuery.mockResolvedValueOnce({ rows: [updated] });

    const res = await request(app)
      .patch("/settings/workspace")
      .send({ name: "Updated Name", description: "New desc", settings: {} });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated Name");
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE workspaces"),
      expect.arrayContaining(["Updated Name", WS_ID])
    );
  });

  test("returns 400 when name is missing", async () => {
    const res = await request(app)
      .patch("/settings/workspace")
      .send({ name: "  ", description: "desc", settings: {} });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
  });

  test("returns 403 for viewer role (no write permission)", async () => {
    mockWorkspaceRole = "read_only"; // read_only has no "write" permission
    const res = await request(app)
      .patch("/settings/workspace")
      .send({ name: "Viewer Update", settings: {} });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/requires permission/i);
  });
});

// ─── GET /settings/members ────────────────────────────────────────────────────
describe("GET /settings/members", () => {
  test("returns member list", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_MEMBER] });

    const res = await request(app).get("/settings/members");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe(USER2_ID);
    expect(res.body[0].workspace_role).toBe("analyst");
  });

  test("returns empty array when no members", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/settings/members");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

// ─── POST /settings/members/invite ───────────────────────────────────────────
describe("POST /settings/members/invite", () => {
  test("returns 400 when email is missing", async () => {
    const res = await request(app)
      .post("/settings/members/invite")
      .send({ workspace_role: "analyst" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  test("returns 400 when email is invalid", async () => {
    const res = await request(app)
      .post("/settings/members/invite")
      .send({ email: "not-an-email", workspace_role: "analyst" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  test("returns 400 when workspace_role is invalid", async () => {
    const res = await request(app)
      .post("/settings/members/invite")
      .send({ email: "valid@example.com", workspace_role: "owner" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/workspace_role/i);
  });

  test("returns 409 when user is already a workspace member", async () => {
    // existing member check returns a row
    dbQuery.mockResolvedValueOnce({ rows: [{ id: USER2_ID }] });

    const res = await request(app)
      .post("/settings/members/invite")
      .send({ email: "jane@example.com", workspace_role: "analyst" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already a member/i);
  });

  test("creates invite for existing org user and returns 201", async () => {
    // 1. existing member check → not a member
    dbQuery.mockResolvedValueOnce({ rows: [] });
    // 2. existing org user check → user exists
    dbQuery.mockResolvedValueOnce({ rows: [{ id: USER2_ID }] });
    // 3. INSERT workspace_members (existing user path)
    dbQuery.mockResolvedValueOnce({ rows: [] });
    // 4. SELECT workspace name
    dbQuery.mockResolvedValueOnce({ rows: [{ name: "Test Workspace" }] });
    // 5. SELECT inviter name
    dbQuery.mockResolvedValueOnce({ rows: [{ name: "Test User" }] });
    // 6. INSERT invitation
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/settings/members/invite")
      .send({ email: "jane@example.com", name: "Jane", workspace_role: "analyst" });

    expect(res.status).toBe(201);
    expect(res.body.invited).toBe(true);
    expect(res.body.user_id).toBe(USER2_ID);
    expect(sendInviteEmail).toHaveBeenCalledTimes(1);
  });

  test("creates invite for new user and returns 201", async () => {
    // 1. existing member check → not a member
    dbQuery.mockResolvedValueOnce({ rows: [] });
    // 2. existing org user check → user does NOT exist
    dbQuery.mockResolvedValueOnce({ rows: [] });
    // 3. INSERT new user RETURNING id
    dbQuery.mockResolvedValueOnce({ rows: [{ id: "new-user-id" }] });
    // 4. SELECT workspace name
    dbQuery.mockResolvedValueOnce({ rows: [{ name: "Test Workspace" }] });
    // 5. SELECT inviter name
    dbQuery.mockResolvedValueOnce({ rows: [{ name: "Test User" }] });
    // 6. INSERT invitation
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post("/settings/members/invite")
      .send({ email: "newuser@example.com", name: "New User", workspace_role: "media_buyer" });

    expect(res.status).toBe(201);
    expect(res.body.invited).toBe(true);
    expect(res.body.isNewUser).toBe(true);
  });

  test("returns 403 for viewer role (no invite permission)", async () => {
    mockWorkspaceRole = "read_only"; // read_only has no "invite" permission
    const res = await request(app)
      .post("/settings/members/invite")
      .send({ email: "jane@example.com", workspace_role: "analyst" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/requires permission/i);
  });
});

// ─── PATCH /settings/members/:userId/role ─────────────────────────────────────
describe("PATCH /settings/members/:userId/role", () => {
  test("updates member role successfully", async () => {
    // SELECT member → found, not owner
    dbQuery.mockResolvedValueOnce({ rows: [{ role: "analyst" }] });
    // UPDATE
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch(`/settings/members/${USER2_ID}/role`)
      .send({ role: "media_buyer" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.role).toBe("media_buyer");
  });

  test("returns 400 for invalid role (owner)", async () => {
    const res = await request(app)
      .patch(`/settings/members/${USER2_ID}/role`)
      .send({ role: "owner" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid role/i);
  });

  test("returns 404 when member not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch(`/settings/members/${USER2_ID}/role`)
      .send({ role: "analyst" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test("returns 403 when trying to change owner role", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ role: "owner" }] });

    const res = await request(app)
      .patch(`/settings/members/${USER2_ID}/role`)
      .send({ role: "analyst" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner/i);
  });

  test("returns 403 for viewer role (no manage_roles permission)", async () => {
    mockWorkspaceRole = "read_only"; // read_only has no "manage_roles" permission
    const res = await request(app)
      .patch(`/settings/members/${USER2_ID}/role`)
      .send({ role: "analyst" });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/requires permission/i);
  });
});

// ─── DELETE /settings/members/:userId ─────────────────────────────────────────
describe("DELETE /settings/members/:userId", () => {
  test("removes member successfully", async () => {
    // SELECT member → found, not owner
    dbQuery.mockResolvedValueOnce({ rows: [{ role: "analyst" }] });
    // DELETE
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete(`/settings/members/${USER2_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("returns 400 when trying to remove yourself", async () => {
    const res = await request(app).delete(`/settings/members/${USER_ID}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/yourself/i);
  });

  test("returns 404 when member not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete(`/settings/members/${USER2_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test("returns 403 when trying to remove workspace owner", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ role: "owner" }] });

    const res = await request(app).delete(`/settings/members/${USER2_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/owner/i);
  });

  test("returns 403 for viewer role (no remove permission)", async () => {
    mockWorkspaceRole = "read_only"; // read_only has no "remove" permission
    const res = await request(app).delete(`/settings/members/${USER2_ID}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/requires permission/i);
  });
});

// ─── GET /settings/profile ────────────────────────────────────────────────────
describe("GET /settings/profile", () => {
  test("returns user profile", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_PROFILE] });

    const res = await request(app).get("/settings/profile");

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(USER_ID);
    expect(res.body.email).toBe("test@example.com");
    expect(res.body.name).toBe("Test User");
  });
});

// ─── PATCH /settings/profile ─────────────────────────────────────────────────
describe("PATCH /settings/profile", () => {
  test("updates name and email", async () => {
    // email uniqueness check → no clash
    dbQuery.mockResolvedValueOnce({ rows: [] });
    // UPDATE RETURNING
    dbQuery.mockResolvedValueOnce({ rows: [{ ...SAMPLE_PROFILE, name: "Updated Name", email: "updated@example.com" }] });

    const res = await request(app)
      .patch("/settings/profile")
      .send({ name: "Updated Name", email: "updated@example.com" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated Name");
    expect(res.body.email).toBe("updated@example.com");
  });

  test("returns 400 when name is missing", async () => {
    const res = await request(app)
      .patch("/settings/profile")
      .send({ name: "", email: "test@example.com" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name is required/i);
  });

  test("returns 400 when email is invalid", async () => {
    const res = await request(app)
      .patch("/settings/profile")
      .send({ name: "Test User", email: "bad-email" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email/i);
  });

  test("returns 409 when email is already in use", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: USER2_ID }] });

    const res = await request(app)
      .patch("/settings/profile")
      .send({ name: "Test User", email: "taken@example.com" });

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already in use/i);
  });
});

// ─── PATCH /settings/profile/password ────────────────────────────────────────
describe("PATCH /settings/profile/password", () => {
  test("changes password successfully", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ password_hash: "$2a$10$oldhash" }] });
    // bcrypt.compare is mocked to return true by default
    dbQuery.mockResolvedValueOnce({ rows: [] }); // UPDATE

    const res = await request(app)
      .patch("/settings/profile/password")
      .send({ current_password: "OldPass123", new_password: "NewPass456" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(bcrypt.compare).toHaveBeenCalledWith("OldPass123", "$2a$10$oldhash");
  });

  test("returns 400 when new_password is too short", async () => {
    const res = await request(app)
      .patch("/settings/profile/password")
      .send({ current_password: "OldPass123", new_password: "short" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8 characters/i);
  });

  test("returns 400 when current password is wrong", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ password_hash: "$2a$10$oldhash" }] });
    bcrypt.compare.mockResolvedValueOnce(false);

    const res = await request(app)
      .patch("/settings/profile/password")
      .send({ current_password: "WrongPass", new_password: "NewPass456" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/incorrect/i);
  });
});

// ─── GET /settings/notifications ─────────────────────────────────────────────
describe("GET /settings/notifications", () => {
  test("returns merged notification prefs with defaults", async () => {
    dbQuery.mockResolvedValueOnce({
      rows: [{ settings: JSON.stringify({ notifications: { email_alerts: false, alert_budget: false } }) }],
    });

    const res = await request(app).get("/settings/notifications");

    expect(res.status).toBe(200);
    // Overrides applied
    expect(res.body.email_alerts).toBe(false);
    expect(res.body.alert_budget).toBe(false);
    // Default fills in the rest
    expect(res.body.email_weekly_report).toBe(true);
    expect(res.body.alert_acos).toBe(true);
  });

  test("returns all defaults when no notifications key in settings", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ settings: "{}" }] });

    const res = await request(app).get("/settings/notifications");

    expect(res.status).toBe(200);
    expect(res.body.email_alerts).toBe(true);
    expect(res.body.email_ai_summary).toBe(false);
  });
});

// ─── PATCH /settings/notifications ───────────────────────────────────────────
describe("PATCH /settings/notifications", () => {
  test("updates notification prefs and returns ok:true", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const prefs = { email_alerts: false, email_weekly_report: true, alert_acos: false };
    const res = await request(app)
      .patch("/settings/notifications")
      .send(prefs);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("jsonb_set"),
      expect.arrayContaining([JSON.stringify(prefs), WS_ID])
    );
  });
});
