"use strict";
/**
 * Rules engine — integration tests with real PostgreSQL.
 *
 * What's REAL:   PostgreSQL (Docker), all SQL queries, DB state changes,
 *                audit_events writes, negative_keywords / negative_targets inserts.
 * What's MOCKED: Amazon API write-backs (pushKeywordUpdates, pushNegativeKeyword,
 *                pushNegativeAsin, apiPut), auth middleware, logger, Redis.
 *
 * Run: npm run test:integration
 */

// ── Amazon write-backs: mocked (no real API calls) ───────────────────────────
jest.mock("../../src/services/amazon/writeback", () => ({
  pushNegativeKeyword: jest.fn().mockResolvedValue({}),
  pushNegativeAsin:    jest.fn().mockResolvedValue({}),
  pushKeywordUpdates:  jest.fn().mockResolvedValue({}),
}));
jest.mock("../../src/services/amazon/adsClient", () => ({
  put: jest.fn().mockResolvedValue({}),
}));
// Auth: fixed test workspace (hardcoded to match testConfig.js IDS — jest.mock hoisting forbids imports)
jest.mock("../../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = {
      id:     "00000002-0000-4000-8000-000000000002",
      name:   "Integration Tester",
      role:   "owner",
      org_id: "00000001-0000-4000-8000-000000000001",
    };
    req.orgId = "00000001-0000-4000-8000-000000000001";
    next();
  },
  requireWorkspace: (req, _res, next) => {
    req.workspaceId   = "00000003-0000-4000-8000-000000000003";
    req.workspaceRole = "owner";
    next();
  },
}));
// Redis: suppress connection errors during tests
jest.mock("../../src/config/redis", () => ({
  getRedis: jest.fn().mockReturnValue({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue("OK"),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
  }),
}));
jest.mock("../../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const request  = require("supertest");
const express  = require("express");
const { Pool } = require("pg");

const { TEST_DB_URL, IDS, AZ_IDS } = require("./setup/testConfig");
const {
  seedBase, seedKeywordMetrics, seedTargetMetrics,
  seedSearchTermMetrics, cleanMutable, yesterday,
} = require("./helpers/seed");
const { pushKeywordUpdates, pushNegativeKeyword, pushNegativeAsin } =
  require("../../src/services/amazon/writeback");
const { put: apiPut } = require("../../src/services/amazon/adsClient");

// ── App & DB setup ────────────────────────────────────────────────────────────
let pool;
let app;

function buildApp() {
  const a = express();
  a.use(express.json());
  a.use("/rules", require("../../src/routes/rules"));
  a.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return a;
}

beforeAll(async () => {
  // Use a raw Pool for seed/assertion queries (bypasses the singleton)
  pool = new Pool({ connectionString: TEST_DB_URL });

  // Initialize the app's pool singleton with the test DB
  const { connectDB } = require("../../src/db/pool");
  await connectDB();

  // Build Express app
  app = buildApp();

  // Seed base data (idempotent — uses ON CONFLICT DO NOTHING)
  await seedBase(pool);
});

afterAll(async () => {
  const { getPool } = require("../../src/db/pool");
  try { await getPool().end(); } catch {}
  await pool.end();
});

beforeEach(async () => {
  await cleanMutable(pool);
  jest.clearAllMocks();
});

// ── Helpers ───────────────────────────────────────────────────────────────────
// Create a rule via API and return its id
async function createRule(body) {
  const res = await request(app).post("/rules").send(body);
  if (res.status !== 201) throw new Error(`createRule failed: ${JSON.stringify(res.body)}`);
  return res.body.id;
}

// Seed high-ACOS metrics for given keywords (acos ≈ 67%)
async function highAcos(...kwEntries) {
  await seedKeywordMetrics(pool, kwEntries, { cost: 10, sales14d: 15, clicks: 100 });
}

// ─────────────────────────────────────────────────────────────────────────────
//  1. CRUD — real DB
// ─────────────────────────────────────────────────────────────────────────────
describe("CRUD — real DB", () => {
  it("creates rule and persists to DB", async () => {
    const res = await request(app).post("/rules").send({
      name: "DB Test Rule",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
    });
    expect(res.status).toBe(201);
    const { rows } = await pool.query("SELECT * FROM rules WHERE id = $1", [res.body.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("DB Test Rule");
    expect(rows[0].workspace_id).toBe(IDS.workspace);
  });

  it("updates rule and persists change", async () => {
    const id = await createRule({
      name: "Original Name",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
    });
    await request(app).patch(`/rules/${id}`).send({ name: "Updated Name", is_active: false });
    const { rows } = await pool.query("SELECT name, is_active FROM rules WHERE id = $1", [id]);
    expect(rows[0].name).toBe("Updated Name");
    expect(rows[0].is_active).toBe(false);
  });

  it("deletes rule from DB", async () => {
    const id = await createRule({
      name: "To Delete",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
    });
    await request(app).delete(`/rules/${id}`);
    const { rows } = await pool.query("SELECT id FROM rules WHERE id = $1", [id]);
    expect(rows).toHaveLength(0);
  });

  it("GET /rules returns only this workspace's rules", async () => {
    await createRule({
      name: "My Rule",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
    });
    const res = await request(app).get("/rules");
    expect(res.status).toBe(200);
    expect(res.body.data.every(r => r.workspace_id === IDS.workspace)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  2. Rule execution — SQL actually runs against real data
// ─────────────────────────────────────────────────────────────────────────────
describe("Rule execution — real SQL", () => {
  it("evaluates real fact_metrics_daily — keywords with high ACOS are matched", async () => {
    // kwExact1 has high ACOS, kwBroad1 has low ACOS
    await highAcos({ kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 });
    await seedKeywordMetrics(pool, [{ kwId: IDS.kwBroad1, azId: AZ_IDS.kwBroad1 }],
      { cost: 5, sales14d: 100, clicks: 50 }); // acos ≈ 5% → no match

    const id = await createRule({
      name: "Pause high ACOS",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
      scope: { entity_type: "keyword", period_days: 14 },
    });
    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: true });

    expect(res.status).toBe(200);
    // Only kwExact1 has acos > 30
    expect(res.body.matched_count).toBe(1);
    expect(res.body.applied[0].keyword_text).toBe("running shoes");
  });

  it("keyword with no metrics rows counts as 0 spend/acos — not matched by acos>30", async () => {
    // No metrics seeded for any keyword
    const id = await createRule({
      name: "No metrics rule",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
      scope: { entity_type: "keyword", period_days: 14 },
    });
    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(0);
  });

  it("multi-metric AND condition: acos AND clicks both must pass", async () => {
    // kwExact1: high acos, high clicks
    await highAcos({ kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 }); // acos≈67%, clicks=100
    // kwPhrase1: high acos, but low clicks (1 click)
    await seedKeywordMetrics(pool, [{ kwId: IDS.kwPhrase1, azId: AZ_IDS.kwPhrase1 }],
      { cost: 10, sales14d: 15, clicks: 1 });

    const id = await createRule({
      name: "ACOS + clicks rule",
      conditions: [
        { metric: "acos",   op: "gt",  value: 30 },
        { metric: "clicks", op: "gte", value: 50 },
      ],
      actions: [{ type: "pause_keyword" }],
      scope: { entity_type: "keyword", period_days: 14 },
    });
    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: true });
    // Only kwExact1 passes both conditions (clicks=100 >= 50)
    expect(res.body.matched_count).toBe(1);
    expect(res.body.applied[0].keyword_text).toBe("running shoes");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  3. pause_keyword — non-dry-run: verify DB state changes
// ─────────────────────────────────────────────────────────────────────────────
describe("pause_keyword — non-dry-run DB writes", () => {
  it("changes keyword state to paused in DB", async () => {
    await highAcos({ kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 });
    const id = await createRule({
      name: "Pause ACOS rule",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
      scope: { entity_type: "keyword", period_days: 14 },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: false });
    expect(res.status).toBe(200);
    expect(res.body.applied_count).toBe(1);

    // Verify DB state
    const { rows } = await pool.query(
      "SELECT state FROM keywords WHERE id = $1", [IDS.kwExact1]
    );
    expect(rows[0].state).toBe("paused");
  });

  it("writes audit_event for each paused keyword", async () => {
    await highAcos({ kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 });
    const id = await createRule({
      name: "Audit test rule",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
      scope: { entity_type: "keyword", period_days: 14 },
    });

    await request(app).post(`/rules/${id}/run`).send({ dry_run: false });

    const { rows } = await pool.query(
      "SELECT action, entity_type FROM audit_events WHERE workspace_id = $1 AND action = 'keyword.pause_keyword'",
      [IDS.workspace]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].entity_type).toBe("keyword");
  });

  it("calls pushKeywordUpdates with state=paused", async () => {
    await highAcos({ kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 });
    const id = await createRule({
      name: "Pause write-back rule",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
      scope: { entity_type: "keyword", period_days: 14 },
    });

    await request(app).post(`/rules/${id}/run`).send({ dry_run: false });

    expect(pushKeywordUpdates).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ state: "paused", amazonKeywordId: AZ_IDS.kwExact1 }),
    ]));
  });

  it("dry_run=true does NOT change keyword state in DB", async () => {
    await highAcos({ kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 });
    const id = await createRule({
      name: "Dry-run no-write",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
      scope: { entity_type: "keyword", period_days: 14 },
    });

    await request(app).post(`/rules/${id}/run`).send({ dry_run: true });

    const { rows } = await pool.query(
      "SELECT state FROM keywords WHERE id = $1", [IDS.kwExact1]
    );
    expect(rows[0].state).toBe("enabled"); // unchanged
    expect(pushKeywordUpdates).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  4. adjust_bid_pct — safety clamping verified in real DB
// ─────────────────────────────────────────────────────────────────────────────
describe("adjust_bid_pct — safety clamping in real DB", () => {
  it("increases bid by 20% and persists new bid", async () => {
    await highAcos({ kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 });
    const id = await createRule({
      name: "Bid up rule",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "adjust_bid_pct", value: 20 }],
      scope: { entity_type: "keyword", period_days: 14 },
      safety: { min_bid: 0.02, max_bid: 50 },
    });

    await request(app).post(`/rules/${id}/run`).send({ dry_run: false });

    const { rows } = await pool.query(
      "SELECT bid FROM keywords WHERE id = $1", [IDS.kwExact1]
    );
    // bid was 1.00, +20% = 1.20
    expect(parseFloat(rows[0].bid)).toBeCloseTo(1.20, 2);
  });

  it("clamps bid at max_bid=1.10 when increase would exceed it", async () => {
    await highAcos({ kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 });
    const id = await createRule({
      name: "Clamp max rule",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "adjust_bid_pct", value: 50 }], // +50%: 1.00 → 1.50 → clamped to 1.10
      scope: { entity_type: "keyword", period_days: 14 },
      safety: { min_bid: 0.02, max_bid: 1.10 },
    });

    await request(app).post(`/rules/${id}/run`).send({ dry_run: false });

    const { rows } = await pool.query(
      "SELECT bid FROM keywords WHERE id = $1", [IDS.kwExact1]
    );
    expect(parseFloat(rows[0].bid)).toBeCloseTo(1.10, 2);
  });

  it("clamps bid at min_bid=0.80 when decrease would go below it", async () => {
    await highAcos({ kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 });
    const id = await createRule({
      name: "Clamp min rule",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "adjust_bid_pct", value: -99 }], // -99%: 1.00 → 0.01 → clamped to 0.80
      scope: { entity_type: "keyword", period_days: 14 },
      safety: { min_bid: 0.80, max_bid: 50 },
    });

    await request(app).post(`/rules/${id}/run`).send({ dry_run: false });

    const { rows } = await pool.query(
      "SELECT bid FROM keywords WHERE id = $1", [IDS.kwExact1]
    );
    expect(parseFloat(rows[0].bid)).toBeCloseTo(0.80, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  5. add_negative_keyword — real INSERT into negative_keywords
// ─────────────────────────────────────────────────────────────────────────────
describe("add_negative_keyword — real DB inserts", () => {
  it("inserts negative_keywords row (exact) and calls pushNegativeKeyword", async () => {
    await highAcos({ kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 });
    const id = await createRule({
      name: "Neg KW exact",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "add_negative_keyword", value: "exact" }],
      scope: { entity_type: "keyword", period_days: 14 },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: false });
    expect(res.body.applied_count).toBe(1);

    const { rows } = await pool.query(
      "SELECT * FROM negative_keywords WHERE workspace_id = $1", [IDS.workspace]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].keyword_text).toBe("running shoes");
    expect(rows[0].match_type).toBe("negative_exact");
    expect(rows[0].campaign_id).toBe(IDS.campManual);

    expect(pushNegativeKeyword).toHaveBeenCalledWith(expect.objectContaining({
      keywordText: "running shoes",
      matchType: "negativeExact",
    }));
  });

  it("inserts TWO rows when action.value='both' (exact + phrase)", async () => {
    await highAcos({ kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 });
    const id = await createRule({
      name: "Neg KW both",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "add_negative_keyword", value: "both" }],
      scope: { entity_type: "keyword", period_days: 14 },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: false });
    expect(res.body.applied_count).toBe(2);

    const { rows } = await pool.query(
      "SELECT match_type FROM negative_keywords WHERE workspace_id = $1 ORDER BY match_type",
      [IDS.workspace]
    );
    expect(rows.map(r => r.match_type).sort()).toEqual(["negative_exact", "negative_phrase"]);
  });

  it("dedup: second run skips already-negated keyword (already_negative)", async () => {
    await highAcos({ kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 });
    const id = await createRule({
      name: "Neg KW dedup",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "add_negative_keyword", value: "exact" }],
      scope: { entity_type: "keyword", period_days: 14 },
    });

    // First run: insert
    await request(app).post(`/rules/${id}/run`).send({ dry_run: false });
    // Second run: should skip
    await seedKeywordMetrics(pool, [{ kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 }],
      { cost: 10, sales14d: 15, clicks: 100 });
    const res2 = await request(app).post(`/rules/${id}/run`).send({ dry_run: false });

    expect(res2.body.skipped_count).toBe(1);
    expect(res2.body.skipped[0].reason).toBe("already_negative");
    // Still only one row in DB
    const { rows } = await pool.query(
      "SELECT COUNT(*) AS c FROM negative_keywords WHERE workspace_id = $1", [IDS.workspace]
    );
    expect(parseInt(rows[0].c)).toBe(1);
  });

  it("dry_run=true: dedup check still runs, no INSERT in DB", async () => {
    await highAcos({ kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 });
    const id = await createRule({
      name: "Neg KW dry",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "add_negative_keyword", value: "exact" }],
      scope: { entity_type: "keyword", period_days: 14 },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(1);

    // Nothing in DB
    const { rows } = await pool.query(
      "SELECT COUNT(*) AS c FROM negative_keywords WHERE workspace_id = $1", [IDS.workspace]
    );
    expect(parseInt(rows[0].c)).toBe(0);
    expect(pushNegativeKeyword).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  6. ASIN auto-routing — search_term → negative_targets
// ─────────────────────────────────────────────────────────────────────────────
describe("ASIN auto-routing — search_term entity → negative_targets", () => {
  const asinQuery = "b076j8j3w5";

  it("non-dry-run: inserts into negative_targets (not negative_keywords)", async () => {
    await seedSearchTermMetrics(pool, [
      { query: asinQuery, clicks: 100, spend: 10, orders: 0, sales: 0 },
    ]);
    const id = await createRule({
      name: "ASIN auto-route rule",
      conditions: [{ metric: "spend", op: "gt", value: 5 }],
      actions: [{ type: "add_negative_keyword", value: "exact" }],
      scope: { entity_type: "search_term", period_days: 14 },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: false });
    expect(res.body.applied_count).toBe(1);
    expect(res.body.applied[0].action).toBe("add_negative_target");
    expect(res.body.applied[0].auto_routed).toBe(true);

    // Check negative_targets
    const { rows: nt } = await pool.query(
      "SELECT * FROM negative_targets WHERE workspace_id = $1", [IDS.workspace]
    );
    expect(nt).toHaveLength(1);
    expect(nt[0].campaign_id).toBe(IDS.campManual);
    const expr = typeof nt[0].expression === "string"
      ? JSON.parse(nt[0].expression) : nt[0].expression;
    expect(expr[0].type).toBe("ASIN_SAME_AS");
    expect(expr[0].value).toBe("B076J8J3W5"); // uppercased

    // NOT in negative_keywords
    const { rows: nk } = await pool.query(
      "SELECT COUNT(*) AS c FROM negative_keywords WHERE workspace_id = $1", [IDS.workspace]
    );
    expect(parseInt(nk[0].c)).toBe(0);

    expect(pushNegativeAsin).toHaveBeenCalledWith(expect.objectContaining({
      asinValue: "B076J8J3W5",
    }));
  });

  it("dedup: ASIN already in negative_targets → already_negative skip", async () => {
    // Pre-seed negative_target for this ASIN
    await pool.query(`
      INSERT INTO negative_targets
        (workspace_id, profile_id, campaign_id, ad_group_id,
         amazon_neg_target_id, expression, expression_type, level)
      VALUES ($1, $2, $3, $4, 'pre-existing-nt',
         $5::jsonb, 'asinSameAs', 'ad_group')
    `, [IDS.workspace, IDS.profile, IDS.campManual, IDS.agManual,
        JSON.stringify([{ type: "ASIN_SAME_AS", value: "B076J8J3W5" }])]);

    await seedSearchTermMetrics(pool, [
      { query: asinQuery, clicks: 100, spend: 10, orders: 0, sales: 0 },
    ]);
    const id = await createRule({
      name: "ASIN dedup rule",
      conditions: [{ metric: "spend", op: "gt", value: 5 }],
      actions: [{ type: "add_negative_keyword", value: "exact" }],
      scope: { entity_type: "search_term", period_days: 14 },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: false });
    expect(res.body.skipped_count).toBe(1);
    expect(res.body.skipped[0].reason).toBe("already_negative");
    expect(pushNegativeAsin).not.toHaveBeenCalled();
  });

  it("non-ASIN search term uses regular negative_keywords path", async () => {
    await seedSearchTermMetrics(pool, [
      { query: "blue running shoes", clicks: 100, spend: 10, orders: 0, sales: 0 },
    ]);
    const id = await createRule({
      name: "Regular ST rule",
      conditions: [{ metric: "spend", op: "gt", value: 5 }],
      actions: [{ type: "add_negative_keyword", value: "exact" }],
      scope: { entity_type: "search_term", period_days: 14 },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: false });
    expect(res.body.applied[0].action).toBe("add_negative_keyword");

    const { rows } = await pool.query(
      "SELECT keyword_text FROM negative_keywords WHERE workspace_id = $1", [IDS.workspace]
    );
    expect(rows[0].keyword_text).toBe("blue running shoes");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  7. Scope filters — verified by real SQL execution
// ─────────────────────────────────────────────────────────────────────────────
describe("Scope filters — real SQL", () => {
  it("campaign_name_contains include: only Alpha campaign keywords matched", async () => {
    // Both kwExact1 (Alpha Manual) and kwAuto1 (Beta Auto) have high ACOS
    await highAcos(
      { kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 },
      { kwId: IDS.kwAuto1,  azId: AZ_IDS.kwAuto1 },
    );
    const id = await createRule({
      name: "Name filter include",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
      scope: {
        entity_type: "keyword", period_days: 14,
        campaign_name_contains: "Alpha",
        campaign_name_mode: "include",
      },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(1);
    expect(res.body.applied[0].campaign_name).toBe("Alpha Manual Campaign");
  });

  it("campaign_name_contains exclude: Beta campaign excluded, Alpha matched", async () => {
    await highAcos(
      { kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 },
      { kwId: IDS.kwAuto1,  azId: AZ_IDS.kwAuto1 },
    );
    const id = await createRule({
      name: "Name filter exclude",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
      scope: {
        entity_type: "keyword", period_days: 14,
        campaign_name_contains: "Beta",
        campaign_name_mode: "exclude",
      },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(1);
    expect(res.body.applied[0].campaign_name).toBe("Alpha Manual Campaign");
  });

  it("campaign_targeting_type=manual: only MANUAL campaign keywords", async () => {
    await highAcos(
      { kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 },  // MANUAL campaign
      { kwId: IDS.kwAuto1,  azId: AZ_IDS.kwAuto1 },   // AUTO campaign
    );
    const id = await createRule({
      name: "Manual only",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
      scope: { entity_type: "keyword", period_days: 14, campaign_targeting_type: "manual" },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(1);
    expect(res.body.applied[0].campaign_name).toBe("Alpha Manual Campaign");
  });

  it("campaign_targeting_type=auto: only AUTO campaign keywords", async () => {
    await highAcos(
      { kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 },
      { kwId: IDS.kwAuto1,  azId: AZ_IDS.kwAuto1 },
    );
    const id = await createRule({
      name: "Auto only",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
      scope: { entity_type: "keyword", period_days: 14, campaign_targeting_type: "auto" },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(1);
    expect(res.body.applied[0].campaign_name).toBe("Beta Auto Campaign");
  });

  it("match_types=['exact']: only exact keywords fetched", async () => {
    await highAcos(
      { kwId: IDS.kwExact1,  azId: AZ_IDS.kwExact1 },
      { kwId: IDS.kwPhrase1, azId: AZ_IDS.kwPhrase1 },
      { kwId: IDS.kwBroad1,  azId: AZ_IDS.kwBroad1 },
    );
    const id = await createRule({
      name: "Exact only",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
      scope: { entity_type: "keyword", period_days: 14, match_types: ["exact"] },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: true });
    // Only kwExact1 is match_type=exact (kwPaused1 is also exact but paused so not counted in enabled kws here)
    // Actually kwPaused1 has no metrics so won't match acos>30. And it's 'paused' but state filter is NOT archived
    // So it's fetched but acos=0 (no metrics) → no match. Total evaluated = 1 (exact+enabled), matched = 1.
    expect(res.body.applied.every(a => a.keyword_text !== "red running shoes")).toBe(true);
    expect(res.body.applied.every(a => a.keyword_text !== "sport shoes")).toBe(true);
    expect(res.body.matched_count).toBe(1);
  });

  it("campaign_ids filter: restricts to specific campaigns", async () => {
    await highAcos(
      { kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 },  // campManual
      { kwId: IDS.kwAuto1,  azId: AZ_IDS.kwAuto1 },   // campAuto
    );
    const id = await createRule({
      name: "Specific campaign",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
      scope: {
        entity_type: "keyword", period_days: 14,
        campaign_ids: [IDS.campManual],  // only Alpha
      },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(1);
    expect(res.body.applied[0].campaign_name).toBe("Alpha Manual Campaign");
  });

  it("period_days=1: only yesterday's metrics count (not older)", async () => {
    // Insert metrics 5 days ago (outside the 1-day window)
    const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString().split("T")[0];
    await seedKeywordMetrics(pool, [{ kwId: IDS.kwExact1, azId: AZ_IDS.kwExact1 }],
      { cost: 10, sales14d: 15, date: fiveDaysAgo }); // high ACOS but old

    const id = await createRule({
      name: "Yesterday only",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
      scope: { entity_type: "keyword", period_days: 1 },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: true });
    // No metrics in yesterday window → acos=0 → no match
    expect(res.body.matched_count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  8. Product target entity type — real targets table query
// ─────────────────────────────────────────────────────────────────────────────
describe("entity_type=product_target — real targets table", () => {
  it("fetches and matches real target with high ACOS", async () => {
    await seedTargetMetrics(pool, { cost: 10, sales14d: 15 });

    const id = await createRule({
      name: "Target rule",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_target" }],
      scope: { entity_type: "product_target", period_days: 14 },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: true });
    expect(res.body.matched_count).toBe(1);
    expect(res.body.applied[0].action).toBe("pause_target");
  });

  it("pause_target non-dry-run: updates DB state and calls apiPut", async () => {
    await seedTargetMetrics(pool, { cost: 10, sales14d: 15 });

    const id = await createRule({
      name: "Target pause real",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_target" }],
      scope: { entity_type: "product_target", period_days: 14 },
    });

    await request(app).post(`/rules/${id}/run`).send({ dry_run: false });

    const { rows } = await pool.query("SELECT state FROM targets WHERE id = $1", [IDS.tgt1]);
    expect(rows[0].state).toBe("paused");

    expect(apiPut).toHaveBeenCalledWith(expect.objectContaining({
      path: "/sp/targets",
      data: expect.objectContaining({
        targets: expect.arrayContaining([
          expect.objectContaining({ state: "PAUSED" }),
        ]),
      }),
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  9. Skip reasons — real DB
// ─────────────────────────────────────────────────────────────────────────────
describe("Skip reasons — real DB validation", () => {
  it("already_paused: paused keyword skipped, enabled keyword applied", async () => {
    // kwExact1 (enabled) + kwPaused1 (paused) both have high ACOS
    await highAcos(
      { kwId: IDS.kwExact1,  azId: AZ_IDS.kwExact1 },
      { kwId: IDS.kwPaused1, azId: AZ_IDS.kwPaused1 },
    );
    const id = await createRule({
      name: "Pause mix",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
      scope: { entity_type: "keyword", period_days: 14 },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: true });
    expect(res.body.applied_count).toBe(1);
    expect(res.body.skipped_count).toBe(1);
    expect(res.body.skipped[0].reason).toBe("already_paused");
  });

  it("not_enabled: paused keyword skipped for adjust_bid_pct", async () => {
    await highAcos({ kwId: IDS.kwPaused1, azId: AZ_IDS.kwPaused1 });
    const id = await createRule({
      name: "Bid on paused",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "adjust_bid_pct", value: 20 }],
      scope: { entity_type: "keyword", period_days: 14 },
    });

    const res = await request(app).post(`/rules/${id}/run`).send({ dry_run: true });
    expect(res.body.skipped[0].reason).toBe("not_enabled");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  10. last_run_at and last_run_result updated after execution
// ─────────────────────────────────────────────────────────────────────────────
describe("Rule metadata update after execution", () => {
  it("last_run_at and last_run_result are persisted in DB", async () => {
    const id = await createRule({
      name: "Metadata test",
      conditions: [{ metric: "acos", op: "gt", value: 30 }],
      actions: [{ type: "pause_keyword" }],
      scope: { entity_type: "keyword", period_days: 14 },
    });

    const before = await pool.query("SELECT last_run_at FROM rules WHERE id = $1", [id]);
    expect(before.rows[0].last_run_at).toBeNull();

    await request(app).post(`/rules/${id}/run`).send({ dry_run: true });

    const after = await pool.query(
      "SELECT last_run_at, last_run_result FROM rules WHERE id = $1", [id]
    );
    expect(after.rows[0].last_run_at).not.toBeNull();
    const result = after.rows[0].last_run_result;
    expect(result).toHaveProperty("matched_count");
    expect(result).toHaveProperty("dry_run", true);
  });
});
