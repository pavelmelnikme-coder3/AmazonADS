"use strict";
/**
 * Email marketing uploads — image/file hosting for block content, and true SMTP
 * attachments for campaigns. Uses real disk storage (multer.diskStorage) pointed at a
 * throwaway temp dir via EMAIL_UPLOAD_ROOT so tests never touch the real backend/uploads/.
 */
const request = require("supertest");
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");

const WS_ID = "ws---0001-0000-0000-000000000001";
const ORG_ID = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const CAMP_ID = "camp-0001-0000-0000-000000000001";

let TMP;
beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "adsflow-uploads-test-"));
  process.env.EMAIL_UPLOAD_ROOT = TMP;
});
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.EMAIL_UPLOAD_ROOT;
});

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

// Lazy require: routes (and the uploads.js module it pulls in) must load AFTER
// EMAIL_UPLOAD_ROOT is set, since uploads.js resolves it once at module-load time.
function app() {
  const router = require("../src/routes/emailMarketing");
  const a = express(); a.use(express.json()); a.use("/email-marketing", router);
  a.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return a;
}

beforeEach(() => jest.clearAllMocks());

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"
);

describe("POST /uploads/image", () => {
  test("400 on unsupported mime type", async () => {
    const res = await request(app()).post("/email-marketing/uploads/image")
      .attach("file", Buffer.from("not an image"), { filename: "a.txt", contentType: "text/plain" });
    expect(res.status).toBe(400);
  });

  test("accepts a real png and returns a public url + writes it to disk", async () => {
    const res = await request(app()).post("/email-marketing/uploads/image")
      .attach("file", PNG_1PX, { filename: "a.png", contentType: "image/png" });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(new RegExp(`/api/v1/email/uploads/images/${WS_ID}/.+\\.png$`));
    expect(fs.existsSync(path.join(TMP, "email", "images", WS_ID, res.body.filename))).toBe(true);
  });
});

describe("POST /uploads/file", () => {
  test("400 on unsupported extension", async () => {
    const res = await request(app()).post("/email-marketing/uploads/file")
      .attach("file", Buffer.from("hi"), { filename: "a.exe", contentType: "application/octet-stream" });
    expect(res.status).toBe(400);
  });

  test("accepts a pdf and returns the original filename + a public url", async () => {
    const res = await request(app()).post("/email-marketing/uploads/file")
      .attach("file", Buffer.from("%PDF-1.4 fake"), { filename: "price-list.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(new RegExp(`/api/v1/email/uploads/files/${WS_ID}/.+\\.pdf$`));
    expect(res.body.filename).toBe("price-list.pdf");
  });
});

describe("POST /campaigns/:id/attachments", () => {
  test("409 when campaign not found/editable", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).post(`/email-marketing/campaigns/${CAMP_ID}/attachments`)
      .attach("file", Buffer.from("%PDF-1.4"), { filename: "a.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(409);
  });

  test("400 when cumulative size would exceed 10MB", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ attachments: [{ id: "x", filename: "big.pdf", storedName: "big.pdf", size: 9.9 * 1024 * 1024 }] }] });
    const res = await request(app()).post(`/email-marketing/campaigns/${CAMP_ID}/attachments`)
      .attach("file", Buffer.alloc(200 * 1024, 1), { filename: "b.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/10MB/);
  });

  test("appends a new attachment entry via the jsonb || operator", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ attachments: [] }] })
      .mockResolvedValueOnce({ rows: [{ attachments: [{ id: "new", filename: "c.pdf", size: 5 }] }] });
    const res = await request(app()).post(`/email-marketing/campaigns/${CAMP_ID}/attachments`)
      .attach("file", Buffer.from("%PDF-1.4"), { filename: "c.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(200);
    expect(dbQuery.mock.calls[1][0]).toMatch(/attachments \|\| \$2::jsonb/);
  });
});

describe("DELETE /campaigns/:id/attachments/:attId", () => {
  test("removes the matching entry", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ attachments: [{ id: "att1", filename: "a.pdf", storedName: "stored-a.pdf" }] }] })
      .mockResolvedValueOnce({ rows: [{ attachments: [] }] });
    const res = await request(app()).delete(`/email-marketing/campaigns/${CAMP_ID}/attachments/att1`);
    expect(res.status).toBe(200);
    expect(res.body.attachments).toEqual([]);
  });

  test("409 when campaign not editable", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app()).delete(`/email-marketing/campaigns/${CAMP_ID}/attachments/att1`);
    expect(res.status).toBe(409);
  });
});
