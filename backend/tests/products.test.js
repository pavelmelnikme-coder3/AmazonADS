"use strict";
/**
 * Products routes — comprehensive test suite
 *
 * Endpoints:
 *   GET  /products               — list active products with BSR
 *   POST /products               — add ASIN (ASIN validation, no SP-API path)
 *   POST /products/sync-meta     — trigger metadata scrape
 *   DELETE /products/:id         — soft delete
 *   GET  /products/:id/history   — BSR history
 *   GET  /products/notes         — list notes
 *   POST /products/notes         — create note
 *   DELETE /products/notes/:id   — delete note
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID      = "ws---0001-0000-0000-000000000001";
const ORG_ID     = "org--0001-0000-0000-000000000001";
const USER_ID    = "user-0001-0000-0000-000000000001";
const PRODUCT_ID = "prod-0001-0000-0000-000000000001";
const NOTE_ID    = "note-0001-0000-0000-000000000001";

const SAMPLE_PRODUCT = {
  id: PRODUCT_ID,
  workspace_id: WS_ID,
  asin: "B08N5WRWNW",
  marketplace_id: "A1PA6795UKMFR9",
  title: "Test Product DE",
  brand: "TestBrand",
  image_url: "https://example.com/img.jpg",
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  best_rank: 42,
  best_category: "Kitchen",
  bsr_updated_at: "2026-04-01T00:00:00.000Z",
};

const SAMPLE_NOTE = {
  id: NOTE_ID,
  workspace_id: WS_ID,
  product_id: PRODUCT_ID,
  note_date: "2026-04-22",
  text: "This is a test note",
  created_by: USER_ID,
  author_name: "Test User",
};

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/services/amazon/spClient", () => ({
  getCatalogItem: jest.fn(),
}));
jest.mock("../src/jobs/workers", () => ({
  queueProductMetaSync: jest.fn().mockResolvedValue({ id: "job-1" }),
}));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user  = { id: USER_ID, name: "Test User", role: "owner", org_id: ORG_ID };
    req.orgId = ORG_ID;
    next();
  },
  requireWorkspace: (req, _res, next) => {
    req.workspaceId   = WS_ID;
    req.workspaceRole = "owner";
    next();
  },
}));

const { query: dbQuery } = require("../src/db/pool");
const { queueProductMetaSync } = require("../src/jobs/workers");
const productsRouter = require("../src/routes/products");

// Ensure SP-API env var is NOT set — forces the no-SP-API code path
delete process.env.SP_API_REFRESH_TOKEN;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/products", productsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /products
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /products", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns list of active products with BSR data", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_PRODUCT] });

    const res = await request(app).get("/products");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].asin).toBe("B08N5WRWNW");
    expect(res.body[0].best_rank).toBe(42);
  });

  it("returns empty array when no products", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/products");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /products
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /products", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("adds a valid ASIN and returns product", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_PRODUCT] });

    const res = await request(app).post("/products").send({ asin: "B08N5WRWNW" });
    expect(res.status).toBe(200);
    expect(res.body.asin).toBe("B08N5WRWNW");
    expect(queueProductMetaSync).toHaveBeenCalledWith(WS_ID);
  });

  it("normalizes lowercase ASIN to uppercase", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ ...SAMPLE_PRODUCT, asin: "B08N5WRWNW" }] });

    const res = await request(app).post("/products").send({ asin: "b08n5wrwnw" });
    expect(res.status).toBe(200);
    const insertParams = dbQuery.mock.calls[0][1];
    expect(insertParams).toContain("B08N5WRWNW");
  });

  it("returns 400 for ASIN shorter than 10 chars", async () => {
    const res = await request(app).post("/products").send({ asin: "B0001" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid asin/i);
  });

  it("returns 400 for ASIN longer than 10 chars", async () => {
    const res = await request(app).post("/products").send({ asin: "B08N5WRWNWX" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid asin/i);
  });

  it("returns 400 for ASIN with invalid characters", async () => {
    const res = await request(app).post("/products").send({ asin: "B08N5WRWN!" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid asin/i);
  });

  it("returns 400 when ASIN is missing", async () => {
    const res = await request(app).post("/products").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid asin/i);
  });

  it("uses default marketplace when not provided", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_PRODUCT] });

    await request(app).post("/products").send({ asin: "B08N5WRWNW" });
    const insertParams = dbQuery.mock.calls[0][1];
    expect(insertParams).toContain("A1PA6795UKMFR9");
  });

  it("uses provided marketplaceId", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_PRODUCT] });

    await request(app).post("/products").send({ asin: "B08N5WRWNW", marketplaceId: "ATVPDKIKX0DER" });
    const insertParams = dbQuery.mock.calls[0][1];
    expect(insertParams).toContain("ATVPDKIKX0DER");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /products/sync-meta
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /products/sync-meta", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("queues sync when pending products exist", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ cnt: "3" }] });

    const res = await request(app).post("/products/sync-meta");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.queued).toBe(3);
    expect(queueProductMetaSync).toHaveBeenCalledWith(WS_ID);
  });

  it("returns queued:0 when all products have metadata", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ cnt: "0" }] });

    const res = await request(app).post("/products/sync-meta");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.queued).toBe(0);
    expect(queueProductMetaSync).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /products/:id
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /products/:id", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("soft-deletes product and returns ok:true", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete(`/products/${PRODUCT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toContain("is_active=false");
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(PRODUCT_ID);
    expect(params).toContain(WS_ID);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /products/:id/history
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /products/:id/history", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns BSR history in chronological order", async () => {
    const snapshots = [
      { captured_at: "2026-04-20T00:00:00Z", best_rank: 50, best_category: "Kitchen" },
      { captured_at: "2026-04-21T00:00:00Z", best_rank: 45, best_category: "Kitchen" },
      { captured_at: "2026-04-22T00:00:00Z", best_rank: 42, best_category: "Kitchen" },
    ];
    // Query returns DESC, route reverses to chronological
    dbQuery.mockResolvedValueOnce({ rows: [...snapshots].reverse() });

    const res = await request(app).get(`/products/${PRODUCT_ID}/history`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(3);
    // Verify chronological order (oldest first)
    expect(res.body[0].captured_at).toBe("2026-04-20T00:00:00Z");
    expect(res.body[2].captured_at).toBe("2026-04-22T00:00:00Z");
  });

  it("returns empty array when no snapshots", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get(`/products/${PRODUCT_ID}/history`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /products/notes
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /products/notes", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns all notes for workspace", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_NOTE] });

    const res = await request(app).get("/products/notes");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].text).toBe("This is a test note");
  });

  it("filters by product_id when provided", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_NOTE] });

    const res = await request(app).get(`/products/notes?product_id=${PRODUCT_ID}`);
    expect(res.status).toBe(200);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(PRODUCT_ID);
  });

  it("returns empty array when no notes", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/products/notes");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /products/notes
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /products/notes", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("creates a note and returns 201", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_NOTE] });

    const res = await request(app)
      .post("/products/notes")
      .send({ product_id: PRODUCT_ID, note_date: "2026-04-22", text: "This is a test note" });

    expect(res.status).toBe(201);
    expect(res.body.text).toBe("This is a test note");
  });

  it("creates workspace-level note without product_id", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [{ ...SAMPLE_NOTE, product_id: null }] });

    const res = await request(app)
      .post("/products/notes")
      .send({ text: "Workspace-level note" });

    expect(res.status).toBe(201);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(null); // product_id is null
  });

  it("returns 400 when text is empty", async () => {
    const res = await request(app)
      .post("/products/notes")
      .send({ text: "" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/text/i);
  });

  it("returns 400 when text is missing", async () => {
    const res = await request(app)
      .post("/products/notes")
      .send({ product_id: PRODUCT_ID });

    expect(res.status).toBe(400);
  });

  it("uses current date when note_date is not provided", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [SAMPLE_NOTE] });

    await request(app).post("/products/notes").send({ text: "Test note" });

    const params = dbQuery.mock.calls[0][1];
    // 4th param is note_date — should be a date string like "2026-04-22"
    expect(params[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /products/notes/:noteId
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /products/notes/:noteId", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("deletes note and returns ok:true", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const res = await request(app).delete(`/products/notes/${NOTE_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(NOTE_ID);
    expect(params).toContain(WS_ID);
  });
});
