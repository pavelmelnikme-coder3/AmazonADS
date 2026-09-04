"use strict";
/**
 * End-to-end: a negative Amazon refuses must not be left looking applied.
 *
 * The 2026-09-01 failure in full. The rule matched the search term
 * "abdeckplane wohnmobil 7,50 m", inserted a negative_keywords row with a synthetic
 * "rule-…" id, called Amazon, and Amazon answered:
 *
 *   malformedValueError / { "message": "Keyword is invalid", "reason": "PATTERN_NOT_MATCHED" }
 *
 * The write-back failure was recorded on the audit row and nowhere else. The local row stayed
 * state='enabled', so:
 *   • every subsequent run skipped the term as `already_negative`;
 *   • reconciliation never questioned it — it only re-checks whether the metrics still justify
 *     the negative, not whether the negative exists;
 *   • no sync could repair it, because a synthetic id matches nothing Amazon returns.
 * The term went on spending, unblocked and unreported, until it was found by hand.
 *
 * Covered here: a term carrying characters Amazon refuses is skipped rather than rewritten
 * into a different keyword; a rejection rolls the row back and records why; a permanent
 * rejection is reported as a skip on later runs instead of being retried forever; a transient
 * one is retried.
 */

const request = require("supertest");
const express = require("express");

const WS_ID   = "ws---0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const RULE_ID = "rule-0001-0000-0000-000000000001";
const CAMP_ID = "camp-0001-0000-0000-000000000001";
const AG_ID   = "ag---0001-0000-0000-000000000001";

const AMAZON_PATTERN_REJECTION =
  '{"errors":[{"errorType":"malformedValueError","errorValue":{"malformedValueError":'
  + '{"cause":{},"message":"Keyword is invalid","reason":"PATTERN_NOT_MATCHED"}}}],"index":0}';

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/routes/audit", () => ({
  writeAudit: jest.fn().mockResolvedValue("audit-1"),
  updateAuditStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/amazon/writeback", () => ({
  pushNegativeKeyword:    jest.fn().mockResolvedValue({ ok: true }),
  pushNegativeAsin:       jest.fn().mockResolvedValue({ ok: true }),
  pushNegativeTarget:     jest.fn().mockResolvedValue({ ok: true }),
  pushKeywordUpdates:     jest.fn().mockResolvedValue({ ok: true }),
  pushCampaignUpdates:    jest.fn().mockResolvedValue({ ok: true }),
  archiveNegativeKeyword: jest.fn().mockResolvedValue({ ok: true }),
  archiveNegativeTarget:  jest.fn().mockResolvedValue({ ok: true }),
  campaignApiPath:        jest.fn(),
  partialError: (result, dataKey) => {
    const errors = result?.[dataKey]?.error;
    if (!Array.isArray(errors) || errors.length === 0) return null;
    return errors[0]?.description || errors[0]?.message || JSON.stringify(errors[0]);
  },
}));
jest.mock("../src/services/amazon/adsClient", () => ({ put: jest.fn(), post: jest.fn() }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("../src/config/redis", () => ({
  getRedis: jest.fn().mockReturnValue({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(1),
  }),
}));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user  = { id: USER_ID, name: "Test User", role: "owner", org_id: ORG_ID };
    req.orgId = ORG_ID;
    next();
  },
  requireWorkspace: (req, _res, next) => {
    req.workspaceId = WS_ID; req.workspaceRole = "owner"; next();
  },
}));

const { query: dbQuery } = require("../src/db/pool");
const { updateAuditStatus } = require("../src/routes/audit");
const { pushNegativeKeyword } = require("../src/services/amazon/writeback");
const rulesRouter = require("../src/routes/rules");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/rules", rulesRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

const NEG_RULE = {
  id: RULE_ID, workspace_id: WS_ID, name: "[ST]-8cl-0or-60d (neg key)",
  description: "", schedule: "0 8 * * *", dry_run: false, is_active: true, created_by: USER_ID,
  conditions: JSON.stringify([{ metric: "clicks", op: "gte", value: 8 }]),
  actions:    JSON.stringify([{ type: "add_negative_keyword", value: "exact" }]),
  scope:      JSON.stringify({ entity_type: "search_term", period_days: 60 }),
  safety:     JSON.stringify({ min_bid: 0.02, max_bid: 50 }),
};

function makeSearchTerm(overrides = {}) {
  return {
    id: "st-001", keyword_text: "abdeckplane wohnmobil 7,50 m", state: "enabled",
    campaign_id: CAMP_ID, ad_group_id: AG_ID,
    campaign_name: "7 [SP-BM]-Wohnwagen Abdeckung", campaign_type: "sponsoredProducts",
    amazon_campaign_id: "AZ_CAMP_001", ad_group_name: "AG 1", amazon_ad_group_id: "AZ_AG_001",
    profile_db_id: "prof-001", amazon_profile_id: "123456789",
    connection_id: "conn-001", marketplace_id: "A1PA6795UKMFR9",
    clicks: 12, spend: "8.00", orders: 0, sales: "0", acos: "0", impressions: 300,
    entity_type: "search_term", ...overrides,
  };
}

// SELECT rule · SELECT org_id · campaign_exemptions · search_terms · [extra] ·
// reconcile negative_keywords · reconcile negative_targets · UPDATE rules · INSERT rule_executions
function mockRun(stRows, extraMocks = []) {
  dbQuery
    .mockResolvedValueOnce({ rows: [NEG_RULE] })
    .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: stRows });
  extraMocks.forEach(m => dbQuery.mockResolvedValueOnce(m));
  dbQuery.mockResolvedValue({ rows: [] });
}

// Text Amazon accepts, for the scenarios that need the write-back to actually be attempted.
const ACCEPTED = { keyword_text: "campingstuhl kompakt" };

const findCall = (needle) =>
  dbQuery.mock.calls.find(([sql]) => String(sql).includes(needle));

let app;
beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });
afterEach(() => { dbQuery.mockReset(); });

describe("a term carrying characters Amazon refuses", () => {
  it("is skipped, not rewritten into a different keyword", async () => {
    // Substituting a space for the comma would negate "abdeckplane wohnmobil 7 50 m" — a
    // different keyword. That query took 6 clicks in August 2026 while a negative_exact for
    // the space-form sat enabled in the same ad group, so the substitute blocks nothing while
    // the run reports success and every later run skips the term as `already_negative`.
    mockRun([makeSearchTerm()], []);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    expect(res.body.applied_count).toBe(0);
    expect(res.body.skipped[0].reason).toBe("unsupported_keyword_text");
    expect(res.body.skipped[0].detail.characters).toEqual([","]);
    expect(pushNegativeKeyword).not.toHaveBeenCalled();
    expect(findCall("INSERT INTO negative_keywords")).toBeUndefined();
  });

  it("is reported every run, so it stays visible until handled by hand", async () => {
    mockRun([makeSearchTerm()], []);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    const exec = findCall("INSERT INTO rule_executions");
    expect(exec[1]).toContain("completed");   // a skip is not a failure
    const diagnostics = JSON.parse(exec[1][exec[1].length - 1]);
    expect(diagnostics.skipped_by_reason).toEqual({ unsupported_keyword_text: 1 });
  });
});

describe("negating a term Amazon accepts", () => {
  const CLEAN = { keyword_text: "campingstuhl 150\u00A0kg" };   // the live U+00A0 case

  it("sends the whitespace-normalized text, not the raw report text", async () => {
    mockRun([makeSearchTerm(CLEAN)], [
      { rows: [] },                      // dedup SELECT
      { rows: [{ id: "neg-ins-001" }] }, // INSERT RETURNING id
    ]);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    expect(pushNegativeKeyword).toHaveBeenCalledWith(expect.objectContaining({
      keywordText: "campingstuhl 150 kg",   // plain space — Amazon rejects U+00A0
    }));
  });

  it("stores the normalized text locally, so reconciliation can match it back", async () => {
    mockRun([makeSearchTerm(CLEAN)], [{ rows: [] }, { rows: [{ id: "neg-ins-001" }] }]);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    const insert = findCall("INSERT INTO negative_keywords");
    expect(insert[1]).toContain("campingstuhl 150 kg");
    expect(insert[1]).not.toContain(CLEAN.keyword_text);   // the raw U+00A0 form
  });

  it("leaves the row alone when Amazon accepts it", async () => {
    mockRun([makeSearchTerm(CLEAN)], [{ rows: [] }, { rows: [{ id: "neg-ins-001" }] }]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    expect(res.body.writeback_error_count).toBe(0);
    expect(findCall("writeback_error = $2")).toBeUndefined();
    expect(updateAuditStatus).toHaveBeenCalledWith("audit-1", "success", null);
  });
});

describe("negating a term Amazon refuses", () => {
  beforeEach(() => {
    pushNegativeKeyword.mockResolvedValue({ ok: false, error: AMAZON_PATTERN_REJECTION });
  });
  afterEach(() => { pushNegativeKeyword.mockResolvedValue({ ok: true }); });

  it("rolls the row back to archived instead of leaving it enabled", async () => {
    mockRun([makeSearchTerm(ACCEPTED)], [{ rows: [] }, { rows: [{ id: "neg-ins-001" }] }]);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    const rollback = findCall("writeback_error = $2");
    expect(rollback).toBeDefined();
    expect(rollback[0]).toContain("UPDATE negative_keywords");
    expect(rollback[0]).toContain("state = 'archived'");
    expect(rollback[1][0]).toBe("neg-ins-001");
    expect(rollback[1][1]).toContain("PATTERN_NOT_MATCHED");
  });

  it("frees the placeholder id so a later attempt can re-own the row", async () => {
    mockRun([makeSearchTerm(ACCEPTED)], [{ rows: [] }, { rows: [{ id: "neg-ins-001" }] }]);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    // A real numeric Amazon id would be kept; a "rule-…" placeholder is replaced.
    expect(findCall("writeback_error = $2")[0]).toContain("'archived-'");
  });

  it("reports the run as partial, not completed", async () => {
    mockRun([makeSearchTerm(ACCEPTED)], [{ rows: [] }, { rows: [{ id: "neg-ins-001" }] }]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    expect(res.body.writeback_error_count).toBe(1);
    expect(res.body.writeback_errors[0]).toMatchObject({ action: "add_negative_keyword" });
    const exec = findCall("INSERT INTO rule_executions");
    expect(exec[1]).toContain("partial");
  });

  it("marks the audit row as an error", async () => {
    mockRun([makeSearchTerm(ACCEPTED)], [{ rows: [] }, { rows: [{ id: "neg-ins-001" }] }]);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(updateAuditStatus).toHaveBeenCalledWith("audit-1", "error", AMAZON_PATTERN_REJECTION);
  });

  it("waits for the rejection before returning — the run must not finish first", async () => {
    let settle;
    pushNegativeKeyword.mockReturnValueOnce(new Promise(r => { settle = r; }));
    mockRun([makeSearchTerm(ACCEPTED)], [{ rows: [] }, { rows: [{ id: "neg-ins-001" }] }]);

    const pending = request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    await new Promise(r => setImmediate(r));
    settle({ ok: false, error: AMAZON_PATTERN_REJECTION });
    const res = await pending;

    expect(res.body.writeback_error_count).toBe(1);
    expect(findCall("writeback_error = $2")).toBeDefined();
  });
});

describe("a term Amazon has already refused", () => {
  const priorRejection = (error) => ({
    rows: [{
      id: "neg-old-001", state: "archived", ad_group_id: AG_ID,
      amazon_neg_keyword_id: "archived-1-neg-old-001", writeback_error: error,
    }],
  });

  it("is reported as a skip carrying Amazon's reason, not retried", async () => {
    mockRun([makeSearchTerm(ACCEPTED)], [priorRejection(AMAZON_PATTERN_REJECTION)]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    expect(res.body.applied_count).toBe(0);
    expect(res.body.skipped[0].reason).toBe("amazon_rejected_keyword_text");
    expect(res.body.skipped[0].detail.amazon_error).toContain("PATTERN_NOT_MATCHED");
    expect(pushNegativeKeyword).not.toHaveBeenCalled();
  });

  it("does not count as a failure — the run is completed, with the reason recorded", async () => {
    mockRun([makeSearchTerm(ACCEPTED)], [priorRejection(AMAZON_PATTERN_REJECTION)]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    expect(res.body.writeback_error_count).toBe(0);
    const exec = findCall("INSERT INTO rule_executions");
    expect(exec[1]).toContain("completed");
    const diagnostics = JSON.parse(exec[1][exec[1].length - 1]);
    expect(diagnostics.skipped_by_reason).toEqual({ amazon_rejected_keyword_text: 1 });
  });

  it("is retried when the earlier failure was only an outage", async () => {
    mockRun([makeSearchTerm(ACCEPTED)], [
      priorRejection('Amazon API error: 401 {"message":"Unauthorized exception"}'),
      { rows: [{ id: "neg-old-001" }] },
    ]);
    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    expect(res.body.applied_count).toBe(1);
    expect(pushNegativeKeyword).toHaveBeenCalled();
  });

  it("clears the stale error when the row is re-owned for a fresh attempt", async () => {
    mockRun([makeSearchTerm(ACCEPTED)], [
      priorRejection("Amazon API error: 429 Too Many Requests"),
      { rows: [{ id: "neg-old-001" }] },
    ]);
    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    const reown = findCall("UPDATE negative_keywords\n                      SET state='enabled'");
    expect(reown[0]).toContain("writeback_error=NULL");
  });

  it("still skips as already_negative when an enabled row exists, whatever it carries", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [NEG_RULE] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [makeSearchTerm(ACCEPTED)] })
      .mockResolvedValueOnce({ rows: [{
        id: "neg-live-001", state: "enabled", ad_group_id: AG_ID,
        amazon_neg_keyword_id: "112233445566", writeback_error: null,
      }] });
    dbQuery.mockResolvedValue({ rows: [] });

    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });
    expect(res.body.skipped[0].reason).toBe("already_negative");
  });
});
