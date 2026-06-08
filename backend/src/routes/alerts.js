const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { evaluateWorkspaceAlerts } = require("../services/alerts/evaluate");

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
// Build { alertType, conditions } from a request body, validating per alert type.
// Returns { error } on validation failure.
function buildAlertConfig(body) {
  if (body.alert_type === "product_movers") {
    const ALLOWED = ["bsr", "orders", "units", "sales", "spend", "clicks", "impressions", "acos", "ctr", "cpc", "cvr", "roas", "ad_orders", "ad_sales"];
    let metrics = Array.isArray(body.metrics) ? body.metrics : null;
    // Back-compat: accept the legacy two-field payload too.
    if (!metrics) {
      metrics = [];
      if (Number(body.bsr_change_pct) > 0)    metrics.push({ metric: "bsr",    direction: "up",   change_pct: Number(body.bsr_change_pct) });
      if (Number(body.orders_change_pct) > 0) metrics.push({ metric: "orders", direction: "down", change_pct: Number(body.orders_change_pct) });
    }
    metrics = (metrics || [])
      .filter((m) => m && ALLOWED.includes(m.metric) && Number(m.change_pct) > 0)
      .map((m) => ({ metric: m.metric, direction: m.direction === "up" ? "up" : "down", change_pct: Number(m.change_pct) }));
    if (!metrics.length) {
      return { error: "Add at least one metric condition" };
    }
    const conditions = {
      window_days: Math.min(90, Math.max(1, parseInt(body.window_days) || 7)),
      match: body.match === "all" ? "all" : "any",
      min_orders_prev: Math.max(0, parseInt(body.min_orders_prev) || 0),
      // Per-product dedup: suppress an ASIN already alerted within `product_cooldown_days`
      // (0 = off) unless its worst move grew by ≥ `escalation_pct` points since.
      product_cooldown_days: Number.isFinite(parseInt(body.product_cooldown_days))
        ? Math.min(90, Math.max(0, parseInt(body.product_cooldown_days))) : 7,
      escalation_pct: Number.isFinite(Number(body.escalation_pct))
        ? Math.max(0, Number(body.escalation_pct)) : 25,
      // Thresholds for the data-derived "likely causes" surfaced on each flagged product.
      cause_price_pct: Number.isFinite(Number(body.cause_price_pct))
        ? Math.max(0, Number(body.cause_price_pct)) : 5,   // price rose ≥ this % → "price up"
      cause_ad_pct: Number.isFinite(Number(body.cause_ad_pct))
        ? Math.max(0, Number(body.cause_ad_pct)) : 50,     // ad spend fell ≥ this % → "ad cut"
      cause_low_stock: Number.isFinite(parseInt(body.cause_low_stock))
        ? Math.max(0, parseInt(body.cause_low_stock)) : 10, // stock ≤ this (but >0) → "low stock"
      metrics,
    };
    return { alertType: "product_movers", conditions };
  }
  // Single-metric threshold alert (legacy default).
  const { metric, operator, value, window_days, asin } = body;
  if (!metric || !operator || value === undefined) {
    return { error: "name, metric, operator, value required" };
  }
  if (metric === "bsr" && !asin) {
    return { error: "asin required for BSR alerts" };
  }
  return {
    alertType: metric,
    conditions: { metric, operator, value, window_days: window_days || 7, asin: asin || null },
  };
}

router.post("/configs", async (req, res, next) => {
  try {
    const { name, channels = { in_app: true }, cooldown_hours = 24 } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const built = buildAlertConfig(req.body);
    if (built.error) return res.status(400).json({ error: built.error });
    const { rows: [config] } = await query(
      `INSERT INTO alert_configs (workspace_id, name, alert_type, conditions, channels, suppression_hours)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.workspaceId, name, built.alertType, JSON.stringify(built.conditions), JSON.stringify(channels), cooldown_hours]
    );
    res.status(201).json(config);
  } catch (err) { next(err); }
});

// PUT /alerts/configs/:id
router.put("/configs/:id", async (req, res, next) => {
  try {
    const { name, channels, cooldown_hours } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const built = buildAlertConfig(req.body);
    if (built.error) return res.status(400).json({ error: built.error });
    const { rows: [config] } = await query(
      `UPDATE alert_configs
       SET name=$1, alert_type=$2, conditions=$3, channels=$4, suppression_hours=$5, updated_at=NOW()
       WHERE id=$6 AND workspace_id=$7 RETURNING *`,
      [name, built.alertType, JSON.stringify(built.conditions), JSON.stringify(channels || { in_app: true }), cooldown_hours || 24, req.params.id, req.workspaceId]
    );
    if (!config) return res.status(404).json({ error: "Alert config not found" });
    res.json(config);
  } catch (err) { next(err); }
});

// DELETE /alerts/configs/:id — soft delete to trash
router.delete("/configs/:id", async (req, res, next) => {
  try {
    const { rows: [alert] } = await query(
      "SELECT * FROM alert_configs WHERE id=$1 AND workspace_id=$2",
      [req.params.id, req.workspaceId]
    );
    if (!alert) return res.status(404).json({ error: "Alert config not found" });
    await query(
      `INSERT INTO trash (workspace_id, entity_type, entity_id, entity_name, data, deleted_by)
       VALUES ($1, 'alert', $2, $3, $4::jsonb, $5)`,
      [req.workspaceId, alert.id, alert.name, JSON.stringify(alert), req.user?.id ?? null]
    );
    await query("DELETE FROM alert_configs WHERE id=$1 AND workspace_id=$2", [req.params.id, req.workspaceId]);
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

// POST /alerts/check — evaluate all active alerts for this workspace now (manual run / test)
router.post("/check", async (req, res, next) => {
  try {
    const { rows: [ws] } = await query("SELECT name FROM workspaces WHERE id = $1", [req.workspaceId]);
    const result = await evaluateWorkspaceAlerts(req.workspaceId, { workspaceName: ws?.name || null });
    res.json(result);
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
