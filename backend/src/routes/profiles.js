// ─── profiles.js ──────────────────────────────────────────────────────────────
const express = require("express");
const profilesRouter = express.Router();
const { requireAuth } = require("../middleware/auth");
const { query } = require("../db/pool");

profilesRouter.use(requireAuth);

// GET /profiles?workspaceId=...
profilesRouter.get("/", async (req, res, next) => {
  try {
    const { workspaceId } = req.query;
    const { rows } = await query(
      `SELECT p.id, p.profile_id, p.marketplace, p.country_code, p.currency_code,
              p.account_name, p.account_type, p.is_attached, p.sync_status, p.last_synced_at,
              p.connection_id, c.status as connection_status
       FROM amazon_profiles p
       JOIN amazon_connections c ON c.id = p.connection_id
       WHERE c.org_id = $1 ${workspaceId ? "AND p.workspace_id = $2" : ""}
       ORDER BY p.marketplace`,
      workspaceId ? [req.orgId, workspaceId] : [req.orgId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /profiles/:id/sync — manual sync trigger
profilesRouter.post("/:id/sync", async (req, res, next) => {
  try {
    const { queueEntitySync } = require("../jobs/workers");
    await queueEntitySync(req.params.id, ["campaigns", "ad_groups", "keywords"], 1);
    await query("UPDATE amazon_profiles SET sync_status = 'pending', updated_at = NOW() WHERE id = $1", [req.params.id]);
    res.json({ message: "Sync queued", profileId: req.params.id });
  } catch (err) {
    next(err);
  }
});

module.exports = profilesRouter;
