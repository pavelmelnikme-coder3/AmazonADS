"use strict";
const request = require("supertest");
const express = require("express");

const WS_ID  = "ws---0001-0000-0000-000000000001";
const ORG_ID = "org--0001-0000-0000-000000000001";
const USER_ID = "user-0001-0000-0000-000000000001";

const SAMPLE_REPORT = {
  id: "rep--0001-0000-0000-000000000001",
  campaign_type: "SP", report_type: "campaign",
  date_start: "2026-04-01", date_end: "2026-04-07",
  status: "completed", row_count: 150,
  triggered_by: "ui", created_at: "2026-04-08T00:00:00.000Z",
  completed_at: "2026-04-08T00:05:00.000Z", error_message: null,
};

jest.mock("../src/db/pool", () => ({ query: jest.fn() }));
jest.mock("../src/jobs/workers", () => ({
  queueReportPipeline: jest.fn().mockResolvedValue({ id: "job-rep-1" }),
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
const { queueReportPipeline } = require("../src/jobs/workers");
const reportsRouter = require("../src/routes/reports");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/reports", reportsRouter);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  return app;
}

function resetMocks() {
  jest.resetAllMocks();
  queueReportPipeline.mockResolvedValue({ id: "job-rep-1" });
}

describe("GET /reports", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("returns report list with pagination", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [SAMPLE_REPORT] })
      .mockResolvedValueOnce({ rows: [{ total: "1" }] });
    const res = await request(app).get("/reports");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(1);
    expect(res.body.data[0].campaign_type).toBe("SP");
  });

  it("returns empty list when no reports", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    const res = await request(app).get("/reports");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(0);
  });

  it("passes workspace_id to query", async () => {
    dbQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ total: "0" }] });
    await request(app).get("/reports");
    const params = dbQuery.mock.calls[0][1];
    expect(params).toContain(WS_ID);
  });
});

describe("POST /reports", () => {
  let app;
  beforeEach(() => { app = buildApp(); resetMocks(); });

  it("queues report pipeline and returns 202", async () => {
    const res = await request(app).post("/reports")
      .send({ profileId: "prof-001", startDate: "2026-04-01", endDate: "2026-04-07" });
    expect(res.status).toBe(202);
    expect(res.body.jobId).toBe("job-rep-1");
    expect(queueReportPipeline).toHaveBeenCalled();
  });

  it("returns 400 when profileId missing", async () => {
    const res = await request(app).post("/reports")
      .send({ startDate: "2026-04-01", endDate: "2026-04-07" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when startDate missing", async () => {
    const res = await request(app).post("/reports")
      .send({ profileId: "prof-001", endDate: "2026-04-07" });
    expect(res.status).toBe(400);
  });

  it("returns 400 when endDate missing", async () => {
    const res = await request(app).post("/reports")
      .send({ profileId: "prof-001", startDate: "2026-04-01" });
    expect(res.status).toBe(400);
  });

  it("uses default campaignType=SP when not provided", async () => {
    await request(app).post("/reports")
      .send({ profileId: "prof-001", startDate: "2026-04-01", endDate: "2026-04-07" });
    expect(queueReportPipeline).toHaveBeenCalledWith(
      "prof-001", "SP", expect.any(String), "2026-04-01", "2026-04-07"
    );
  });
});
