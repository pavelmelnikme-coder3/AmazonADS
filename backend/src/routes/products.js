const express = require("express");
const router = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const { getCatalogItem } = require("../services/amazon/spClient");
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

    res.json(product);
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
