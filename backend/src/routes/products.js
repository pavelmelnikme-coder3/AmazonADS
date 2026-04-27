const express = require("express");
const router = express.Router();
const ExcelJS = require("exceljs");
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const { getCatalogItem } = require("../services/amazon/spClient");
const { queueProductMetaSync } = require("../jobs/workers");
const logger = require("../config/logger");

router.use(requireAuth, requireWorkspace);

// GET /products — list all products for workspace with latest BSR
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT
         p.id, p.asin, p.marketplace_id, p.title, p.brand, p.image_url, p.is_active,
         p.created_at,
         s.best_rank,
         s.best_category,
         s.classification_ranks,
         s.display_group_ranks,
         s.captured_at as bsr_updated_at
       FROM products p
       LEFT JOIN LATERAL (
         SELECT best_rank, best_category, classification_ranks, display_group_ranks, captured_at
         FROM bsr_snapshots
         WHERE product_id = p.id
         ORDER BY captured_at DESC
         LIMIT 1
       ) s ON true
       WHERE p.workspace_id = $1 AND p.is_active = true
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

// GET /products/:id/history — BSR history for chart (last 90 snapshots)
router.get("/:id/history", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT captured_at, best_rank, best_category, classification_ranks, display_group_ranks
       FROM bsr_snapshots
       WHERE product_id = $1
       ORDER BY captured_at DESC
       LIMIT 90`,
      [req.params.id]
    );
    res.json(rows.reverse()); // chronological order
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
                SUM(m.sales_14d)    AS ad_sales,
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
