"use strict";
/**
 * Keyword Ranks routes — comprehensive test suite
 *
 * Endpoints:
 *   GET    /keyword-ranks              — list tracked keywords with latest snapshot
 *   POST   /keyword-ranks              — add keyword; validates ASIN + keyword length; upserts; fires async rank check
 *   PATCH  /keyword-ranks/labels/:asin — upserts asin_labels; 400 for invalid ASIN
 *   GET    /keyword-ranks/:id/history  — rank snapshots ordered ASC
 *   DELETE /keyword-ranks/:id          — soft-deletes (sets is_active = FALSE); 404 handled via ok:true (route always returns ok)
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID  = "ws---0001-0000-0000-000000000001";
const ORG_ID = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const TK_ID  = "tk---0001-0000-0000-000000000001";

const VALID_ASIN   = "B08N5WRWNW"; // exactly 10 alphanumeric chars — verified /^[A-Z0-9]{10}$/
const INVALID_ASIN = "bad-asin";

const SAMPLE_TRACKED_KEYWORD = {
  id: TK_ID,
  workspace_id: WS_ID,
  asin: VALID_ASIN,
  keyword: "running shoes",
  marketplace_id: "A1PA6795UKMFR9",
  search_volume: 12000,
  display_order: null,
  position: 5,
  found: true,
  blocked: false,
  checked_at: "2026-05-14T10:00:00.000Z",
  prev_position: 7,
  asin_label: "My Product",
  asin_display_order: 1,
  asin_portfolio_id: null,
  product_title: "Running Shoes DE",
  product_brand: "TestBrand",
  product_image_url: "https://example.com/img.jpg",
  created_at: "2026-04-01T00:00:00.000Z",
};

const SAMPLE_SNAPSHOT = {
  position: 5,
  found: true,
  blocked: false,
  captured_at: "2026-05-14T10:00:00.000Z",
};

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("../src/services/amazon/rankScraper", () => ({
  scrapeRank:            jest.fn().mockResolvedValue({ position: 3, page: 1, found: true, blocked: false, search_volume: null }),
  scrapeWorkspaceRanks:  jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../src/services/junglescout/client", () => ({
  getRanksByAsin: jest.fn().mockResolvedValue(new Map()),
  isConfigured:   jest.fn().mockReturnValue(false),
}));

jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user          = { id: USER_ID, name: "Test User", role: "owner", org_id: ORG_ID };
    req.orgId         = ORG_ID;
    next();
  },
  requireWorkspace: (req, _res, next) => {
    req.workspaceId   = WS_ID;
    req.workspaceRole = "owner";
    next();
  },
}));

const { query: dbQuery }                    = require("../src/db/pool");
const { scrapeRank }                        = require("../src/services/amazon/rankScraper");
const { getRanksByAsin, isConfigured: jsConfigured } = require("../src/services/junglescout/client");
const keywordRanksRouter                    = require("../src/routes/keywordRanks");

// ─── App builder ──────────────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/keyword-ranks", keywordRanksRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

let app;

beforeEach(() => {
  // resetAllMocks clears mockResolvedValueOnce queues in addition to call history,
  // preventing unconsumed mocks from leaking into subsequent tests.
  jest.resetAllMocks();
  app = buildApp();
  // Default: Jungle Scout not configured
  jsConfigured.mockReturnValue(false);
});

// ─── GET /keyword-ranks ───────────────────────────────────────────────────────
describe("GET /keyword-ranks", () => {
  test("returns list of tracked keywords", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_TRACKED_KEYWORD] });

    const res = await request(app).get("/keyword-ranks");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe(TK_ID);
    expect(res.body[0].asin).toBe(VALID_ASIN);
    expect(res.body[0].keyword).toBe("running shoes");
    expect(res.body[0].position).toBe(5);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("FROM tracked_keywords tk"),
      [WS_ID]
    );
  });

  test("returns empty array when no keywords tracked", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/keyword-ranks");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("returns multiple tracked keywords", async () => {
    const kw2 = { ...SAMPLE_TRACKED_KEYWORD, id: "tk---0002", keyword: "yoga mat" };
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_TRACKED_KEYWORD, kw2] });

    const res = await request(app).get("/keyword-ranks");

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[1].keyword).toBe("yoga mat");
  });
});

// ─── POST /keyword-ranks ──────────────────────────────────────────────────────
describe("POST /keyword-ranks", () => {
  test("returns 400 for invalid ASIN (too short)", async () => {
    const res = await request(app)
      .post("/keyword-ranks")
      .send({ asin: "SHORT", keyword: "running shoes" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid asin/i);
  });

  test("returns 400 for invalid ASIN (lowercase letters)", async () => {
    const res = await request(app)
      .post("/keyword-ranks")
      .send({ asin: "b0example000", keyword: "running shoes" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid asin/i);
  });

  test("returns 400 for ASIN with special characters", async () => {
    const res = await request(app)
      .post("/keyword-ranks")
      .send({ asin: "B0-EXAMPLE!", keyword: "running shoes" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid asin/i);
  });

  test("returns 400 when keyword is missing", async () => {
    const res = await request(app)
      .post("/keyword-ranks")
      .send({ asin: VALID_ASIN });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/keyword is required/i);
  });

  test("returns 400 when keyword is too short (1 char)", async () => {
    const res = await request(app)
      .post("/keyword-ranks")
      .send({ asin: VALID_ASIN, keyword: "x" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/min 2 chars/i);
  });

  test("returns 400 when keyword is empty string", async () => {
    const res = await request(app)
      .post("/keyword-ranks")
      .send({ asin: VALID_ASIN, keyword: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/keyword is required/i);
  });

  test("successfully adds keyword — verifies INSERT call and returns 200", async () => {
    const insertedRow = {
      ...SAMPLE_TRACKED_KEYWORD,
      id: TK_ID,
      inserted: false, // not newly inserted → skip async rank check
    };
    dbQuery.mockResolvedValueOnce({ rows: [insertedRow] });

    const res = await request(app)
      .post("/keyword-ranks")
      .send({ asin: VALID_ASIN, keyword: "running shoes", marketplaceId: "A1PA6795UKMFR9" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(TK_ID);
    expect(res.body.asin).toBe(VALID_ASIN);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO tracked_keywords"),
      expect.arrayContaining([WS_ID, VALID_ASIN, "running shoes", "A1PA6795UKMFR9"])
    );
  });

  test("accepts lowercase ASIN input and uppercases it before validation", async () => {
    // Route does asin.trim().toUpperCase() before regex check.
    // "b08n5wrwnw".toUpperCase() = "B08N5WRWNW" — exactly 10 chars, passes /^[A-Z0-9]{10}$/.
    const insertedRow = { ...SAMPLE_TRACKED_KEYWORD, inserted: false };
    dbQuery.mockResolvedValueOnce({ rows: [insertedRow] });

    const res = await request(app)
      .post("/keyword-ranks")
      .send({ asin: "b08n5wrwnw", keyword: "running shoes" });

    expect(res.status).toBe(200);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO tracked_keywords"),
      expect.arrayContaining([WS_ID, "B08N5WRWNW"])
    );
  });

  test("does not call scraper synchronously when inserted=false", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ ...SAMPLE_TRACKED_KEYWORD, inserted: false }] });

    await request(app)
      .post("/keyword-ranks")
      .send({ asin: VALID_ASIN, keyword: "running shoes" });

    // scrapeRank should not be called synchronously (response is sent before async block)
    expect(scrapeRank).not.toHaveBeenCalled();
  });

  test("upserts on conflict — re-activates existing keyword", async () => {
    // ON CONFLICT DO UPDATE SET is_active = TRUE — DB returns the updated row.
    // Route responds with the full tracked_keyword row regardless of insert vs update path.
    const reactivatedRow = { ...SAMPLE_TRACKED_KEYWORD, inserted: false };
    dbQuery.mockResolvedValueOnce({ rows: [reactivatedRow] });

    const res = await request(app)
      .post("/keyword-ranks")
      .send({ asin: VALID_ASIN, keyword: "running shoes" });

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(TK_ID);
    expect(res.body.asin).toBe(VALID_ASIN);
  });
});

// ─── PATCH /keyword-ranks/labels/:asin ───────────────────────────────────────
describe("PATCH /keyword-ranks/labels/:asin", () => {
  test("upserts label and returns ok:true", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch(`/keyword-ranks/labels/${VALID_ASIN}`)
      .send({ label: "My Product" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO asin_labels"),
      expect.arrayContaining([WS_ID, VALID_ASIN])
    );
  });

  test("returns 400 for invalid ASIN format in URL param", async () => {
    const res = await request(app)
      .patch(`/keyword-ranks/labels/${INVALID_ASIN}`)
      .send({ label: "My Product" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid asin/i);
  });

  test("returns 400 for lowercase ASIN in URL param", async () => {
    const res = await request(app)
      .patch("/keyword-ranks/labels/b00example0")
      .send({ label: "Lowercase Product" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid asin/i);
  });

  test("upserts portfolio_id when provided", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch(`/keyword-ranks/labels/${VALID_ASIN}`)
      .send({ label: "Test Product", portfolio_id: "port-001" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // portfolio_id is included as a positional param in the query
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO asin_labels"),
      expect.arrayContaining([WS_ID, VALID_ASIN, "Test Product", "port-001"])
    );
  });

  test("updates label to empty string", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch(`/keyword-ranks/labels/${VALID_ASIN}`)
      .send({ label: "" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ─── GET /keyword-ranks/:id/history ──────────────────────────────────────────
describe("GET /keyword-ranks/:id/history", () => {
  test("returns snapshot history ordered ASC", async () => {
    const snapshot1 = { ...SAMPLE_SNAPSHOT, captured_at: "2026-05-08T00:00:00.000Z", position: 8 };
    const snapshot2 = { ...SAMPLE_SNAPSHOT, captured_at: "2026-05-14T00:00:00.000Z", position: 5 };
    dbQuery.mockResolvedValueOnce({ rows: [snapshot1, snapshot2] });

    const res = await request(app).get(`/keyword-ranks/${TK_ID}/history`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].position).toBe(8);
    expect(res.body[1].position).toBe(5);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("FROM keyword_rank_snapshots"),
      [TK_ID]
    );
  });

  test("returns empty array when no history", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get(`/keyword-ranks/${TK_ID}/history`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test("uses default 30 days when ?days not provided", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_SNAPSHOT] });

    const res = await request(app).get(`/keyword-ranks/${TK_ID}/history`);

    expect(res.status).toBe(200);
    // The query uses template literal interval, check it was called with the keyword id
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("30 days"),
      [TK_ID]
    );
  });

  test("respects ?days=7 parameter", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_SNAPSHOT] });

    const res = await request(app).get(`/keyword-ranks/${TK_ID}/history?days=7`);

    expect(res.status).toBe(200);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("7 days"),
      [TK_ID]
    );
  });

  test("clamps days to max 90", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get(`/keyword-ranks/${TK_ID}/history?days=200`);

    expect(res.status).toBe(200);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("90 days"),
      [TK_ID]
    );
  });
});

// ─── DELETE /keyword-ranks/:id ───────────────────────────────────────────────
describe("DELETE /keyword-ranks/:id", () => {
  test("soft-deletes tracked keyword and returns ok:true", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete(`/keyword-ranks/${TK_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE tracked_keywords SET is_active = FALSE"),
      [TK_ID, WS_ID]
    );
  });

  test("always returns ok:true (route soft-deletes, no 404 branch)", async () => {
    // The DELETE route does UPDATE ... WHERE id=$1 AND workspace_id=$2 and always returns ok:true
    // even if no row matched — there is no 404 path in this route
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).delete("/keyword-ranks/nonexistent-id");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  test("scopes the delete to the current workspace", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).delete(`/keyword-ranks/${TK_ID}`);

    expect(dbQuery).toHaveBeenCalledWith(
      expect.stringContaining("workspace_id = $2"),
      [TK_ID, WS_ID]
    );
  });
});
