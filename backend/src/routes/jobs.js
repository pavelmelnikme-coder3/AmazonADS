const express = require("express");
const router  = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { getQueue, QUEUES, queueMetricsBackfill } = require("../jobs/workers");
const { query } = require("../db/pool");

// ── GET /jobs/progress — active job progress for workspace (for progress bar) ─
router.get("/progress", requireAuth, requireWorkspace, async (req, res, next) => {
  try {
    const syncQueue   = getQueue(QUEUES.ENTITY_SYNC);
    const reportQueue = getQueue(QUEUES.REPORT);

    const [syncActive, reportActive] = await Promise.all([
      syncQueue.getActive(),
      reportQueue.getActive(),
    ]);

    const jobs = [];

    for (const job of syncActive) {
      if (!job.data?.profileId) continue;
      const { rows } = await query(
        "SELECT workspace_id FROM amazon_profiles WHERE id = $1",
        [job.data.profileId]
      );
      if (!rows[0] || rows[0].workspace_id !== req.workspaceId) continue;
      jobs.push({
        id: job.id,
        type: "entity_sync",
        label: `Sync ${job.data.entityTypes?.join(", ") || "entities"}`,
        progress: typeof job.progress === "number" ? job.progress : 0,
        startedAt: job.processedOn,
      });
    }

    for (const job of reportActive) {
      if (!job.data?.profileId) continue;
      const { rows } = await query(
        "SELECT workspace_id FROM amazon_profiles WHERE id = $1",
        [job.data.profileId]
      );
      if (!rows[0] || rows[0].workspace_id !== req.workspaceId) continue;
      jobs.push({
        id: job.id,
        type: "report",
        label: `Report ${job.data.campaignType}/${job.data.reportLevel}`,
        progress: typeof job.progress === "number" ? job.progress : 0,
        startedAt: job.processedOn,
      });
    }

    const [syncCounts, reportCounts, backfillCounts] = await Promise.all([
      syncQueue.getJobCounts("active", "waiting"),
      reportQueue.getJobCounts("active", "waiting"),
      getQueue(QUEUES.METRICS_BACKFILL).getJobCounts("active", "waiting"),
    ]);

    res.json({
      active: jobs,
      queued: {
        sync:    (syncCounts.active || 0) + (syncCounts.waiting || 0),
        report:  (reportCounts.active || 0) + (reportCounts.waiting || 0),
        backfill:(backfillCounts.active || 0) + (backfillCounts.waiting || 0),
      }
    });
  } catch (err) { next(err); }
});

// ── GET /jobs — queue stats ───────────────────────────────────────────────────
router.get("/", requireAuth, async (req, res, next) => {
  try {
    const results = {};
    for (const [name, queueName] of Object.entries(QUEUES)) {
      const q = getQueue(queueName);
      const [active, waiting, completed, failed] = await Promise.all([
        q.getActiveCount(), q.getWaitingCount(), q.getCompletedCount(), q.getFailedCount()
      ]);
      results[name] = { active, waiting, completed, failed };
    }
    res.json(results);
  } catch (err) { next(err); }
});

// ── POST /jobs/backfill-metrics — trigger historical metrics backfill ─────────
router.post("/backfill-metrics", requireAuth, requireWorkspace, async (req, res, next) => {
  try {
    const { dateFrom, dateTo } = req.body;
    const job = await queueMetricsBackfill(req.workspaceId, dateFrom, dateTo);
    res.json({
      ok: true,
      message: "Metrics backfill queued — this will take 10-30 minutes",
      jobId: job.id,
      dateFrom: dateFrom || "last 60 days",
      dateTo:   dateTo   || "yesterday",
    });
  } catch (err) { next(err); }
});

module.exports = router;
