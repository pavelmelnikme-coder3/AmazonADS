const express = require("express");
const router  = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { getQueue, QUEUES, queueMetricsBackfill } = require("../jobs/workers");

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
