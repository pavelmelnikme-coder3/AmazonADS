"use strict";
/**
 * Public email endpoints: unsubscribe (token → suppress) and SES/SNS webhook events.
 */
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { query: dbQuery } = require("../src/db/pool");
const { _internal } = require("../src/routes/emailPublic");

beforeEach(() => { jest.clearAllMocks(); });

describe("doUnsubscribe", () => {
  test("resolves token → marks contact unsubscribed + inserts suppression", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: "c1", workspace_id: "ws1", email: "a@b.com" }] }) // lookup token
      .mockResolvedValueOnce({ rows: [] })  // UPDATE contact unsubscribed
      .mockResolvedValueOnce({ rows: [] }); // INSERT suppression
    const ok = await _internal.doUnsubscribe("tok1");
    expect(ok).toBe(true);
    expect(dbQuery.mock.calls.some((c) => /status='unsubscribed'/.test(c[0]))).toBe(true);
    const sup = dbQuery.mock.calls.find((c) => /INSERT INTO email_suppressions/.test(c[0]));
    expect(sup[0]).toMatch(/'unsubscribe'/);
    expect(sup[0]).toMatch(/ON CONFLICT/);
  });

  test("unknown token → false, no writes", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    expect(await _internal.doUnsubscribe("nope")).toBe(false);
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });
});

describe("applySesEvent", () => {
  const sendRow = { id: "s1", campaign_id: "camp1", contact_id: "c1", email: "a@b.com", workspace_id: "ws1" };

  test("permanent bounce → mark bounced, suppress (hard_bounce), flag contact", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [sendRow] }) // find sends by messageId
      .mockResolvedValue({ rows: [] });           // all subsequent updates
    await _internal.applySesEvent({
      eventType: "Bounce", mail: { messageId: "m1" },
      bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: "a@b.com" }] },
    });
    const sqls = dbQuery.mock.calls.map((c) => c[0]);
    expect(sqls.some((s) => /SET status='bounced'/.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO email_suppressions/.test(s))).toBe(true);
    expect(sqls.some((s) => /bounced = bounced \+ 1/.test(s))).toBe(true);
    const sup = dbQuery.mock.calls.find((c) => /INSERT INTO email_suppressions/.test(c[0]));
    expect(sup[1]).toContain("hard_bounce");
  });

  test("transient bounce → marked bounced but NOT suppressed", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [sendRow] }).mockResolvedValue({ rows: [] });
    await _internal.applySesEvent({
      eventType: "Bounce", mail: { messageId: "m1" },
      bounce: { bounceType: "Transient", bouncedRecipients: [{ emailAddress: "a@b.com" }] },
    });
    expect(dbQuery.mock.calls.some((c) => /INSERT INTO email_suppressions/.test(c[0]))).toBe(false);
  });

  test("complaint → suppress (complaint) + flag contact complained", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [sendRow] }).mockResolvedValue({ rows: [] });
    await _internal.applySesEvent({
      eventType: "Complaint", mail: { messageId: "m1" },
      complaint: { complainedRecipients: [{ emailAddress: "a@b.com" }] },
    });
    const sup = dbQuery.mock.calls.find((c) => /INSERT INTO email_suppressions/.test(c[0]));
    expect(sup[1]).toContain("complaint");
    expect(dbQuery.mock.calls.some((c) => /status='complained'/.test(c[0]))).toBe(true);
  });

  test("delivery → marks delivered + bumps counter", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [sendRow] }).mockResolvedValue({ rows: [] });
    await _internal.applySesEvent({ eventType: "Delivery", mail: { messageId: "m1" }, delivery: {} });
    expect(dbQuery.mock.calls.some((c) => /status='delivered'/.test(c[0]))).toBe(true);
    expect(dbQuery.mock.calls.some((c) => /delivered = delivered \+ 1/.test(c[0]))).toBe(true);
  });

  test("ignores events with no messageId", async () => {
    await _internal.applySesEvent({ eventType: "Bounce", bounce: {} });
    expect(dbQuery).not.toHaveBeenCalled();
  });
});
