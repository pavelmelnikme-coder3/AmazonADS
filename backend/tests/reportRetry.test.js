"use strict";
/**
 * Report-pipeline retry cadence.
 *
 * Amazon's report-creation throttle is a burst window that can stay closed for many
 * minutes. createReportRequest retries in-request (15→30→60→120s), but the shared
 * defaultJobOptions backoff of 5s/10s put every job-level retry inside that same window,
 * so all attempts burned out together and the report was lost. On 2026-08-06 that cost a
 * real data gap: 2026-08-05 has no SB rows at all and only 1 of 3 SD campaigns.
 */

jest.mock("bullmq", () => ({ Queue: jest.fn(), Worker: jest.fn() }));
jest.mock("../src/config/redis", () => ({
  createRedisConnection: jest.fn(), getRedis: jest.fn(),
}));
jest.mock("../src/config/logger", () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock("../src/db/pool", () => ({ query: jest.fn() }));

const { REPORT_JOB_OPTIONS } = require("../src/jobs/workers");

describe("REPORT_JOB_OPTIONS", () => {
  it("retries on a scale that outlasts a throttle window, not seconds", () => {
    // The shared default is 5s — anything near that retries straight back into the
    // window that just rejected the request.
    expect(REPORT_JOB_OPTIONS.backoff.delay).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  it("uses exponential backoff so later retries spread further out", () => {
    expect(REPORT_JOB_OPTIONS.backoff.type).toBe("exponential");
  });

  it("allows enough attempts to survive a multi-minute window", () => {
    expect(REPORT_JOB_OPTIONS.attempts).toBeGreaterThanOrEqual(3);
  });

  it("finishes its retries well within the day, so the daily backfill is not pre-empted", () => {
    const { attempts, backoff } = REPORT_JOB_OPTIONS;
    // Exponential: delay * 2^0 + delay * 2^1 + … for (attempts - 1) retries.
    const totalMs = Array.from({ length: attempts - 1 })
      .reduce((sum, _, i) => sum + backoff.delay * 2 ** i, 0);
    expect(totalMs).toBeLessThan(12 * 60 * 60 * 1000);
  });
});

// ─── Abandoned sync-run cleanup ──────────────────────────────────────────────
//
// A sweep whose worker died leaves its sp_sync_log row 'running' with no completed_at
// forever — 22 such rows had accumulated between 2026-04-27 and 2026-07-31, because
// nothing ever reconciled them. Worker startup is when the previous process's in-flight
// rows are known to be dead.
describe("closeAbandonedSyncRuns", () => {
  const { query } = require("../src/db/pool");
  const logger = require("../src/config/logger");
  const { closeAbandonedSyncRuns } = require("../src/jobs/workers");

  beforeEach(() => jest.clearAllMocks());

  it("closes only rows older than the age cut-off, never a live sweep", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await closeAbandonedSyncRuns();
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/status='running'/);
    expect(sql).toMatch(/started_at < NOW\(\) - INTERVAL '6 hours'/);
  });

  it("marks them failed with a completion time so they stop reading as live", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: "a" }, { id: "b" }] });
    await closeAbandonedSyncRuns();
    const [sql] = query.mock.calls[0];
    expect(sql).toMatch(/status='failed'/);
    expect(sql).toMatch(/completed_at=NOW\(\)/);
  });

  it("preserves an existing error_message rather than overwriting the real cause", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await closeAbandonedSyncRuns();
    expect(query.mock.calls[0][0]).toMatch(/COALESCE\(error_message/);
  });

  it("reports how many it closed", async () => {
    query.mockResolvedValueOnce({ rows: [{ id: "a" }, { id: "b" }] });
    await closeAbandonedSyncRuns();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Closed abandoned"), { count: 2 });
  });

  it("stays quiet when there is nothing to close", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await closeAbandonedSyncRuns();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("never blocks worker startup if the housekeeping query fails", async () => {
    query.mockRejectedValueOnce(new Error("db down"));
    await expect(closeAbandonedSyncRuns()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not close"), expect.objectContaining({ error: "db down" }));
  });
});
