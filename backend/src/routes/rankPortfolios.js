const express = require("express");
const router  = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");

router.use(requireAuth, requireWorkspace);

// GET /rank-portfolios
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, display_order, created_at
       FROM rank_portfolios
       WHERE workspace_id = $1
       ORDER BY display_order NULLS LAST, id ASC`,
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /rank-portfolios
router.post("/", async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Name required" });
    const { rows: [pf] } = await query(
      `INSERT INTO rank_portfolios (workspace_id, name)
       VALUES ($1, $2)
       ON CONFLICT (workspace_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [req.workspaceId, name.trim()]
    );
    res.json(pf);
  } catch (err) { next(err); }
});

// PATCH /rank-portfolios/:id — rename
router.patch("/:id", async (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Name required" });
    const { rows: [pf] } = await query(
      `UPDATE rank_portfolios SET name = $1
       WHERE id = $2 AND workspace_id = $3
       RETURNING *`,
      [name.trim(), req.params.id, req.workspaceId]
    );
    if (!pf) return res.status(404).json({ error: "Not found" });
    res.json(pf);
  } catch (err) { next(err); }
});

// DELETE /rank-portfolios/:id
router.delete("/:id", async (req, res, next) => {
  try {
    await query(
      `DELETE FROM rank_portfolios WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.workspaceId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
