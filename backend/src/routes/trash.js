/**
 * Trash (soft-delete recycle bin)
 * GET    /trash              — list items (optional ?type=rule)
 * POST   /trash/:id/restore  — restore item back to its table
 * DELETE /trash/:id          — permanent delete
 */

const express = require("express");
const router  = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");

router.use(requireAuth, requireWorkspace);

// ── List ─────────────────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { type } = req.query;
    const params = [req.workspaceId];
    let filter = "";
    if (type) { filter = ` AND entity_type = $2`; params.push(type); }

    const { rows } = await query(
      `SELECT id, entity_type, entity_id, entity_name, deleted_by,
              deleted_at, expires_at,
              EXTRACT(DAY FROM (expires_at - NOW()))::int AS days_left,
              (SELECT name FROM users WHERE id = t.deleted_by) AS deleted_by_name
       FROM trash t
       WHERE workspace_id = $1${filter}
         AND expires_at > NOW()
       ORDER BY deleted_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── Restore ───────────────────────────────────────────────────────────────────
router.post("/:id/restore", async (req, res, next) => {
  try {
    const { rows: [item] } = await query(
      "SELECT * FROM trash WHERE id=$1 AND workspace_id=$2 AND expires_at > NOW()",
      [req.params.id, req.workspaceId]
    );
    if (!item) return res.status(404).json({ error: "Item not found in trash" });

    const RESTORERS = {
      rule:     restoreRule,
      alert:    restoreAlert,
      strategy: restoreStrategy,
    };

    const restorer = RESTORERS[item.entity_type];
    if (!restorer) return res.status(400).json({ error: `Restore not supported for type: ${item.entity_type}` });

    await restorer(item, req.workspaceId);
    await query("DELETE FROM trash WHERE id=$1", [item.id]);

    res.json({ ok: true, entity_type: item.entity_type, entity_name: item.entity_name });
  } catch (err) { next(err); }
});

// ── Permanent delete ──────────────────────────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    const { rowCount } = await query(
      "DELETE FROM trash WHERE id=$1 AND workspace_id=$2",
      [req.params.id, req.workspaceId]
    );
    if (!rowCount) return res.status(404).json({ error: "Not found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Restore implementations ───────────────────────────────────────────────────
async function restoreAlert(item, workspaceId) {
  const d = item.data;
  const { rows: existing } = await query("SELECT id FROM alert_configs WHERE id=$1", [d.id]);
  if (existing.length) {
    await query(
      `INSERT INTO alert_configs (workspace_id, name, alert_type, conditions, channels, suppression_hours, is_active)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
      [workspaceId, d.name, d.alert_type, JSON.stringify(d.conditions),
       JSON.stringify(d.channels), d.suppression_hours ?? 24, d.is_active ?? true]
    );
  } else {
    await query(
      `INSERT INTO alert_configs (id, workspace_id, name, alert_type, conditions, channels, suppression_hours, is_active, created_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)`,
      [d.id, workspaceId, d.name, d.alert_type, JSON.stringify(d.conditions),
       JSON.stringify(d.channels), d.suppression_hours ?? 24, d.is_active ?? true, d.created_at]
    );
  }
}

async function restoreStrategy(item, workspaceId) {
  const d = item.data;
  const { rows: existing } = await query("SELECT id FROM strategies WHERE id=$1", [d.id]);
  if (existing.length) {
    await query(
      `INSERT INTO strategies (workspace_id, name, description, rule_ids, is_active)
       VALUES ($1,$2,$3,$4::uuid[],$5)`,
      [workspaceId, d.name, d.description, d.rule_ids ?? [], d.is_active ?? true]
    );
  } else {
    await query(
      `INSERT INTO strategies (id, workspace_id, name, description, rule_ids, is_active, created_at)
       VALUES ($1,$2,$3,$4,$5::uuid[],$6,$7)`,
      [d.id, workspaceId, d.name, d.description, d.rule_ids ?? [], d.is_active ?? true, d.created_at]
    );
  }
}

async function restoreRule(item, workspaceId) {
  const d = item.data;
  // Check if rule ID already exists (edge case: re-created manually)
  const { rows: existing } = await query("SELECT id FROM rules WHERE id=$1", [d.id]);
  if (existing.length) {
    // Insert with a new ID to avoid conflict
    await query(
      `INSERT INTO rules
         (workspace_id, name, description, is_active, conditions, actions, scope, safety,
          schedule, schedule_type, run_hour, priority, sort_order, dry_run, run_count, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [workspaceId, d.name, d.description, d.is_active,
       JSON.stringify(d.conditions), JSON.stringify(d.actions),
       JSON.stringify(d.scope), JSON.stringify(d.safety),
       d.schedule, d.schedule_type, d.run_hour, d.priority, d.sort_order,
       d.dry_run ?? false, 0, d.created_by]
    );
  } else {
    await query(
      `INSERT INTO rules
         (id, workspace_id, name, description, is_active, conditions, actions, scope, safety,
          schedule, schedule_type, run_hour, priority, sort_order, dry_run, run_count, created_by, created_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [d.id, workspaceId, d.name, d.description, d.is_active,
       JSON.stringify(d.conditions), JSON.stringify(d.actions),
       JSON.stringify(d.scope), JSON.stringify(d.safety),
       d.schedule, d.schedule_type, d.run_hour, d.priority, d.sort_order,
       d.dry_run ?? false, 0, d.created_by, d.created_at]
    );
  }
}

module.exports = router;
