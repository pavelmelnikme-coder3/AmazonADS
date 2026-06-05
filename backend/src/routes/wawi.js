/**
 * JTL-Wawi routes — READ-ONLY ERP data (status, sync trigger, and read/joined views).
 * No endpoint here writes to Wawi; the sync only ingests.
 */
const express = require("express");
const router = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const { queueWawiSync } = require("../jobs/workers");
const { getConnection, wawiInfo } = require("../services/wawi/client");
const logger = require("../config/logger");

router.use(requireAuth, requireWorkspace);

// GET /wawi/status — connection, live reachability, sync cursors + row counts.
router.get("/status", async (req, res, next) => {
  try {
    const ws = req.workspaceId;
    const { rows: conns } = await query(
      `SELECT id, base_url, app_id, api_version, wawi_version, status, last_sync_at, error_count, last_error, created_at
         FROM wawi_connections WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1`, [ws]);
    const connection = conns[0] || null;

    let reachable = null, liveVersion = null;
    if (connection) {
      const c = await getConnection(ws);
      if (c) { try { const info = await wawiInfo(c); reachable = true; liveVersion = info?.Version || null; } catch { reachable = false; } }
    }
    const { rows: syncState } = await query(`SELECT entity, cursor_value, last_run_at, last_status, rows_synced, last_error FROM wawi_sync_state WHERE workspace_id=$1 ORDER BY entity`, [ws]);
    const { rows: counts } = await query(
      `SELECT
         (SELECT count(*) FROM wawi_items            WHERE workspace_id=$1) AS items,
         (SELECT count(*) FROM wawi_item_asins       WHERE workspace_id=$1 AND product_id IS NOT NULL) AS matched_asins,
         (SELECT count(*) FROM wawi_item_asins       WHERE workspace_id=$1) AS total_asins,
         (SELECT count(*) FROM wawi_stocks           WHERE workspace_id=$1) AS stock_rows,
         (SELECT count(*) FROM wawi_sales_orders     WHERE workspace_id=$1) AS orders,
         (SELECT count(*) FROM wawi_sales_order_items WHERE workspace_id=$1) AS order_items,
         (SELECT count(*) FROM wawi_customers        WHERE workspace_id=$1) AS customers,
         (SELECT count(*) FROM wawi_warehouses       WHERE workspace_id=$1) AS warehouses`, [ws]);

    res.json({ connection, reachable, liveVersion, syncState, counts: counts[0] || {} });
  } catch (err) { next(err); }
});

// POST /wawi/sync — enqueue a (read-only) ingest. ?full=true forces a from-scratch pull.
router.post("/sync", async (req, res, next) => {
  try {
    const conn = await getConnection(req.workspaceId);
    if (!conn) return res.status(400).json({ error: "No active Wawi connection" });
    const full = req.body?.full === true || req.query.full === "true";
    const job = await queueWawiSync(req.workspaceId, { full });
    logger.info("Wawi sync queued", { workspaceId: req.workspaceId, full, jobId: job.id });
    res.json({ ok: true, jobId: job.id, full, message: "Wawi sync queued" });
  } catch (err) { next(err); }
});

// GET /wawi/items — Wawi catalog with cost, identifiers, stock and the Amazon match.
router.get("/items", async (req, res, next) => {
  try {
    const ws = req.workspaceId;
    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit) || 100));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const q = (req.query.q || "").trim();
    const matchedOnly = req.query.matched === "true";

    const where = ["i.workspace_id = $1"]; const params = [ws];
    if (q) { params.push(`%${q}%`); where.push(`(i.name ILIKE $${params.length} OR i.sku ILIKE $${params.length} OR i.gtin ILIKE $${params.length})`); }
    if (matchedOnly) where.push(`EXISTS (SELECT 1 FROM wawi_item_asins a WHERE a.workspace_id=i.workspace_id AND a.wawi_item_id=i.wawi_id AND a.product_id IS NOT NULL)`);

    const { rows } = await query(
      `SELECT i.wawi_id, i.sku, i.name, i.gtin, i.amazon_fnsku, i.is_active, i.parent_item_id,
              i.purchase_price_net, i.sales_price_net, i.amazon_price, i.asins,
              COALESCE((SELECT SUM(s.quantity_total) FROM wawi_stocks s WHERE s.workspace_id=i.workspace_id AND s.wawi_item_id=i.wawi_id),0) AS stock_total,
              COALESCE((SELECT SUM(s.quantity_total - s.qty_locked_shipment - s.qty_locked_avail) FROM wawi_stocks s WHERE s.workspace_id=i.workspace_id AND s.wawi_item_id=i.wawi_id),0) AS stock_available,
              (SELECT json_agg(json_build_object('asin', a.asin, 'product_id', a.product_id)) FROM wawi_item_asins a WHERE a.workspace_id=i.workspace_id AND a.wawi_item_id=i.wawi_id) AS asin_links
         FROM wawi_items i
        WHERE ${where.join(" AND ")}
        ORDER BY i.name NULLS LAST
        LIMIT ${limit} OFFSET ${offset}`, params);
    res.json({ items: rows, limit, offset });
  } catch (err) { next(err); }
});

// GET /wawi/matched — the Amazon↔Wawi bridge by ASIN: cost/margin, real stock,
// all-channel orders (Wawi) — a NEW source alongside the Amazon SP/ad data.
router.get("/matched", async (req, res, next) => {
  try {
    const ws = req.workspaceId;
    const days = Math.min(365, Math.max(1, parseInt(req.query.days) || 30));
    const { rows } = await query(
      `SELECT p.asin, p.title, p.image_url, p.brand,
              i.wawi_id, i.sku, i.purchase_price_net AS cost, i.sales_price_net, i.amazon_price,
              COALESCE(st.stock_total,0)     AS wawi_stock_total,
              COALESCE(st.stock_available,0) AS wawi_stock_available,
              COALESCE(o.orders_all_channel,0) AS wawi_orders_all_channel,
              COALESCE(o.units_all_channel,0)  AS wawi_units_all_channel
         FROM wawi_item_asins a
         JOIN products p   ON p.id = a.product_id
         JOIN wawi_items i ON i.workspace_id = a.workspace_id AND i.wawi_id = a.wawi_item_id
         LEFT JOIN LATERAL (
           SELECT SUM(s.quantity_total) AS stock_total,
                  SUM(s.quantity_total - s.qty_locked_shipment - s.qty_locked_avail) AS stock_available
             FROM wawi_stocks s WHERE s.workspace_id=a.workspace_id AND s.wawi_item_id=a.wawi_item_id) st ON true
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT so.wawi_id) AS orders_all_channel, COALESCE(SUM(li.quantity),0) AS units_all_channel
             FROM wawi_sales_order_items li
             JOIN wawi_sales_orders so ON so.workspace_id=li.workspace_id AND so.wawi_id=li.order_wawi_id
            WHERE li.workspace_id=a.workspace_id AND li.wawi_item_id=a.wawi_item_id
              AND so.is_cancelled=false AND so.order_date >= NOW() - make_interval(days => $2)) o ON true
        WHERE a.workspace_id = $1 AND a.product_id IS NOT NULL
        ORDER BY wawi_orders_all_channel DESC NULLS LAST
        LIMIT 1000`, [ws, days]);
    res.json({ matched: rows, window_days: days });
  } catch (err) { next(err); }
});

module.exports = router;
