const express = require("express");
const router  = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");

router.use(requireAuth, requireWorkspace);

// GET /portfolios — list portfolios with name + campaign count
// Joins portfolios table for name; falls back to amazon_portfolio_id when name is missing.
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT
         c.amazon_portfolio_id,
         COALESCE(p.name, 'Portfolio ' || c.amazon_portfolio_id) AS name,
         p.state,
         COUNT(c.id)::int AS campaign_count
       FROM campaigns c
       LEFT JOIN portfolios p
         ON p.amazon_portfolio_id = c.amazon_portfolio_id
         AND p.workspace_id = $1
       WHERE c.workspace_id = $1
         AND c.amazon_portfolio_id IS NOT NULL
         AND c.state != 'archived'
       GROUP BY c.amazon_portfolio_id, p.name, p.state
       ORDER BY name`,
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
