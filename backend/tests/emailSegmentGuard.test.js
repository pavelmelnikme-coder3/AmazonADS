"use strict";
/**
 * Deleting a segment must not silently widen a campaign's audience.
 *
 * email_campaigns.segment_id is ON DELETE SET NULL, and NULL is not "no audience" — it is
 * "every active contact" (resolveRecipientIds applies no tag filter without a segment). So
 * deleting a segment a campaign still points at does not disarm that campaign, it aims it at
 * the whole list. Reproduced against the live schema on 2026-09-08: a draft pointing at a
 * segment came back with segment_id NULL the instant the segment was deleted, which in that
 * workspace would have turned a 3,248-recipient send into 5,297.
 *
 * The list delete had a guard, but only for 'sending' and 'scheduled' — the two states in
 * which a campaign is least likely to be sitting when someone tidies up lists. A draft, the
 * ordinary case, walked straight through. Deleting a segment directly had no guard at all.
 */
const request = require("supertest");
const express = require("express");

const WS_ID = "ws---0001-0000-0000-000000000001";
const ORG_ID = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const SEG_ID = "seg--0001-0000-0000-000000000001";

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/routes/audit", () => ({ writeAudit: jest.fn().mockResolvedValue("aud1"), updateAuditStatus: jest.fn() }));
jest.mock("../src/services/email/provider", () => ({ name: jest.fn().mockReturnValue("brevo"), isConfigured: jest.fn(), sendBulkEmail: jest.fn() }));
jest.mock("../src/services/email/dispatch", () => ({ resolveRecipientIds: jest.fn() }));
jest.mock("../src/jobs/workers", () => ({ queueEmailCampaign: jest.fn() }));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => { req.user = { id: USER_ID, name: "T", org_id: ORG_ID }; req.orgId = ORG_ID; next(); },
  requireWorkspace: (req, _res, next) => { req.workspaceId = WS_ID; req.workspaceRole = "owner"; next(); },
}));

const { query: dbQuery } = require("../src/db/pool");
const { resolveRecipientIds } = require("../src/services/email/dispatch");
const router = require("../src/routes/emailMarketing");

function app() {
  const a = express(); a.use(express.json()); a.use("/email-marketing", router);
  a.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return a;
}
beforeEach(() => jest.clearAllMocks());

describe("DELETE /segments/:id", () => {
  test("refuses while a draft campaign still points at it, and names the campaign", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ name: "asian_b2b", status: "draft" }] });

    const res = await request(app()).delete(`/email-marketing/segments/${SEG_ID}`);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/asian_b2b/);
    expect(res.body.error).toMatch(/draft/);
    expect(res.body.error).toMatch(/every active contact/i);
    // Nothing was deleted.
    expect(dbQuery.mock.calls.some(([sql]) => /DELETE FROM email_segments/.test(sql))).toBe(false);
  });

  test("guards every state a campaign can still be sent from", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app()).delete(`/email-marketing/segments/${SEG_ID}`);
    const [, params] = dbQuery.mock.calls[0];
    expect(params[2].sort()).toEqual(["draft", "paused", "scheduled", "sending"]);
  });

  test("deletes once nothing sendable points at it", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })         // no blocking campaigns
      .mockResolvedValueOnce({ rowCount: 1 });     // the delete
    const res = await request(app()).delete(`/email-marketing/segments/${SEG_ID}`);
    expect(res.status).toBe(200);
    expect(dbQuery.mock.calls.some(([sql]) => /DELETE FROM email_segments/.test(sql))).toBe(true);
  });

  test("a finished campaign never blocks a cleanup", async () => {
    // 'sent' and 'failed' will not send again; blocking forever over them would be its own bug.
    dbQuery.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rowCount: 1 });
    const res = await request(app()).delete(`/email-marketing/segments/${SEG_ID}`);
    expect(res.status).toBe(200);
    const [, params] = dbQuery.mock.calls[0];
    expect(params[2]).not.toContain("sent");
    expect(params[2]).not.toContain("failed");
  });
});

describe("DELETE /contacts/lists/:tag", () => {
  // count → segments defined by the tag → blocking campaigns → …
  const listDeleteFlow = ({ total = 5, segments = [{ id: SEG_ID }], blocking = [] }) => {
    dbQuery.mockReset();
    dbQuery
      .mockResolvedValueOnce({ rows: [{ count: total }] })
      .mockResolvedValueOnce({ rows: segments })
      .mockResolvedValueOnce({ rows: blocking })
      .mockResolvedValue({ rowCount: 1, rows: [] });
  };

  test("a draft campaign on that list's segment now blocks the delete too", async () => {
    listDeleteFlow({ blocking: [{ name: "asian_b2b", status: "draft" }] });

    const res = await request(app()).delete("/email-marketing/contacts/lists/asian_b2b");

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/asian_b2b/);
    expect(dbQuery.mock.calls.some(([sql]) => /DELETE FROM email_contacts/.test(sql))).toBe(false);
    expect(dbQuery.mock.calls.some(([sql]) => /UPDATE email_contacts SET tags/.test(sql))).toBe(false);
  });

  test("goes through when no campaign depends on the list", async () => {
    listDeleteFlow({});
    const res = await request(app()).delete("/email-marketing/contacts/lists/asian_b2b");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, tag: "asian_b2b", mode: "untag" });
  });

  test("404s for a tag no contact carries", async () => {
    dbQuery.mockReset();
    dbQuery.mockResolvedValueOnce({ rows: [{ count: 0 }] });
    const res = await request(app()).delete("/email-marketing/contacts/lists/nope");
    expect(res.status).toBe(404);
  });
});

describe("GET /campaigns/:id/audience", () => {
  test("reports the count and the segment it came from", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: "c1", workspace_id: WS_ID, segment_id: SEG_ID }] })
      .mockResolvedValueOnce({ rows: [{ name: "asian_b2b" }] });
    resolveRecipientIds.mockResolvedValue(["a", "b", "c"]);

    const res = await request(app()).get("/email-marketing/campaigns/c1/audience");

    expect(res.body).toEqual({ recipients: 3, segment_id: SEG_ID, segment_name: "asian_b2b", all_contacts: false });
  });

  test("says plainly when a campaign has no segment and would go to everyone", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: "c1", workspace_id: WS_ID, segment_id: null }] });
    resolveRecipientIds.mockResolvedValue(new Array(5297).fill("x"));

    const res = await request(app()).get("/email-marketing/campaigns/c1/audience");

    expect(res.body).toMatchObject({ recipients: 5297, all_contacts: true, segment_name: null });
  });

  test("404s for a campaign in another workspace", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).get("/email-marketing/campaigns/c1/audience");
    expect(res.status).toBe(404);
    expect(resolveRecipientIds).not.toHaveBeenCalled();
  });
});
