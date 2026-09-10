"use strict";
/**
 * Who can see which workspace's data.
 *
 * This is not a single-tenant deployment: three organizations, eleven users, three workspaces,
 * nine memberships. `requireWorkspace` has checked membership since the LEFT JOIN → INNER JOIN
 * fix, but `/profiles` runs on requireAuth alone and scoped by org id only — so any member of an
 * org could read the profiles of a workspace in that org they do not belong to. One workspace per
 * org today; the gap opens the moment a second one is added.
 *
 * Separately, a workspace id that is not a UUID reached `w.id = $2` on a uuid column and came
 * back 500 — a malformed header answered as a server fault.
 */
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/middleware/auth", () => {
  const actual = jest.requireActual("../src/middleware/auth");
  return {
    ...actual,
    requireAuth: (req, _res, next) => { req.user = { id: "user-1" }; req.orgId = "org-1"; next(); },
  };
});

const request = require("supertest");
const express = require("express");
const { query } = require("../src/db/pool");

const WS = "05831bc2-b7b3-44f2-a3e2-149ad0759627";

function app(router, mount) {
  const a = express();
  a.use(express.json());
  a.use(mount, router);
  return a;
}

beforeEach(() => { query.mockReset(); query.mockResolvedValue({ rows: [] }); });

describe("GET /profiles scopes by workspace membership", () => {
  const profilesApp = () => app(require("../src/routes/profiles"), "/profiles");

  test("the query only returns profiles in workspaces this user belongs to", async () => {
    await request(profilesApp()).get("/profiles");
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/workspace_members wm/);
    expect(sql).toMatch(/wm\.user_id = \$2/);
    expect(params).toEqual(["org-1", "user-1"]);
  });

  test("asking for one workspace still requires membership in it", async () => {
    await request(profilesApp()).get(`/profiles?workspaceId=${WS}`);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/wm\.workspace_id = p\.workspace_id AND wm\.user_id = \$2/);
    expect(sql).toMatch(/AND p\.workspace_id = \$3/);
    expect(params).toEqual(["org-1", "user-1", WS]);
  });

  // The connect screen lists profiles that have not been attached anywhere yet. Those are
  // org-level and must stay visible, or a new connection cannot be set up.
  test("unattached profiles remain visible", async () => {
    await request(profilesApp()).get("/profiles");
    expect(query.mock.calls[0][0]).toMatch(/p\.workspace_id IS NULL OR EXISTS/);
  });

  test("the org boundary is still the outer bound", async () => {
    await request(profilesApp()).get("/profiles");
    expect(query.mock.calls[0][0]).toMatch(/c\.org_id = \$1/);
  });
});

describe("requireWorkspace rejects a malformed id instead of failing on it", () => {
  const { requireWorkspace } = jest.requireActual("../src/middleware/auth");
  const guarded = () => {
    const a = express();
    a.use((req, _res, next) => { req.user = { id: "user-1" }; req.orgId = "org-1"; next(); });
    a.get("/x", requireWorkspace, (_req, res) => res.json({ ok: true }));
    return a;
  };

  test.each(["abc", "1", "not-a-uuid", "05831bc2", "'; DROP TABLE users;--"])(
    "%p is a 400, and no query is attempted", async (bad) => {
      const res = await request(guarded()).get("/x").set("x-workspace-id", bad);
      expect(res.status).toBe(400);
      expect(query).not.toHaveBeenCalled();
    });

  test("a missing id is still a 400", async () => {
    const res = await request(guarded()).get("/x");
    expect(res.status).toBe(400);
  });

  test("a real uuid gets through to the membership check", async () => {
    query.mockResolvedValue({ rows: [{ id: WS, org_id: "org-1", name: "W", workspace_role: "owner" }] });
    const res = await request(guarded()).get("/x").set("x-workspace-id", WS);
    expect(res.status).toBe(200);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/JOIN workspace_members wm ON wm\.workspace_id = w\.id AND wm\.user_id = \$1/);
    expect(params).toEqual(["user-1", WS, "org-1"]);
  });

  test("a uuid the user is not a member of is a 403, not a 200", async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await request(guarded()).get("/x").set("x-workspace-id", WS);
    expect(res.status).toBe(403);
  });
});
