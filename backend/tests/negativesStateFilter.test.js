"use strict";
/**
 * The negatives pages must list only what Amazon is actually enforcing.
 *
 * Both list endpoints returned every row regardless of state, so negatives a rule had
 * released — PAUSED or ARCHIVED on Amazon, blocking nothing — were shown alongside live ones
 * with nothing to tell them apart. It stayed hidden because negative_targets.state was never
 * synced from Amazon at all; once it was, the overstatement was measurable: on 2026-09-04,
 * 246 of 8881 negative keywords and 184 of 5610 negative targets were inactive.
 */

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => { req.user = { id: "u1" }; req.orgId = "org1"; next(); },
  requireWorkspace: (req, _res, next) => { req.workspaceId = "ws1"; next(); },
}));

const request = require("supertest");
const express = require("express");
const { query: dbQuery } = require("../src/db/pool");

function buildApp(mountPath, routerPath) {
  const app = express();
  app.use(express.json());
  app.use(mountPath, require(routerPath));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  dbQuery.mockResolvedValue({ rows: [{ total: "0" }] });
});

const listCall = (needle) =>
  dbQuery.mock.calls.find(([sql]) => String(sql).includes(needle));

describe.each([
  ["negative keywords", "/negative-keywords", "../src/routes/negativeKeywords", "nk.state", "nk.id"],
  ["negative ASINs",    "/negative-asins",    "../src/routes/negativeAsins",    "nt.state", "nt.id"],
])("%s list", (_label, mount, routerPath, stateCol, idCol) => {
  it("returns only enabled negatives by default", async () => {
    const app = buildApp(mount, routerPath);
    await request(app).get(mount);
    const [sql, params] = listCall(`SELECT ${idCol}`);
    expect(sql).toContain(`${stateCol} = $`);
    expect(params).toContain("enabled");
  });

  it("returns released negatives when asked for them", async () => {
    const app = buildApp(mount, routerPath);
    await request(app).get(`${mount}?state=paused`);
    expect(listCall(`SELECT ${idCol}`)[1]).toContain("paused");
  });

  it("drops the filter entirely for state=all", async () => {
    const app = buildApp(mount, routerPath);
    await request(app).get(`${mount}?state=all`);
    const [sql, params] = listCall(`SELECT ${idCol}`);
    expect(sql).not.toContain(`${stateCol} = $`);
    expect(params).not.toContain("enabled");
  });

  it("falls back to enabled for an unrecognised state", async () => {
    const app = buildApp(mount, routerPath);
    await request(app).get(`${mount}?state=bogus`);
    expect(listCall(`SELECT ${idCol}`)[1]).toContain("enabled");
  });

  it("applies the same filter to the count, so pagination matches the rows", async () => {
    const app = buildApp(mount, routerPath);
    await request(app).get(mount);
    const countCall = dbQuery.mock.calls.find(([sql]) => String(sql).includes("COUNT(*)"));
    expect(countCall[0]).toContain(`${stateCol} = $`);
    expect(countCall[1]).toContain("enabled");
  });

  it("returns the state so the row can be labelled", async () => {
    const app = buildApp(mount, routerPath);
    await request(app).get(mount);
    expect(listCall(`SELECT ${idCol}`)[0]).toContain(`${stateCol},`);
  });
});
