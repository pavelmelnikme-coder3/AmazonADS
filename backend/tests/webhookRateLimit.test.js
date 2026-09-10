"use strict";
/**
 * Provider webhooks must not share the per-IP request budget with user traffic.
 *
 * Every event Brevo posts for a campaign arrives from one source address in a burst that tracks
 * the send rate. During the asian_b2b send — 250 messages in a minute — the general 300/min
 * ceiling started answering 429, and a rejected webhook is a lost event: a wrong number in the
 * stats, and worse, a hard_bounce that never reaches the suppression list, so the address stays
 * on the list and bounces again on the next campaign.
 */
const request = require("supertest");
const express = require("express");
const rateLimit = require("express-rate-limit");

// The same wiring app.js uses, kept in one place so the test exercises the real shape.
function buildApp({ generalMax = 3, webhookMax = 50 } = {}) {
  const app = express();
  app.set("trust proxy", false);
  const WEBHOOK_PATHS = ["/v1/email/webhooks/brevo", "/v1/email/webhooks/ses"];
  const isWebhook = (req) => WEBHOOK_PATHS.some((p) => req.path.startsWith(p));
  const webhookLimiter = rateLimit({ windowMs: 60_000, max: webhookMax, legacyHeaders: false });
  const limiter = rateLimit({ windowMs: 60_000, max: generalMax, skip: isWebhook, legacyHeaders: false });
  app.use("/api/", (req, res, next) => (isWebhook(req) ? webhookLimiter : limiter)(req, res, next));
  app.all("/api/*", (req, res) => res.status(200).send("ok"));
  return app;
}

// One listening server per test, reused for every request in it.
//
// `request(app)` binds a fresh ephemeral server for each call, and these tests fire twenty or
// more in a row. Under a loaded parallel run that churn occasionally produced a "socket hang up"
// — roughly one full-suite run in eight, always in this file. Nothing to do with rate limiting;
// the sockets simply ran out from under it.
const servers = [];
const listen = (app) => { const s = app.listen(0); servers.push(s); return s; };
afterEach(() => { while (servers.length) servers.pop().close(); });

const hammer = async (server, path, n, method = "post") => {
  const codes = [];
  for (let i = 0; i < n; i++) codes.push((await request(server)[method](path)).status);
  return codes;
};

describe("the general limiter still protects user traffic", () => {
  test("ordinary API calls are cut off at the ceiling", async () => {
    const app = listen(buildApp({ generalMax: 3 }));
    const codes = await hammer(app, "/api/v1/campaigns", 5, "get");
    expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
    expect(codes.slice(3)).toEqual([429, 429]);
  });
});

describe("webhooks are on their own budget", () => {
  test("a burst well past the user ceiling is still accepted", async () => {
    const app = listen(buildApp({ generalMax: 3, webhookMax: 50 }));
    const codes = await hammer(app, "/api/v1/email/webhooks/brevo?token=s", 20);
    expect(codes.every((c) => c === 200)).toBe(true);
  });

  test("the SES webhook gets the same treatment", async () => {
    const app = listen(buildApp({ generalMax: 3, webhookMax: 50 }));
    const codes = await hammer(app, "/api/v1/email/webhooks/ses", 20);
    expect(codes.every((c) => c === 200)).toBe(true);
  });

  // The point of the split: a flood of webhook events must not use up the budget that keeps
  // the app usable, and vice versa.
  test("webhook traffic does not consume the user budget", async () => {
    const app = listen(buildApp({ generalMax: 3, webhookMax: 50 }));
    await hammer(app, "/api/v1/email/webhooks/brevo?token=s", 20);
    const codes = await hammer(app, "/api/v1/campaigns", 3, "get");
    expect(codes).toEqual([200, 200, 200]);
  });

  test("user traffic does not consume the webhook budget", async () => {
    const app = listen(buildApp({ generalMax: 3, webhookMax: 50 }));
    await hammer(app, "/api/v1/campaigns", 5, "get");
    const codes = await hammer(app, "/api/v1/email/webhooks/brevo?token=s", 10);
    expect(codes.every((c) => c === 200)).toBe(true);
  });

  // Not unlimited — the exemption is a bigger bucket, not the absence of one.
  test("the webhook budget has a ceiling of its own", async () => {
    const app = listen(buildApp({ generalMax: 3, webhookMax: 5 }));
    const codes = await hammer(app, "/api/v1/email/webhooks/brevo?token=s", 7);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  // Only the two webhook routes are exempt; nothing else under /email may borrow the bucket.
  test("other public email routes stay on the user budget", async () => {
    const app = listen(buildApp({ generalMax: 3 }));
    const codes = await hammer(app, "/api/v1/email/unsubscribe/tok", 5, "get");
    expect(codes.slice(3)).toEqual([429, 429]);
  });
});
