const express = require("express");
const router = express.Router();
const ExcelJS = require("exceljs");
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const { getCatalogItem } = require("../services/amazon/spClient");
const { queueProductMetaSync } = require("../jobs/workers");
const logger = require("../config/logger");

router.use(requireAuth, requireWorkspace);

// GET /products — list all products for workspace with latest BSR + metrics
router.get("/", async (req, res, next) => {
  try {
    // ── Filters (enum-driven → safe to inline) ──
    // availability: all | available (live listing) | unavailable (delisted / 404, no catalog data)
    // advertising:  all | advertised (enabled ad in enabled campaign) | not_advertised
    const availability = ["available", "unavailable"].includes(req.query.availability) ? req.query.availability : "all";
    const advertising  = ["advertised", "not_advertised"].includes(req.query.advertising) ? req.query.advertising : "all";

    const advExists = `EXISTS (
      SELECT 1 FROM product_ads pa JOIN campaigns c ON c.id = pa.campaign_id
      WHERE pa.workspace_id = p.workspace_id AND UPPER(pa.asin) = p.asin
        AND pa.state = 'enabled' AND c.state = 'enabled'
    )`;
    let availFilter = "";
    if (availability === "available")   availFilter = "AND p.title IS NOT NULL AND p.title <> ''";
    if (availability === "unavailable") availFilter = "AND (p.title IS NULL OR p.title = '')";
    let advFilter = "";
    if (advertising === "advertised")     advFilter = `AND ${advExists}`;
    if (advertising === "not_advertised") advFilter = `AND NOT ${advExists}`;

    const { rows } = await query(
      `SELECT
         p.id, p.asin, p.marketplace_id, p.title, p.brand, p.image_url, p.is_active,
         p.created_at, p.parent_asin,
         ${advExists} AS is_advertised,
         (p.title IS NOT NULL AND p.title <> '') AS is_available,
         s.best_rank,
         s.best_category,
         s.classification_ranks,
         s.display_group_ranks,
         s.captured_at as bsr_updated_at,
         COALESCE(sm.sku, '') AS internal_sku,
         COALESCE(inv.seller_skus, ARRAY[]::text[]) AS seller_skus,
         -- cost / price metadata
         COALESCE(sm.cogs_per_unit, 0)    AS cogs_per_unit,
         COALESCE(sm.amazon_fee_pct, -0.15) AS amazon_fee_pct,
         -- stock
         COALESCE(stock.fba_qty, 0) AS fba_qty,
         COALESCE(stock.fbm_qty, 0) AS fbm_qty,
         -- sell price (buy-box preferred)
         pricing.sell_price,
         -- PPC spend — true per-ASIN ad spend (advertised_product level). Replaces the
         -- old campaign-level attribution that repeated a campaign's full spend on every
         -- ASIN in it (double-counted across a listing's variations).
         COALESCE(adp.ad_spend_yesterday, 0) AS ppc_yesterday,
         COALESCE(adp.ad_spend_7d, 0)        AS ppc_7d,
         COALESCE(adp.ad_spend_7d, 0) AS ad_spend_7d,
         COALESCE(adp.ad_sales_7d, 0) AS ad_sales_7d,
         -- orders / revenue
         COALESCE(orders.revenue_yesterday, 0) AS revenue_yesterday,
         COALESCE(orders.revenue_7d, 0)        AS revenue_7d,
         COALESCE(orders.qty_yesterday, 0)     AS qty_yesterday,
         COALESCE(orders.qty_7d, 0)            AS qty_7d,
         -- net profit (revenue after Amazon fee minus COGS minus per-ASIN ad spend)
         ROUND((
           COALESCE(orders.revenue_yesterday, 0) * (1 + COALESCE(sm.amazon_fee_pct, -0.15))
           - COALESCE(sm.cogs_per_unit, 0) * COALESCE(orders.qty_yesterday, 0)
           - COALESCE(adp.ad_spend_yesterday, 0)
         )::numeric, 2) AS profit_yesterday,
         ROUND((
           COALESCE(orders.revenue_7d, 0) * (1 + COALESCE(sm.amazon_fee_pct, -0.15))
           - COALESCE(sm.cogs_per_unit, 0) * COALESCE(orders.qty_7d, 0)
           - COALESCE(adp.ad_spend_7d, 0)
         )::numeric, 2) AS profit_7d
       FROM products p
       LEFT JOIN LATERAL (
         SELECT best_rank, best_category, classification_ranks, display_group_ranks, captured_at
         FROM bsr_snapshots
         WHERE product_id = p.id
         ORDER BY captured_at DESC
         LIMIT 1
       ) s ON true
       LEFT JOIN sku_mapping sm
         ON sm.workspace_id = p.workspace_id AND sm.asin = p.asin
       LEFT JOIN LATERAL (
         SELECT ARRAY_AGG(DISTINCT si.seller_sku) FILTER (WHERE si.seller_sku != '') AS seller_skus
         FROM sp_inventory si
         WHERE si.workspace_id = p.workspace_id
           AND si.asin = p.asin
           AND si.marketplace_id = p.marketplace_id
       ) inv ON true
       -- FBA / FBM stock
       LEFT JOIN LATERAL (
         SELECT
           COALESCE(SUM(CASE WHEN UPPER(si.fulfillment_channel) LIKE '%AMAZON%'
                             THEN si.quantity_sellable ELSE 0 END), 0) AS fba_qty,
           COALESCE(SUM(CASE WHEN UPPER(si.fulfillment_channel) NOT LIKE '%AMAZON%'
                             THEN si.quantity_sellable ELSE 0 END), 0) AS fbm_qty
         FROM sp_inventory si
         WHERE si.workspace_id = p.workspace_id
           AND si.asin = p.asin
           AND si.marketplace_id = p.marketplace_id
       ) stock ON true
       -- Sell price (latest buy-box, fall back to listing price)
       LEFT JOIN LATERAL (
         SELECT COALESCE(buy_box_price_amount, listing_price_amount) AS sell_price
         FROM sp_pricing
         WHERE workspace_id = p.workspace_id
           AND asin = p.asin
           AND marketplace_id = p.marketplace_id
         ORDER BY captured_at DESC
         LIMIT 1
       ) pricing ON true
       -- Per-ASIN ad spend & ad-attributed sales (advertised_product level) — correct
       -- per-ASIN attribution (the old campaign-level join repeated a campaign's full
       -- spend on every ASIN, double-counting across a listing's variations).
       LEFT JOIN LATERAL (
         SELECT
           COALESCE(SUM(CASE WHEN m.date = CURRENT_DATE - 1 THEN m.cost ELSE 0 END), 0) AS ad_spend_yesterday,
           COALESCE(SUM(CASE WHEN m.date >= CURRENT_DATE - 7 AND m.date <= CURRENT_DATE - 1 THEN m.cost     ELSE 0 END), 0) AS ad_spend_7d,
           -- 14-day attribution — the app-wide standard (campaigns/rules/analytics all use sales_14d)
           COALESCE(SUM(CASE WHEN m.date >= CURRENT_DATE - 7 AND m.date <= CURRENT_DATE - 1 THEN m.sales_14d ELSE 0 END), 0) AS ad_sales_7d
         FROM fact_metrics_daily m
         WHERE m.workspace_id = p.workspace_id
           AND m.entity_type = 'advertised_product'
           AND UPPER(m.amazon_id) = p.asin
           AND m.date >= CURRENT_DATE - 7
       ) adp ON true
       -- Orders revenue from SP Orders API
       LEFT JOIN LATERAL (
         SELECT
           COALESCE(SUM(CASE WHEN DATE(o.purchase_date AT TIME ZONE 'UTC') = CURRENT_DATE - 1
                             THEN oi.item_price_amount * oi.quantity_ordered ELSE 0 END), 0) AS revenue_yesterday,
           COALESCE(SUM(CASE WHEN DATE(o.purchase_date AT TIME ZONE 'UTC') >= CURRENT_DATE - 7
                              AND DATE(o.purchase_date AT TIME ZONE 'UTC') <= CURRENT_DATE - 1
                             THEN oi.item_price_amount * oi.quantity_ordered ELSE 0 END), 0) AS revenue_7d,
           COALESCE(SUM(CASE WHEN DATE(o.purchase_date AT TIME ZONE 'UTC') = CURRENT_DATE - 1
                             THEN oi.quantity_ordered ELSE 0 END), 0) AS qty_yesterday,
           COALESCE(SUM(CASE WHEN DATE(o.purchase_date AT TIME ZONE 'UTC') >= CURRENT_DATE - 7
                              AND DATE(o.purchase_date AT TIME ZONE 'UTC') <= CURRENT_DATE - 1
                             THEN oi.quantity_ordered ELSE 0 END), 0) AS qty_7d
         FROM sp_order_items oi
         JOIN sp_orders o ON o.id = oi.order_id
         WHERE oi.workspace_id = p.workspace_id
           AND oi.asin = p.asin
           AND o.purchase_date >= NOW() - INTERVAL '8 days'
           AND o.order_status NOT IN ('Cancelled', 'Pending')
       ) orders ON true
       WHERE p.workspace_id = $1 AND p.is_active = true
         ${availFilter}
         ${advFilter}
       ORDER BY s.best_rank ASC NULLS LAST, p.created_at DESC`,
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /products — add ASIN to track
router.post("/", async (req, res, next) => {
  try {
    const { asin, marketplaceId = "A1PA6795UKMFR9" } = req.body;
    if (!asin || !/^[A-Z0-9]{10}$/.test(asin.trim().toUpperCase())) {
      return res.status(400).json({ error: "Invalid ASIN format (10 alphanumeric chars)" });
    }
    const cleanAsin = asin.trim().toUpperCase();

    const { rows: [product] } = await query(
      `INSERT INTO products (workspace_id, asin, marketplace_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, asin, marketplace_id)
       DO UPDATE SET is_active = true, updated_at = NOW()
       RETURNING *`,
      [req.workspaceId, cleanAsin, marketplaceId]
    );

    // Fetch BSR immediately if SP-API is configured
    if (process.env.SP_API_REFRESH_TOKEN) {
      try {
        const data = await getCatalogItem(cleanAsin, marketplaceId);

        await query(
          `UPDATE products SET title=$1, brand=$2, image_url=$3, updated_at=NOW() WHERE id=$4`,
          [data.title, data.brand, data.imageUrl, product.id]
        );

        const allRanks = [...data.classificationRanks, ...data.displayGroupRanks];
        const best = allRanks.reduce((b, r) => (!b || r.rank < b.rank ? r : b), null);

        await query(
          `INSERT INTO bsr_snapshots
             (product_id, classification_ranks, display_group_ranks, best_rank, best_category)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            product.id,
            JSON.stringify(data.classificationRanks),
            JSON.stringify(data.displayGroupRanks),
            best?.rank || null,
            best?.title || null,
          ]
        );

        return res.json({
          ...product,
          title: data.title,
          brand: data.brand,
          image_url: data.imageUrl,
          bsr: data,
        });
      } catch (spErr) {
        logger.warn("SP-API fetch failed on add", { asin: cleanAsin, error: spErr.message });
        return res.json({ ...product, bsr_warning: "SP-API not configured or failed" });
      }
    }

    // No SP-API — queue background meta scrape
    queueProductMetaSync(req.workspaceId).catch(() => {});
    res.json(product);
  } catch (err) { next(err); }
});

// POST /products/sync-meta — trigger metadata scrape for all products without title
router.post("/sync-meta", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT COUNT(*) as cnt FROM products WHERE workspace_id = $1 AND is_active = true AND title IS NULL`,
      [req.workspaceId]
    );
    const pending = parseInt(rows[0].cnt);
    if (pending === 0) return res.json({ ok: true, queued: 0, message: "All products already have metadata" });
    await queueProductMetaSync(req.workspaceId);
    res.json({ ok: true, queued: pending });
  } catch (err) { next(err); }
});

// POST /products/:id/refresh — manually trigger BSR refresh for one ASIN
router.post("/:id/refresh", async (req, res, next) => {
  try {
    const { rows: [product] } = await query(
      `SELECT * FROM products WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );
    if (!product) return res.status(404).json({ error: "Product not found" });

    const data = await getCatalogItem(product.asin, product.marketplace_id);

    await query(
      `UPDATE products SET title=$1, brand=$2, image_url=$3, updated_at=NOW() WHERE id=$4`,
      [data.title, data.brand, data.imageUrl, product.id]
    );

    const allRanks = [...data.classificationRanks, ...data.displayGroupRanks];
    const best = allRanks.reduce((b, r) => (!b || r.rank < b.rank ? r : b), null);

    const { rows: [snapshot] } = await query(
      `INSERT INTO bsr_snapshots
         (product_id, classification_ranks, display_group_ranks, best_rank, best_category)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [
        product.id,
        JSON.stringify(data.classificationRanks),
        JSON.stringify(data.displayGroupRanks),
        best?.rank || null,
        best?.title || null,
      ]
    );

    res.json({ product, snapshot, raw: data });
  } catch (err) { next(err); }
});

// GET /products/:id/history — BSR history for chart (all snapshots, optional ?start=YYYY-MM-DD&end=YYYY-MM-DD)
router.get("/:id/history", async (req, res, next) => {
  try {
    const { start, end } = req.query;
    const params = [req.params.id];
    let conds = `WHERE product_id = $1`;
    if (start) { params.push(start); conds += ` AND captured_at >= $${params.length}::date`; }
    if (end)   { params.push(end);   conds += ` AND captured_at < ($${params.length}::date + INTERVAL '1 day')`; }
    const { rows } = await query(
      `SELECT captured_at, best_rank, best_category, classification_ranks, display_group_ranks
       FROM bsr_snapshots
       ${conds}
       ORDER BY captured_at ASC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// GET /products/timeseries?asins=A,B,C&start=YYYY-MM-DD&end=YYYY-MM-DD&compare=1
// Daily aligned series for the listing/ASIN charts: BSR, price, orders, ad spend,
// ACOS, TACOS, ROAS. Per-ASIN series + a listing aggregate. With compare=1 it also
// returns the immediately-preceding equal-length window (`prev`), aligned by index.
// Lazy-loaded on expand (never for the whole page) so 500+ products stay performant.
router.get("/timeseries", async (req, res, next) => {
  try {
    const asins = String(req.query.asins || "").split(",")
      .map((a) => a.trim().toUpperCase()).filter((a) => /^[A-Z0-9]{10}$/.test(a)).slice(0, 60);
    if (!asins.length) return res.json({ start: null, end: null, by_asin: {}, aggregate: [], prev: null });

    const end   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.end)   ? req.query.end   : new Date().toISOString().slice(0, 10);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start) ? req.query.start
      : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const compare = req.query.compare === "1" || req.query.compare === "true";
    const ws = req.workspaceId;

    const DAY = 86400000;
    const spine = (from, to) => {
      const out = [];
      for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d = new Date(d.getTime() + DAY)) out.push(d.toISOString().slice(0, 10));
      return out;
    };
    const curDates = spine(start, end);
    const windowLen = curDates.length;
    const prevStart = new Date(new Date(start + "T00:00:00Z").getTime() - windowLen * DAY).toISOString().slice(0, 10);
    const prevEnd   = new Date(new Date(start + "T00:00:00Z").getTime() - DAY).toISOString().slice(0, 10);
    const prevDates = compare ? spine(prevStart, prevEnd) : [];
    const qStart = compare ? prevStart : start;   // widen the queried range to cover both windows

    const [bsr, ad, price, ord] = await Promise.all([
      query(`SELECT UPPER(p.asin) AS asin, bs.captured_at::date::text AS d, MIN(bs.best_rank) AS bsr
               FROM products p JOIN bsr_snapshots bs ON bs.product_id = p.id
              WHERE p.workspace_id=$1 AND UPPER(p.asin)=ANY($2::text[]) AND bs.best_rank IS NOT NULL
                AND bs.captured_at::date BETWEEN $3 AND $4
              GROUP BY 1,2`, [ws, asins, qStart, end]),
      query(`SELECT UPPER(amazon_id) AS asin, date::text AS d,
                COALESCE(SUM(cost),0) AS ad_spend, COALESCE(SUM(sales_14d),0) AS ad_sales
               FROM fact_metrics_daily
              WHERE workspace_id=$1 AND entity_type='advertised_product' AND UPPER(amazon_id)=ANY($2::text[])
                AND date BETWEEN $3 AND $4
              GROUP BY 1,2`, [ws, asins, qStart, end]),
      query(`SELECT UPPER(asin) AS asin, captured_at::date::text AS d,
                (array_agg(COALESCE(buy_box_price_amount, listing_price_amount) ORDER BY captured_at DESC)
                   FILTER (WHERE COALESCE(buy_box_price_amount, listing_price_amount) IS NOT NULL))[1] AS price
               FROM sp_pricing
              WHERE workspace_id=$1 AND UPPER(asin)=ANY($2::text[]) AND captured_at::date BETWEEN $3 AND $4
              GROUP BY 1,2`, [ws, asins, qStart, end]),
      query(`SELECT UPPER(oi.asin) AS asin, o.purchase_date::date::text AS d,
                COUNT(DISTINCT o.id) AS orders, COALESCE(SUM(oi.quantity_ordered),0) AS units,
                COALESCE(SUM(oi.item_price_amount),0) AS revenue
               FROM sp_order_items oi JOIN sp_orders o ON o.id = oi.order_id
              WHERE oi.workspace_id=$1 AND UPPER(oi.asin)=ANY($2::text[]) AND o.order_status <> 'Canceled'
                AND o.purchase_date::date BETWEEN $3 AND $4
              GROUP BY 1,2`, [ws, asins, qStart, end]),
    ]);

    const key = (asin, d) => `${asin}|${d}`;
    const bsrM = new Map(bsr.rows.map((r) => [key(r.asin, r.d), Number(r.bsr)]));
    const adM = new Map(ad.rows.map((r) => [key(r.asin, r.d), r]));
    const priceM = new Map(price.rows.map((r) => [key(r.asin, r.d), r.price != null ? Number(r.price) : null]));
    const ordM = new Map(ord.rows.map((r) => [key(r.asin, r.d), r]));
    const r2 = (v) => Math.round(v * 100) / 100;
    const r1 = (v) => Math.round(v * 10) / 10;
    // ACOS = spend/adSales; TACOS = spend/totalRevenue; ROAS = adSales/spend.
    const mkPoint = (date, { bsr, cost, adSales, price, orders, units, revenue }) => ({
      date, bsr, price: price != null ? r2(price) : null, orders, units,
      ad_spend: r2(cost), ad_sales: r2(adSales), revenue: r2(revenue),
      acos:  adSales > 0 ? r1((cost / adSales) * 100) : null,
      tacos: revenue > 0 ? r1((cost / revenue) * 100) : null,
      roas:  cost > 0    ? r2(adSales / cost)         : null,
    });
    const buildSeries = (asin, dateList) => dateList.map((d) => {
      const a = adM.get(key(asin, d)); const o = ordM.get(key(asin, d));
      return mkPoint(d, {
        bsr: bsrM.has(key(asin, d)) ? bsrM.get(key(asin, d)) : null,
        cost: a ? Number(a.ad_spend) : 0, adSales: a ? Number(a.ad_sales) : 0,
        price: priceM.has(key(asin, d)) ? priceM.get(key(asin, d)) : null,
        orders: o ? Number(o.orders) : 0, units: o ? Number(o.units) : 0, revenue: o ? Number(o.revenue) : 0,
      });
    });
    const aggregateOf = (seriesByAsin, len) => Array.from({ length: len }, (_, i) => {
      let bsr = null, cost = 0, adSales = 0, revenue = 0, orders = 0, units = 0, pSum = 0, pN = 0, date = null;
      for (const asin of asins) {
        const pt = seriesByAsin[asin][i]; if (!pt) continue; date = pt.date;
        if (pt.bsr != null) bsr = bsr == null ? pt.bsr : Math.min(bsr, pt.bsr);
        if (pt.price != null) { pSum += pt.price; pN++; }
        cost += pt.ad_spend; adSales += pt.ad_sales; revenue += pt.revenue; orders += pt.orders; units += pt.units;
      }
      return mkPoint(date, { bsr, cost, adSales, price: pN ? pSum / pN : null, orders, units, revenue });
    });

    const by_asin = {}; const prev_by_asin = {};
    for (const asin of asins) {
      by_asin[asin] = buildSeries(asin, curDates);
      if (compare) prev_by_asin[asin] = buildSeries(asin, prevDates);
    }
    const aggregate = aggregateOf(by_asin, curDates.length);
    const prev = compare
      ? { start: prevStart, end: prevEnd, by_asin: prev_by_asin, aggregate: aggregateOf(prev_by_asin, prevDates.length) }
      : null;

    res.json({ start, end, by_asin, aggregate, prev });
  } catch (err) { next(err); }
});

// GET /products/period-orders?start=&end= — total orders/units/revenue per ASIN over a
// date range (default last 30d). Lightweight: powers "sort by orders for the period" so
// the user can surface the top revenue-driving listings without loading every chart.
router.get("/period-orders", async (req, res, next) => {
  try {
    const end   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.end)   ? req.query.end   : new Date().toISOString().slice(0, 10);
    const start = /^\d{4}-\d{2}-\d{2}$/.test(req.query.start) ? req.query.start
      : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const { rows } = await query(
      `SELECT UPPER(oi.asin) AS asin,
         COUNT(DISTINCT o.id) AS orders,
         COALESCE(SUM(oi.quantity_ordered),0) AS units,
         COALESCE(SUM(oi.item_price_amount),0) AS revenue
       FROM sp_order_items oi JOIN sp_orders o ON o.id = oi.order_id
       WHERE oi.workspace_id=$1 AND o.order_status <> 'Canceled'
         AND o.purchase_date::date BETWEEN $2 AND $3 AND oi.asin IS NOT NULL
       GROUP BY UPPER(oi.asin)`,
      [req.workspaceId, start, end]
    );
    const by_asin = {};
    for (const r of rows) by_asin[r.asin] = { orders: Number(r.orders), units: Number(r.units), revenue: Math.round(Number(r.revenue) * 100) / 100 };
    res.json({ start, end, by_asin });
  } catch (err) { next(err); }
});

// GET /products/notes — get notes for workspace (optionally filtered by product_id)
router.get("/notes", async (req, res, next) => {
  try {
    const { product_id } = req.query;
    const { rows } = await query(
      `SELECT n.*, u.name as author_name
       FROM product_notes n
       LEFT JOIN users u ON u.id = n.created_by
       WHERE n.workspace_id = $1
         AND (n.product_id IS NULL OR n.product_id = $2 OR $2 IS NULL)
       ORDER BY n.note_date DESC, n.created_at DESC`,
      [req.workspaceId, product_id || null]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /products/notes — create note
router.post("/notes", async (req, res, next) => {
  try {
    const { product_id, note_date, text } = req.body;
    if (!text?.trim()) return res.status(400).json({ error: "text is required" });
    const { rows: [note] } = await query(
      `INSERT INTO product_notes (workspace_id, product_id, note_date, text, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.workspaceId, product_id || null, note_date || new Date().toISOString().slice(0, 10), text.trim(), req.user.id]
    );
    res.status(201).json(note);
  } catch (err) { next(err); }
});

// DELETE /products/notes/:noteId — delete note
router.delete("/notes/:noteId", async (req, res, next) => {
  try {
    await query(
      `DELETE FROM product_notes WHERE id = $1 AND workspace_id = $2`,
      [req.params.noteId, req.workspaceId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Products report export (XLSX) ─────────────────────────────────────────
// All columns we know how to compute. Frontend sends back a subset based on
// user checkbox state, so we render only those. Order here = order in sheet.
const ALL_EXPORT_COLUMNS = [
  { key: "asin",          label: "ASIN",                 width: 14 },
  { key: "title",         label: "Title",                width: 50 },
  { key: "brand",         label: "Brand",                width: 16 },
  { key: "marketplace",   label: "Marketplace",          width: 8  },
  { key: "best_rank",     label: "Latest BSR",           width: 12, num: "#,##0" },
  { key: "best_category", label: "Best Category",        width: 22 },
  { key: "min_bsr",       label: "Best BSR (period)",    width: 14, num: "#,##0" },
  { key: "max_bsr",       label: "Worst BSR (period)",   width: 14, num: "#,##0" },
  { key: "avg_bsr",       label: "Avg BSR (period)",     width: 13, num: "#,##0" },
  { key: "first_bsr",     label: "BSR (period start)",   width: 14, num: "#,##0" },
  { key: "last_bsr",      label: "BSR (period end)",     width: 14, num: "#,##0" },
  { key: "bsr_change",    label: "BSR change %",         width: 12, num: '#,##0.0"%"' },
  { key: "snapshots",     label: "Snapshots",            width: 11, num: "#,##0" },
  { key: "ad_spend",      label: "Ad spend (€)",         width: 12, num: "#,##0.00" },
  { key: "ad_sales",      label: "Ad sales (€)",         width: 12, num: "#,##0.00" },
  { key: "ad_orders",     label: "Ad orders",            width: 11, num: "#,##0" },
  { key: "ad_clicks",     label: "Ad clicks",            width: 11, num: "#,##0" },
  { key: "ad_acos",       label: "ACoS %",               width: 10, num: '#,##0.00"%"' },
];

router.post("/export", async (req, res, next) => {
  try {
    const { startDate, endDate, columns: rawCols, format = "xlsx", includeHistory = false } = req.body || {};
    const wid = req.workspaceId;

    // ISO date format check — must validate before passing to SQL or postgres
    // throws "invalid input syntax for type date" with a leaky stack trace.
    // Accept only YYYY-MM-DD strings; allow null/undefined → use defaults.
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
    const validISO = (v) => v == null || (typeof v === "string" && ISO_DATE.test(v) && !isNaN(new Date(v).getTime()));
    if (!validISO(startDate)) return res.status(400).json({ error: "startDate must be in YYYY-MM-DD format" });
    if (!validISO(endDate))   return res.status(400).json({ error: "endDate must be in YYYY-MM-DD format" });

    const start = startDate || new Date(Date.now() - 30 * 86400000).toISOString().split("T")[0];
    const end   = endDate   || new Date().toISOString().split("T")[0];
    if (new Date(start) > new Date(end)) {
      return res.status(400).json({ error: "startDate must be before endDate" });
    }

    // Pick columns by key, preserving canonical order. Whitelist only — never
    // trust raw column names (no SQL string injection possible since we never
    // interpolate them, but still defensive).
    const requestedKeys = Array.isArray(rawCols) && rawCols.length
      ? new Set(rawCols)
      : new Set(ALL_EXPORT_COLUMNS.map(c => c.key));
    const cols = ALL_EXPORT_COLUMNS.filter(c => requestedKeys.has(c.key));
    if (!cols.length) return res.status(400).json({ error: "No valid columns selected" });

    // ── Aggregate per-product data ──────────────────────────────────────────
    // BSR aggregates from bsr_snapshots in [start, end].
    // Ad performance from fact_metrics_daily joined by amazon_id (advertised
    // ASIN reports use ASIN as amazon_id with entity_type='advertised_product').
    const { rows } = await query(
      `WITH bsr AS (
         SELECT product_id,
                MIN(best_rank) FILTER (WHERE best_rank IS NOT NULL)        AS min_bsr,
                MAX(best_rank) FILTER (WHERE best_rank IS NOT NULL)        AS max_bsr,
                AVG(best_rank) FILTER (WHERE best_rank IS NOT NULL)::int   AS avg_bsr,
                COUNT(*)                                                   AS snapshots,
                (ARRAY_AGG(best_rank ORDER BY captured_at ASC))[1]         AS first_bsr,
                (ARRAY_AGG(best_rank ORDER BY captured_at DESC))[1]        AS last_bsr
         FROM bsr_snapshots
         WHERE captured_at::date BETWEEN $2 AND $3
         GROUP BY product_id
       ),
       latest AS (
         SELECT DISTINCT ON (product_id) product_id, best_rank, best_category, captured_at
         FROM bsr_snapshots
         ORDER BY product_id, captured_at DESC
       ),
       ads AS (
         SELECT m.amazon_id AS asin,
                SUM(m.cost)         AS ad_spend,
                SUM(m.sales_14d)    AS ad_sales,   -- 14d attribution — app-wide standard, consistent with the UI
                SUM(m.orders_14d)   AS ad_orders,
                SUM(m.clicks)       AS ad_clicks
         FROM fact_metrics_daily m
         WHERE m.workspace_id = $1
           AND m.date BETWEEN $2 AND $3
           AND m.entity_type = 'advertised_product'
         GROUP BY m.amazon_id
       )
       SELECT p.asin, p.marketplace_id AS marketplace,
              COALESCE(p.title, '')   AS title,
              COALESCE(p.brand, '')   AS brand,
              latest.best_rank, latest.best_category,
              bsr.min_bsr, bsr.max_bsr, bsr.avg_bsr, bsr.snapshots,
              bsr.first_bsr, bsr.last_bsr,
              CASE WHEN bsr.first_bsr > 0 AND bsr.last_bsr IS NOT NULL
                   THEN ((bsr.last_bsr - bsr.first_bsr)::numeric / bsr.first_bsr * 100)::numeric(10,2)
              END AS bsr_change,
              ads.ad_spend, ads.ad_sales, ads.ad_orders, ads.ad_clicks,
              CASE WHEN ads.ad_sales > 0
                   THEN (ads.ad_spend / ads.ad_sales * 100)::numeric(10,2)
              END AS ad_acos
       FROM products p
       LEFT JOIN bsr      ON bsr.product_id    = p.id
       LEFT JOIN latest   ON latest.product_id = p.id
       LEFT JOIN ads      ON ads.asin          = p.asin
       WHERE p.workspace_id = $1 AND p.is_active = true
       ORDER BY latest.best_rank ASC NULLS LAST, p.asin ASC`,
      [wid, start, end]
    );

    // ── Build XLSX ──────────────────────────────────────────────────────────
    const wb = new ExcelJS.Workbook();
    wb.creator = "AdsFlow";
    wb.created = new Date();
    const headerFill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2D3748" } };
    const headerFont = { bold: true, color: { argb: "FFFFFFFF" }, size: 10, name: "Arial" };
    const dataFont   = { size: 10, name: "Arial" };

    // Sheet 1: Per-product summary
    const ws = wb.addWorksheet("Products");
    ws.addRow([`Period: ${start} to ${end}`]).font = { italic: true, color: { argb: "FF718096" }, size: 9 };
    ws.addRow([]);
    ws.addRow(cols.map(c => c.label));
    const headerRow = ws.getRow(3);
    headerRow.eachCell(c => { c.fill = headerFill; c.font = headerFont; c.alignment = { vertical: "middle", horizontal: "center", wrapText: true }; });
    headerRow.height = 30;
    cols.forEach((c, i) => { ws.getColumn(i + 1).width = c.width; });

    // OWASP CSV-Injection mitigation: any text cell starting with =, +, -, @,
    // tab or CR is prepended with a single quote so Excel/Sheets renders it
    // as text, not a formula. Amazon allows arbitrary product titles, and a
    // hostile listing like `=HYPERLINK("http://evil",…)` could otherwise
    // execute when the user opens the XLSX.
    const sanitizeText = (s) => {
      if (typeof s !== "string" || !s.length) return s;
      return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    };

    rows.forEach(r => {
      // Postgres returns NUMERIC columns as strings via node-postgres, so
      // numeric cells end up as text in XLSX and number formats don't apply.
      // Coerce columns that have a numFmt to actual JS numbers; leave others
      // (asin, title, brand) as strings.
      const cellValues = cols.map(c => {
        const v = r[c.key];
        if (v == null || v === "") return "";
        if (c.num) {
          const n = Number(v);
          return Number.isFinite(n) ? n : "";
        }
        return sanitizeText(v);
      });
      const newRow = ws.addRow(cellValues);
      newRow.eachCell((cell, colNum) => {
        cell.font = dataFont;
        const colDef = cols[colNum - 1];
        if (colDef.num && typeof cell.value === "number") {
          cell.numFmt = colDef.num;
        }
      });
    });
    ws.views = [{ state: "frozen", ySplit: 3 }];

    // Sheet 2 (optional): per-snapshot history
    if (includeHistory) {
      const { rows: histRows } = await query(
        `SELECT p.asin, p.title, p.brand, s.captured_at, s.best_rank, s.best_category
         FROM bsr_snapshots s
         JOIN products p ON p.id = s.product_id
         WHERE p.workspace_id = $1 AND p.is_active = true
           AND s.captured_at::date BETWEEN $2 AND $3
         ORDER BY p.asin ASC, s.captured_at DESC`,
        [wid, start, end]
      );
      const ws2 = wb.addWorksheet("BSR History");
      const HEAD2 = ["ASIN", "Title", "Brand", "Captured At (UTC)", "Best BSR", "Category"];
      ws2.addRow(HEAD2);
      const h2 = ws2.getRow(1);
      h2.eachCell(c => { c.fill = headerFill; c.font = headerFont; c.alignment = { vertical: "middle", horizontal: "center", wrapText: true }; });
      h2.height = 24;
      [14, 50, 16, 22, 12, 22].forEach((w, i) => { ws2.getColumn(i + 1).width = w; });
      histRows.forEach(r => {
        const newRow = ws2.addRow([
          sanitizeText(r.asin),
          sanitizeText(r.title || ""),
          sanitizeText(r.brand || ""),
          new Date(r.captured_at),
          r.best_rank,
          sanitizeText(r.best_category || ""),
        ]);
        newRow.eachCell((cell, colNum) => {
          cell.font = dataFont;
          if (colNum === 4) cell.numFmt = "yyyy-mm-dd hh:mm";
          if (colNum === 5) cell.numFmt = "#,##0";
        });
      });
      ws2.views = [{ state: "frozen", ySplit: 1 }];
    }

    const buffer = await wb.xlsx.writeBuffer();
    const filename = `adsflow-products-${start}_${end}.xlsx`;
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
    logger.info("Products report exported", { wid, start, end, rows: rows.length, cols: cols.length, includeHistory });
  } catch (err) { next(err); }
});

// DELETE /products/:id — soft delete (deactivate tracking)
router.delete("/:id", async (req, res, next) => {
  try {
    await query(
      `UPDATE products SET is_active=false, updated_at=NOW()
       WHERE id=$1 AND workspace_id=$2`,
      [req.params.id, req.workspaceId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
