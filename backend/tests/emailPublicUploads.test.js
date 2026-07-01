"use strict";
/**
 * Public (unauthenticated) serving of uploaded campaign images/files — mail clients have
 * no AdsFlow session, so these must work without auth while still guarding path traversal.
 */
const request = require("supertest");
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");

let TMP;
beforeAll(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), "adsflow-public-uploads-test-"));
  process.env.EMAIL_UPLOAD_ROOT = TMP;
});
afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  delete process.env.EMAIL_UPLOAD_ROOT;
});

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const WS_ID = "11111111-1111-1111-1111-111111111111";

// Lazy require so uploads.js resolves EMAIL_UPLOAD_ROOT after it's set (module-level const).
function app() {
  const router = require("../src/routes/emailPublic");
  const a = express(); a.use("/email", router);
  return a;
}

describe("GET /email/uploads/images/:id/:filename", () => {
  test("serves an existing file with correct content-type + long-lived cache headers", async () => {
    const dir = path.join(TMP, "email", "images", WS_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "abc123.jpg"), Buffer.from([0xff, 0xd8, 0xff]));
    const res = await request(app()).get(`/email/uploads/images/${WS_ID}/abc123.jpg`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("image/jpeg");
    expect(res.headers["cache-control"]).toMatch(/max-age=31536000/);
  });

  test("404s for a missing file", async () => {
    const res = await request(app()).get(`/email/uploads/images/${WS_ID}/missing.jpg`);
    expect(res.status).toBe(404);
  });

  test("blocks a directory-traversal filename", async () => {
    const res = await request(app()).get(`/email/uploads/images/${WS_ID}/${encodeURIComponent("../../../etc/passwd")}`);
    expect(res.status).toBe(404);
  });

  test("blocks a directory-traversal id", async () => {
    const res = await request(app()).get(`/email/uploads/images/${encodeURIComponent("../../etc")}/passwd.jpg`);
    expect(res.status).toBe(404);
  });
});

describe("GET /email/uploads/files/:id/:filename", () => {
  test("serves a pdf with the right content-type", async () => {
    const dir = path.join(TMP, "email", "files", WS_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "pricelist.pdf"), Buffer.from("%PDF-1.4"));
    const res = await request(app()).get(`/email/uploads/files/${WS_ID}/pricelist.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
  });
});
