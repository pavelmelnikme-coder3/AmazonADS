"use strict";
/**
 * A send that fails on transport, and a send that fails because the account is out of quota,
 * are two different things, and both were being handled wrongly.
 *
 * A dropped connection or a timeout talking to the relay landed the row on 'failed', which is
 * terminal: nothing returns it to 'queued', so that recipient silently leaves the campaign. The
 * July campaign's error column is full of "connection timeout" / "connection closed by
 * recipient's server" — those came back from Brevo's webhook as bounce reasons, but the same
 * strings arrive as thrown SMTP errors, and then the recipient was simply gone.
 *
 * A quota rejection, meanwhile, applies to the whole account: the drip would work through the
 * rest of the budget getting the same refusal, then do it again five minutes later, all day.
 */
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/services/email/provider", () => ({
  name: jest.fn().mockReturnValue("brevo"),
  isConfigured: jest.fn().mockReturnValue(true),
  sendBulkEmail: jest.fn(),
}));

const brevo = require("../src/services/email/brevo");

// dispatch keeps the "account is out of quota today" gate in a module-level variable, so each
// test needs a fresh copy of the module — and therefore fresh copies of the mocks it closed
// over, since resetModules re-runs the jest.mock factories. Re-acquire all four together or the
// test configures one `query` mock while dispatch calls another.
let dispatch, dbQuery, provider, logger;
beforeEach(() => {
  jest.resetModules();
  dbQuery = require("../src/db/pool").query;
  provider = require("../src/services/email/provider");
  logger = require("../src/config/logger");
  dispatch = require("../src/services/email/dispatch");
});

// ─── classification ───────────────────────────────────────────────────────────
describe("brevo error classification", () => {
  const { isTransientError, isQuotaError } = brevo._internal;

  test.each([
    [{ code: "ECONNRESET", message: "socket hang up" }],
    [{ code: "ETIMEDOUT", message: "Connection timeout" }],
    [{ code: "ESOCKET", message: "Client network socket disconnected" }],
    [{ code: "EAI_AGAIN", message: "getaddrinfo EAI_AGAIN smtp-relay.brevo.com" }],
    [{ message: "Greeting never received" }],
    [{ message: "Message failed", response: "451 4.7.1 Please try again later" }],
  ])("%o is transient", (err) => expect(isTransientError(err)).toBe(true));

  test.each([
    [{ message: "Message failed", response: "550 5.1.1 User unknown" }],
    [{ message: "Mailbox does not exist" }],
    [{ message: "550 5.4.1 Recipient address rejected: Access denied" }],
  ])("%o is a permanent failure", (err) => expect(isTransientError(err)).toBe(false));

  // "550 … 4.7.1 …" quotes a 4xx inside a permanent refusal; only a leading 4yz is transient.
  test("a 5xx response that mentions a 4.x.x status stays permanent", () => {
    expect(isTransientError({ response: "550 4.7.1 relay access denied" })).toBe(false);
  });

  test("quota wins over transient when an error looks like both", () => {
    const err = { message: "too many connections, try again later" };
    expect(isQuotaError(err)).toBe(true);
  });
});

// ─── processBatch ─────────────────────────────────────────────────────────────
// The query sequence processBatch walks: campaign → queued contacts → (per-contact writes) →
// campaign counter → maybeFinish count → optional finish.
function mockBatchOf(contact, afterContactWrites) {
  dbQuery
    .mockResolvedValueOnce({ rows: [{ id: "camp1", workspace_id: "ws1", subject: "S", html_body: "B" }] })
    .mockResolvedValueOnce({ rows: [contact] });
  for (const r of afterContactWrites) dbQuery.mockResolvedValueOnce(r);
  dbQuery.mockResolvedValue({ rows: [{ n: 1 }] }); // campaign counter + maybeFinish: still queued
}

describe("a transient transport failure keeps the recipient", () => {
  const contact = { id: "c1", email: "a@b.de", attributes: {}, unsubscribe_token: "t1" };

  test("the row stays queued, burns one attempt, and is not marked failed", async () => {
    mockBatchOf(contact, [{ rows: [{ attempts: 1 }] }]);
    provider.sendBulkEmail.mockResolvedValueOnce([
      { email: "a@b.de", messageId: null, status: "deferred", deferReason: "transient", error: "Connection timeout" }]);

    const r = await dispatch.processBatch({ campaignId: "camp1", contactIds: ["c1"] });
    expect(r).toEqual({ sent: 0, failed: 0, deferred: 1, quotaHit: false });

    const attemptWrite = dbQuery.mock.calls.find((c) => /attempts = attempts \+ 1/.test(c[0]));
    expect(attemptWrite).toBeTruthy();
    expect(attemptWrite[1]).toEqual(["camp1", "c1", "Connection timeout"]);
    // Crucially: nothing moved the row off 'queued', so the next drip retries it.
    expect(dbQuery.mock.calls.some((c) => /SET status = CASE WHEN status='queued' THEN 'failed'/.test(c[0]))).toBe(false);
    expect(dbQuery.mock.calls.some((c) => /SET status='sent'/.test(c[0]))).toBe(false);
  });

  test("at the attempt ceiling it becomes a real failure, loudly", async () => {
    mockBatchOf(contact, [{ rows: [{ attempts: dispatch.MAX_SEND_ATTEMPTS }] }, { rows: [] }]);
    provider.sendBulkEmail.mockResolvedValueOnce([
      { email: "a@b.de", messageId: null, status: "deferred", deferReason: "transient", error: "socket hang up" }]);

    const r = await dispatch.processBatch({ campaignId: "camp1", contactIds: ["c1"] });
    expect(r.failed).toBe(1);
    expect(dbQuery.mock.calls.some((c) => /THEN 'failed'/.test(c[0]))).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Giving up on a recipient"),
      expect.objectContaining({ email: "a@b.de", attempts: dispatch.MAX_SEND_ATTEMPTS }));
  });

  test("a quota deferral costs no attempt and raises quotaHit", async () => {
    mockBatchOf(contact, []);
    provider.sendBulkEmail.mockResolvedValueOnce([
      { email: "a@b.de", messageId: null, status: "deferred", deferReason: "quota", error: "daily limit reached" }]);

    const r = await dispatch.processBatch({ campaignId: "camp1", contactIds: ["c1"] });
    expect(r).toEqual({ sent: 0, failed: 0, deferred: 1, quotaHit: true });
    expect(dbQuery.mock.calls.some((c) => /attempts = attempts \+ 1/.test(c[0]))).toBe(false);
  });

  // The SES adapter never defers, but a future one might defer without saying why. The old
  // meaning of a bare 'deferred' was quota, and that reading costs the recipient nothing.
  test("a deferral with no stated reason is treated as quota", async () => {
    mockBatchOf(contact, []);
    provider.sendBulkEmail.mockResolvedValueOnce([
      { email: "a@b.de", messageId: null, status: "deferred", error: "no reason given" }]);

    const r = await dispatch.processBatch({ campaignId: "camp1", contactIds: ["c1"] });
    expect(r.quotaHit).toBe(true);
    expect(dbQuery.mock.calls.some((c) => /attempts = attempts \+ 1/.test(c[0]))).toBe(false);
  });
});

// ─── dripSend ─────────────────────────────────────────────────────────────────
describe("the drip stops for the day once the provider says the quota is gone", () => {
  // sentToday → queued rows → then processBatch's own sequence.
  function mockDripWithQuotaRefusal() {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })                                  // sentToday
      .mockResolvedValueOnce({ rows: [{ campaign_id: "camp1", contact_id: "c1" },   // queued, 2 campaigns
                                      { campaign_id: "camp2", contact_id: "c2" }] })
      .mockResolvedValueOnce({ rows: [{ id: "camp1", workspace_id: "ws1", subject: "S", html_body: "B" }] })
      .mockResolvedValueOnce({ rows: [{ id: "c1", email: "a@b.de", attributes: {}, unsubscribe_token: "t1" }] })
      .mockResolvedValue({ rows: [{ n: 1 }] });
    provider.sendBulkEmail.mockResolvedValue([
      { email: "a@b.de", messageId: null, status: "deferred", deferReason: "quota", error: "daily limit reached" }]);
  }

  test("the second campaign is not even attempted", async () => {
    mockDripWithQuotaRefusal();
    const r = await dispatch.dripSend();
    expect(r.quotaExhausted).toBe(true);
    // One provider call only — camp2 was never tried.
    expect(provider.sendBulkEmail).toHaveBeenCalledTimes(1);
  });

  test("later runs the same day return immediately, without touching the provider or the DB", async () => {
    mockDripWithQuotaRefusal();
    await dispatch.dripSend();
    const callsAfterFirstRun = dbQuery.mock.calls.length;

    const second = await dispatch.dripSend();
    expect(second).toEqual({ sent: 0, budget: 0, skipped: true, quotaExhausted: true });
    expect(dbQuery.mock.calls.length).toBe(callsAfterFirstRun); // not one extra query
    expect(provider.sendBulkEmail).toHaveBeenCalledTimes(1);
  });

  test("a run that hits no quota refusal leaves the gate open", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ n: 0 }] })
      .mockResolvedValueOnce({ rows: [{ campaign_id: "camp1", contact_id: "c1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "camp1", workspace_id: "ws1", subject: "S", html_body: "B" }] })
      .mockResolvedValueOnce({ rows: [{ id: "c1", email: "a@b.de", attributes: {}, unsubscribe_token: "t1" }] })
      .mockResolvedValue({ rows: [{ n: 0 }] });
    provider.sendBulkEmail.mockResolvedValue([{ email: "a@b.de", messageId: "m1", status: "sent", error: null }]);

    const r = await dispatch.dripSend();
    expect(r.quotaExhausted).toBeUndefined();
    expect(r.sent).toBe(1);
  });
});
