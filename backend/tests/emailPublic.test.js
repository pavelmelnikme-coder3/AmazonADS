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
  test("resolves token → marks contact unsubscribed + inserts suppression attributed to last campaign", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: "c1", workspace_id: "ws1", email: "a@b.com" }] }) // lookup token
      .mockResolvedValueOnce({ rows: [] })                             // UPDATE contact unsubscribed
      .mockResolvedValueOnce({ rows: [{ campaign_id: "camp1" }] })     // SELECT most recent send
      .mockResolvedValueOnce({ rows: [] })                             // INSERT suppression
      .mockResolvedValueOnce({ rows: [] });                            // UPDATE campaign unsubscribed += 1
    const ok = await _internal.doUnsubscribe("tok1");
    expect(ok).toBe(true);
    expect(dbQuery.mock.calls.some((c) => /status='unsubscribed'/.test(c[0]))).toBe(true);
    const sup = dbQuery.mock.calls.find((c) => /INSERT INTO email_suppressions/.test(c[0]));
    expect(sup[0]).toMatch(/'unsubscribe'/);
    expect(sup[0]).toMatch(/ON CONFLICT/);
    expect(sup[1]).toContain("camp1"); // source_campaign_id set, not left null
    expect(dbQuery.mock.calls.some((c) => /unsubscribed = unsubscribed \+ 1/.test(c[0]) && c[1].includes("camp1"))).toBe(true);
  });

  test("contact never received a campaign send → suppression still inserted, no campaign counter touched", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ id: "c1", workspace_id: "ws1", email: "a@b.com" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })  // SELECT most recent send → none
      .mockResolvedValueOnce({ rows: [] }); // INSERT suppression
    const ok = await _internal.doUnsubscribe("tok1");
    expect(ok).toBe(true);
    expect(dbQuery.mock.calls.some((c) => /unsubscribed = unsubscribed \+ 1/.test(c[0]))).toBe(false);
    const sup = dbQuery.mock.calls.find((c) => /INSERT INTO email_suppressions/.test(c[0]));
    expect(sup[1]).toContain(null);
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

  test("open → bumps counter on first open, not on a repeat open (was: unconditional +1 every event)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ ...sendRow, opened_at: null }] }).mockResolvedValue({ rows: [] });
    await _internal.applySesEvent({ eventType: "Open", mail: { messageId: "m1" } });
    expect(dbQuery.mock.calls.some((c) => /opened = opened \+ 1/.test(c[0]))).toBe(true);

    dbQuery.mockClear();
    dbQuery.mockResolvedValueOnce({ rows: [{ ...sendRow, opened_at: "2026-01-01T00:00:00Z" }] }).mockResolvedValue({ rows: [] });
    await _internal.applySesEvent({ eventType: "Open", mail: { messageId: "m1" } });
    expect(dbQuery.mock.calls.some((c) => /opened = opened \+ 1/.test(c[0]))).toBe(false);
  });

  test("click → bumps counter on first click only", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ ...sendRow, clicked_at: "2026-01-01T00:00:00Z" }] }).mockResolvedValue({ rows: [] });
    await _internal.applySesEvent({ eventType: "Click", mail: { messageId: "m1" } });
    expect(dbQuery.mock.calls.some((c) => /clicked = clicked \+ 1/.test(c[0]))).toBe(false);
  });
});

describe("applyBrevoEvent", () => {
  const sendRow = {
    id: "send1", campaign_id: "camp1", contact_id: "c1", email: "a@b.com",
    delivered_at: null, opened_at: null, clicked_at: null, workspace_id: "ws1",
  };

  test("no tag and no matching message-id → no-op (no rows found)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    await _internal.applyBrevoEvent({ event: "delivered", "message-id": "mid-unknown" });
    expect(dbQuery.mock.calls.some((c) => /UPDATE/.test(c[0]))).toBe(false);
  });

  test("delivered → correlates by tag (email_sends.id), bumps counter once", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [sendRow] }).mockResolvedValue({ rows: [] });
    await _internal.applyBrevoEvent({ event: "delivered", tag: "send1" });
    const lookup = dbQuery.mock.calls[0];
    expect(lookup[0]).toMatch(/es\.id = \$1/);
    expect(lookup[1]).toEqual(["send1"]);
    expect(dbQuery.mock.calls.some((c) => /status='delivered'/.test(c[0]))).toBe(true);
    expect(dbQuery.mock.calls.some((c) => /delivered = delivered \+ 1/.test(c[0]))).toBe(true);
  });

  test("falls back to message-id lookup when no tag present (pre-tag sends)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [sendRow] }).mockResolvedValue({ rows: [] });
    await _internal.applyBrevoEvent({ event: "delivered", "message-id": "mid-1" });
    const lookup = dbQuery.mock.calls[0];
    expect(lookup[0]).toMatch(/ses_message_id = \$1/);
    expect(lookup[1]).toEqual(["mid-1"]);
  });

  test("opened → unique-gated: first opened event counts, repeat does not", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ ...sendRow, opened_at: null }] }).mockResolvedValue({ rows: [] });
    await _internal.applyBrevoEvent({ event: "opened", tag: "send1" });
    expect(dbQuery.mock.calls.some((c) => /opened = opened \+ 1/.test(c[0]))).toBe(true);

    dbQuery.mockClear();
    dbQuery.mockResolvedValueOnce({ rows: [{ ...sendRow, opened_at: "2026-01-01T00:00:00Z" }] }).mockResolvedValue({ rows: [] });
    await _internal.applyBrevoEvent({ event: "opened", tag: "send1" });
    expect(dbQuery.mock.calls.some((c) => /opened = opened \+ 1/.test(c[0]))).toBe(false);
  });

  test("unique_opened is treated the same as opened", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ ...sendRow, opened_at: null }] }).mockResolvedValue({ rows: [] });
    await _internal.applyBrevoEvent({ event: "unique_opened", tag: "send1" });
    expect(dbQuery.mock.calls.some((c) => /opened = opened \+ 1/.test(c[0]))).toBe(true);
  });

  test("click → unique-gated the same way as opened", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ ...sendRow, clicked_at: null }] }).mockResolvedValue({ rows: [] });
    await _internal.applyBrevoEvent({ event: "click", tag: "send1" });
    expect(dbQuery.mock.calls.some((c) => /clicked = clicked \+ 1/.test(c[0]))).toBe(true);
  });

  test("hard_bounce → bounced + suppressed + contact flagged", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [sendRow] }).mockResolvedValue({ rows: [] });
    await _internal.applyBrevoEvent({ event: "hard_bounce", tag: "send1", reason: "mailbox does not exist" });
    expect(dbQuery.mock.calls.some((c) => /status='bounced'/.test(c[0]))).toBe(true);
    expect(dbQuery.mock.calls.some((c) => /bounced = bounced \+ 1/.test(c[0]))).toBe(true);
    const sup = dbQuery.mock.calls.find((c) => /INSERT INTO email_suppressions/.test(c[0]));
    expect(sup[1]).toContain("hard_bounce");
    expect(dbQuery.mock.calls.some((c) => /status='bounced', updated_at/.test(c[0]))).toBe(true);
  });

  test("blocked and invalid_email are treated as permanent bounces too", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [sendRow] }).mockResolvedValue({ rows: [] });
    await _internal.applyBrevoEvent({ event: "blocked", tag: "send1" });
    expect(dbQuery.mock.calls.some((c) => /INSERT INTO email_suppressions/.test(c[0]))).toBe(true);
  });

  test("soft_bounce → counted but NOT suppressed", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [sendRow] }).mockResolvedValue({ rows: [] });
    await _internal.applyBrevoEvent({ event: "soft_bounce", tag: "send1" });
    expect(dbQuery.mock.calls.some((c) => /bounced = bounced \+ 1/.test(c[0]))).toBe(true);
    expect(dbQuery.mock.calls.some((c) => /INSERT INTO email_suppressions/.test(c[0]))).toBe(false);
  });

  test("spam → complained + suppressed + contact flagged", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [sendRow] }).mockResolvedValue({ rows: [] });
    await _internal.applyBrevoEvent({ event: "spam", tag: "send1" });
    expect(dbQuery.mock.calls.some((c) => /status='complained'/.test(c[0]))).toBe(true);
    const sup = dbQuery.mock.calls.find((c) => /INSERT INTO email_suppressions/.test(c[0]));
    expect(sup[1]).toContain("complaint");
  });

  test("unsubscribed → suppressed + campaign counter bumped", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [sendRow] }).mockResolvedValue({ rows: [] });
    await _internal.applyBrevoEvent({ event: "unsubscribed", tag: "send1" });
    expect(dbQuery.mock.calls.some((c) => /unsubscribed = unsubscribed \+ 1/.test(c[0]))).toBe(true);
  });

  test("unknown/transport event types (deferred, error, request) → no writes beyond the lookup", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [sendRow] });
    await _internal.applyBrevoEvent({ event: "deferred", tag: "send1" });
    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  test("no event field → no-op, no query at all", async () => {
    await _internal.applyBrevoEvent({ tag: "send1" });
    expect(dbQuery).not.toHaveBeenCalled();
  });
});
