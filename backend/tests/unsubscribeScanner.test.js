"use strict";
/**
 * A GET on the unsubscribe link must not unsubscribe anybody.
 *
 * It used to, which reads as reasonable — a human clicking a link sends a GET. But this list is
 * 3,102 business mailboxes, and corporate mail gateways (Outlook Safe Links, Proofpoint,
 * Mimecast) fetch every URL in a message before the recipient sees it. Those recipients would
 * have been removed by a scanner, silently, indistinguishable from a real opt-out.
 *
 * It was not theory. An internal check script fetched a live token to confirm the route answered
 * 200 and unsubscribed a real contact, which then had to be restored by hand.
 *
 * The legally required one-click path is unaffected: RFC 8058 puts it on POST
 * (List-Unsubscribe-Post), which is what a mail client's own Unsubscribe button uses.
 */
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("sns-validator", () => jest.fn().mockImplementation(() => ({ validate: jest.fn() })));

const request = require("supertest");
const express = require("express");
const { query } = require("../src/db/pool");

const TOKEN = "tok-of-a-real-contact";

function app() {
  const a = express();
  a.use("/api/v1/email", require("../src/routes/emailPublic"));
  return a;
}

// The queries doUnsubscribe walks, in order: find contact → flip status → last send → suppress.
function mockContactFound() {
  query.mockReset();
  query
    .mockResolvedValueOnce({ rows: [{ id: "c1", workspace_id: "ws1", email: "info@restaurant.de" }] })
    .mockResolvedValueOnce({ rowCount: 1 })
    .mockResolvedValueOnce({ rows: [{ campaign_id: "camp1" }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [] });
}

const wrote = () => query.mock.calls.some(([sql]) =>
  /UPDATE email_contacts|INSERT INTO email_suppressions|UPDATE email_campaigns/.test(sql));

beforeEach(() => { query.mockReset(); });

describe("GET only asks", () => {
  test("a scanner fetching the link changes nothing", async () => {
    query.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    const res = await request(app()).get(`/api/v1/email/unsubscribe/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(wrote()).toBe(false);
  });

  test("the page offers a form that posts back to the same token", async () => {
    query.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    const res = await request(app()).get(`/api/v1/email/unsubscribe/${TOKEN}`);
    expect(res.text).toMatch(/<form method="post"/);
    expect(res.text).toContain(`/api/v1/email/unsubscribe/${TOKEN}`);
  });

  test("an unknown token says so instead of showing a button that does nothing", async () => {
    query.mockResolvedValue({ rows: [] });
    const res = await request(app()).get("/api/v1/email/unsubscribe/nobody");
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/<form/);
    expect(wrote()).toBe(false);
  });

  test("a database failure still renders a page rather than a stack trace", async () => {
    query.mockRejectedValue(new Error("db down"));
    const res = await request(app()).get(`/api/v1/email/unsubscribe/${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<h1/);
  });
});

describe("POST is the one that acts", () => {
  test("one-click from a mail client unsubscribes and answers 200", async () => {
    mockContactFound();
    const res = await request(app())
      .post(`/api/v1/email/unsubscribe/${TOKEN}`)
      .send("List-Unsubscribe=One-Click");
    expect(res.status).toBe(200);
    expect(query.mock.calls.some(([sql]) => /UPDATE email_contacts SET status='unsubscribed'/.test(sql))).toBe(true);
    expect(query.mock.calls.some(([sql]) => /INSERT INTO email_suppressions/.test(sql))).toBe(true);
  });

  test("the confirmation form gets a page back, not the bare word", async () => {
    mockContactFound();
    const res = await request(app())
      .post(`/api/v1/email/unsubscribe/${TOKEN}`)
      .set("Accept", "text/html")
      .send("");
    expect(res.text).toMatch(/<h1/);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
  });

  // Providers retry on non-2xx, and a retry storm on a transient database error would be worse
  // than a lost event.
  test("a database failure still answers 200", async () => {
    query.mockRejectedValue(new Error("db down"));
    const res = await request(app()).post(`/api/v1/email/unsubscribe/${TOKEN}`).send("");
    expect(res.status).toBe(200);
  });
});

describe("the page speaks the recipient's language", () => {
  test.each([["de", /Abmelden/], ["ru", /Отпис/], ["en", /Unsubscribe/]])(
    "?lang=%s renders %p", async (lang, re) => {
      query.mockResolvedValue({ rows: [{ "?column?": 1 }] });
      const res = await request(app()).get(`/api/v1/email/unsubscribe/${TOKEN}?lang=${lang}`);
      expect(res.text).toMatch(re);
    });

  test("an unknown language falls back to English rather than an empty page", async () => {
    query.mockResolvedValue({ rows: [{ "?column?": 1 }] });
    const res = await request(app()).get(`/api/v1/email/unsubscribe/${TOKEN}?lang=zz`);
    expect(res.text).toMatch(/Unsubscribe/);
  });
});
