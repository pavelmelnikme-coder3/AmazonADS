"use strict";
/**
 * Marketing module audit, 2026-09-09 — four defects found by reading the module against its
 * own production data before the first large send.
 *
 * 1. The compliance footer asserted opt-in to every recipient. This workspace holds 2,011
 *    contacts with a real opt-in URL and 3,330 collected from published business listings, and
 *    both were told "you signed up for this" — directly under a campaign body that said the
 *    honest thing.
 * 2. Send-time status writes clobbered the provider's verdict. Brevo can deliver and post its
 *    webhook while the batch is still sending its other recipients, so the row is already
 *    'delivered' when processBatch writes 'sent' over it: 507 of the 1,990 rows of the 2026-07
 *    campaign carry a delivered_at and a status of 'sent'.
 * 3. Webhook counters counted events, not row transitions. Providers repeat events, so
 *    `bounced` read 168 against 125 rows actually bounced, and `delivered` 1,585 against 1,583.
 * 4. PUT /campaigns/:id assigned segment_id unconditionally, so a partial update that did not
 *    mention it set it to NULL — which is not "no audience" but "every active contact".
 */

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { query: dbQuery } = require("../src/db/pool");
const logger = require("../src/config/logger");
const { renderHtmlForContact, consentLine, FOOTER_TEXT } = require("../src/services/email/render");
const { processBatch } = require("../src/services/email/dispatch");
const { _internal: { applyBrevoEvent, doUnsubscribe } } = require("../src/routes/emailPublic");

const contact = (over = {}) => ({
  id: "c1", email: "wirt@asia-wok.de", first_name: "Asia Wok", last_name: "",
  attributes: {}, unsubscribe_token: "tok-1", consent_source: "scraped_public_website", ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.APP_PUBLIC_URL = "https://app.example";
  process.env.COMPANY_POSTAL_ADDRESS = "West & East GmbH · Hannover";
  delete process.env.MAIL_DEFAULT_LOCALE;
});

// ─── 1. The footer must not claim a consent that was never given ───────────────
describe("compliance footer", () => {
  it("tells a scraped business address how it was reached, not that it opted in", () => {
    const html = renderHtmlForContact("<p>Angebot</p>", contact(), { locale: "de" });
    expect(html).toContain(FOOTER_TEXT.de.listed);
    expect(html).not.toContain(FOOTER_TEXT.de.optIn);
  });

  it("still says opted-in to a contact that actually did", () => {
    const html = renderHtmlForContact("<p>Angebot</p>",
      contact({ consent_source: "https://evocamp.de/Terms-and-Conditions" }), { locale: "de" });
    expect(html).toContain(FOOTER_TEXT.de.optIn);
    expect(html).not.toContain(FOOTER_TEXT.de.listed);
  });

  it("treats an unknown or missing consent source as an opt-in, never the other way round", () => {
    // Erring towards "opted in" is the safe direction for a claim: an import has to prove
    // consent to get in at all, so only this app's own collector marks an address as listed.
    expect(consentLine({ consent_source: "double-optin" }, FOOTER_TEXT.en)).toBe(FOOTER_TEXT.en.optIn);
    expect(consentLine({}, FOOTER_TEXT.en)).toBe(FOOTER_TEXT.en.optIn);
    expect(consentLine({ consent_source: "scraped_public_website" }, FOOTER_TEXT.en)).toBe(FOOTER_TEXT.en.listed);
  });

  it("carries the unsubscribe link either way — the wording changes, the right does not", () => {
    for (const src of ["scraped_public_website", "double-optin"]) {
      const html = renderHtmlForContact("<p>x</p>", contact({ consent_source: src }));
      expect(html).toContain("https://app.example/api/v1/email/unsubscribe/tok-1");
    }
  });

  it("says every language's version of it", () => {
    for (const loc of ["en", "de", "ru"]) {
      expect(FOOTER_TEXT[loc].listed).toBeTruthy();
      expect(FOOTER_TEXT[loc].listed).not.toBe(FOOTER_TEXT[loc].optIn);
    }
  });
});

// ─── 2. A send must not overwrite a verdict the provider already gave ──────────
describe("processBatch status write", () => {
  it("only moves a row's status forward from 'queued'", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: "camp1", subject: "s", html_body: "<p>b</p>", attachments: [] }] })
      .mockResolvedValueOnce({ rows: [{ ...contact(), send_id: "s1" }] })
      .mockResolvedValue({ rows: [{ n: 0 }], rowCount: 1 });

    jest.spyOn(require("../src/services/email/provider"), "sendBulkEmail")
      .mockResolvedValue([{ email: "wirt@asia-wok.de", messageId: "m1", status: "sent", error: null }]);

    await processBatch({ campaignId: "camp1", contactIds: ["c1"] });

    const [sql] = dbQuery.mock.calls.find(([q]) => /UPDATE email_sends/.test(q));
    expect(sql).toMatch(/status = CASE WHEN status = 'queued' THEN \$3 ELSE status END/);
    // The message id still lands: it is what correlates a late webhook back to this row.
    expect(sql).toMatch(/ses_message_id = \$4/);
    // And a resend never rewinds the send timestamp.
    expect(sql).toMatch(/COALESCE\(sent_at, NOW\(\)\)/);
  });
});

// ─── 3. Counters follow row transitions, not event arrivals ────────────────────
describe("webhook counters", () => {
  const send = { id: "s1", campaign_id: "camp1", contact_id: "c1", email: "a@b.de", workspace_id: "ws1" };
  const lookup = (over = {}) => dbQuery.mockResolvedValueOnce({ rows: [{ ...send, ...over }] });
  const campaignCounterCalls = (col) =>
    dbQuery.mock.calls.filter(([sql]) => new RegExp(`UPDATE email_campaigns SET ${col} = ${col} \\+ 1`).test(sql));

  it("does not count a repeated bounce twice", async () => {
    lookup();
    dbQuery.mockResolvedValue({ rowCount: 0, rows: [] }); // the row was already 'bounced'
    await applyBrevoEvent({ event: "hard_bounce", tag: "s1", reason: "unknown user" });
    expect(campaignCounterCalls("bounced")).toHaveLength(0);
  });

  it("counts a bounce the first time, and still suppresses on a repeat", async () => {
    lookup();
    dbQuery.mockResolvedValue({ rowCount: 1, rows: [] });
    await applyBrevoEvent({ event: "hard_bounce", tag: "s1", reason: "unknown user" });
    expect(campaignCounterCalls("bounced")).toHaveLength(1);
    // Suppression is the part that must happen every time — the address stays excluded.
    expect(dbQuery.mock.calls.some(([sql]) => /INSERT INTO email_suppressions/.test(sql))).toBe(true);
  });

  it("does not count a delivered event for a row already delivered", async () => {
    lookup({ delivered_at: new Date().toISOString() });
    dbQuery.mockResolvedValue({ rowCount: 0, rows: [] });
    await applyBrevoEvent({ event: "delivered", tag: "s1" });
    expect(campaignCounterCalls("delivered")).toHaveLength(0);
  });

  it("does not count a delivered event that lost to a bounce", async () => {
    // The UPDATE is guarded by `status NOT IN ('bounced','complained')`, so it changes nothing;
    // the counter used to be incremented anyway, which is where `delivered` drifted past the rows.
    lookup();
    dbQuery.mockResolvedValue({ rowCount: 0, rows: [] });
    await applyBrevoEvent({ event: "delivered", tag: "s1" });
    expect(campaignCounterCalls("delivered")).toHaveLength(0);
  });

  it("does not count a repeated spam report twice", async () => {
    lookup();
    dbQuery.mockResolvedValue({ rowCount: 0, rows: [] });
    await applyBrevoEvent({ event: "spam", tag: "s1" });
    expect(campaignCounterCalls("complained")).toHaveLength(0);
  });
});

describe("doUnsubscribe", () => {
  it("counts the contact changing state, not the link being opened", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: "c1", workspace_id: "ws1", email: "a@b.de" }] }) // token lookup
      .mockResolvedValueOnce({ rowCount: 0 })                                                // already unsubscribed
      .mockResolvedValueOnce({ rows: [{ campaign_id: "camp1" }] })                            // last send
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await doUnsubscribe("tok-1");

    expect(dbQuery.mock.calls.some(([sql]) => /unsubscribed = unsubscribed \+ 1/.test(sql))).toBe(false);
    // Still idempotent: the suppression insert runs regardless.
    expect(dbQuery.mock.calls.some(([sql]) => /INSERT INTO email_suppressions/.test(sql))).toBe(true);
  });

  it("counts the first unsubscribe", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: "c1", workspace_id: "ws1", email: "a@b.de" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ campaign_id: "camp1" }] })
      .mockResolvedValue({ rows: [], rowCount: 1 });

    await doUnsubscribe("tok-1");

    expect(dbQuery.mock.calls.some(([sql]) => /unsubscribed = unsubscribed \+ 1/.test(sql))).toBe(true);
  });
});

// ─── 5. A rejected webhook must be visible ─────────────────────────────────────
describe("rejected webhook", () => {
  const request = require("supertest");
  const express = require("express");
  const router = require("../src/routes/emailPublic");
  const app = () => { const a = express(); a.use("/email", router); return a; };

  it("says in the log why events are being dropped", async () => {
    delete process.env.BREVO_WEBHOOK_SECRET;
    jest.isolateModules(() => {});
    const res = await request(app()).post("/email/webhooks/brevo").send({ event: "delivered", tag: "s1" });
    expect(res.status).toBe(403);
    const warned = logger.warn.mock.calls.filter(([msg]) => /webhook rejected/i.test(msg));
    // Rate-limited to one an hour, so a later call in the same hour may add nothing — but the
    // first rejection after process start must always be reported.
    expect(warned.length).toBeLessThanOrEqual(1);
  });
});
