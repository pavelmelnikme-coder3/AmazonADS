// Stub routes - to be expanded in next sprint
const express = require("express");
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const { queueReportPipeline } = require("../jobs/workers");

// ─── Ad Groups ────────────────────────────────────────────────────────────────
const adGroupsRouter = express.Router();
adGroupsRouter.use(requireAuth, requireWorkspace);

adGroupsRouter.get("/", async (req, res, next) => {
  try {
    const { campaignId, limit = 100, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const cond = campaignId ? "AND ag.campaign_id = $3" : "";
    const params = campaignId ? [req.workspaceId, offset, campaignId] : [req.workspaceId, offset];
    const { rows } = await query(
      `SELECT ag.*, c.name as campaign_name FROM ad_groups ag
       JOIN campaigns c ON c.id = ag.campaign_id
       WHERE ag.workspace_id = $1 ${cond}
       ORDER BY ag.name LIMIT ${parseInt(limit)} OFFSET $2`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── Keywords ────────────────────────────────────────────────────────────────
const keywordsRouter = express.Router();
keywordsRouter.use(requireAuth, requireWorkspace);

keywordsRouter.get("/", async (req, res, next) => {
  try {
    const { campaignId, adGroupId, state, search, limit = 200, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = ["k.workspace_id = $1"];
    const params = [req.workspaceId];
    let pi = 2;
    if (campaignId) { conditions.push(`k.campaign_id = $${pi++}`); params.push(campaignId); }
    if (adGroupId)  { conditions.push(`k.ad_group_id = $${pi++}`); params.push(adGroupId); }
    if (state)      { conditions.push(`k.state = $${pi++}`);       params.push(state); }
    if (search)     { conditions.push(`k.keyword_text ILIKE $${pi++}`); params.push(`%${search}%`); }
    const where = "WHERE " + conditions.join(" AND ");

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT k.*, c.name as campaign_name, c.campaign_type
         FROM keywords k
         JOIN campaigns c ON c.id = k.campaign_id
         ${where}
         ORDER BY k.keyword_text
         LIMIT ${parseInt(limit)} OFFSET $${pi}`,
        [...params, offset]
      ),
      query(
        `SELECT COUNT(*) as total FROM keywords k ${where}`,
        params
      ),
    ]);

    res.json({ data: rows, total: parseInt(countRows[0].total), page: parseInt(page), limit: parseInt(limit) });
  } catch (err) { next(err); }
});

// PATCH /keywords/bulk - update bids
keywordsRouter.patch("/bulk", async (req, res, next) => {
  try {
    const { updates } = req.body; // [{id, bid}]
    if (!updates?.length) return res.status(400).json({ error: "updates required" });
    for (const { id, bid } of updates) {
      await query(
        "UPDATE keywords SET bid = $1, updated_at = NOW() WHERE id = $2 AND workspace_id = $3",
        [bid, id, req.workspaceId]
      );
    }
    res.json({ updated: updates.length });
  } catch (err) { next(err); }
});

// ─── Reports ─────────────────────────────────────────────────────────────────
const reportsRouter = express.Router();
reportsRouter.use(requireAuth, requireWorkspace);

reportsRouter.get("/", async (req, res, next) => {
  try {
    const VALID_LIMITS = [25, 50, 100];
    const rawLimit = parseInt(req.query.limit);
    const limit = VALID_LIMITS.includes(rawLimit) ? rawLimit : 50;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const offset = (page - 1) * limit;

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT id, campaign_type, report_type, date_start, date_end,
                status, row_count, triggered_by, created_at, completed_at, error_message
         FROM report_requests WHERE workspace_id = $1
         ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [req.workspaceId, limit, offset]
      ),
      query("SELECT COUNT(*) as total FROM report_requests WHERE workspace_id = $1", [req.workspaceId]),
    ]);

    const total = parseInt(countRows[0].total);
    res.json({
      data: rows,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
});

reportsRouter.post("/", async (req, res, next) => {
  try {
    const { profileId, campaignType = "SP", reportLevel = "campaign", startDate, endDate } = req.body;
    if (!profileId || !startDate || !endDate) {
      return res.status(400).json({ error: "profileId, startDate, endDate required" });
    }
    const job = await queueReportPipeline(profileId, campaignType, reportLevel, startDate, endDate);
    res.status(202).json({ message: "Report queued", jobId: job.id });
  } catch (err) { next(err); }
});

// ─── Rules ───────────────────────────────────────────────────────────────────
const rulesRouter = express.Router();
rulesRouter.use(requireAuth, requireWorkspace);

rulesRouter.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT * FROM rules WHERE workspace_id = $1 ORDER BY created_at DESC",
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

rulesRouter.post("/", async (req, res, next) => {
  try {
    const { name, conditions, actions, schedule, safety, dryRun } = req.body;
    const { rows: [rule] } = await query(
      `INSERT INTO rules (workspace_id, name, conditions, actions, schedule, safety, dry_run, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.workspaceId, name, JSON.stringify(conditions), JSON.stringify(actions), schedule || "0 8 * * *",
       JSON.stringify(safety || { max_change_pct: 20, min_bid: 0.02, max_bid: 50 }), dryRun || false, req.user.id]
    );
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

// ─── Alerts ──────────────────────────────────────────────────────────────────
const alertsRouter = express.Router();
alertsRouter.use(requireAuth, requireWorkspace);

alertsRouter.get("/", async (req, res, next) => {
  try {
    const { status = "open" } = req.query;
    const { rows } = await query(
      `SELECT ai.*, ac.name as config_name FROM alert_instances ai
       LEFT JOIN alert_configs ac ON ac.id = ai.config_id
       WHERE ai.workspace_id = $1 AND ai.status = $2
       ORDER BY ai.created_at DESC LIMIT 50`,
      [req.workspaceId, status]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

alertsRouter.patch("/:id/acknowledge", async (req, res, next) => {
  try {
    await query(
      "UPDATE alert_instances SET status = 'acknowledged' WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── AI ──────────────────────────────────────────────────────────────────────
const aiRouter = express.Router();
aiRouter.use(requireAuth, requireWorkspace);

aiRouter.get("/recommendations", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT * FROM ai_recommendations
       WHERE workspace_id = $1 AND status = 'pending' AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 20`,
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

aiRouter.post("/recommendations/generate", async (req, res, next) => {
  // TODO: Connect to AI Orchestrator
  res.status(202).json({ message: "AI analysis queued", estimatedSeconds: 30 });
});

aiRouter.post("/recommendations/:id/apply", async (req, res, next) => {
  try {
    const { rows: [rec] } = await query(
      "SELECT * FROM ai_recommendations WHERE id = $1 AND workspace_id = $2 AND status = 'pending'",
      [req.params.id, req.workspaceId]
    );
    if (!rec) return res.status(404).json({ error: "Recommendation not found" });
    await query(
      "UPDATE ai_recommendations SET status = 'applied', applied_at = NOW(), applied_by = $1 WHERE id = $2",
      [req.user.id, req.params.id]
    );
    res.json({ message: "Recommendation applied", recommendation: rec });
  } catch (err) { next(err); }
});

aiRouter.post("/recommendations/:id/dismiss", async (req, res, next) => {
  try {
    await query(
      "UPDATE ai_recommendations SET status = 'dismissed', dismissed_at = NOW() WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Jobs status ─────────────────────────────────────────────────────────────
const jobsRouter = express.Router();
jobsRouter.use(requireAuth);

jobsRouter.get("/", async (req, res, next) => {
  try {
    const { getQueue, QUEUES } = require("../jobs/workers");
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

module.exports = {
  adGroupsRouter,
  keywordsRouter,
  reportsRouter,
  rulesRouter,
  alertsRouter,
  aiRouter,
  jobsRouter,
};
