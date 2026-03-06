const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireWorkspace } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireWorkspace);

// POST /bulk/campaigns/status — bulk state change
router.post("/campaigns/status", async (req, res, next) => {
  try {
    const { ids, state } = req.body;
    const allowed = ["enabled", "paused", "archived"];
    if (!ids?.length) return res.status(400).json({ error: "ids required" });
    if (!allowed.includes(state)) {
      return res.status(400).json({ error: `state must be one of: ${allowed.join(", ")}` });
    }
    const { rowCount } = await query(
      "UPDATE campaigns SET state = $1, updated_at = NOW() WHERE id = ANY($2::uuid[]) AND workspace_id = $3",
      [state, ids, req.workspaceId]
    );
    res.json({ updated: rowCount });
  } catch (err) { next(err); }
});

// POST /bulk/campaigns/budget — bulk budget adjustment (percent)
router.post("/campaigns/budget", async (req, res, next) => {
  try {
    const { ids, adjustPct } = req.body;
    if (!ids?.length) return res.status(400).json({ error: "ids required" });
    if (adjustPct === undefined) return res.status(400).json({ error: "adjustPct required" });
    const { rowCount } = await query(
      `UPDATE campaigns
       SET daily_budget = GREATEST(0.01, daily_budget * (1 + $1::numeric / 100)), updated_at = NOW()
       WHERE id = ANY($2::uuid[]) AND workspace_id = $3`,
      [adjustPct, ids, req.workspaceId]
    );
    res.json({ updated: rowCount });
  } catch (err) { next(err); }
});

// POST /bulk/keywords/bid — bulk bid adjustment (percent or absolute)
router.post("/keywords/bid", async (req, res, next) => {
  try {
    const { ids, adjustPct, absoluteBid } = req.body;
    if (!ids?.length) return res.status(400).json({ error: "ids required" });

    let rowCount;
    if (absoluteBid !== undefined) {
      ({ rowCount } = await query(
        "UPDATE keywords SET bid = $1, updated_at = NOW() WHERE id = ANY($2::uuid[]) AND workspace_id = $3",
        [absoluteBid, ids, req.workspaceId]
      ));
    } else if (adjustPct !== undefined) {
      ({ rowCount } = await query(
        `UPDATE keywords
         SET bid = GREATEST(0.02, LEAST(50, bid * (1 + $1::numeric / 100))), updated_at = NOW()
         WHERE id = ANY($2::uuid[]) AND workspace_id = $3`,
        [adjustPct, ids, req.workspaceId]
      ));
    } else {
      return res.status(400).json({ error: "adjustPct or absoluteBid required" });
    }
    res.json({ updated: rowCount });
  } catch (err) { next(err); }
});

module.exports = router;
