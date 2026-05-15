"use strict";
/**
 * Strategies routes — comprehensive test suite
 *
 * Covers:
 *   GET  /strategies              — list, empty list
 *   POST /strategies              — create 201, 400 name missing
 *   PATCH /strategies/:id         — update name, toggle is_active, 404, 400 nothing to update
 *   DELETE /strategies/:id        — ok:true, 404
 *   POST /strategies/:id/run      — 404, 400 no rules, dry_run shape, executeRules called per
 *                                   rule_id, non-fatal error continues + status completed_with_errors,
 *                                   saves execution record + updates last_run_at
 *   GET  /strategies/:id/runs     — history, limit capped at 100
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID       = "ws---0001-0000-0000-000000000001";
const ORG_ID      = "org--0001-0000-0000-000000000001";
const USER_ID     = "user-0001-0000-0000-000000000001";
const STRAT_ID    = "str--0001-0000-0000-000000000001";
const RULE_ID_A   = "rule-0001-0000-0000-000000000001";
const RULE_ID_B   = "rule-0002-0000-0000-000000000002";
const EXEC_ID     = "exec-0001-0000-0000-000000000001";

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
jest.mock("../src/services/rules/engine", () => ({
  executeRules: jest.fn(),
}));

const { query: dbQuery }              = require("../src/db/pool");
const { executeRules }                = require("../src/services/rules/engine");
const strategiesRouter                = require("../src/routes/strategies");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/strategies", strategiesRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function makeStrategy(overrides = {}) {
  return {
    id: STRAT_ID,
    workspace_id: WS_ID,
    name: "My Strategy",
    description: "test",
    rule_ids: [RULE_ID_A, RULE_ID_B],
    is_active: true,
    last_run_at: null,
    last_run_status: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeRuleResult(ruleId, overrides = {}) {
  return {
    results: [{
      ruleId,
      name: "Rule " + ruleId,
      actionsTaken: 3,
      matched: 5,
    }],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /strategies
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /strategies", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns list of strategies", async () => {
    const strat = { ...makeStrategy(), rules: [{ id: RULE_ID_A, name: "Rule A", is_active: true }] };
    dbQuery.mockResolvedValueOnce({ rows: [strat] });

    const res = await request(app).get("/strategies");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].id).toBe(STRAT_ID);
    expect(dbQuery).toHaveBeenCalledTimes(1);
    expect(dbQuery.mock.calls[0][1]).toEqual([WS_ID]);
  });

  it("returns empty array when no strategies exist", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/strategies");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("propagates DB error as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("DB down"));

    const res = await request(app).get("/strategies");
    expect(res.status).toBe(500);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /strategies
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /strategies", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("creates strategy and returns 201", async () => {
    const created = makeStrategy();
    dbQuery.mockResolvedValueOnce({ rows: [created] });

    const res = await request(app)
      .post("/strategies")
      .send({ name: "My Strategy", description: "test", rule_ids: [RULE_ID_A], is_active: true });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(STRAT_ID);
    expect(res.body.name).toBe("My Strategy");
    expect(dbQuery).toHaveBeenCalledTimes(1);
    // Verify workspace_id and trimmed name are passed
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO strategies/);
    expect(params[0]).toBe(WS_ID);
    expect(params[1]).toBe("My Strategy");
  });

  it("trims whitespace from name", async () => {
    const created = makeStrategy({ name: "Trimmed" });
    dbQuery.mockResolvedValueOnce({ rows: [created] });

    const res = await request(app)
      .post("/strategies")
      .send({ name: "  Trimmed  " });

    expect(res.status).toBe(201);
    const [, params] = dbQuery.mock.calls[0];
    expect(params[1]).toBe("Trimmed");
  });

  it("defaults rule_ids to [] and is_active to true when not provided", async () => {
    const created = makeStrategy({ rule_ids: [], is_active: true });
    dbQuery.mockResolvedValueOnce({ rows: [created] });

    const res = await request(app)
      .post("/strategies")
      .send({ name: "No Rules" });

    expect(res.status).toBe(201);
    const [, params] = dbQuery.mock.calls[0];
    expect(params[3]).toEqual([]);
    expect(params[4]).toBe(true);
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/strategies")
      .send({ description: "no name here" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name required/i);
    expect(dbQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when name is blank whitespace", async () => {
    const res = await request(app)
      .post("/strategies")
      .send({ name: "   " });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name required/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  PATCH /strategies/:id
// ─────────────────────────────────────────────────────────────────────────────
describe("PATCH /strategies/:id", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("updates name and returns updated strategy", async () => {
    const updated = makeStrategy({ name: "Updated Name" });
    dbQuery.mockResolvedValueOnce({ rows: [updated] });

    const res = await request(app)
      .patch(`/strategies/${STRAT_ID}`)
      .send({ name: "Updated Name" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated Name");
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE strategies/);
    expect(params).toContain("Updated Name");
    expect(params).toContain(STRAT_ID);
    expect(params).toContain(WS_ID);
  });

  it("toggles is_active to false", async () => {
    const updated = makeStrategy({ is_active: false });
    dbQuery.mockResolvedValueOnce({ rows: [updated] });

    const res = await request(app)
      .patch(`/strategies/${STRAT_ID}`)
      .send({ is_active: false });

    expect(res.status).toBe(200);
    expect(res.body.is_active).toBe(false);
    const [, params] = dbQuery.mock.calls[0];
    expect(params).toContain(false);
  });

  it("updates rule_ids array", async () => {
    const newRuleIds = [RULE_ID_A];
    const updated = makeStrategy({ rule_ids: newRuleIds });
    dbQuery.mockResolvedValueOnce({ rows: [updated] });

    const res = await request(app)
      .patch(`/strategies/${STRAT_ID}`)
      .send({ rule_ids: newRuleIds });

    expect(res.status).toBe(200);
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/rule_ids = \$\d+::uuid\[\]/);
    expect(params).toContainEqual(newRuleIds);
  });

  it("updates description to null", async () => {
    const updated = makeStrategy({ description: null });
    dbQuery.mockResolvedValueOnce({ rows: [updated] });

    const res = await request(app)
      .patch(`/strategies/${STRAT_ID}`)
      .send({ description: null });

    expect(res.status).toBe(200);
  });

  it("returns 404 when strategy not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch(`/strategies/${STRAT_ID}`)
      .send({ name: "X" });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 400 when body has nothing to update", async () => {
    const res = await request(app)
      .patch(`/strategies/${STRAT_ID}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/nothing to update/i);
    expect(dbQuery).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  DELETE /strategies/:id
// ─────────────────────────────────────────────────────────────────────────────
describe("DELETE /strategies/:id", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("deletes strategy and returns ok:true", async () => {
    dbQuery.mockResolvedValueOnce({ rowCount: 1 });

    const res = await request(app).delete(`/strategies/${STRAT_ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    const [sql, params] = dbQuery.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM strategies/);
    expect(params).toEqual([STRAT_ID, WS_ID]);
  });

  it("returns 404 when strategy not found", async () => {
    dbQuery.mockResolvedValueOnce({ rowCount: 0 });

    const res = await request(app).delete(`/strategies/${STRAT_ID}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  POST /strategies/:id/run
// ─────────────────────────────────────────────────────────────────────────────
describe("POST /strategies/:id/run", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns 404 when strategy not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/strategies/${STRAT_ID}/run`)
      .send({ dry_run: true });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("returns 400 when strategy has no rule_ids", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [makeStrategy({ rule_ids: [] })] });

    const res = await request(app)
      .post(`/strategies/${STRAT_ID}/run`)
      .send({ dry_run: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no rules/i);
  });

  it("returns 400 when strategy has null rule_ids", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [makeStrategy({ rule_ids: null })] });

    const res = await request(app)
      .post(`/strategies/${STRAT_ID}/run`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no rules/i);
  });

  it("returns correct dry_run response shape", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [makeStrategy({ rule_ids: [RULE_ID_A] })] })
      .mockResolvedValueOnce({ rows: [{ id: EXEC_ID }] }) // INSERT strategy_executions
      .mockResolvedValueOnce({ rows: [] });                // UPDATE strategies

    executeRules.mockResolvedValueOnce(makeRuleResult(RULE_ID_A));

    const res = await request(app)
      .post(`/strategies/${STRAT_ID}/run`)
      .send({ dry_run: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      executionId: EXEC_ID,
      status: "completed",
      rulesRun: 1,
      totalActions: 3,
      dryRun: true,
    });
    expect(typeof res.body.durationMs).toBe("number");
    expect(Array.isArray(res.body.summary)).toBe(true);
    expect(res.body.summary[0]).toMatchObject({
      ruleId: RULE_ID_A,
      actionsTaken: 3,
      entitiesMatched: 5,
      status: "ok",
    });
  });

  it("calls executeRules once per rule_id in order", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [makeStrategy({ rule_ids: [RULE_ID_A, RULE_ID_B] })] })
      .mockResolvedValueOnce({ rows: [{ id: EXEC_ID }] })
      .mockResolvedValueOnce({ rows: [] });

    executeRules
      .mockResolvedValueOnce(makeRuleResult(RULE_ID_A))
      .mockResolvedValueOnce(makeRuleResult(RULE_ID_B));

    const res = await request(app)
      .post(`/strategies/${STRAT_ID}/run`)
      .send({ dry_run: false });

    expect(res.status).toBe(200);
    expect(executeRules).toHaveBeenCalledTimes(2);
    expect(executeRules.mock.calls[0][1]).toBe(RULE_ID_A);
    expect(executeRules.mock.calls[1][1]).toBe(RULE_ID_B);
    // Both calls should have forceDryRun: false
    expect(executeRules.mock.calls[0][2]).toMatchObject({ forceDryRun: false, saveExecution: true });
    expect(executeRules.mock.calls[1][2]).toMatchObject({ forceDryRun: false, saveExecution: true });
    expect(res.body.rulesRun).toBe(2);
    expect(res.body.totalActions).toBe(6); // 3 + 3
  });

  it("passes dry_run=true to executeRules as forceDryRun", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [makeStrategy({ rule_ids: [RULE_ID_A] })] })
      .mockResolvedValueOnce({ rows: [{ id: EXEC_ID }] })
      .mockResolvedValueOnce({ rows: [] });

    executeRules.mockResolvedValueOnce(makeRuleResult(RULE_ID_A));

    await request(app).post(`/strategies/${STRAT_ID}/run`).send({ dry_run: true });

    expect(executeRules).toHaveBeenCalledWith(WS_ID, RULE_ID_A, {
      forceDryRun: true,
      saveExecution: true,
    });
  });

  it("handles single rule execution error non-fatally; status becomes completed_with_errors", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [makeStrategy({ rule_ids: [RULE_ID_A, RULE_ID_B] })] })
      .mockResolvedValueOnce({ rows: [{ id: EXEC_ID }] })
      .mockResolvedValueOnce({ rows: [] });

    executeRules
      .mockRejectedValueOnce(new Error("Rule A exploded"))
      .mockResolvedValueOnce(makeRuleResult(RULE_ID_B));

    const res = await request(app)
      .post(`/strategies/${STRAT_ID}/run`)
      .send({ dry_run: false });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("completed_with_errors");
    // RULE_ID_B still ran
    expect(executeRules).toHaveBeenCalledTimes(2);
    // summary has both entries
    const summaries = res.body.summary;
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({ ruleId: RULE_ID_A, status: "error", error: "Rule A exploded" });
    expect(summaries[1]).toMatchObject({ ruleId: RULE_ID_B, status: "ok" });
    // total actions only count the successful rule
    expect(res.body.totalActions).toBe(3);
  });

  it("saves strategy_execution record with correct params", async () => {
    const strategy = makeStrategy({ rule_ids: [RULE_ID_A] });
    dbQuery
      .mockResolvedValueOnce({ rows: [strategy] })
      .mockResolvedValueOnce({ rows: [{ id: EXEC_ID }] })
      .mockResolvedValueOnce({ rows: [] });

    executeRules.mockResolvedValueOnce(makeRuleResult(RULE_ID_A));

    await request(app).post(`/strategies/${STRAT_ID}/run`).send({ dry_run: false });

    // Find the INSERT strategy_executions call (2nd dbQuery call)
    const [insertSql, insertParams] = dbQuery.mock.calls[1];
    expect(insertSql).toMatch(/INSERT INTO strategy_executions/);
    expect(insertParams[0]).toBe(STRAT_ID);   // strategy_id
    expect(insertParams[1]).toBe(WS_ID);       // workspace_id
    expect(insertParams[2]).toBe(false);        // dry_run
    expect(insertParams[3]).toBe("completed"); // status
    expect(insertParams[4]).toBe(1);           // rules_run
  });

  it("updates strategy last_run_at after execution", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [makeStrategy({ rule_ids: [RULE_ID_A] })] })
      .mockResolvedValueOnce({ rows: [{ id: EXEC_ID }] })
      .mockResolvedValueOnce({ rows: [] });

    executeRules.mockResolvedValueOnce(makeRuleResult(RULE_ID_A));

    await request(app).post(`/strategies/${STRAT_ID}/run`).send({ dry_run: false });

    // Third dbQuery call should be the UPDATE strategies
    const [updateSql, updateParams] = dbQuery.mock.calls[2];
    expect(updateSql).toMatch(/UPDATE strategies SET last_run_at/);
    expect(updateParams[0]).toBe("completed");
    expect(updateParams[1]).toBe(STRAT_ID);
  });

  it("handles rule result with missing results array gracefully", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [makeStrategy({ rule_ids: [RULE_ID_A] })] })
      .mockResolvedValueOnce({ rows: [{ id: EXEC_ID }] })
      .mockResolvedValueOnce({ rows: [] });

    // executeRules returns object with no results array
    executeRules.mockResolvedValueOnce({});

    const res = await request(app)
      .post(`/strategies/${STRAT_ID}/run`)
      .send({ dry_run: true });

    expect(res.status).toBe(200);
    expect(res.body.totalActions).toBe(0);
    expect(res.body.summary[0].actionsTaken).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  GET /strategies/:id/runs
// ─────────────────────────────────────────────────────────────────────────────
describe("GET /strategies/:id/runs", () => {
  let app;
  beforeEach(() => { app = buildApp(); jest.clearAllMocks(); });

  it("returns execution history for a strategy", async () => {
    const runs = [
      {
        id: EXEC_ID,
        dry_run: false,
        status: "completed",
        rules_run: 2,
        total_actions: 5,
        summary: [],
        error_message: null,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
      },
    ];
    dbQuery.mockResolvedValueOnce({ rows: runs });

    const res = await request(app).get(`/strategies/${STRAT_ID}/runs`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(EXEC_ID);
    expect(res.body[0].status).toBe("completed");
  });

  it("returns empty array when no runs exist", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get(`/strategies/${STRAT_ID}/runs`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("uses default limit of 20 when not specified", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get(`/strategies/${STRAT_ID}/runs`);

    const [, params] = dbQuery.mock.calls[0];
    // params: [strategyId, workspaceId, limit]
    expect(params[2]).toBe(20);
  });

  it("caps limit at 100 regardless of query param", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get(`/strategies/${STRAT_ID}/runs?limit=999`);

    const [, params] = dbQuery.mock.calls[0];
    expect(params[2]).toBe(100);
  });

  it("accepts limit below 100", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get(`/strategies/${STRAT_ID}/runs?limit=5`);

    const [, params] = dbQuery.mock.calls[0];
    expect(params[2]).toBe(5);
  });

  it("filters by correct strategy_id and workspace_id", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    await request(app).get(`/strategies/${STRAT_ID}/runs`);

    const [, params] = dbQuery.mock.calls[0];
    expect(params[0]).toBe(STRAT_ID);
    expect(params[1]).toBe(WS_ID);
  });

  it("propagates DB error as 500", async () => {
    dbQuery.mockRejectedValueOnce(new Error("DB connection lost"));

    const res = await request(app).get(`/strategies/${STRAT_ID}/runs`);
    expect(res.status).toBe(500);
  });
});
