"use strict";
const request = require("supertest");
const express = require("express");

const WS_ID  = "ws---0001-0000-0000-000000000001";
const ORG_ID = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";

function makeMockQueue(overrides = {}) {
  return {
    getActive:       jest.fn().mockResolvedValue([]),
    getActiveCount:  jest.fn().mockResolvedValue(0),
    getWaitingCount: jest.fn().mockResolvedValue(0),
    getCompletedCount: jest.fn().mockResolvedValue(10),
    getFailedCount:  jest.fn().mockResolvedValue(0),
    getJobCounts:    jest.fn().mockResolvedValue({ active: 0, waiting: 0 }),
    ...overrides,
  };
}

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/jobs/workers", () => ({
  getQueue: jest.fn(),
  QUEUES: {
    ENTITY_SYNC:      "entity-sync",
    REPORT:           "report",
    METRICS_BACKFILL: "metrics-backfill",
    RULE_EXECUTION:   "rule-execution",
  },
  queueMetricsBackfill: jest.fn().mockResolvedValue({ id: "job-backfill-1" }),
}));
jest.mock("../src/middleware/auth", () => ({
  requireAuth: (req, _res, next) => {
    req.user = { id: USER_ID, name: "Test User", role: "owner", org_id: ORG_ID };
    req.orgId = ORG_ID; next();
  },
  requireWorkspace: (req, _res, next) => {
    req.workspaceId = WS_ID; req.workspaceRole = "owner"; next();
  },
}));

const { query: dbQuery } = require("../src/db/pool");
const { getQueue, queueMetricsBackfill } = require("../src/jobs/workers");
const router = require("../src/routes/jobs");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/jobs", router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

function resetMocks() {
  jest.resetAllMocks();
  queueMetricsBackfill.mockResolvedValue({ id: "job-backfill-1" });
  getQueue.mockReturnValue(makeMockQueue());
}

describe("GET /jobs", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns queue stats for all queues", async () => {
    const res = await request(app).get("/jobs");
    expect(res.status).toBe(200);
    expect(res.body).toBeDefined();
    const keys = Object.keys(res.body);
    expect(keys.length).toBeGreaterThan(0);
  });

  it("includes active, waiting, completed, failed for each queue", async () => {
    const q = makeMockQueue({
      getActiveCount: jest.fn().mockResolvedValue(2),
      getWaitingCount: jest.fn().mockResolvedValue(5),
      getCompletedCount: jest.fn().mockResolvedValue(100),
      getFailedCount: jest.fn().mockResolvedValue(1),
    });
    getQueue.mockReturnValue(q);
    const res = await request(app).get("/jobs");
    expect(res.status).toBe(200);
    const first = Object.values(res.body)[0];
    expect(first).toEqual({ active: 2, waiting: 5, completed: 100, failed: 1 });
  });
});

describe("GET /jobs/progress", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns active jobs and queue counts", async () => {
    const q = makeMockQueue();
    getQueue.mockReturnValue(q);

    const res = await request(app).get("/jobs/progress");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("active");
    expect(res.body).toHaveProperty("queued");
    expect(res.body.active).toBeInstanceOf(Array);
  });

  it("filters jobs that don't belong to workspace", async () => {
    const activeJob = {
      id: "job-123",
      data: { profileId: "prof-001", entityTypes: ["campaigns"] },
      progress: 50,
      processedOn: Date.now(),
    };
    const q = makeMockQueue({ getActive: jest.fn().mockResolvedValue([activeJob]) });
    getQueue.mockReturnValue(q);
    // DB returns different workspace → job filtered out
    dbQuery.mockResolvedValue({ rows: [{ workspace_id: "other-workspace" }] });

    const res = await request(app).get("/jobs/progress");
    expect(res.status).toBe(200);
    expect(res.body.active).toHaveLength(0);
  });

  it("includes job that belongs to workspace", async () => {
    const activeJob = {
      id: "job-123",
      data: { profileId: "prof-001", entityTypes: ["campaigns"] },
      progress: 50,
      processedOn: Date.now(),
    };
    // Only entity-sync has the active job; report and backfill queues are empty
    const syncQ = makeMockQueue({ getActive: jest.fn().mockResolvedValue([activeJob]) });
    const emptyQ = makeMockQueue();
    getQueue.mockImplementation(name =>
      name === "entity-sync" ? syncQ : emptyQ
    );
    dbQuery.mockResolvedValue({ rows: [{ workspace_id: WS_ID }] });

    const res = await request(app).get("/jobs/progress");
    expect(res.status).toBe(200);
    expect(res.body.active).toHaveLength(1);
    expect(res.body.active[0].type).toBe("entity_sync");
  });

  it("returns queued counts for sync, report, backfill", async () => {
    const q = makeMockQueue({
      getJobCounts: jest.fn().mockResolvedValue({ active: 1, waiting: 2 }),
    });
    getQueue.mockReturnValue(q);

    const res = await request(app).get("/jobs/progress");
    expect(res.status).toBe(200);
    expect(res.body.queued.sync).toBe(3);
    expect(res.body.queued.report).toBe(3);
    expect(res.body.queued.backfill).toBe(3);
  });
});

describe("POST /jobs/backfill-metrics", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("queues backfill and returns jobId", async () => {
    const res = await request(app).post("/jobs/backfill-metrics")
      .send({ dateFrom: "2026-01-01", dateTo: "2026-03-01" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.jobId).toBe("job-backfill-1");
    expect(queueMetricsBackfill).toHaveBeenCalledWith(WS_ID, "2026-01-01", "2026-03-01");
  });

  it("queues without dates (uses defaults)", async () => {
    const res = await request(app).post("/jobs/backfill-metrics").send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(queueMetricsBackfill).toHaveBeenCalled();
  });
});
