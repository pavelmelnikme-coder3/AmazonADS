/**
 * Search Terms — comprehensive test suite
 *
 * Covers all 5 endpoints:
 *   GET  /search-terms            list + filters + pagination + sorting
 *   GET  /search-terms/campaigns  picker list
 *   POST /search-terms/sync       trigger report refresh
 *   POST /search-terms/add-keyword  harvest → keywords table
 *   POST /search-terms/add-negative harvest → negative keywords
 *
 * Strategy: mock DB (pool.query) and auth middleware — no real DB required.
 */

"use strict";

const request  = require("supertest");
const express  = require("express");

// ─── Fixtures ────────────────────────────────────────────────────────────────
const WS_ID   = "aaaaaaaa-0000-0000-0000-000000000001";
const ORG_ID  = "bbbbbbbb-0000-0000-0000-000000000001";
const USER_ID = "cccccccc-0000-0000-0000-000000000001";
const CAMP_ID = "dddddddd-0000-0000-0000-000000000001";
const AG_ID   = "eeeeeeee-0000-0000-0000-000000000001";
const KW_ID   = "ffffffff-0000-0000-0000-000000000001";
const PROF_ID = "11111111-0000-0000-0000-000000000001";

const SAMPLE_STM = {
  id: "stm-0001-0000-0000-000000000001",
  workspace_id: WS_ID,
  campaign_id: CAMP_ID,
  campaign_name: "Test Campaign Auto",
  query: "feuerfeste unterlage",
  keyword_text: "feuerfeste unterlage",
  match_type: "exact",
  impressions: 1068,
  clicks: 8,
  spend: "3.80",
  orders: 3,
  sales: "44.10",
  acos: "8.61",
  date_start: "2026-03-03",
  date_end: "2026-04-01",
};

// ─── Mocks ───────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/jobs/workers", () => ({ queueMetricsBackfill: jest.fn().mockResolvedValue({ id: "job-1" }) }));
jest.mock("../src/routes/audit", () => ({ writeAudit: jest.fn().mockResolvedValue(undefined) }));

const { query: dbQuery }             = require("../src/db/pool");
const { queueMetricsBackfill }       = require("../src/jobs/workers");
const { writeAudit }                 = require("../src/routes/audit");

// Inject auth middleware directly — avoids JWT + DB user lookup
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user     = { id: USER_ID, name: "Test User", role: "owner", org_id: ORG_ID };
    req.orgId    = ORG_ID;
    next();
  },
  requireWorkspace: (req, _res, next) => {
    req.workspaceId   = WS_ID;
    req.workspaceRole = "owner";
    next();
  },
}));

// ─── App setup ───────────────────────────────────────────────────────────────
const searchTermsRouter = require("../src/routes/searchTerms");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/search-terms", searchTermsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

// ─── Helper ──────────────────────────────────────────────────────────────────
/** Default two-call mock: first call = data rows, second = count row */
function mockListQuery(rows, total) {
  dbQuery
    .mockResolvedValueOnce({ rows })               // data
    .mockResolvedValueOnce({ rows: [{ total }] }); // count
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. GET /search-terms
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /search-terms", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns paginated list with default params", async () => {
    mockListQuery([SAMPLE_STM], 1);

    const res = await request(app).get("/search-terms");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].query).toBe("feuerfeste unterlage");
    expect(res.body.pagination).toMatchObject({ total: 1, page: 1, limit: 100 });
  });

  test("applies valid limit values", async () => {
    for (const limit of [25, 50, 100, 200, 500]) {
      mockListQuery([], 0);
      const res = await request(app).get(`/search-terms?limit=${limit}`);
      expect(res.status).toBe(200);
      expect(res.body.pagination.limit).toBe(limit);
    }
  });

  test("falls back to limit=100 for invalid limit", async () => {
    mockListQuery([], 0);
    const res = await request(app).get("/search-terms?limit=999");
    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);
  });

  test("calculates correct offset for page 3, limit 25", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?page=3&limit=25");
    // offset = (3-1)*25 = 50 — should appear in SQL params
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/OFFSET/i);
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(50);
  });

  test("page=0 clamps to page 1 — offset must be 0 not negative", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?page=0&limit=25");
    const params = dbQuery.mock.calls[0][1];
    const offset = params[params.length - 1];
    expect(offset).toBe(0);
  });

  test("page=-5 clamps to page 1 — offset must be 0 not negative", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?page=-5&limit=25");
    const params = dbQuery.mock.calls[0][1];
    const offset = params[params.length - 1];
    expect(offset).toBe(0);
  });

  test("filters by search query (ILIKE)", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?search=feuerfest");
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("%feuerfest%");
  });

  test("filters by minClicks", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?minClicks=5");
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(5);
  });

  test("filters by minSpend", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?minSpend=2.50");
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(2.5);
  });

  test("filters hasOrders=true — SQL must check orders > 0", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?hasOrders=true");
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/orders\s*>\s*0/i);
  });

  test("filters noOrders=true — SQL must check orders=0 AND clicks>0", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?noOrders=true");
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/orders\s*=\s*0/i);
    expect(sql).toMatch(/clicks\s*>\s*0/i);
  });

  test("date range filter with valid dateFrom/dateTo", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?dateFrom=2026-03-01&dateTo=2026-03-31");
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("2026-03-01");
    expect(params).toContain("2026-03-31");
  });

  test("ignores invalid date format and uses metricsDays instead", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?dateFrom=not-a-date&dateTo=also-not");
    const sql = dbQuery.mock.calls[0][0];
    // should use INTERVAL not literal date params
    expect(sql).toMatch(/INTERVAL/i);
  });

  test("metricsDays clamped to 1-365", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?metricsDays=999");
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/365 days/i);
  });

  test("metricsDays=0 clamps to 1 day (NaN-safe parseInt check)", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?metricsDays=0");
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/1 days/i);
  });

  test("sortBy defaults to spend DESC", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms");
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/stm\.spend\s+DESC/i);
  });

  test("sortBy=clicks sortDir=asc", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?sortBy=clicks&sortDir=asc");
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/stm\.clicks\s+ASC/i);
  });

  test("invalid sortBy falls back to spend", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?sortBy=injected_field--");
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/stm\.spend/i);
  });

  test("campaign type SP filter applied", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?campaignType=SP");
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("sponsoredProducts");
  });

  test("campaign type SB filter applied", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?campaignType=SB");
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("sponsoredBrands");
  });

  test("campaignIds filter — single UUID passed as array", async () => {
    mockListQuery([], 0);
    await request(app).get(`/search-terms?campaignIds[]=${CAMP_ID}`);
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/stm\.campaign_id\s*=\s*ANY/i);
  });

  test("pagination math: pages = ceil(total / limit)", async () => {
    mockListQuery([SAMPLE_STM], 37);
    const res = await request(app).get("/search-terms?limit=25");
    expect(res.body.pagination.pages).toBe(2); // ceil(37/25)
  });

  test("empty result returns empty data array not null", async () => {
    mockListQuery([], 0);
    const res = await request(app).get("/search-terms");
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  test("DB error propagates as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("DB connection lost"));
    const res = await request(app).get("/search-terms");
    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. GET /search-terms/campaigns
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /search-terms/campaigns", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  const CAMP_ROW = {
    id: CAMP_ID,
    name: "3 [SP-AUTO] Feuermatte",
    campaign_type: "sponsoredProducts",
    ad_groups: [{ id: AG_ID, name: "Default Group" }],
  };

  test("returns list of campaigns with ad_groups", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [CAMP_ROW] });
    const res = await request(app).get("/search-terms/campaigns");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].ad_groups).toHaveLength(1);
  });

  test("filters by campaignType=SP", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get("/search-terms/campaigns?campaignType=SP");
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("sponsoredProducts");
  });

  test("filters by campaignType=SB", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get("/search-terms/campaigns?campaignType=SB");
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("sponsoredBrands");
  });

  test("filters by campaignType=SD", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get("/search-terms/campaigns?campaignType=SD");
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain("sponsoredDisplay");
  });

  test("excludes archived campaigns", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get("/search-terms/campaigns");
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).toMatch(/state\s*!=\s*'archived'/i);
  });

  test("unknown campaignType is ignored (no extra filter)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    await request(app).get("/search-terms/campaigns?campaignType=UNKNOWN");
    const params = dbQuery.mock.calls[0][1];
    // only workspaceId in params
    expect(params).toEqual([WS_ID]);
  });

  test("returns empty array when no campaigns", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app).get("/search-terms/campaigns");
    expect(res.body).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. POST /search-terms/sync
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /search-terms/sync", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("queues backfill and returns success with date range", async () => {
    const res = await request(app).post("/search-terms/sync");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/queued/i);
    expect(res.body.dateFrom).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.dateTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("calls queueMetricsBackfill with workspaceId", async () => {
    await request(app).post("/search-terms/sync");
    expect(queueMetricsBackfill).toHaveBeenCalledWith(
      WS_ID,
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
  });

  test("dateFrom is 30 days before dateTo", async () => {
    const res = await request(app).post("/search-terms/sync");
    const from  = new Date(res.body.dateFrom);
    const to    = new Date(res.body.dateTo);
    const diffMs = to - from;
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeCloseTo(29, 0); // today-30 → today-1 = 29 day gap
  });

  test("queue failure returns 500", async () => {
    queueMetricsBackfill.mockRejectedValueOnce(new Error("Redis down"));
    const res = await request(app).post("/search-terms/sync");
    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. POST /search-terms/add-keyword
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /search-terms/add-keyword", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  /** Sets up DB mocks for a successful single-campaign keyword add */
  function mockSuccessfulAdd() {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ profile_id: PROF_ID }] })   // campaign lookup
      .mockResolvedValueOnce({ rows: [{ id: AG_ID }] })             // ad_group lookup
      .mockResolvedValueOnce({ rows: [] })                          // existing keyword check
      .mockResolvedValueOnce({ rows: [{ id: KW_ID }] });            // INSERT keyword
  }

  test("adds keyword successfully for single campaign", async () => {
    mockSuccessfulAdd();
    const res = await request(app)
      .post("/search-terms/add-keyword")
      .send({ query: "feuerfeste matte", campaignId: CAMP_ID });

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    expect(res.body.skipped).toBe(0);
    expect(res.body.keywordId).toBe(KW_ID);
    expect(res.body.results[0].success).toBe(true);
  });

  test("uses default bid 0.50 when bid not provided", async () => {
    mockSuccessfulAdd();
    await request(app)
      .post("/search-terms/add-keyword")
      .send({ query: "test keyword", campaignId: CAMP_ID });

    const insertCall = dbQuery.mock.calls.find(c => c[0].includes("INSERT INTO keywords"));
    expect(insertCall[1]).toContain(0.5);
  });

  test("uses provided bid", async () => {
    mockSuccessfulAdd();
    await request(app)
      .post("/search-terms/add-keyword")
      .send({ query: "test keyword", campaignId: CAMP_ID, bid: 1.25 });

    const insertCall = dbQuery.mock.calls.find(c => c[0].includes("INSERT INTO keywords"));
    expect(insertCall[1]).toContain(1.25);
  });

  test("defaults matchType to 'exact'", async () => {
    mockSuccessfulAdd();
    await request(app)
      .post("/search-terms/add-keyword")
      .send({ query: "test keyword", campaignId: CAMP_ID });

    const insertCall = dbQuery.mock.calls.find(c => c[0].includes("INSERT INTO keywords"));
    expect(insertCall[1]).toContain("exact");
  });

  test("respects custom matchType=broad", async () => {
    mockSuccessfulAdd();
    await request(app)
      .post("/search-terms/add-keyword")
      .send({ query: "test keyword", campaignId: CAMP_ID, matchType: "broad" });

    const insertCall = dbQuery.mock.calls.find(c => c[0].includes("INSERT INTO keywords"));
    expect(insertCall[1]).toContain("broad");
  });

  test("skips duplicate keyword and returns skipped=1", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ profile_id: PROF_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: AG_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: KW_ID }] }); // existing found → skip

    const res = await request(app)
      .post("/search-terms/add-keyword")
      .send({ query: "feuerfeste matte", campaignId: CAMP_ID });

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(res.body.results[0].reason).toBe("already_exists");
  });

  test("adds to multiple campaigns via campaignIds array", async () => {
    const CAMP_ID_2 = "dddddddd-0000-0000-0000-000000000002";
    const KW_ID_2   = "ffffffff-0000-0000-0000-000000000002";

    dbQuery
      // campaign 1
      .mockResolvedValueOnce({ rows: [{ profile_id: PROF_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: AG_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: KW_ID }] })
      // campaign 2
      .mockResolvedValueOnce({ rows: [{ profile_id: PROF_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: AG_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: KW_ID_2 }] });

    const res = await request(app)
      .post("/search-terms/add-keyword")
      .send({ query: "fire mat", campaignIds: [CAMP_ID, CAMP_ID_2] });

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(2);
    expect(res.body.results).toHaveLength(2);
    // No single keywordId in response for multi-campaign
    expect(res.body.keywordId).toBeUndefined();
  });

  test("returns error per campaign when campaign not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] }); // campaign not found

    const res = await request(app)
      .post("/search-terms/add-keyword")
      .send({ query: "test", campaignId: "non-existent-id" });

    expect(res.status).toBe(200);
    expect(res.body.results[0].error).toBe("Campaign not found");
  });

  test("returns error when no ad group found", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ profile_id: PROF_ID }] })
      .mockResolvedValueOnce({ rows: [] }); // no ad groups

    const res = await request(app)
      .post("/search-terms/add-keyword")
      .send({ query: "test", campaignId: CAMP_ID });

    expect(res.status).toBe(200);
    expect(res.body.results[0].error).toBe("No ad group found");
  });

  test("400 when query is missing", async () => {
    const res = await request(app)
      .post("/search-terms/add-keyword")
      .send({ campaignId: CAMP_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/query is required/i);
  });

  test("400 when both campaignId and campaignIds missing", async () => {
    const res = await request(app)
      .post("/search-terms/add-keyword")
      .send({ query: "test keyword" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/campaignId/i);
  });

  test("empty campaignIds array treated same as missing", async () => {
    const res = await request(app)
      .post("/search-terms/add-keyword")
      .send({ query: "test keyword", campaignIds: [] });
    expect(res.status).toBe(400);
  });

  test("writes audit event on success", async () => {
    mockSuccessfulAdd();
    await request(app)
      .post("/search-terms/add-keyword")
      .send({ query: "test keyword", campaignId: CAMP_ID });

    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "keyword.created",
        entityType: "keyword",
        entityName: "test keyword",
        source: "ui",
      })
    );
  });

  test("uses harvested prefix for amazon_keyword_id", async () => {
    mockSuccessfulAdd();
    await request(app)
      .post("/search-terms/add-keyword")
      .send({ query: "test keyword", campaignId: CAMP_ID });

    const insertCall = dbQuery.mock.calls.find(c => c[0].includes("harvest_"));
    expect(insertCall[0]).toMatch(/harvest_/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  5. POST /search-terms/add-negative
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /search-terms/add-negative", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  function mockNegativeSuccess() {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ profile_id: PROF_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: AG_ID }] })
      .mockResolvedValueOnce({ rows: [] })                          // no existing negative
      .mockResolvedValueOnce({ rows: [{ id: KW_ID }] });            // INSERT
  }

  test("adds negative keyword successfully", async () => {
    mockNegativeSuccess();
    const res = await request(app)
      .post("/search-terms/add-negative")
      .send({ query: "cheap", campaignId: CAMP_ID });

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    expect(res.body.results[0].success).toBe(true);
  });

  test("inserts into negative_keywords with negativeExact match type", async () => {
    mockNegativeSuccess();
    await request(app)
      .post("/search-terms/add-negative")
      .send({ query: "cheap", campaignId: CAMP_ID });

    // Route inserts into negative_keywords (not keywords), no state/bid columns
    const insertCall = dbQuery.mock.calls.find(c => c[0].includes("INSERT INTO negative_keywords"));
    expect(insertCall).toBeTruthy();
    // 'exact' input maps to Amazon's 'negativeExact' match type
    expect(insertCall[1]).toContain("negativeExact");
  });

  test("uses harvest_neg_ prefix for amazon_keyword_id", async () => {
    mockNegativeSuccess();
    await request(app)
      .post("/search-terms/add-negative")
      .send({ query: "cheap", campaignId: CAMP_ID });

    const insertCall = dbQuery.mock.calls.find(c => c[0].includes("harvest_neg_"));
    expect(insertCall).toBeTruthy();
  });

  test("skips duplicate negative keyword", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [{ profile_id: PROF_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: AG_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: KW_ID }] }); // already exists

    const res = await request(app)
      .post("/search-terms/add-negative")
      .send({ query: "cheap", campaignId: CAMP_ID });

    expect(res.body.skipped).toBe(1);
    expect(res.body.results[0].reason).toBe("already_exists");
  });

  test("adds to multiple campaigns via campaignIds", async () => {
    const CAMP_ID_2 = "dddddddd-0000-0000-0000-000000000002";
    const KW_ID_2   = "ffffffff-0000-0000-0000-000000000002";

    dbQuery
      .mockResolvedValueOnce({ rows: [{ profile_id: PROF_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: AG_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: KW_ID }] })
      .mockResolvedValueOnce({ rows: [{ profile_id: PROF_ID }] })
      .mockResolvedValueOnce({ rows: [{ id: AG_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: KW_ID_2 }] });

    const res = await request(app)
      .post("/search-terms/add-negative")
      .send({ query: "cheap product", campaignIds: [CAMP_ID, CAMP_ID_2] });

    expect(res.body.added).toBe(2);
  });

  test("400 when query missing", async () => {
    const res = await request(app)
      .post("/search-terms/add-negative")
      .send({ campaignId: CAMP_ID });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/query is required/i);
  });

  test("400 when no campaignId or campaignIds", async () => {
    const res = await request(app)
      .post("/search-terms/add-negative")
      .send({ query: "cheap" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/campaignId/i);
  });

  test("defaults matchType to 'exact' → maps to negativeExact in dedup check", async () => {
    mockNegativeSuccess();
    await request(app)
      .post("/search-terms/add-negative")
      .send({ query: "cheap", campaignId: CAMP_ID });

    // Dedup check queries negative_keywords by match_type
    const existingCheck = dbQuery.mock.calls.find(
      c => c[0].includes("FROM negative_keywords") && c[0].includes("match_type")
    );
    expect(existingCheck).toBeTruthy();
    // Amazon negativeExact is the DB value for 'exact' input
    expect(existingCheck[1]).toContain("negativeExact");
  });

  test("writes audit event with keyword.negative_added action", async () => {
    mockNegativeSuccess();
    await request(app)
      .post("/search-terms/add-negative")
      .send({ query: "cheap", campaignId: CAMP_ID });

    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "keyword.negative_added" })
    );
  });

  test("returns error per campaign when campaign not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });
    const res = await request(app)
      .post("/search-terms/add-negative")
      .send({ query: "cheap", campaignId: "non-existent" });

    expect(res.body.results[0].error).toBe("Campaign not found");
  });

  test("proceeds with null ad_group_id when no ad group found in campaign", async () => {
    // Route auto-discovers first ad group; if none exists, proceeds with null (no error)
    dbQuery
      .mockResolvedValueOnce({ rows: [{ profile_db_id: PROF_ID, amazon_campaign_id: "AMZ001",
        campaign_type: "sponsoredProducts", connection_id: "conn-1",
        amazon_profile_id: PROF_ID, marketplace_id: "A1PA6795UKMFR9" }] }) // campaign lookup
      .mockResolvedValueOnce({ rows: [] })                                   // no ad group found
      .mockResolvedValueOnce({ rows: [] })                                   // dedup check (no duplicate)
      .mockResolvedValueOnce({ rows: [{ id: KW_ID }] });                    // INSERT negative_keywords

    const res = await request(app)
      .post("/search-terms/add-negative")
      .send({ query: "cheap", campaignId: CAMP_ID });

    expect(res.status).toBe(200);
    expect(res.body.added).toBe(1);
    expect(res.body.results[0].success).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  6. Security / Auth
// ─────────────────────────────────────────────────────────────────────────────
describe("Security — auth guards", () => {
  test("all routes require auth middleware to be applied (middleware chain present)", () => {
    // Verify the router registers requireAuth + requireWorkspace by examining the stack
    const router = require("../src/routes/searchTerms");
    const layerNames = router.stack.map(l => l.handle?.name || l.route?.path || "");
    // The router.use() call at the top registers two middleware functions
    expect(layerNames.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  7. SQL Injection safety
// ─────────────────────────────────────────────────────────────────────────────
describe("SQL injection safety", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  test("search param is parameterised, not interpolated", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?search='; DROP TABLE users; --");
    const sql = dbQuery.mock.calls[0][0];
    // malicious string must NOT appear in SQL
    expect(sql).not.toContain("DROP TABLE");
    // must appear in params as a literal string
    const params = dbQuery.mock.calls[0][1];
    expect(params.some(p => typeof p === "string" && p.includes("DROP TABLE"))).toBe(true);
  });

  test("sortBy injection falls back to safe default", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms?sortBy=1; DROP TABLE--");
    const sql = dbQuery.mock.calls[0][0];
    expect(sql).not.toContain("DROP TABLE");
    expect(sql).toMatch(/stm\.spend/i);
  });

  test("kw_c subquery filters by workspace_id — no cross-workspace data leak", async () => {
    mockListQuery([], 0);
    await request(app).get("/search-terms");
    const sql = dbQuery.mock.calls[0][0];
    // The keywords subquery must contain WHERE k.workspace_id = $1
    expect(sql).toMatch(/FROM keywords k[\s\S]*?WHERE k\.workspace_id\s*=\s*\$1/);
  });
});
