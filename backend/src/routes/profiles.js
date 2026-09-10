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
    // Org membership alone is not enough to see a workspace's profiles. This deployment holds
    // three organizations, eleven users and nine workspace memberships, and an org can hold more
    // than one workspace — so scope to the workspaces this user actually belongs to, the same
    // rule requireWorkspace applies everywhere else. A profile not yet attached to any workspace
    // is org-level and stays visible: that is the list the connect screen picks from.
    const { rows } = await query(
      `SELECT p.id, p.profile_id, p.marketplace, p.country_code, p.currency_code,
              p.account_name, p.account_type, p.is_attached, p.sync_status, p.last_synced_at,
              p.connection_id, c.status as connection_status
       FROM amazon_profiles p
       JOIN amazon_connections c ON c.id = p.connection_id
       WHERE c.org_id = $1
         AND (p.workspace_id IS NULL OR EXISTS (
               SELECT 1 FROM workspace_members wm
                WHERE wm.workspace_id = p.workspace_id AND wm.user_id = $2))
         ${workspaceId ? "AND p.workspace_id = $3" : ""}
       ORDER BY p.marketplace`,
      workspaceId ? [req.orgId, req.user.id, workspaceId] : [req.orgId, req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// POST /profiles/:id/sync — manual sync trigger
profilesRouter.post("/:id/sync", async (req, res, next) => {
  try {
    // Validate ownership: profile must belong to a connection in this org
    const { rows: [profile] } = await query(
      `SELECT p.id FROM amazon_profiles p
       JOIN amazon_connections c ON c.id = p.connection_id
       WHERE p.id = $1 AND c.org_id = $2`,
      [req.params.id, req.orgId]
    );
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    const { queueEntitySync } = require("../jobs/workers");
    await queueEntitySync(req.params.id, ["campaigns", "ad_groups", "keywords"], 1);
    await query("UPDATE amazon_profiles SET sync_status = 'pending', updated_at = NOW() WHERE id = $1", [req.params.id]);
    res.json({ message: "Sync queued", profileId: req.params.id });
  } catch (err) {
    next(err);
  }
});

module.exports = profilesRouter;
