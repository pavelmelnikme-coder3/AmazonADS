const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireWorkspace } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireWorkspace);

// ─── Alert Config CRUD ────────────────────────────────────────────────────────

// GET /alerts/configs
router.get("/configs", async (req, res, next) => {
  try {
    const VALID_LIMITS = [10, 25, 50, 100];
    const rawLimit = parseInt(req.query.limit);
    const limit = VALID_LIMITS.includes(rawLimit) ? rawLimit : 25;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const offset = (page - 1) * limit;

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        "SELECT * FROM alert_configs WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
        [req.workspaceId, limit, offset]
      ),
      query("SELECT COUNT(*) as total FROM alert_configs WHERE workspace_id = $1", [req.workspaceId]),
    ]);

    const total = parseInt(countRows[0].total);
    res.json({
      data: rows,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
});

// POST /alerts/configs
router.post("/configs", async (req, res, next) => {
  try {
    const { name, metric, operator, value, channels = { in_app: true }, cooldown_hours = 24 } = req.body;
    if (!name || !metric || !operator || value === undefined) {
      return res.status(400).json({ error: "name, metric, operator, value required" });
    }
    const conditions = { metric, operator, value };
    const { rows: [config] } = await query(
      `INSERT INTO alert_configs (workspace_id, name, alert_type, conditions, channels, suppression_hours)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.workspaceId, name, metric, JSON.stringify(conditions), JSON.stringify(channels), cooldown_hours]
    );
    res.status(201).json(config);
  } catch (err) { next(err); }
});

// PUT /alerts/configs/:id
router.put("/configs/:id", async (req, res, next) => {
  try {
    const { name, metric, operator, value, channels, cooldown_hours } = req.body;
    if (!name || !metric || !operator || value === undefined) {
      return res.status(400).json({ error: "name, metric, operator, value required" });
    }
    const conditions = { metric, operator, value };
    const { rows: [config] } = await query(
      `UPDATE alert_configs
       SET name=$1, alert_type=$2, conditions=$3, channels=$4, suppression_hours=$5, updated_at=NOW()
       WHERE id=$6 AND workspace_id=$7 RETURNING *`,
      [name, metric, JSON.stringify(conditions), JSON.stringify(channels || { in_app: true }), cooldown_hours || 24, req.params.id, req.workspaceId]
    );
    if (!config) return res.status(404).json({ error: "Alert config not found" });
    res.json(config);
  } catch (err) { next(err); }
});

// DELETE /alerts/configs/:id
router.delete("/configs/:id", async (req, res, next) => {
  try {
    const { rowCount } = await query(
      "DELETE FROM alert_configs WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    if (!rowCount) return res.status(404).json({ error: "Alert config not found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PATCH /alerts/configs/:id/toggle
router.patch("/configs/:id/toggle", async (req, res, next) => {
  try {
    const { rows: [config] } = await query(
      "UPDATE alert_configs SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1 AND workspace_id = $2 RETURNING *",
      [req.params.id, req.workspaceId]
    );
    if (!config) return res.status(404).json({ error: "Alert config not found" });
    res.json(config);
  } catch (err) { next(err); }
});

// ─── Alert Instances ──────────────────────────────────────────────────────────

// GET /alerts
router.get("/", async (req, res, next) => {
  try {
    const VALID_LIMITS = [10, 25, 50, 100];
    const rawLimit = parseInt(req.query.limit);
    const limit = VALID_LIMITS.includes(rawLimit) ? rawLimit : 25;
    const { status = "open", page: pageParam = 1 } = req.query;
    const page = Math.max(1, parseInt(pageParam));
    const offset = (page - 1) * limit;

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT ai.*, ac.name as config_name FROM alert_instances ai
         LEFT JOIN alert_configs ac ON ac.id = ai.config_id
         WHERE ai.workspace_id = $1 AND ai.status = $2
         ORDER BY ai.created_at DESC LIMIT $3 OFFSET $4`,
        [req.workspaceId, status, limit, offset]
      ),
      query(
        "SELECT COUNT(*) as total FROM alert_instances WHERE workspace_id = $1 AND status = $2",
        [req.workspaceId, status]
      ),
    ]);

    const total = parseInt(countRows[0].total);
    res.json({
      data: rows,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) { next(err); }
});

// PATCH /alerts/:id/acknowledge
router.patch("/:id/acknowledge", async (req, res, next) => {
  try {
    await query(
      "UPDATE alert_instances SET status = 'acknowledged' WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
