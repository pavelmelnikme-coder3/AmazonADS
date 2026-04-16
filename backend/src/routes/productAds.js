const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireWorkspace } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireWorkspace);

// GET /product-ads — list product ads for a campaign or ad group
router.get("/", async (req, res, next) => {
  try {
    const { campaignId, adGroupId, state, page = 1, limit: rawLimit = 500 } = req.query;
    const limit  = Math.min(parseInt(rawLimit) || 500, 2000);
    const offset = (Math.max(parseInt(page), 1) - 1) * limit;

    const conditions = ["pa.workspace_id = $1"];
    const params = [req.workspaceId];
    let pi = 2;

    if (campaignId) { conditions.push(`pa.campaign_id  = $${pi++}`); params.push(campaignId); }
    if (adGroupId)  { conditions.push(`pa.ad_group_id  = $${pi++}`); params.push(adGroupId); }
    if (state && state !== "all") { conditions.push(`pa.state = $${pi++}`); params.push(state); }

    const where = "WHERE " + conditions.join(" AND ");

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT
           pa.id, pa.amazon_ad_id, pa.asin, pa.sku, pa.state,
           pa.ad_group_id, pa.campaign_id,
           ag.name       AS ad_group_name,
           pr.title      AS product_title,
           pr.brand,
           pr.image_url
         FROM product_ads pa
         LEFT JOIN ad_groups ag ON ag.id = pa.ad_group_id
         LEFT JOIN products pr  ON pr.asin = pa.asin AND pr.workspace_id = pa.workspace_id
         ${where}
         ORDER BY pa.asin NULLS LAST, pa.created_at DESC
         LIMIT ${limit} OFFSET $${pi++}`,
        [...params, offset]
      ),
      query(
        `SELECT COUNT(*) AS total FROM product_ads pa ${where}`,
        params
      ),
    ]);

    res.json({
      data: rows,
      pagination: {
        total: parseInt(countRows[0].total),
        page:  parseInt(page),
        limit,
      },
    });
  } catch (err) { next(err); }
});

module.exports = router;
