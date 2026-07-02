"use strict";
/**
 * POST /email/webhooks/brevo — Brevo isn't a signed webhook provider, so authenticity is a
 * shared secret baked into the URL (BREVO_WEBHOOK_SECRET). Route-level: secret enforcement +
 * that the handler is actually wired up to applyBrevoEvent. Event-type logic itself is
 * covered by the applyBrevoEvent unit tests in emailPublic.test.js.
 */
const request = require("supertest");
const express = require("express");

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { query: dbQuery } = require("../src/db/pool");
const router = require("../src/routes/emailPublic");

function app() {
  const a = express();
  a.use("/email", router);
  return a;
}

beforeEach(() => { jest.clearAllMocks(); delete process.env.BREVO_WEBHOOK_SECRET; });

test("no secret configured on the server → fails closed (403), not silently accepted", async () => {
  const res = await request(app()).post("/email/webhooks/brevo").send({ event: "delivered", tag: "s1" });
  expect(res.status).toBe(403);
  expect(dbQuery).not.toHaveBeenCalled();
});

test("secret configured but missing/wrong on the request → 403", async () => {
  process.env.BREVO_WEBHOOK_SECRET = "correct-secret";
  const res = await request(app()).post("/email/webhooks/brevo").send({ event: "delivered", tag: "s1" });
  expect(res.status).toBe(403);

  const res2 = await request(app()).post("/email/webhooks/brevo?token=wrong").send({ event: "delivered", tag: "s1" });
  expect(res2.status).toBe(403);
  expect(dbQuery).not.toHaveBeenCalled();
});

test("correct secret + single event object → processed, 200", async () => {
  process.env.BREVO_WEBHOOK_SECRET = "correct-secret";
  dbQuery.mockResolvedValueOnce({ rows: [] }); // tag lookup finds nothing → no-op, still 200
  const res = await request(app()).post("/email/webhooks/brevo?token=correct-secret").send({ event: "delivered", tag: "s1" });
  expect(res.status).toBe(200);
  expect(dbQuery).toHaveBeenCalledTimes(1);
});

test("correct secret + array of events → each processed", async () => {
  process.env.BREVO_WEBHOOK_SECRET = "correct-secret";
  dbQuery.mockResolvedValue({ rows: [] });
  const res = await request(app()).post("/email/webhooks/brevo?token=correct-secret")
    .send([{ event: "delivered", tag: "s1" }, { event: "opened", tag: "s2" }]);
  expect(res.status).toBe(200);
  expect(dbQuery).toHaveBeenCalledTimes(2); // one lookup per event, both find nothing
});

test("a DB error mid-processing still returns 200 (no SNS/Brevo retry-storm on transient failure)", async () => {
  process.env.BREVO_WEBHOOK_SECRET = "correct-secret";
  dbQuery.mockRejectedValueOnce(new Error("db down"));
  const res = await request(app()).post("/email/webhooks/brevo?token=correct-secret").send({ event: "delivered", tag: "s1" });
  expect(res.status).toBe(200);
});
