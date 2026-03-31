const express = require("express");
const router  = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const { scrapeRank, scrapeWorkspaceRanks } = require("../services/amazon/rankScraper");
const logger  = require("../config/logger");

router.use(requireAuth, requireWorkspace);

// GET /keyword-ranks — list all tracked keywords with latest snapshot + previous for delta
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT
         tk.id, tk.asin, tk.keyword, tk.marketplace_id, tk.created_at,
         latest.position          AS position,
         latest.found             AS found,
         latest.blocked           AS blocked,
         latest.captured_at       AS checked_at,
         prev.position            AS prev_position
       FROM tracked_keywords tk
       LEFT JOIN LATERAL (
         SELECT position, found, blocked, captured_at
         FROM keyword_rank_snapshots
         WHERE tracked_keyword_id = tk.id
         ORDER BY captured_at DESC
         LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT position
         FROM keyword_rank_snapshots
         WHERE tracked_keyword_id = tk.id
         ORDER BY captured_at DESC
         LIMIT 1 OFFSET 1
       ) prev ON true
       WHERE tk.workspace_id = $1 AND tk.is_active = TRUE
       ORDER BY latest.position ASC NULLS LAST, tk.asin, tk.keyword`,
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /keyword-ranks — add a keyword to track
router.post("/", async (req, res, next) => {
  try {
    const { asin, keyword, marketplaceId = "A1PA6795UKMFR9" } = req.body;
    if (!asin || !/^[A-Z0-9]{10}$/.test(asin.trim().toUpperCase())) {
      return res.status(400).json({ error: "Invalid ASIN (10 alphanumeric chars required)" });
    }
    if (!keyword || keyword.trim().length < 2) {
      return res.status(400).json({ error: "keyword is required (min 2 chars)" });
    }

    const { rows: [tk] } = await query(
      `INSERT INTO tracked_keywords (workspace_id, asin, keyword, marketplace_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, asin, keyword, marketplace_id)
       DO UPDATE SET is_active = TRUE, updated_at = NOW()
       RETURNING *`,
      [req.workspaceId, asin.trim().toUpperCase(), keyword.trim().toLowerCase(), marketplaceId]
    );

    res.json(tk);
  } catch (err) { next(err); }
});

// DELETE /keyword-ranks/:id — stop tracking a keyword
router.delete("/:id", async (req, res, next) => {
  try {
    await query(
      `UPDATE tracked_keywords SET is_active = FALSE, updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// GET /keyword-ranks/:id/history?days=7|30 — snapshot history for chart
router.get("/:id/history", async (req, res, next) => {
  try {
    const days  = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 90);
    const { rows } = await query(
      `SELECT position, found, blocked, captured_at
       FROM keyword_rank_snapshots
       WHERE tracked_keyword_id = $1
         AND captured_at >= NOW() - INTERVAL '${days} days'
       ORDER BY captured_at ASC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /keyword-ranks/:id/check — manually trigger a single keyword check
router.post("/:id/check", async (req, res, next) => {
  try {
    const { rows: [tk] } = await query(
      `SELECT * FROM tracked_keywords WHERE id = $1 AND workspace_id = $2 AND is_active = TRUE`,
      [req.params.id, req.workspaceId]
    );
    if (!tk) return res.status(404).json({ error: "Tracked keyword not found" });

    const result = await scrapeRank(tk.asin, tk.keyword, tk.marketplace_id);

    await query(
      `INSERT INTO keyword_rank_snapshots
         (tracked_keyword_id, position, page, found, blocked)
       VALUES ($1, $2, $3, $4, $5)`,
      [tk.id, result.position, result.page, result.found, result.blocked]
    );

    res.json({ ...tk, ...result });
  } catch (err) { next(err); }
});

// POST /keyword-ranks/check-all — trigger full workspace rank check
router.post("/check-all", async (req, res, next) => {
  try {
    // Run async, respond immediately
    scrapeWorkspaceRanks(req.workspaceId, { query }).catch(err =>
      logger.error("rank check-all failed", { workspaceId: req.workspaceId, error: err.message })
    );
    res.json({ ok: true, message: "Rank check started. Results will appear in a few minutes." });
  } catch (err) { next(err); }
});

module.exports = router;
