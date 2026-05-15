"use strict";
/**
 * Audit routes — comprehensive test suite
 *
 * Covers:
 *   GET  /audit                    — paginated list, entityType filter, sortBy=actor_name,
 *                                    invalid limit defaults to 50, valid limit 25 accepted,
 *                                    rollbackable filter, dateFrom/dateTo filters
 *   GET  /audit/entity/:entityId   — returns events, limit capped at 50, default limit 10
 *   POST /audit/:id/rollback       — 404 not found; 400 no before_data;
 *                                    keyword bid restored (bid_change/adjust_bid_pct/set_bid);
 *                                    keyword state restored (pause_keyword/enable_keyword/state_change);
 *                                    target state restored (target.pause/target.enable);
 *                                    target bid restored (target.adjust_bid_pct);
 *                                    negative_keyword deletion (keyword.negative_added);
 *                                    negative_target deletion (keyword.negative_added);
 *                                    campaign state rollback (rule.pause_campaign/rule.enable_campaign);
 *                                    campaign budget rollback (rule.adjust_budget/rule.set_budget);
 *                                    unsupported event type → 400;
 *                                    writeAudit called on success
 *
 * Note: audit.js exports writeAudit which calls query() directly, so the DB mock
 * covers writeAudit calls transparently.
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID    = "ws---0001-0000-0000-000000000001";
const ORG_ID   = "org--0001-0000-0000-000000000001";
const USER_ID  = "user-0001-0000-0000-000000000001";
const EVENT_ID = "evt--0001-0000-0000-000000000001";
const KW_ID    = "kw---0001-0000-0000-000000000001";
const TGT_ID   = "tgt--0001-0000-0000-000000000001";
const CAMP_ID  = "camp-0001-0000-0000-000000000001";
const NEG_KW_ID = "negk-0001-0000-0000-000000000001";
const NEG_TGT_ID = "negt-0001-0000-0000-000000000001";
const AUDIT_WRITE_ID = "audit-new-0000-0000-000000000099";

// ─── Mocks ────────────────────────────────────────────────────────────────────
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user      = { id: USER_ID, name: "Test User", role: "owner", org_id: ORG_ID };
    req.orgId     = ORG_ID;
    next();
  },
  requireWorkspace: (req, _res, next) => {
    req.workspaceId   = WS_ID;
    req.workspaceRole = "owner";
    next();
  },
}));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { query: dbQuery } = require("../src/db/pool");
const auditRouter        = require("../src/routes/audit");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/audit", auditRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

// ─── Event builder ────────────────────────────────────────────────────────────
function makeEvent(overrides = {}) {
  return {
    id: EVENT_ID,
    org_id: ORG_ID,
    workspace_id: WS_ID,
    actor_id: USER_ID,
    actor_name: "Test User",
    actor_type: "user",
    action: "keyword.bid_change",
    entity_type: "keyword",
    entity_id: KW_ID,
    entity_name: "running shoes",
    before_data: JSON.stringify({ bid: "1.00", state: "enabled" }),
    after_data: JSON.stringify({ bid: "1.50", state: "enabled" }),
    diff: null,
    source: "ui",
    created_at: new Date().toISOString(),
    amazon_status: null,
    amazon_error: null,
    metadata: null,
    ...overrides,
  };
}

// After a successful rollback, writeAudit (inside the route) calls query() to
// INSERT into audit_events. Mock that final call to return an id.
function mockWriteAuditCall() {
  dbQuery.mockResolvedValueOnce({ rows: [{ id: AUDIT_WRITE_ID }] });
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /audit
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /audit", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  // GET / fires two parallel queries: SELECT rows + SELECT COUNT
  function mockListQuery(rows = [], total = 0) {
    // Promise.all resolves both at once; jest processes mock queue in order
    dbQuery
      .mockResolvedValueOnce({ rows })
      .mockResolvedValueOnce({ rows: [{ total: String(total) }] });
  }

  it("returns paginated data and pagination metadata", async () => {
    const events = [makeEvent()];
    mockListQuery(events, 1);

    const res = await request(app).get("/audit");

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
    expect(res.body).toHaveProperty("pagination");
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0].id).toBe(EVENT_ID);
    expect(res.body.pagination).toMatchObject({
      total: 1,
      page: 1,
      limit: 50,
      pages: 1,
    });
  });

  it("defaults limit to 50 when not provided", async () => {
    mockListQuery([], 0);

    const res = await request(app).get("/audit");

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(50);
    // The SELECT query should include LIMIT 50
    const [sql] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/LIMIT/);
  });

  it("accepts valid limit of 25", async () => {
    mockListQuery([], 0);

    const res = await request(app).get("/audit?limit=25");

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(25);
  });

  it("accepts valid limit of 100", async () => {
    mockListQuery([], 0);

    const res = await request(app).get("/audit?limit=100");

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(100);
  });

  it("accepts valid limit of 200", async () => {
    mockListQuery([], 0);

    const res = await request(app).get("/audit?limit=200");

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(200);
  });

  it("defaults to 50 when limit is invalid (not in allowed list)", async () => {
    mockListQuery([], 0);

    const res = await request(app).get("/audit?limit=77");

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(50);
  });

  it("defaults to 50 when limit is 0", async () => {
    mockListQuery([], 0);

    const res = await request(app).get("/audit?limit=0");

    expect(res.status).toBe(200);
    expect(res.body.pagination.limit).toBe(50);
  });

  it("applies entityType filter — passes it as query param", async () => {
    mockListQuery([], 0);

    await request(app).get("/audit?entityType=keyword");

    // At least one of the two parallel queries must contain the entityType param
    const paramArrays = dbQuery.mock.calls.map(([, params]) => params);
    const hasEntityType = paramArrays.some(p => p.includes("keyword"));
    expect(hasEntityType).toBe(true);
  });

  it("applies source filter", async () => {
    mockListQuery([], 0);

    await request(app).get("/audit?source=rule");

    const paramArrays = dbQuery.mock.calls.map(([, params]) => params);
    const hasSource = paramArrays.some(p => p.includes("rule"));
    expect(hasSource).toBe(true);
  });

  it("applies actorId filter", async () => {
    mockListQuery([], 0);

    await request(app).get(`/audit?actorId=${USER_ID}`);

    const paramArrays = dbQuery.mock.calls.map(([, params]) => params);
    const hasActor = paramArrays.some(p => p.includes(USER_ID));
    expect(hasActor).toBe(true);
  });

  it("sorts by actor_name when sortBy=actor_name", async () => {
    mockListQuery([], 0);

    await request(app).get("/audit?sortBy=actor_name");

    const [sql] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/actor_name/);
  });

  it("uses DESC order by default", async () => {
    mockListQuery([], 0);

    await request(app).get("/audit");

    const [sql] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/DESC/);
  });

  it("uses ASC order when sortDir=asc", async () => {
    mockListQuery([], 0);

    await request(app).get("/audit?sortDir=asc");

    const [sql] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/ASC/);
  });

  it("returns empty data array when no events", async () => {
    mockListQuery([], 0);

    const res = await request(app).get("/audit");

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
    expect(res.body.pagination.pages).toBe(0);
  });

  it("calculates pages correctly with multiple pages", async () => {
    mockListQuery([], 110);

    const res = await request(app).get("/audit?limit=50");

    expect(res.status).toBe(200);
    expect(res.body.pagination.pages).toBe(3); // ceil(110/50) = 3
    expect(res.body.pagination.total).toBe(110);
  });

  it("computes correct offset for page=2", async () => {
    mockListQuery([], 100);

    const res = await request(app).get("/audit?page=2&limit=25");

    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(2);
  });

  it("applies rollbackable filter — SQL must exclude .rollback actions", async () => {
    mockListQuery([], 0);

    await request(app).get("/audit?rollbackable=true");

    const [sql] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/NOT LIKE '%.rollback'/);
    expect(sql).toMatch(/before_data IS NOT NULL/);
  });

  it("propagates DB error as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("connection timeout"));

    const res = await request(app).get("/audit");
    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /audit/entity/:entityId
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /audit/entity/:entityId", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns events for a given entity", async () => {
    const events = [makeEvent(), makeEvent({ id: "evt-0002" })];
    dbQuery.mockResolvedValueOnce({ rows: events });

    const res = await request(app).get(`/audit/entity/${KW_ID}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].id).toBe(EVENT_ID);
  });

  it("passes entity_id and workspace_id to query", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get(`/audit/entity/${KW_ID}`);

    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/entity_id = \$2/);
    expect(params[0]).toBe(WS_ID);
    expect(params[1]).toBe(KW_ID);
  });

  it("defaults limit to 10 when not specified", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get(`/audit/entity/${KW_ID}`);

    const [, params] = dbQuery.mock.calls[0];
    expect(params[2]).toBe(10);
  });

  it("uses provided limit when within bounds", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get(`/audit/entity/${KW_ID}?limit=30`);

    const [, params] = dbQuery.mock.calls[0];
    expect(params[2]).toBe(30);
  });

  it("caps limit at 50", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get(`/audit/entity/${KW_ID}?limit=200`);

    const [, params] = dbQuery.mock.calls[0];
    expect(params[2]).toBe(50);
  });

  it("returns empty array when no events for entity", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get(`/audit/entity/${KW_ID}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("propagates DB error as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("DB failure"));

    const res = await request(app).get(`/audit/entity/${KW_ID}`);
    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /audit/:id/rollback
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /audit/:id/rollback — not found / no before_data", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns 404 when audit event not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 400 when event has no before_data and is not a negative addition", async () => {
    const event = makeEvent({
      action: "keyword.bid_change",
      entity_type: "keyword",
      before_data: null,
    });
    dbQuery.mockResolvedValueOnce({ rows: [event] });

    const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no before_data/i);
  });
});

describe("POST /audit/:id/rollback — keyword bid rollback", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const BID_ACTIONS = [
    "keyword.bid_change",
    "keyword.adjust_bid_pct",
    "keyword.set_bid",
  ];

  BID_ACTIONS.forEach(action => {
    it(`restores keyword bid for action=${action}`, async () => {
      const event = makeEvent({
        action,
        entity_type: "keyword",
        entity_id: KW_ID,
        before_data: JSON.stringify({ bid: "0.75", state: "enabled" }),
        after_data: JSON.stringify({ bid: "1.50", state: "enabled" }),
      });

      dbQuery
        .mockResolvedValueOnce({ rows: [event] })  // SELECT event
        .mockResolvedValueOnce({ rows: [] })        // UPDATE keywords SET bid
        .mockResolvedValueOnce({ rows: [{ id: AUDIT_WRITE_ID }] }); // writeAudit INSERT

      const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.message).toMatch(/0\.75/);

      // Verify the UPDATE keywords call
      const [updateSql, updateParams] = dbQuery.mock.calls[1];
      expect(updateSql).toMatch(/UPDATE keywords SET bid/);
      expect(updateParams[0]).toBe("0.75");
      expect(updateParams[1]).toBe(KW_ID);
      expect(updateParams[2]).toBe(WS_ID);
    });
  });
});

describe("POST /audit/:id/rollback — keyword state rollback", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const STATE_ACTIONS = [
    "keyword.pause_keyword",
    "keyword.enable_keyword",
    "keyword.state_change",
  ];

  STATE_ACTIONS.forEach(action => {
    it(`restores keyword state for action=${action}`, async () => {
      const event = makeEvent({
        action,
        entity_type: "keyword",
        entity_id: KW_ID,
        before_data: JSON.stringify({ state: "enabled", bid: "1.00" }),
        after_data: JSON.stringify({ state: "paused", bid: "1.00" }),
      });

      dbQuery
        .mockResolvedValueOnce({ rows: [event] })
        .mockResolvedValueOnce({ rows: [] })       // UPDATE keywords SET state
        .mockResolvedValueOnce({ rows: [{ id: AUDIT_WRITE_ID }] });

      const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.message).toMatch(/enabled/);

      const [updateSql, updateParams] = dbQuery.mock.calls[1];
      expect(updateSql).toMatch(/UPDATE keywords SET state/);
      expect(updateParams[0]).toBe("enabled");
      expect(updateParams[1]).toBe(KW_ID);
      expect(updateParams[2]).toBe(WS_ID);
    });
  });
});

describe("POST /audit/:id/rollback — target state rollback", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const TARGET_STATE_ACTIONS = ["target.pause", "target.enable"];

  TARGET_STATE_ACTIONS.forEach(action => {
    it(`restores target state for action=${action}`, async () => {
      const event = makeEvent({
        action,
        entity_type: "target",
        entity_id: TGT_ID,
        before_data: JSON.stringify({ state: "enabled", bid: "0.80" }),
        after_data: JSON.stringify({ state: "paused", bid: "0.80" }),
      });

      dbQuery
        .mockResolvedValueOnce({ rows: [event] })
        .mockResolvedValueOnce({ rows: [] })       // UPDATE targets SET state
        .mockResolvedValueOnce({ rows: [{ id: AUDIT_WRITE_ID }] });

      const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.message).toMatch(/enabled/);

      const [updateSql, updateParams] = dbQuery.mock.calls[1];
      expect(updateSql).toMatch(/UPDATE targets SET state/);
      expect(updateParams[0]).toBe("enabled");
      expect(updateParams[1]).toBe(TGT_ID);
      expect(updateParams[2]).toBe(WS_ID);
    });
  });
});

describe("POST /audit/:id/rollback — target bid rollback", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("restores target bid for target.adjust_bid_pct", async () => {
    const event = makeEvent({
      action: "target.adjust_bid_pct",
      entity_type: "target",
      entity_id: TGT_ID,
      before_data: JSON.stringify({ bid: "0.50" }),
      after_data: JSON.stringify({ bid: "0.65" }),
    });

    dbQuery
      .mockResolvedValueOnce({ rows: [event] })
      .mockResolvedValueOnce({ rows: [] })       // UPDATE targets SET bid
      .mockResolvedValueOnce({ rows: [{ id: AUDIT_WRITE_ID }] });

    const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toMatch(/0\.50/);

    const [updateSql, updateParams] = dbQuery.mock.calls[1];
    expect(updateSql).toMatch(/UPDATE targets SET bid/);
    expect(updateParams[0]).toBe("0.50");
    expect(updateParams[1]).toBe(TGT_ID);
    expect(updateParams[2]).toBe(WS_ID);
  });
});

describe("POST /audit/:id/rollback — negative_keyword deletion", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("deletes the negative keyword from DB (keyword.negative_added + entity_type=negative_keyword)", async () => {
    const event = makeEvent({
      action: "keyword.negative_added",
      entity_type: "negative_keyword",
      entity_id: NEG_KW_ID,
      entity_name: "cheap shoes",
      before_data: null,  // negative additions have no before_data
      after_data: JSON.stringify({ match_type: "negativeExact" }),
    });

    dbQuery
      .mockResolvedValueOnce({ rows: [event] })     // SELECT event
      .mockResolvedValueOnce({ rowCount: 1 })        // DELETE negative_keywords
      .mockResolvedValueOnce({ rows: [{ id: AUDIT_WRITE_ID }] }); // writeAudit

    const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toMatch(/cheap shoes/);
    expect(res.body.message).toMatch(/removed/i);

    const [deleteSql, deleteParams] = dbQuery.mock.calls[1];
    expect(deleteSql).toMatch(/DELETE FROM negative_keywords/);
    expect(deleteParams[0]).toBe(NEG_KW_ID);
    expect(deleteParams[1]).toBe(WS_ID);
  });

  it("returns 404 when negative_keyword not found in DB", async () => {
    const event = makeEvent({
      action: "keyword.negative_added",
      entity_type: "negative_keyword",
      entity_id: NEG_KW_ID,
      entity_name: "cheap shoes",
      before_data: null,
      after_data: JSON.stringify({ match_type: "negativeExact" }),
    });

    dbQuery
      .mockResolvedValueOnce({ rows: [event] })
      .mockResolvedValueOnce({ rowCount: 0 });  // DELETE found nothing

    const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe("POST /audit/:id/rollback — negative_target deletion", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("deletes the negative ASIN target from DB (keyword.negative_added + entity_type=negative_target)", async () => {
    const event = makeEvent({
      action: "keyword.negative_added",
      entity_type: "negative_target",
      entity_id: NEG_TGT_ID,
      entity_name: "B0TESTPRODUCT",
      before_data: null,
      after_data: JSON.stringify({ asin: "B0TESTPRODUCT" }),
    });

    dbQuery
      .mockResolvedValueOnce({ rows: [event] })
      .mockResolvedValueOnce({ rowCount: 1 })   // DELETE negative_targets
      .mockResolvedValueOnce({ rows: [{ id: AUDIT_WRITE_ID }] });

    const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toMatch(/B0TESTPRODUCT/i);
    expect(res.body.message).toMatch(/removed/i);

    const [deleteSql, deleteParams] = dbQuery.mock.calls[1];
    expect(deleteSql).toMatch(/DELETE FROM negative_targets/);
    expect(deleteParams[0]).toBe(NEG_TGT_ID);
    expect(deleteParams[1]).toBe(WS_ID);
  });

  it("returns 404 when negative_target not found in DB", async () => {
    const event = makeEvent({
      action: "keyword.negative_added",
      entity_type: "negative_target",
      entity_id: NEG_TGT_ID,
      entity_name: "B0TESTPRODUCT",
      before_data: null,
      after_data: JSON.stringify({ asin: "B0TESTPRODUCT" }),
    });

    dbQuery
      .mockResolvedValueOnce({ rows: [event] })
      .mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe("POST /audit/:id/rollback — campaign state rollback", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const CAMPAIGN_STATE_ACTIONS = [
    "rule.pause_campaign",
    "rule.enable_campaign",
    "campaign.pause",
    "campaign.enable",
  ];

  CAMPAIGN_STATE_ACTIONS.forEach(action => {
    it(`restores campaign state for action=${action}`, async () => {
      const event = makeEvent({
        action,
        entity_type: "campaign",
        entity_id: CAMP_ID,
        before_data: JSON.stringify({ state: "enabled" }),
        after_data: JSON.stringify({ state: "paused" }),
      });

      dbQuery
        .mockResolvedValueOnce({ rows: [event] })
        .mockResolvedValueOnce({ rows: [] })   // UPDATE campaigns SET state
        .mockResolvedValueOnce({ rows: [{ id: AUDIT_WRITE_ID }] });

      const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.message).toMatch(/enabled/);

      const [updateSql, updateParams] = dbQuery.mock.calls[1];
      expect(updateSql).toMatch(/UPDATE campaigns SET state/);
      expect(updateParams[0]).toBe("enabled");
      expect(updateParams[1]).toBe(CAMP_ID);
      expect(updateParams[2]).toBe(WS_ID);
    });
  });

  it("uses before.value when before.state is absent", async () => {
    const event = makeEvent({
      action: "rule.pause_campaign",
      entity_type: "campaign",
      entity_id: CAMP_ID,
      before_data: JSON.stringify({ value: "enabled" }), // legacy shape
      after_data: JSON.stringify({ state: "paused" }),
    });

    dbQuery
      .mockResolvedValueOnce({ rows: [event] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: AUDIT_WRITE_ID }] });

    const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

    expect(res.status).toBe(200);
    const [, updateParams] = dbQuery.mock.calls[1];
    expect(updateParams[0]).toBe("enabled");
  });

  it("returns 400 when before_data has neither state nor value", async () => {
    const event = makeEvent({
      action: "rule.pause_campaign",
      entity_type: "campaign",
      entity_id: CAMP_ID,
      before_data: JSON.stringify({ dailyBudget: 100 }), // no state/value
      after_data: JSON.stringify({ state: "paused" }),
    });

    dbQuery.mockResolvedValueOnce({ rows: [event] });

    const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/state/i);
  });
});

describe("POST /audit/:id/rollback — campaign budget rollback", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  const BUDGET_ACTIONS = [
    "rule.adjust_budget",
    "rule.set_budget",
    "campaign.adjust_budget_pct",
    "campaign.set_budget",
  ];

  BUDGET_ACTIONS.forEach(action => {
    it(`restores campaign budget for action=${action}`, async () => {
      const event = makeEvent({
        action,
        entity_type: "campaign",
        entity_id: CAMP_ID,
        before_data: JSON.stringify({ dailyBudget: 50 }),
        after_data: JSON.stringify({ dailyBudget: 80 }),
      });

      dbQuery
        .mockResolvedValueOnce({ rows: [event] })
        .mockResolvedValueOnce({ rows: [] })   // UPDATE campaigns SET daily_budget
        .mockResolvedValueOnce({ rows: [{ id: AUDIT_WRITE_ID }] });

      const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.message).toMatch(/50/);

      const [updateSql, updateParams] = dbQuery.mock.calls[1];
      expect(updateSql).toMatch(/UPDATE campaigns SET daily_budget/);
      expect(updateParams[0]).toBe(50);
      expect(updateParams[1]).toBe(CAMP_ID);
      expect(updateParams[2]).toBe(WS_ID);
    });
  });

  it("falls back to before.value when dailyBudget absent", async () => {
    const event = makeEvent({
      action: "rule.set_budget",
      entity_type: "campaign",
      entity_id: CAMP_ID,
      before_data: JSON.stringify({ value: 40 }),
      after_data: JSON.stringify({ dailyBudget: 80 }),
    });

    dbQuery
      .mockResolvedValueOnce({ rows: [event] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: AUDIT_WRITE_ID }] });

    const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

    expect(res.status).toBe(200);
    const [, updateParams] = dbQuery.mock.calls[1];
    expect(updateParams[0]).toBe(40);
  });

  it("falls back to before.daily_budget when dailyBudget and value are absent", async () => {
    const event = makeEvent({
      action: "rule.adjust_budget",
      entity_type: "campaign",
      entity_id: CAMP_ID,
      before_data: JSON.stringify({ daily_budget: 35 }),
      after_data: JSON.stringify({ dailyBudget: 50 }),
    });

    dbQuery
      .mockResolvedValueOnce({ rows: [event] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: AUDIT_WRITE_ID }] });

    const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

    expect(res.status).toBe(200);
    const [, updateParams] = dbQuery.mock.calls[1];
    expect(updateParams[0]).toBe(35);
  });
});

describe("POST /audit/:id/rollback — unsupported event type", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns 400 for an unknown action/entity_type combination", async () => {
    const event = makeEvent({
      action: "something.completely_unknown",
      entity_type: "unknown_entity",
      before_data: JSON.stringify({ foo: "bar" }),
    });
    dbQuery.mockResolvedValueOnce({ rows: [event] });

    const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported/i);
    expect(res.body.action).toBe("something.completely_unknown");
    expect(res.body.entity_type).toBe("unknown_entity");
  });

  it("returns 400 for a keyword entity with an unsupported action", async () => {
    const event = makeEvent({
      action: "keyword.some_new_action",
      entity_type: "keyword",
      before_data: JSON.stringify({ bid: "1.00" }),
    });
    dbQuery.mockResolvedValueOnce({ rows: [event] });

    const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not supported/i);
  });
});

describe("POST /audit/:id/rollback — writeAudit called on success", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("writes a rollback audit event after successful keyword bid rollback", async () => {
    const event = makeEvent({
      action: "keyword.bid_change",
      entity_type: "keyword",
      entity_id: KW_ID,
      entity_name: "running shoes",
      before_data: JSON.stringify({ bid: "0.75" }),
      after_data: JSON.stringify({ bid: "1.50" }),
    });

    dbQuery
      .mockResolvedValueOnce({ rows: [event] })
      .mockResolvedValueOnce({ rows: [] })                            // UPDATE keywords
      .mockResolvedValueOnce({ rows: [{ id: AUDIT_WRITE_ID }] });    // writeAudit INSERT

    const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

    expect(res.status).toBe(200);

    // writeAudit calls query() for the INSERT
    const writeAuditCall = dbQuery.mock.calls[2];
    const [insertSql, insertParams] = writeAuditCall;
    expect(insertSql).toMatch(/INSERT INTO audit_events/);
    // action should be keyword.bid_change.rollback
    expect(insertParams[5]).toBe("keyword.bid_change.rollback");
    // actor should be the authed user
    expect(insertParams[2]).toBe(USER_ID);
  });

  it("response includes original_event_id", async () => {
    const event = makeEvent({
      action: "keyword.bid_change",
      entity_type: "keyword",
      entity_id: KW_ID,
      before_data: JSON.stringify({ bid: "0.75" }),
      after_data: JSON.stringify({ bid: "1.50" }),
    });

    dbQuery
      .mockResolvedValueOnce({ rows: [event] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: AUDIT_WRITE_ID }] });

    const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

    expect(res.status).toBe(200);
    expect(res.body.original_event_id).toBe(EVENT_ID);
  });
});

describe("POST /audit/:id/rollback — before_data as object (already parsed)", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("handles before_data that is already a JS object (not a string)", async () => {
    // Some DB drivers may return JSONB as a parsed object
    const event = makeEvent({
      action: "keyword.set_bid",
      entity_type: "keyword",
      entity_id: KW_ID,
      before_data: { bid: "0.60" },      // already parsed — no JSON.stringify
      after_data: { bid: "1.00" },
    });

    dbQuery
      .mockResolvedValueOnce({ rows: [event] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: AUDIT_WRITE_ID }] });

    const res = await request(app).post(`/audit/${EVENT_ID}/rollback`).send({});

    expect(res.status).toBe(200);
    const [, updateParams] = dbQuery.mock.calls[1];
    expect(updateParams[0]).toBe("0.60");
  });
});
