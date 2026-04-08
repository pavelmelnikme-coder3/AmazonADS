const express = require("express");
const router  = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const { scrapeRank, scrapeWorkspaceRanks } = require("../services/amazon/rankScraper");
const { getRanksByAsin, isConfigured: jsConfigured } = require("../services/junglescout/client");
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
       RETURNING *, (xmax = 0) AS inserted`,
      [req.workspaceId, asin.trim().toUpperCase(), keyword.trim().toLowerCase(), marketplaceId]
    );

    res.json(tk);

    // Auto-check rank immediately after adding (async, non-blocking).
    // Only runs for newly inserted rows to avoid redundant checks on re-activation.
    if (tk.inserted && jsConfigured()) {
      getRanksByAsin(tk.asin, tk.marketplace_id)
        .then(rankMap => {
          const result = rankMap.get(tk.keyword) || { position: null, page: null, found: false, blocked: false };
          return query(
            `INSERT INTO keyword_rank_snapshots (tracked_keyword_id, position, page, found, blocked)
             VALUES ($1, $2, $3, $4, $5)`,
            [tk.id, result.position, result.page, result.found, result.blocked]
          );
        })
        .then(() => logger.info("Auto-check on add complete", { asin: tk.asin, keyword: tk.keyword }))
        .catch(err => logger.warn("Auto-check on add failed (non-fatal)", { error: err.message }));
    }
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

    let result;
    if (jsConfigured()) {
      const rankMap = await getRanksByAsin(tk.asin, tk.marketplace_id);
      result = rankMap.get(tk.keyword) || { position: null, page: null, found: false, blocked: false };
      logger.info("Rank check via Jungle Scout", { asin: tk.asin, keyword: tk.keyword, position: result.position });
    } else {
      result = await scrapeRank(tk.asin, tk.keyword, tk.marketplace_id);
    }

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
    if (jsConfigured()) {
      jsCheckWorkspaceRanks(req.workspaceId).catch(err =>
        logger.error("JS rank check-all failed", { workspaceId: req.workspaceId, error: err.message })
      );
    } else {
      scrapeWorkspaceRanks(req.workspaceId, { query }).catch(err =>
        logger.error("rank check-all failed", { workspaceId: req.workspaceId, error: err.message })
      );
    }
    res.json({ ok: true, message: "Rank check started. Results will appear in a few minutes." });
  } catch (err) { next(err); }
});

/**
 * Batch rank check using Jungle Scout — one API call per unique ASIN.
 * Much faster than scraping (no delays, no CAPTCHA risk).
 */
async function jsCheckWorkspaceRanks(workspaceId) {
  const { rows: keywords } = await query(
    `SELECT id, asin, keyword, marketplace_id
     FROM tracked_keywords
     WHERE workspace_id = $1 AND is_active = TRUE`,
    [workspaceId]
  );
  if (!keywords.length) return;

  // Group tracked keywords by ASIN+marketplace for batch API calls
  const groups = {};
  for (const kw of keywords) {
    const key = `${kw.asin}|${kw.marketplace_id}`;
    if (!groups[key]) groups[key] = { asin: kw.asin, marketplaceId: kw.marketplace_id, keywords: [] };
    groups[key].keywords.push(kw);
  }

  for (const group of Object.values(groups)) {
    const rankMap = await getRanksByAsin(group.asin, group.marketplaceId);
    for (const kw of group.keywords) {
      const result = rankMap.get(kw.keyword) || { position: null, page: null, found: false, blocked: false };
      await query(
        `INSERT INTO keyword_rank_snapshots (tracked_keyword_id, position, page, found, blocked)
         VALUES ($1, $2, $3, $4, $5)`,
        [kw.id, result.position, result.page, result.found, result.blocked]
      );
    }
    // Respect JS rate limit (300 req/min)
    if (Object.keys(groups).length > 1) await new Promise(r => setTimeout(r, 300));
  }

  logger.info("JS rank check-all complete", { workspaceId, asins: Object.keys(groups).length, keywords: keywords.length });
}

module.exports = router;
