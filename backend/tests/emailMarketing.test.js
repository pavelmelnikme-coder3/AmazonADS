"use strict";
/**
 * Marketing email authenticated API — validation + send guards.
 */
const request = require("supertest");
const express = require("express");

const WS_ID = "ws---0001-0000-0000-000000000001";
const ORG_ID = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const CAMP_ID = "camp-0001-0000-0000-000000000001";

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/routes/audit", () => ({ writeAudit: jest.fn().mockResolvedValue("aud1"), updateAuditStatus: jest.fn() }));
jest.mock("../src/services/email/provider", () => ({ name: jest.fn().mockReturnValue("brevo"), isConfigured: jest.fn(), sendBulkEmail: jest.fn() }));
jest.mock("../src/jobs/workers", () => ({ queueEmailCampaign: jest.fn().mockResolvedValue({ total: 3, batches: 1 }) }));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => { req.user = { id: USER_ID, name: "T", org_id: ORG_ID }; req.orgId = ORG_ID; next(); },
  requireWorkspace: (req, _res, next) => { req.workspaceId = WS_ID; req.workspaceRole = "owner"; next(); },
}));

const { query: dbQuery } = require("../src/db/pool");
const ses = require("../src/services/email/provider");
const { queueEmailCampaign } = require("../src/jobs/workers");
const router = require("../src/routes/emailMarketing");

function app() {
  const a = express(); a.use(express.json()); a.use("/email-marketing", router);
  a.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return a;
}
beforeEach(() => jest.clearAllMocks());

describe("POST /contacts/import", () => {
  test("400 without consent_source (GDPR proof)", async () => {
    const res = await request(app()).post("/email-marketing/contacts/import").send({ contacts: [{ email: "a@b.com" }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/consent_source/i);
  });

  test("400 without contacts[]", async () => {
    const res = await request(app()).post("/email-marketing/contacts/import").send({ consent_source: "signup" });
    expect(res.status).toBe(400);
  });

  test("imports valid, counts invalid emails, dedups via ON CONFLICT", async () => {
    dbQuery
      .mockResolvedValueOnce({ rowCount: 1 })  // a@b.com inserted
      .mockResolvedValueOnce({ rowCount: 0 }); // c@d.com conflict (skipped)
    const res = await request(app()).post("/email-marketing/contacts/import")
      .send({ consent_source: "double-optin", contacts: [{ email: "a@b.com" }, { email: "c@d.com" }, { email: "not-an-email" }] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ imported: 1, skipped: 1, invalid: 1 });
    expect(dbQuery.mock.calls[0][0]).toMatch(/ON CONFLICT \(workspace_id, lower\(email\)\) DO NOTHING/);
  });
});

describe("POST /contacts/import-file", () => {
  test("400 without a file", async () => {
    const res = await request(app()).post("/email-marketing/contacts/import-file").field("consent_source", "csv upload");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/file required/i);
  });

  test("400 without consent_source", async () => {
    const res = await request(app()).post("/email-marketing/contacts/import-file")
      .attach("file", Buffer.from("EMAIL\na@b.com\n"), "c.csv");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/consent_source/i);
  });

  test("400 when the file has no detectable email column", async () => {
    const res = await request(app()).post("/email-marketing/contacts/import-file")
      .field("consent_source", "csv upload")
      .attach("file", Buffer.from("NAME,PHONE\nAnna,123\n"), "c.csv");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/email column/i);
  });

  test("parses a CSV, auto-detects columns, imports valid rows", async () => {
    dbQuery.mockResolvedValueOnce({ rowCount: 1 });
    const csv = "EMAIL,VORNAME,NACHNAME,JOB_TITLE\na@b.com,Anna,Ernst,Manager\n";
    const res = await request(app()).post("/email-marketing/contacts/import-file")
      .field("consent_source", "csv upload")
      .attach("file", Buffer.from(csv), "contacts.csv");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ imported: 1, skipped: 0, invalid: 0, rows: 1 });
    expect(res.body.detected).toMatchObject({ email: "EMAIL", first_name: "VORNAME", last_name: "NACHNAME" });
    const params = dbQuery.mock.calls[0][1];
    expect(params[1]).toBe("a@b.com");
    expect(params[2]).toBe("Anna");
    expect(params[3]).toBe("Ernst");
    expect(JSON.parse(params[4])).toEqual({ job_title: "Manager" });
  });
});

describe("POST /campaigns — content_blocks", () => {
  test("persists content_blocks when provided", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: CAMP_ID, content_blocks: { version: 1, blocks: [] } }] });
    const res = await request(app()).post("/email-marketing/campaigns")
      .send({ name: "C", content_blocks: { version: 1, blocks: [] } });
    expect(res.status).toBe(201);
    const params = dbQuery.mock.calls[0][1];
    expect(JSON.parse(params[8])).toEqual({ version: 1, blocks: [] });
  });

  test("content_blocks defaults to null (legacy raw-HTML campaigns)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: CAMP_ID }] });
    await request(app()).post("/email-marketing/campaigns").send({ name: "C" });
    const params = dbQuery.mock.calls[0][1];
    expect(params[8]).toBeNull();
  });
});

describe("PUT /campaigns/:id — content_blocks explicit-null handling", () => {
  test("omitting content_blocks leaves the column untouched (CASE branch false)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: CAMP_ID }] });
    await request(app()).put(`/email-marketing/campaigns/${CAMP_ID}`).send({ name: "renamed" });
    const params = dbQuery.mock.calls[0][1];
    expect(params[9]).toBe(false);  // hasContentBlocks
    expect(params[10]).toBeNull();
  });

  test("explicit content_blocks:null actually nulls the column (switch to HTML mode)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: CAMP_ID, content_blocks: null }] });
    await request(app()).put(`/email-marketing/campaigns/${CAMP_ID}`).send({ content_blocks: null });
    const params = dbQuery.mock.calls[0][1];
    expect(params[9]).toBe(true);  // hasContentBlocks — CASE takes the "set it" branch
    expect(params[10]).toBe("null"); // JSON.stringify(null) → the JSON scalar null, cast via ::jsonb
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/CASE WHEN \$10 THEN \$11::jsonb ELSE content_blocks END/);
  });

  test("explicit content_blocks:{...} sets the new value", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ id: CAMP_ID }] });
    await request(app()).put(`/email-marketing/campaigns/${CAMP_ID}`).send({ content_blocks: { version: 1, blocks: [{ id: "b1", type: "text" }] } });
    const params = dbQuery.mock.calls[0][1];
    expect(params[9]).toBe(true);
    expect(JSON.parse(params[10])).toEqual({ version: 1, blocks: [{ id: "b1", type: "text" }] });
  });
});

describe("POST /campaigns/:id/send guards", () => {
  test("400 when SES not configured", async () => {
    ses.isConfigured.mockReturnValue(false);
    const res = await request(app()).post(`/email-marketing/campaigns/${CAMP_ID}/send`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not configured/i);
    expect(queueEmailCampaign).not.toHaveBeenCalled();
  });

  test("409 when campaign already sent", async () => {
    ses.isConfigured.mockReturnValue(true);
    dbQuery.mockResolvedValueOnce({ rows: [{ id: CAMP_ID, status: "sent", subject: "s", html_body: "h", name: "C" }] });
    const res = await request(app()).post(`/email-marketing/campaigns/${CAMP_ID}/send`).send({});
    expect(res.status).toBe(409);
    expect(queueEmailCampaign).not.toHaveBeenCalled();
  });

  test("enqueues + audits a draft campaign", async () => {
    ses.isConfigured.mockReturnValue(true);
    dbQuery.mockResolvedValueOnce({ rows: [{ id: CAMP_ID, status: "draft", subject: "s", html_body: "<p>h</p>", name: "C" }] });
    const res = await request(app()).post(`/email-marketing/campaigns/${CAMP_ID}/send`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, total: 3 });
    expect(queueEmailCampaign).toHaveBeenCalledWith(CAMP_ID);
  });
});

describe("POST /campaigns/:id/schedule", () => {
  test("400 on a past timestamp", async () => {
    const res = await request(app()).post(`/email-marketing/campaigns/${CAMP_ID}/schedule`).send({ scheduled_at: "2000-01-01T00:00:00Z" });
    expect(res.status).toBe(400);
  });
});
