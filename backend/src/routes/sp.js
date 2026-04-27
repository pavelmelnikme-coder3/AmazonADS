const express = require("express");
const router = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const { queueSpSync } = require("../jobs/workers");
const logger = require("../config/logger");

router.use(requireAuth, requireWorkspace);

const VALID_SYNC_TYPES = ["bsr", "inventory", "orders", "financials", "pricing"];

// ─── Inventory ────────────────────────────────────────────────────────────────
router.get("/inventory", async (req, res, next) => {
  try {
    const wid = req.workspace.id;
    const { marketplaceId, asin, fulfillmentChannel, limit = 100, offset = 0 } = req.query;
    let q = `SELECT * FROM sp_inventory WHERE workspace_id=$1`;
    const params = [wid];
    if (marketplaceId) { params.push(marketplaceId); q += ` AND marketplace_id=$${params.length}`; }
    if (asin)          { params.push(asin);          q += ` AND asin=$${params.length}`; }
    if (fulfillmentChannel) { params.push(fulfillmentChannel); q += ` AND fulfillment_channel=$${params.length}`; }
    q += ` ORDER BY synced_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), parseInt(offset));
    const { rows } = await query(q, params);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/inventory/summary", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT i.asin, i.marketplace_id, i.fulfillment_channel,
              i.quantity_sellable, i.quantity_reserved, i.quantity_total,
              i.inbound_working, i.inbound_shipped, i.inbound_receiving,
              i.synced_at, p.title, p.brand, p.image_url
       FROM sp_inventory i
       LEFT JOIN products p ON p.workspace_id = i.workspace_id
         AND p.asin = i.asin AND p.marketplace_id = i.marketplace_id
       WHERE i.workspace_id = $1
       ORDER BY i.asin, i.fulfillment_channel`,
      [req.workspace.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── Orders ───────────────────────────────────────────────────────────────────
router.get("/orders", async (req, res, next) => {
  try {
    const wid = req.workspace.id;
    const { startDate, endDate, status, fulfillmentChannel, page = 1, limit = 50 } = req.query;
    let q = `SELECT o.*, COUNT(*) OVER() AS total_count FROM sp_orders o WHERE o.workspace_id=$1`;
    const params = [wid];
    // Cast to ::date so a date literal like "2026-04-22" matches the entire
    // day, not only the midnight instant — purchase_date is timestamptz.
    if (startDate) { params.push(startDate); q += ` AND o.purchase_date::date >= $${params.length}::date`; }
    if (endDate)   { params.push(endDate);   q += ` AND o.purchase_date::date <= $${params.length}::date`; }
    if (status)    { params.push(status);    q += ` AND o.order_status = $${params.length}`; }
    if (fulfillmentChannel) { params.push(fulfillmentChannel); q += ` AND o.fulfillment_channel = $${params.length}`; }
    const offset = (parseInt(page) - 1) * parseInt(limit);
    q += ` ORDER BY o.purchase_date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), offset);
    const { rows } = await query(q, params);
    const total = rows[0]?.total_count || 0;
    res.json({ data: rows.map(r => { delete r.total_count; return r; }), pagination: { total: parseInt(total), page: parseInt(page), limit: parseInt(limit) } });
  } catch (err) { next(err); }
});

router.get("/orders/summary", async (req, res, next) => {
  try {
    const { startDate, endDate, groupBy = "day" } = req.query;
    const trunc = groupBy === "month" ? "month" : groupBy === "week" ? "week" : "day";
    const { rows } = await query(
      `SELECT
         DATE_TRUNC($1, purchase_date) AS period,
         COUNT(*) AS orders,
         SUM(order_total_amount) AS revenue,
         AVG(order_total_amount) AS avg_order_value,
         COUNT(*) FILTER (WHERE is_prime) AS prime_orders,
         COUNT(*) FILTER (WHERE is_business_order) AS business_orders,
         COUNT(*) FILTER (WHERE fulfillment_channel = 'AFN') AS fba_orders,
         COUNT(*) FILTER (WHERE fulfillment_channel = 'MFN') AS fbm_orders
       FROM sp_orders
       WHERE workspace_id=$2
         AND ($3::text IS NULL OR purchase_date::date >= $3::date)
         AND ($4::text IS NULL OR purchase_date::date <= $4::date)
       GROUP BY period ORDER BY period DESC`,
      [trunc, req.workspace.id, startDate || null, endDate || null]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/orders/:orderId/items", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT i.* FROM sp_order_items i
       JOIN sp_orders o ON o.id = i.order_id
       WHERE o.amazon_order_id=$1 AND i.workspace_id=$2`,
      [req.params.orderId, req.workspace.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── Financials ───────────────────────────────────────────────────────────────
router.get("/financials", async (req, res, next) => {
  try {
    const wid = req.workspace.id;
    const { startDate, endDate, eventType, asin, page = 1, limit = 100 } = req.query;
    let q = `SELECT *, COUNT(*) OVER() AS total_count FROM sp_financials WHERE workspace_id=$1`;
    const params = [wid];
    if (startDate) { params.push(startDate); q += ` AND posted_date >= $${params.length}`; }
    if (endDate)   { params.push(endDate);   q += ` AND posted_date <= $${params.length}`; }
    if (eventType) { params.push(eventType); q += ` AND event_type = $${params.length}`; }
    if (asin)      { params.push(asin);      q += ` AND asin = $${params.length}`; }
    const offset = (parseInt(page) - 1) * parseInt(limit);
    q += ` ORDER BY posted_date DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(parseInt(limit), offset);
    const { rows } = await query(q, params);
    const total = rows[0]?.total_count || 0;
    res.json({ data: rows.map(r => { delete r.total_count; return r; }), pagination: { total: parseInt(total), page: parseInt(page), limit: parseInt(limit) } });
  } catch (err) { next(err); }
});

router.get("/financials/summary", async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const { rows } = await query(
      `SELECT event_group, event_type,
              COUNT(*) AS count,
              SUM(amount) AS total_amount,
              currency_code
       FROM sp_financials
       WHERE workspace_id=$1
         AND ($2::text IS NULL OR posted_date >= $2::timestamptz)
         AND ($3::text IS NULL OR posted_date <= $3::timestamptz)
       GROUP BY event_group, event_type, currency_code
       ORDER BY event_group, ABS(SUM(amount)) DESC`,
      [req.workspace.id, startDate || null, endDate || null]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── Pricing ──────────────────────────────────────────────────────────────────
router.get("/pricing/current", async (req, res, next) => {
  try {
    const { marketplaceId } = req.query;
    let q = `SELECT DISTINCT ON (asin) asin, marketplace_id, listing_price_amount, listing_price_currency,
               buy_box_price_amount, buy_box_price_currency, buy_box_seller_id, offers_count, captured_at
             FROM sp_pricing WHERE workspace_id=$1`;
    const params = [req.workspace.id];
    if (marketplaceId) { params.push(marketplaceId); q += ` AND marketplace_id=$${params.length}`; }
    q += " ORDER BY asin, captured_at DESC";
    const { rows } = await query(q, params);
    res.json(rows);
  } catch (err) { next(err); }
});

router.get("/pricing/:asin", async (req, res, next) => {
  try {
    const { marketplaceId, limit = 30 } = req.query;
    let q = `SELECT * FROM sp_pricing WHERE workspace_id=$1 AND asin=$2`;
    const params = [req.workspace.id, req.params.asin];
    if (marketplaceId) { params.push(marketplaceId); q += ` AND marketplace_id=$${params.length}`; }
    q += ` ORDER BY captured_at DESC LIMIT $${params.length + 1}`;
    params.push(parseInt(limit));
    const { rows } = await query(q, params);
    res.json(rows);
  } catch (err) { next(err); }
});

// ─── Manual sync trigger ──────────────────────────────────────────────────────
router.post("/sync", async (req, res, next) => {
  try {
    const { marketplaceId, syncTypes = ["bsr", "inventory", "pricing"] } = req.body;
    if (!marketplaceId) return res.status(400).json({ error: "marketplaceId required" });
    const invalid = syncTypes.filter(t => !VALID_SYNC_TYPES.includes(t));
    if (invalid.length) return res.status(400).json({ error: `Invalid sync types: ${invalid.join(", ")}` });
    if (!process.env.SP_API_REFRESH_TOKEN) return res.status(503).json({ error: "SP-API not configured" });

    const job = await queueSpSync(req.workspace.id, marketplaceId, syncTypes, 3);
    res.json({ queued: true, jobId: job.id });
  } catch (err) { next(err); }
});

router.get("/sync/status", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT sync_type, status, records_fetched, records_upserted, error_message, started_at, completed_at
       FROM sp_sync_log WHERE workspace_id=$1 ORDER BY started_at DESC LIMIT 20`,
      [req.workspace.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
