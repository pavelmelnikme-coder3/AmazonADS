const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireWorkspace } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireWorkspace);

// GET /rules
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT * FROM rules WHERE workspace_id = $1 ORDER BY created_at DESC",
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /rules/:id
router.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT * FROM rules WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    if (!rows.length) return res.status(404).json({ error: "Rule not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

// POST /rules
router.post("/", async (req, res, next) => {
  try {
    const { name, conditions, actions, schedule_type = "daily", safety, dry_run = false } = req.body;
    if (!name || !conditions || !actions) {
      return res.status(400).json({ error: "name, conditions, actions required" });
    }
    const schedule = schedule_type === "hourly" ? "0 * * * *" : "0 8 * * *";
    const { rows: [rule] } = await query(
      `INSERT INTO rules (workspace_id, name, conditions, actions, schedule, schedule_type, safety, dry_run, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        req.workspaceId, name,
        JSON.stringify(conditions), JSON.stringify(actions),
        schedule, schedule_type,
        JSON.stringify(safety || { max_change_pct: 20, min_bid: 0.02, max_bid: 50 }),
        dry_run, req.user.id,
      ]
    );
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

// PUT /rules/:id
router.put("/:id", async (req, res, next) => {
  try {
    const { name, conditions, actions, schedule_type = "daily", safety, dry_run } = req.body;
    if (!name || !conditions || !actions) {
      return res.status(400).json({ error: "name, conditions, actions required" });
    }
    const schedule = schedule_type === "hourly" ? "0 * * * *" : "0 8 * * *";
    const { rows: [rule] } = await query(
      `UPDATE rules
       SET name=$1, conditions=$2, actions=$3, schedule=$4, schedule_type=$5, safety=$6, dry_run=$7, updated_at=NOW()
       WHERE id=$8 AND workspace_id=$9 RETURNING *`,
      [
        name, JSON.stringify(conditions), JSON.stringify(actions),
        schedule, schedule_type,
        JSON.stringify(safety || { max_change_pct: 20, min_bid: 0.02, max_bid: 50 }),
        dry_run, req.params.id, req.workspaceId,
      ]
    );
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    res.json(rule);
  } catch (err) { next(err); }
});

// DELETE /rules/:id
router.delete("/:id", async (req, res, next) => {
  try {
    const { rowCount } = await query(
      "DELETE FROM rules WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    if (!rowCount) return res.status(404).json({ error: "Rule not found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// PATCH /rules/:id/toggle
router.patch("/:id/toggle", async (req, res, next) => {
  try {
    const { rows: [rule] } = await query(
      "UPDATE rules SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1 AND workspace_id = $2 RETURNING *",
      [req.params.id, req.workspaceId]
    );
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    res.json(rule);
  } catch (err) { next(err); }
});

module.exports = router;
