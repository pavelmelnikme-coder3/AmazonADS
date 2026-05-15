"use strict";
const request = require("supertest");
const express = require("express");

const WS_ID   = "ws---0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const NK_ID   = "nk---0001-0000-0000-000000000001";
const CAMP_ID = "camp-0001-0000-0000-000000000001";

const SAMPLE_NK = {
  id: NK_ID, keyword_text: "running shoes", match_type: "negativeExact",
  level: "campaign", campaign_id: CAMP_ID, ad_group_id: null,
  created_at: "2026-01-01T00:00:00.000Z",
  campaign_name: "SP Auto", campaign_type: "sponsoredProducts", ad_group_name: null,
};

const CAMP_CTX = {
  profile_id: "prof-001", campaign_type: "sponsoredProducts",
  amazon_campaign_id: "AMZ001", amazon_profile_id: "12345",
  marketplace_id: "A1PA6795UKMFR9", connection_id: "conn-001",
  amazon_ad_group_id: null,
};

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock("../src/routes/audit", () => ({
  writeAudit: jest.fn().mockResolvedValue("audit-id"),
  updateAuditStatus: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/amazon/writeback", () => ({
  pushNegativeKeyword: jest.fn().mockResolvedValue({ ok: true }),
}));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: USER_ID, name: "Test User", role: "owner", org_id: ORG_ID };
    req.orgId = ORG_ID;
    next();
  },
  requireWorkspace: (req, _res, next) => {
    req.workspaceId = WS_ID; req.workspaceRole = "owner"; next();
  },
}));

const { query: dbQuery } = require("../src/db/pool");
const { pushNegativeKeyword } = require("../src/services/amazon/writeback");
const router = require("../src/routes/negativeKeywords");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/negative-keywords", router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

function resetMocks() {
  jest.resetAllMocks();
  pushNegativeKeyword.mockResolvedValue({ ok: true });
}

describe("GET /negative-keywords", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns list with pagination", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_NK] })
      .mockResolvedValueOnce({ rows: [{ total: "1" }] });
    const res = await request(app).get("/negative-keywords");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
  });

  it("filters by campaignId", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_NK] })
      .mockResolvedValueOnce({ rows: [{ total: "1" }] });
    const res = await request(app).get(`/negative-keywords?campaignId=${CAMP_ID}`);
    expect(res.status).toBe(200);
    const listSql = dbQuery.mock.calls[0][0];
    expect(listSql).toMatch(/nk\.campaign_id/);
  });

  it("filters by matchType negativeExact", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get("/negative-keywords?matchType=negativeExact");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContainEqual(["negativeExact", "negative_exact"]);
  });

  it("filters by level=campaign", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get("/negative-keywords?level=campaign");
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("campaign");
  });

  it("returns empty array when no negative keywords", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get("/negative-keywords");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });
});

describe("GET /negative-keywords/export.csv", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns CSV file", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_NK] });
    const res = await request(app).get("/negative-keywords/export.csv");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    expect(res.text).toContain("keyword_text");
    expect(res.text).toContain("running shoes");
  });

  it("returns empty CSV with header when no keywords", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/negative-keywords/export.csv");
    expect(res.status).toBe(200);
    expect(res.text).toContain("keyword_text,match_type");
  });
});

describe("POST /negative-keywords", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("creates a negative keyword", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [CAMP_CTX] })
      .mockResolvedValueOnce({ rows: [SAMPLE_NK] });
    const res = await request(app).post("/negative-keywords")
      .send({ campaignId: CAMP_ID, keywordText: "running shoes" });
    expect(res.status).toBe(200);
    expect(res.body.data.keyword_text).toBe("running shoes");
  });

  it("returns 400 when campaignId missing", async () => {
    const res = await request(app).post("/negative-keywords").send({ keywordText: "shoes" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when keywordText missing", async () => {
    const res = await request(app).post("/negative-keywords").send({ campaignId: CAMP_ID });
    expect(res.status).toBe(400);
  });

  it("returns 404 when campaign not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post("/negative-keywords")
      .send({ campaignId: CAMP_ID, keywordText: "shoes" });
    expect(res.status).toBe(404);
  });

  it("returns null data when conflict (already exists)", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [CAMP_CTX] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await request(app).post("/negative-keywords")
      .send({ campaignId: CAMP_ID, keywordText: "shoes" });
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });
});

describe("POST /negative-keywords/bulk", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("adds keywords to multiple campaigns", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [CAMP_CTX] })
      .mockResolvedValueOnce({ rows: [{ id: NK_ID }] });
    const res = await request(app).post("/negative-keywords/bulk")
      .send({ keywords: ["shoes"], campaignIds: [CAMP_ID] });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    expect(res.body.skipped).toBe(0);
  });

  it("returns 400 when keywords missing", async () => {
    const res = await request(app).post("/negative-keywords/bulk")
      .send({ campaignIds: [CAMP_ID] });
    expect(res.status).toBe(400);
  });

  it("returns 400 when campaignIds missing", async () => {
    const res = await request(app).post("/negative-keywords/bulk")
      .send({ keywords: ["shoes"] });
    expect(res.status).toBe(400);
  });

  it("tracks skipped on conflict", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [CAMP_CTX] })
      .mockResolvedValueOnce({ rows: [] }); // conflict → no row returned
    const res = await request(app).post("/negative-keywords/bulk")
      .send({ keywords: ["shoes"], campaignIds: [CAMP_ID] });
    expect(res.status).toBe(200);
    expect(res.body.skipped).toBe(1);
  });
});

describe("PATCH /negative-keywords/:id", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("updates keyword text", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ ...SAMPLE_NK, keyword_text: "new text" }] });
    const res = await request(app).patch(`/negative-keywords/${NK_ID}`)
      .send({ keywordText: "new text" });
    expect(res.status).toBe(200);
    expect(res.body.data.keyword_text).toBe("new text");
  });

  it("returns 400 when nothing to update", async () => {
    const res = await request(app).patch(`/negative-keywords/${NK_ID}`).send({});
    expect(res.status).toBe(400);
  });

  it("returns 404 when not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).patch(`/negative-keywords/${NK_ID}`)
      .send({ keywordText: "shoes" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /negative-keywords/bulk", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("deletes multiple keywords", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_NK] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).delete("/negative-keywords/bulk")
      .send({ ids: [NK_ID] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
  });

  it("returns 400 when ids missing", async () => {
    const res = await request(app).delete("/negative-keywords/bulk").send({});
    expect(res.status).toBe(400);
  });
});

describe("DELETE /negative-keywords/:id", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("deletes keyword and returns success", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_NK] })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const res = await request(app).delete(`/negative-keywords/${NK_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("still returns success when not found (idempotent)", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const res = await request(app).delete(`/negative-keywords/${NK_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
