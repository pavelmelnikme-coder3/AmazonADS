const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireWorkspace } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireWorkspace);

// GET /keywords — returns { data, pagination: { total, page, limit, pages } }
router.get("/", async (req, res, next) => {
  try {
    const VALID_LIMITS = [25, 50, 100, 200, 500];
    const { campaignId, adGroupId, state, search, page = 1, sortBy = "keyword_text", sortDir = "asc" } = req.query;
    const rawLimit = parseInt(req.query.limit);
    const limit = VALID_LIMITS.includes(rawLimit) ? rawLimit : 100;
    const offset = (parseInt(page) - 1) * limit;
    const conditions = ["k.workspace_id = $1"];
    const params = [req.workspaceId];
    let pi = 2;
    if (campaignId) { conditions.push(`k.campaign_id = $${pi++}`);        params.push(campaignId); }
    if (adGroupId)  { conditions.push(`k.ad_group_id = $${pi++}`);        params.push(adGroupId); }
    if (state)      { conditions.push(`k.state = $${pi++}`);              params.push(state); }
    if (search)     { conditions.push(`k.keyword_text ILIKE $${pi++}`);   params.push(`%${search}%`); }
    const where = "WHERE " + conditions.join(" AND ");

    const allowedSortKw = {
      keyword_text: "k.keyword_text",
      match_type:   "k.match_type",
      state:        "k.state",
      bid:          "k.bid",
      campaign:     "c.name",
    };
    const orderField = allowedSortKw[sortBy] || "k.keyword_text";
    const orderDir   = sortDir === "asc" ? "ASC" : "DESC";

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT k.*, c.name as campaign_name, c.campaign_type, ag.name as ad_group_name
         FROM keywords k
         JOIN campaigns c ON c.id = k.campaign_id
         JOIN ad_groups ag ON ag.id = k.ad_group_id
         ${where} ORDER BY ${orderField} ${orderDir} NULLS LAST
         LIMIT ${parseInt(limit)} OFFSET $${pi}`,
        [...params, offset]
      ),
      query(`SELECT COUNT(*) as total FROM keywords k ${where}`, params),
    ]);

    const total = parseInt(countRows[0].total);
    res.json({
      data: rows,
      pagination: {
        total,
        page: parseInt(page),
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) { next(err); }
});

// PATCH /keywords/bulk — bulk bid/state update
router.patch("/bulk", async (req, res, next) => {
  try {
    const { updates } = req.body;
    if (!updates?.length) return res.status(400).json({ error: "updates required" });
    let updated = 0;
    for (const { id, bid, state } of updates) {
      const sets = [], vals = [];
      let pi = 1;
      if (bid   !== undefined) { sets.push(`bid = $${pi++}`);   vals.push(bid); }
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

// PATCH /keywords/:id — single bid/state update
router.patch("/:id", async (req, res, next) => {
  try {
    const { bid, state } = req.body;
    const sets = [], vals = [];
    let pi = 1;
    if (bid   !== undefined) { sets.push(`bid = $${pi++}`);   vals.push(bid); }
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
