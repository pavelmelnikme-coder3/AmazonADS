"use strict";
/**
 * Postgres SSL is its own setting, not a side effect of NODE_ENV.
 *
 * `ssl: NODE_ENV === "production"` made setting NODE_ENV correctly a way to take the app down.
 * This deployment runs Postgres in a container with `ssl = off` (verified 2026-09-07), so pg
 * would offer SSL, the server would refuse, connectDB() would throw and the backend would never
 * start — while the ROADMAP told whoever read it to set exactly that flag.
 */
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const captured = [];
jest.mock("pg", () => ({
  Pool: jest.fn(function (cfg) {
    captured.push(cfg);
    this.on = jest.fn();
    this.connect = jest.fn().mockResolvedValue({ query: jest.fn().mockResolvedValue({}), release: jest.fn() });
    this.query = jest.fn();
  }),
}));

const { connectDB } = require("../src/db/pool");

const withEnv = async (env, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  try { return await fn(); } finally { process.env = saved; }
};

beforeEach(() => { captured.length = 0; });

test("NODE_ENV=production alone does NOT turn SSL on", async () => {
  await withEnv({ NODE_ENV: "production", DATABASE_SSL: "" }, connectDB);
  expect(captured[0].ssl).toBe(false);
});

test("DATABASE_SSL turns it on explicitly", async () => {
  for (const v of ["true", "1", "yes", "require", "TRUE"]) {
    captured.length = 0;
    await withEnv({ NODE_ENV: "development", DATABASE_SSL: v }, connectDB);
    expect(captured[0].ssl).toEqual({ rejectUnauthorized: true });
  }
});

test("certificate checking can be relaxed separately, and defaults to on", async () => {
  await withEnv({ DATABASE_SSL: "true", DATABASE_SSL_REJECT_UNAUTHORIZED: "false" }, connectDB);
  expect(captured[0].ssl).toEqual({ rejectUnauthorized: false });
});

test("anything else leaves SSL off", async () => {
  for (const v of ["", "false", "no", "0", undefined]) {
    captured.length = 0;
    await withEnv({ DATABASE_SSL: v }, connectDB);
    expect(captured[0].ssl).toBe(false);
  }
});
