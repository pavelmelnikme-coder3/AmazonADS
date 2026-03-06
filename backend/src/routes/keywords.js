const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireWorkspace } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireWorkspace);

// GET /keywords
router.get("/", async (req, res, next) => {
  try {
    const { campaignId, adGroupId, search, limit = 100, page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    const conditions = ["k.workspace_id = $1"];
    const params = [req.workspaceId];
    let pi = 2;
    if (campaignId) { conditions.push(`k.campaign_id = $${pi++}`); params.push(campaignId); }
    if (adGroupId)  { conditions.push(`k.ad_group_id = $${pi++}`); params.push(adGroupId); }
    if (search)     { conditions.push(`k.keyword_text ILIKE $${pi++}`); params.push(`%${search}%`); }
    const where = "WHERE " + conditions.join(" AND ");
    const { rows } = await query(
      `SELECT k.*, c.name as campaign_name, ag.name as ad_group_name
       FROM keywords k
       JOIN campaigns c ON c.id = k.campaign_id
       JOIN ad_groups ag ON ag.id = k.ad_group_id
       ${where} ORDER BY k.keyword_text
       LIMIT ${parseInt(limit)} OFFSET $${pi}`,
      [...params, offset]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// PATCH /keywords/bulk — must be before /:id to avoid route conflict
router.patch("/bulk", async (req, res, next) => {
  try {
    const { updates } = req.body; // [{id, bid?, state?}]
    if (!updates?.length) return res.status(400).json({ error: "updates required" });
    let updated = 0;
    for (const { id, bid, state } of updates) {
      const sets = [];
      const vals = [];
      let pi = 1;
      if (bid !== undefined)   { sets.push(`bid = $${pi++}`);   vals.push(bid); }
      if (state !== undefined) { sets.push(`state = $${pi++}`); vals.push(state); }
      if (!sets.length) continue;
      vals.push(id, req.workspaceId);
      await query(
        `UPDATE keywords SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${pi++} AND workspace_id = $${pi}`,
        vals
      );
      updated++;
    }
    res.json({ updated });
  } catch (err) { next(err); }
});

// PATCH /keywords/:id — update bid or state
router.patch("/:id", async (req, res, next) => {
  try {
    const { bid, state } = req.body;
    const sets = [];
    const vals = [];
    let pi = 1;
    if (bid !== undefined)   { sets.push(`bid = $${pi++}`);   vals.push(bid); }
    if (state !== undefined) { sets.push(`state = $${pi++}`); vals.push(state); }
    if (!sets.length) return res.status(400).json({ error: "bid or state required" });
    vals.push(req.params.id, req.workspaceId);
    const { rows: [kw] } = await query(
      `UPDATE keywords SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${pi++} AND workspace_id = $${pi} RETURNING *`,
      vals
    );
    if (!kw) return res.status(404).json({ error: "Keyword not found" });
    res.json(kw);
  } catch (err) { next(err); }
});

module.exports = router;
