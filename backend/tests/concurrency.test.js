"use strict";
/**
 * Concurrency & locking tests for the rule engine.
 *
 * The rule engine uses two Redis locks to prevent race conditions:
 *
 *   1. Workspace lock  — key: `rule_exec_lock:{workspaceId}`
 *      Set by the BullMQ worker before running `executeAllDueRules`.
 *      Manual /run requests check this key and return 409 if it exists,
 *      preventing a manual trigger from racing a scheduled cron run.
 *
 *   2. Per-rule manual lock — key: `rule_exec_lock:manual:{ruleId}`
 *      Set with NX (only if absent) when a manual /run starts.
 *      Prevents duplicate button clicks from spawning two executions
 *      of the same rule simultaneously.
 *
 *   3. dry_run flag — bypasses ALL Redis locking; safe to call anytime.
 *
 * Lock release contract (both locks):
 *   • Released in a `finally` block so they are freed even on error.
 *   • Only released if the current value equals the acquirer's identity
 *     (user.id for per-rule lock, job.id for workspace lock) to guard
 *     against the TTL expiring and another process acquiring the lock.
 */

const request = require("supertest");
const express = require("express");

// ─── Fixtures ─────────────────────────────────────────────────────────────────
const WS_ID   = "ws---0001-0000-0000-000000000001";
const ORG_ID  = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";
const RULE_ID = "rule-0001-0000-0000-000000000001";

// ─── Mocks — factories must be inline (no out-of-scope refs) ──────────────────
jest.mock("../src/db/pool",             () => ({ query: jest.fn() }));
jest.mock("../src/routes/audit",        () => ({ writeAudit: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../src/services/amazon/writeback", () => ({
  pushNegativeKeyword:    jest.fn().mockResolvedValue({}),
  pushNegativeAsin:       jest.fn().mockResolvedValue({}),
  pushKeywordUpdates:     jest.fn().mockResolvedValue({}),
  archiveNegativeKeyword: jest.fn().mockResolvedValue({}),
  archiveNegativeTarget:  jest.fn().mockResolvedValue({}),
}));
jest.mock("../src/services/amazon/adsClient", () => ({ put: jest.fn().mockResolvedValue({}) }));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
// Redis mock — factory creates getRedis as jest.fn(); each test configures
// the returned client via getRedis.mockReturnValue({...}) in beforeEach.
jest.mock("../src/config/redis", () => ({
  getRedis: jest.fn(),
}));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user       = { id: "user-0001-0000-0000-000000000001", name: "Test User", role: "owner", org_id: "org--0001-0000-0000-000000000001" };
    req.orgId      = "org--0001-0000-0000-000000000001";
    next();
  },
  requireWorkspace: (req, _res, next) => {
    req.workspaceId   = "ws---0001-0000-0000-000000000001";
    req.workspaceRole = "owner";
    next();
  },
}));

// ─── Require mocked modules after jest.mock calls ─────────────────────────────
const { query: dbQuery } = require("../src/db/pool");
const { getRedis }       = require("../src/config/redis");
const rulesRouter        = require("../src/routes/rules");

// ─── App builder ──────────────────────────────────────────────────────────────
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/rules", rulesRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
  });
  return app;
}

// ─── Helper: build a fresh redis client mock ──────────────────────────────────
function makeRedis(overrides = {}) {
  return {
    get: jest.fn().mockResolvedValue(null),   // default: no lock
    set: jest.fn().mockResolvedValue("OK"),   // default: lock acquired
    del: jest.fn().mockResolvedValue(1),
    ...overrides,
  };
}

// ─── Minimal rule fixture ─────────────────────────────────────────────────────
const RULE = {
  id:            RULE_ID,
  workspace_id:  WS_ID,
  name:          "Test Rule",
  description:   "",
  conditions:    JSON.stringify([{ metric: "acos", op: "gt", value: 50 }]),
  actions:       JSON.stringify([{ type: "pause_keyword" }]),
  scope:         JSON.stringify({ entity_type: "keyword", period_days: 14 }),
  safety:        JSON.stringify({ min_bid: 0.02, max_bid: 50 }),
  dry_run:       false,
  is_active:     true,
  schedule_type: "daily",
  run_hour:      8,
};

// ─── DB mock for a full successful real (non-dry) keyword run ─────────────────
// 1. SELECT rule  2. SELECT org_id  3. SELECT exemptions  4. SELECT keywords (empty)
// 5. SELECT neg_kw reconcile  6. SELECT neg_tgt reconcile  7. UPDATE rules
function mockRealRun() {
  dbQuery
    .mockResolvedValueOnce({ rows: [RULE] })
    .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
    .mockResolvedValueOnce({ rows: [] })  // exemptions
    .mockResolvedValueOnce({ rows: [] })  // keywords
    .mockResolvedValueOnce({ rows: [] })  // reconcile neg_kw
    .mockResolvedValueOnce({ rows: [] })  // reconcile neg_tgt
    .mockResolvedValueOnce({ rows: [] }); // UPDATE rules
}

// ─────────────────────────────────────────────────────────────────────────────
//  Workspace lock — cron worker holds it, manual run is blocked
// ─────────────────────────────────────────────────────────────────────────────
describe("Workspace lock (cron vs manual)", () => {
  let app, redis;
  beforeEach(() => {
    app = buildApp();
    jest.resetAllMocks();
    redis = makeRedis();
    getRedis.mockReturnValue(redis);
  });

  it("returns 409 when workspace lock is held by cron worker", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [RULE] });
    redis.get.mockResolvedValue("bullmq-job-42"); // workspace lock exists

    const res = await request(app)
      .post(`/rules/${RULE_ID}/run`)
      .send({ dry_run: false });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("rule_locked");
    expect(res.body.message).toMatch(/already in progress/i);
  });

  it("409 from workspace lock does not call executeRule (only 1 DB query)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [RULE] });
    redis.get.mockResolvedValue("worker-job-99");

    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    expect(dbQuery).toHaveBeenCalledTimes(1); // only SELECT rule
  });

  it("dry_run=true skips workspace lock check entirely", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [RULE] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/rules/${RULE_ID}/run`)
      .send({ dry_run: true });

    expect(res.status).toBe(200);
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("rule.dry_run=true (no body override) also skips Redis entirely", async () => {
    const dryRule = { ...RULE, dry_run: true };
    dbQuery
      .mockResolvedValueOnce({ rows: [dryRule] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post(`/rules/${RULE_ID}/run`).send({});

    expect(res.status).toBe(200);
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("workspace lock key includes correct workspaceId", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [RULE] });
    redis.get.mockResolvedValue("job-1");

    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    expect(redis.get).toHaveBeenCalledWith(`rule_exec_lock:${WS_ID}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Per-rule manual lock — duplicate button click protection
// ─────────────────────────────────────────────────────────────────────────────
describe("Per-rule manual lock (duplicate click protection)", () => {
  let app, redis;
  beforeEach(() => {
    app = buildApp();
    jest.resetAllMocks();
    redis = makeRedis();
    getRedis.mockReturnValue(redis);
  });

  it("returns 409 when per-rule lock is held (NX set returns null)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [RULE] });
    redis.get.mockResolvedValueOnce(null); // workspace lock: free
    redis.set.mockResolvedValue(null);     // NX returns null = not acquired

    const res = await request(app)
      .post(`/rules/${RULE_ID}/run`)
      .send({ dry_run: false });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("rule_locked");
    expect(res.body.message).toMatch(/already running/i);
  });

  it("duplicate click 409 does not call executeRule (only 1 DB query)", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [RULE] });
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue(null);

    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    expect(dbQuery).toHaveBeenCalledTimes(1);
  });

  it("checks workspace lock BEFORE attempting per-rule NX set", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [RULE] });
    redis.get.mockResolvedValue("worker-123"); // workspace lock held
    redis.set.mockResolvedValue(null);

    const res = await request(app)
      .post(`/rules/${RULE_ID}/run`)
      .send({ dry_run: false });

    expect(res.status).toBe(409);
    // NX set should never have been called — short-circuit on workspace lock
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("per-rule lock key includes ruleId", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [RULE] });
    redis.get.mockResolvedValueOnce(null); // workspace: free
    redis.set.mockResolvedValue(null);     // NX fails

    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    expect(redis.set).toHaveBeenCalledWith(
      `rule_exec_lock:manual:${RULE_ID}`,
      USER_ID,
      "NX", "EX", 120
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Lock acquisition & release — happy path
// ─────────────────────────────────────────────────────────────────────────────
describe("Lock acquisition and release — happy path", () => {
  let app, redis;
  beforeEach(() => {
    app = buildApp();
    jest.resetAllMocks();
    redis = makeRedis();
    getRedis.mockReturnValue(redis);
  });

  it("acquires per-rule lock before executing and releases it after", async () => {
    mockRealRun();
    redis.get
      .mockResolvedValueOnce(null)     // workspace lock: free
      .mockResolvedValueOnce(USER_ID); // owns per-rule lock → del allowed
    redis.set.mockResolvedValue("OK");
    redis.del.mockResolvedValue(1);

    const res = await request(app)
      .post(`/rules/${RULE_ID}/run`)
      .send({ dry_run: false });

    expect(res.status).toBe(200);
    expect(redis.set).toHaveBeenCalledWith(
      `rule_exec_lock:manual:${RULE_ID}`, USER_ID, "NX", "EX", 120
    );
    expect(redis.del).toHaveBeenCalledWith(`rule_exec_lock:manual:${RULE_ID}`);
  });

  it("lock is set with NX flag and 120s TTL", async () => {
    mockRealRun();
    redis.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(USER_ID);

    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    const [, , mode, expType, ttl] = redis.set.mock.calls[0];
    expect(mode).toBe("NX");
    expect(expType).toBe("EX");
    expect(ttl).toBe(120);
  });

  it("lock value is the authenticated user ID", async () => {
    mockRealRun();
    redis.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(USER_ID);

    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    expect(redis.set.mock.calls[0][1]).toBe(USER_ID);
  });

  it("does NOT release lock if a different user holds it (lock stolen / TTL expired)", async () => {
    mockRealRun();
    redis.get
      .mockResolvedValueOnce(null)             // workspace: free
      .mockResolvedValueOnce("other-user-id"); // per-rule lock no longer ours
    redis.set.mockResolvedValue("OK");

    await request(app).post(`/rules/${RULE_ID}/run`).send({ dry_run: false });

    expect(redis.del).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Lock release on error — finally block guarantee
// ─────────────────────────────────────────────────────────────────────────────
describe("Lock release on executeRule error — finally block", () => {
  let app, redis;
  beforeEach(() => {
    app = buildApp();
    jest.resetAllMocks();
    redis = makeRedis();
    getRedis.mockReturnValue(redis);
  });

  it("releases per-rule lock even when executeRule throws", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [RULE] })         // SELECT rule
      .mockRejectedValueOnce(new Error("DB lost"));    // org_id query fails inside executeRule

    redis.get
      .mockResolvedValueOnce(null)     // workspace: free
      .mockResolvedValueOnce(USER_ID); // we still own per-rule lock
    redis.set.mockResolvedValue("OK");

    const res = await request(app)
      .post(`/rules/${RULE_ID}/run`)
      .send({ dry_run: false });

    expect(res.status).toBe(500);
    // Lock must be released via finally block
    expect(redis.del).toHaveBeenCalledWith(`rule_exec_lock:manual:${RULE_ID}`);
  });

  it("does NOT release lock on error if a different owner holds it", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [RULE] })
      .mockRejectedValueOnce(new Error("Timeout"));

    redis.get
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("other-user-id"); // lock was stolen while we executed
    redis.set.mockResolvedValue("OK");

    const res = await request(app)
      .post(`/rules/${RULE_ID}/run`)
      .send({ dry_run: false });

    expect(res.status).toBe(500);
    expect(redis.del).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Rule not found — no Redis interaction
// ─────────────────────────────────────────────────────────────────────────────
describe("Rule not found — no Redis interaction", () => {
  let app, redis;
  beforeEach(() => {
    app = buildApp();
    jest.resetAllMocks();
    redis = makeRedis();
    getRedis.mockReturnValue(redis);
  });

  it("returns 404 and never touches Redis when rule is not found", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post(`/rules/${RULE_ID}/run`)
      .send({ dry_run: false });

    expect(res.status).toBe(404);
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.del).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Worker / manual interplay — shared lock namespace
// ─────────────────────────────────────────────────────────────────────────────
describe("Worker lock vs manual run — shared key namespace", () => {
  let app, redis;
  beforeEach(() => {
    app = buildApp();
    jest.resetAllMocks();
    redis = makeRedis();
    getRedis.mockReturnValue(redis);
  });

  it("manual /run sees 409 when worker lock key `rule_exec_lock:{wsId}` is held", async () => {
    dbQuery.mockResolvedValueOnce({ rows: [RULE] });
    redis.get.mockImplementation((key) =>
      key === `rule_exec_lock:${WS_ID}`
        ? Promise.resolve("worker-job-77")
        : Promise.resolve(null)
    );

    const res = await request(app)
      .post(`/rules/${RULE_ID}/run`)
      .send({ dry_run: false });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("rule_locked");
  });

  it("manual /run proceeds when workspace lock is absent", async () => {
    mockRealRun();
    redis.get
      .mockResolvedValueOnce(null)     // workspace: free
      .mockResolvedValueOnce(USER_ID); // owns per-rule lock
    redis.set.mockResolvedValue("OK");

    const res = await request(app)
      .post(`/rules/${RULE_ID}/run`)
      .send({ dry_run: false });

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("matched_count");
  });

  it("dry_run is never blocked even when worker lock is held", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [RULE] })
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    // Worker lock is held but dry_run never reads Redis
    redis.get.mockResolvedValue("worker-job-99");

    const res = await request(app)
      .post(`/rules/${RULE_ID}/run`)
      .send({ dry_run: true });

    expect(res.status).toBe(200);
    expect(redis.get).not.toHaveBeenCalled();
  });
});
