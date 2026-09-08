"use strict";
/**
 * DELETE /contacts/lists/:tag — removing a whole list.
 *
 * "Delete this list" is ambiguous in a way that matters: the list can go while the people
 * stay (they may be real contacts filed under the wrong name — exactly the case that prompted
 * this, a lead search mislabelled `asian` that actually collected German inns), or the people
 * can go with it. The caller has to say which, and a contact that also belongs to another list
 * is never deleted by either — it was not this list's to remove.
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
jest.mock("../src/jobs/workers", () => ({ queueEmailCampaign: jest.fn() }));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => { req.user = { id: USER_ID, name: "T", org_id: ORG_ID }; req.orgId = ORG_ID; next(); },
  requireWorkspace: (req, _res, next) => { req.workspaceId = WS_ID; req.workspaceRole = "owner"; next(); },
}));

const { query: dbQuery } = require("../src/db/pool");
const { writeAudit } = require("../src/routes/audit");
const router = require("../src/routes/emailMarketing");

function app() {
  const a = express(); a.use(express.json()); a.use("/email-marketing", router);
  a.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return a;
}

// The route's query sequence: count → segments → [campaigns still pointing at them] →
// [delete contacts] → untag → [delete segments].
function mockSequence({ count = 131, segments = [], blocking = [], deleted = 0, untagged = 131 } = {}) {
  const calls = [];
  dbQuery.mockImplementation((sql) => {
    calls.push(sql);
    if (/COUNT\(\*\)::int AS count FROM email_contacts/.test(sql)) return Promise.resolve({ rows: [{ count }] });
    if (/FROM email_segments/.test(sql) && /SELECT/.test(sql)) return Promise.resolve({ rows: segments });
    if (/SELECT name, status FROM email_campaigns/.test(sql)) return Promise.resolve({ rows: blocking });
    if (/DELETE FROM email_contacts/.test(sql)) return Promise.resolve({ rowCount: deleted });
    if (/UPDATE email_contacts SET tags = array_remove/.test(sql)) return Promise.resolve({ rowCount: untagged });
    if (/DELETE FROM email_segments/.test(sql)) return Promise.resolve({ rowCount: segments.length });
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  return calls;
}

const delList = (tag, mode) =>
  request(app()).delete(`/email-marketing/contacts/lists/${encodeURIComponent(tag)}${mode ? `?mode=${mode}` : ""}`);

beforeEach(() => jest.clearAllMocks());

describe("default mode keeps the people", () => {
  test("no mode given → contacts are untagged, never deleted", async () => {
    const calls = mockSequence({ untagged: 131 });
    const res = await delList("asian");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "untag", untagged: 131, deleted_contacts: 0 });
    expect(calls.some(s => /DELETE FROM email_contacts/.test(s))).toBe(false);
  });

  test("an unrecognised mode is not treated as the destructive one", async () => {
    const calls = mockSequence();
    const res = await delList("asian", "everything");
    expect(res.body.mode).toBe("untag");
    expect(calls.some(s => /DELETE FROM email_contacts/.test(s))).toBe(false);
  });
});

describe("mode=contacts deletes only what belongs to this list alone", () => {
  test("deletes single-list contacts and untags the rest", async () => {
    const calls = mockSequence({ count: 131, deleted: 120, untagged: 11 });
    const res = await delList("asian", "contacts");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: "contacts", deleted_contacts: 120, untagged: 11 });
    // The delete is constrained to contacts carrying exactly one tag.
    const delSql = calls.find(s => /DELETE FROM email_contacts/.test(s));
    expect(delSql).toMatch(/array_length\(tags, 1\) = 1/);
  });

  test("the untag pass still runs, so multi-list contacts lose this list", async () => {
    const calls = mockSequence({ deleted: 120, untagged: 11 });
    await delList("asian", "contacts");
    expect(calls.some(s => /UPDATE email_contacts SET tags = array_remove/.test(s))).toBe(true);
  });
});

describe("segments defined by the tag go with it", () => {
  test("a segment whose whole filter is this tag is deleted", async () => {
    mockSequence({ segments: [{ id: SEG_ID }] });
    const res = await delList("asian");
    expect(res.body.deleted_segments).toBe(1);
  });

  test("a campaign mid-send against that segment blocks the whole delete", async () => {
    const calls = mockSequence({ segments: [{ id: SEG_ID }], blocking: [{ name: "Spring", status: "sending" }] });
    const res = await delList("asian", "contacts");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Spring/);
    // Nothing may have been touched.
    expect(calls.some(s => /DELETE FROM email_contacts/.test(s))).toBe(false);
    expect(calls.some(s => /UPDATE email_contacts/.test(s))).toBe(false);
    expect(calls.some(s => /DELETE FROM email_segments/.test(s))).toBe(false);
  });

  // The old guard only knew 'sending' and 'scheduled' — the two states a campaign is least
  // likely to be in when someone tidies up lists. A draft, the ordinary case, went straight
  // through, and ON DELETE SET NULL then aimed it at every active contact.
  test("a draft campaign against that segment blocks it too", async () => {
    const calls = mockSequence({ segments: [{ id: SEG_ID }], blocking: [{ name: "asian_b2b", status: "draft" }] });
    const res = await delList("asian");
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/asian_b2b/);
    expect(calls.some(s => /DELETE FROM email_segments/.test(s))).toBe(false);
    expect(calls.some(s => /UPDATE email_contacts/.test(s))).toBe(false);
  });
});

describe("guards and bookkeeping", () => {
  test("404 when the list holds nobody", async () => {
    const calls = mockSequence({ count: 0 });
    const res = await delList("ghost");
    expect(res.status).toBe(404);
    expect(calls.some(s => /UPDATE email_contacts/.test(s))).toBe(false);
  });

  test("a blank tag is rejected before any query runs", async () => {
    mockSequence();
    const res = await delList("  ");  // encodeURIComponent turns this into %20%20
    expect(res.status).toBe(400);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  test("the destructive mode is audited under its own action name", async () => {
    mockSequence({ deleted: 120, untagged: 11 });
    await delList("asian", "contacts");
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "email_list.delete_with_contacts", entityType: "email_list", entityId: "asian",
    }));
  });

  test("the safe mode is audited separately, so the two are distinguishable later", async () => {
    mockSequence();
    await delList("asian");
    expect(writeAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "email_list.delete" }));
  });

  test("a tag with characters needing encoding still resolves", async () => {
    mockSequence({ count: 5, untagged: 5 });
    const res = await delList("lead:germany-pizza");
    expect(res.status).toBe(200);
    expect(res.body.tag).toBe("lead:germany-pizza");
  });
});
