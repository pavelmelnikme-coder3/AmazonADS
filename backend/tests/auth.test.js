"use strict";
/**
 * Auth routes — comprehensive test suite
 *
 * Endpoints:
 *   POST /auth/register          — always 403
 *   POST /auth/login             — valid creds, bad email, wrong password, inactive user
 *   GET  /auth/me                — returns user + workspaces
 *   PATCH /auth/me               — update settings
 *   POST /auth/forgot-password   — safe response regardless
 *   POST /auth/reset-password/:token — valid, invalid, expired, already used
 *   GET  /auth/invite/:token     — found, not found, expired, already accepted
 *   POST /auth/accept-invite/:token — new user, existing user, bad token
 *
 * Strategy: mock DB (pool.query), bcrypt, jwt, and email service.
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const USER_ID = "user-0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const WS_ID   = "ws---0001-0000-0000-000000000001";
const INV_ID  = "inv--0001-0000-0000-000000000001";

const SAMPLE_USER = {
  id: USER_ID,
  org_id: ORG_ID,
  email: "test@example.com",
  password_hash: "$2a$12$hashedpassword",
  name: "Test User",
  role: "owner",
  is_active: true,
  settings: {},
};

const SAMPLE_WS = { id: WS_ID, name: "My Workspace", workspace_role: "owner" };

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("bcryptjs", () => ({ compare: jest.fn(), hash: jest.fn() }));
jest.mock("jsonwebtoken", () => ({
  sign:   jest.fn(() => "mock-jwt-token"),
  verify: jest.fn(() => ({ userId: "user-0001-0000-0000-000000000001" })),
}));
jest.mock("../src/services/email", () => ({
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user  = { id: USER_ID, name: "Test User", role: "owner", org_id: ORG_ID, settings: {} };
    req.orgId = ORG_ID;
    next();
  },
  requireWorkspace: (_req, _res, next) => next(),
}));

const { query: dbQuery } = require("../src/db/pool");
const bcrypt = require("bcryptjs");

// ─── App setup ────────────────────────────────────────────────────────────────
process.env.JWT_SECRET = "test-secret-key";
const authRouter = require("../src/routes/auth");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/auth", authRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
//  POST /auth/register
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /auth/register", () => {
  it("always returns 403 (invite-only)", async () => {
    const app = buildApp();
    const res = await request(app).post("/auth/register").send({ email: "x@x.com", password: "password123" });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/closed/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /auth/login
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /auth/login", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns token + user + workspaces on valid credentials", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_USER] })                  // user lookup
      .mockResolvedValueOnce({ rows: [] })                             // UPDATE last_login_at
      .mockResolvedValueOnce({ rows: [SAMPLE_WS] });                   // workspaces
    bcrypt.compare.mockResolvedValue(true);

    const res = await request(app)
      .post("/auth/login")
      .send({ email: "test@example.com", password: "Secret123!" });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBe("mock-jwt-token");
    expect(res.body.user.email).toBe("test@example.com");
    expect(res.body.workspaces).toHaveLength(1);
  });

  it("returns 400 for invalid email format", async () => {
    const res = await request(app).post("/auth/login").send({ email: "not-an-email", password: "pass" });
    expect(res.status).toBe(400);
  });

  it("returns 401 for wrong password", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_USER] });
    bcrypt.compare.mockResolvedValue(false);

    const res = await request(app).post("/auth/login").send({ email: "test@example.com", password: "wrong" });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid credentials/i);
  });

  it("returns 401 for inactive user", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ ...SAMPLE_USER, is_active: false }] });

    const res = await request(app).post("/auth/login").send({ email: "test@example.com", password: "pass" });
    expect(res.status).toBe(401);
  });

  it("returns 401 when user not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post("/auth/login").send({ email: "nobody@example.com", password: "pass" });
    expect(res.status).toBe(401);
  });

  it("returns 400 when password is missing", async () => {
    const res = await request(app).post("/auth/login").send({ email: "test@example.com" });
    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /auth/me
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /auth/me", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns current user and workspaces", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_WS] });

    const res = await request(app).get("/auth/me").set("Authorization", "Bearer mock-jwt-token");
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(USER_ID);
    expect(res.body.workspaces).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PATCH /auth/me
// ─────────────────────────────────────────────────────────────────────────────
describe("PATCH /auth/me", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("updates user settings and returns updated user", async () => {
    const updatedUser = { ...SAMPLE_USER, settings: { theme: "dark", lang: "de" } };
    dbQuery.mockResolvedValueOnce({ rows: [updatedUser] });

    const res = await request(app)
      .patch("/auth/me")
      .set("Authorization", "Bearer mock-jwt-token")
      .send({ settings: { theme: "dark", lang: "de" } });

    expect(res.status).toBe(200);
    expect(res.body.user.settings.theme).toBe("dark");
  });

  it("returns 400 when settings is not an object", async () => {
    const res = await request(app)
      .patch("/auth/me")
      .set("Authorization", "Bearer mock-jwt-token")
      .send({ settings: "invalid" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/settings/i);
  });

  it("returns 400 when settings is missing", async () => {
    const res = await request(app)
      .patch("/auth/me")
      .set("Authorization", "Bearer mock-jwt-token")
      .send({});

    expect(res.status).toBe(400);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /auth/forgot-password
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /auth/forgot-password", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const SAFE_MSG = "If that email is registered, a reset link has been sent.";

  it("returns safe message for registered email", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_USER] })  // user lookup
      .mockResolvedValueOnce({ rows: [] })              // DELETE existing tokens
      .mockResolvedValueOnce({ rows: [] });             // INSERT new token

    const res = await request(app).post("/auth/forgot-password").send({ email: "test@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe(SAFE_MSG);
  });

  it("returns same safe message when email not found (prevents enumeration)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post("/auth/forgot-password").send({ email: "unknown@example.com" });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe(SAFE_MSG);
  });

  it("returns safe message for invalid email format (no error leaked)", async () => {
    const res = await request(app).post("/auth/forgot-password").send({ email: "not-email" });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe(SAFE_MSG);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /auth/reset-password/:token
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /auth/reset-password/:token", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const VALID_TOKEN = "a".repeat(64);
  const FUTURE_DATE = new Date(Date.now() + 3_600_000).toISOString();
  const PAST_DATE   = new Date(Date.now() - 3_600_000).toISOString();

  it("resets password with valid token", async () => {
    bcrypt.hash.mockResolvedValue("$2a$12$newhash");
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: "rt-1", user_id: USER_ID, uid: USER_ID, used_at: null, expires_at: FUTURE_DATE }] })
      .mockResolvedValueOnce({ rows: [] }) // UPDATE users
      .mockResolvedValueOnce({ rows: [] }); // UPDATE tokens

    const res = await request(app)
      .post(`/auth/reset-password/${VALID_TOKEN}`)
      .send({ password: "NewPassword123!" });

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/password updated/i);
  });

  it("returns 400 for unknown token", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/auth/reset-password/${VALID_TOKEN}`)
      .send({ password: "NewPassword123!" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid/i);
  });

  it("returns 400 for already-used token", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: "rt-1", user_id: USER_ID, uid: USER_ID, used_at: PAST_DATE, expires_at: FUTURE_DATE }] });

    const res = await request(app)
      .post(`/auth/reset-password/${VALID_TOKEN}`)
      .send({ password: "NewPassword123!" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/already been used/i);
  });

  it("returns 400 for expired token", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: "rt-1", user_id: USER_ID, uid: USER_ID, used_at: null, expires_at: PAST_DATE }] });

    const res = await request(app)
      .post(`/auth/reset-password/${VALID_TOKEN}`)
      .send({ password: "NewPassword123!" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/expired/i);
  });

  it("returns 400 when password too short", async () => {
    const res = await request(app)
      .post(`/auth/reset-password/${VALID_TOKEN}`)
      .send({ password: "short" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/8/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /auth/invite/:token
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /auth/invite/:token", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
  const PAST   = new Date(Date.now() - 86_400_000).toISOString();

  it("returns invite info for valid pending token", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{
      email: "new@example.com",
      workspace_name: "My WS",
      inviter_name: "Boss",
      role: "member",
      is_new_user: true,
      accepted_at: null,
      expires_at: FUTURE,
    }] });

    const res = await request(app).get("/auth/invite/valid-token");
    expect(res.status).toBe(200);
    expect(res.body.email).toBe("new@example.com");
    expect(res.body.workspace_name).toBe("My WS");
  });

  it("returns 404 for unknown token", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/auth/invite/bad-token");
    expect(res.status).toBe(404);
  });

  it("returns 410 for already accepted invite", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ accepted_at: PAST, expires_at: FUTURE }] });
    const res = await request(app).get("/auth/invite/used-token");
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/already accepted/i);
  });

  it("returns 410 for expired invite", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ accepted_at: null, expires_at: PAST }] });
    const res = await request(app).get("/auth/invite/expired-token");
    expect(res.status).toBe(410);
    expect(res.body.error).toMatch(/expired/i);
  });
});
