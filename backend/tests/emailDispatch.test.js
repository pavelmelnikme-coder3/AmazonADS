"use strict";
/**
 * Campaign dispatch: recipient resolution + batching + idempotent per-batch send.
 */
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/services/email/ses", () => ({
  isConfigured: jest.fn().mockReturnValue(true),
  sendBulkEmail: jest.fn(),
}));

const { query: dbQuery } = require("../src/db/pool");
const ses = require("../src/services/email/ses");

// SES_MAX_SEND_RATE = batch size; set before requiring dispatch.
process.env.SES_MAX_SEND_RATE = "2";
const dispatch = require("../src/services/email/dispatch");

beforeEach(() => { jest.clearAllMocks(); });

describe("prepareCampaign", () => {
  test("resolves recipients, inserts queued sends, sets sending, returns batches of SEND_RATE", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: "camp1", workspace_id: "ws1", segment_id: null }] }) // load campaign
      .mockResolvedValueOnce({ rows: [{ id: "c1" }, { id: "c2" }, { id: "c3" }] })                // resolveRecipientIds
      .mockResolvedValueOnce({ rows: [] })  // INSERT queued sends
      .mockResolvedValueOnce({ rows: [] }); // UPDATE status=sending

    const r = await dispatch.prepareCampaign("camp1");
    expect(r.total).toBe(3);
    expect(r.batches).toEqual([["c1", "c2"], ["c3"]]); // SEND_RATE = 2
    // queued send rows inserted with ON CONFLICT DO NOTHING
    const insert = dbQuery.mock.calls.find((c) => /INSERT INTO email_sends/.test(c[0]));
    expect(insert[0]).toMatch(/ON CONFLICT \(campaign_id, contact_id\) DO NOTHING/);
    // status flipped to 'sending' with recipient count
    const upd = dbQuery.mock.calls.find((c) => /UPDATE email_campaigns SET status='sending'/.test(c[0]));
    expect(upd[1]).toEqual(["camp1", 3]);
  });

  test("resolveRecipientIds excludes suppressed and applies segment tags", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ filter: { tags: ["vip"] } }] }) // segment lookup
           .mockResolvedValueOnce({ rows: [{ id: "c1" }] });                  // contacts
    const ids = await dispatch.resolveRecipientIds({ workspace_id: "ws1", segment_id: "seg1" });
    expect(ids).toEqual(["c1"]);
    const sql = dbQuery.mock.calls[1][0];
    expect(sql).toMatch(/NOT EXISTS/);            // suppression exclusion
    expect(sql).toMatch(/c\.tags && \$2::text\[\]/); // tag filter
  });
});

describe("processBatch idempotency + counters", () => {
  test("sends only still-queued contacts, updates send rows + counter, finishes campaign", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: "camp1", workspace_id: "ws1", subject: "Hi {{first_name}}", html_body: "<p>{{first_name}}</p>", from_email: "f@x.com" }] }) // load campaign
      .mockResolvedValueOnce({ rows: [ // queued contacts (c2 already sent → not returned)
        { id: "c1", email: "a@b.com", first_name: "Ann", attributes: {}, unsubscribe_token: "t1" },
      ] })
      .mockResolvedValueOnce({ rows: [] })  // UPDATE email_sends for c1
      .mockResolvedValueOnce({ rows: [] })  // UPDATE campaign sent+1
      .mockResolvedValueOnce({ rows: [{ n: 0 }] }) // maybeFinish: none queued
      .mockResolvedValueOnce({ rows: [] }); // UPDATE campaign sent/sent_at

    ses.sendBulkEmail.mockResolvedValueOnce([{ email: "a@b.com", messageId: "m1", status: "sent", error: null }]);

    const r = await dispatch.processBatch({ campaignId: "camp1", contactIds: ["c1", "c2"] });
    expect(r).toEqual({ sent: 1, failed: 0 });
    // only queued contacts were queried (c2 excluded by the s.status='queued' join filter)
    const sel = dbQuery.mock.calls[1][0];
    expect(sel).toMatch(/s\.status = 'queued'/);
    // SES called with the rendered, merged entry
    const entry = ses.sendBulkEmail.mock.calls[0][0].entries[0];
    expect(entry.subject).toBe("Hi Ann");
    expect(entry.html).toContain("<p>Ann</p>");
    // campaign marked sent once nothing queued remains
    expect(dbQuery.mock.calls.some((c) => /SET status='sent'/.test(c[0]))).toBe(true);
  });

  test("no queued contacts → no send, still checks finish", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: "camp1", workspace_id: "ws1" }] }) // campaign
      .mockResolvedValueOnce({ rows: [] })                                      // no queued contacts
      .mockResolvedValueOnce({ rows: [{ n: 2 }] });                            // maybeFinish: still queued elsewhere
    const r = await dispatch.processBatch({ campaignId: "camp1", contactIds: ["c1"] });
    expect(r).toEqual({ sent: 0, failed: 0 });
    expect(ses.sendBulkEmail).not.toHaveBeenCalled();
  });
});
