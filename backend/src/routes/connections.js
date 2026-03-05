/**
 * Amazon Ads Connection Routes
 *
 * GET  /connections/amazon/init          → get OAuth URL
 * GET  /connections/amazon/callback      → receive code, exchange tokens (FRONTEND handles redirect, calls this)
 * GET  /connections/:id/profiles         → list profiles for a connection
 * POST /connections/:id/profiles/attach  → attach selected profiles to workspace
 * GET  /connections                      → list connections for org
 * DELETE /connections/:id               → revoke connection
 */

const express = require("express");
const { query } = require("../db/pool");
const { requireAuth, requireWorkspace, requireRole } = require("../middleware/auth");
const {
  buildAuthUrl,
  exchangeCodeForTokens,
  saveConnection,
  revokeConnection,
  validateState,
} = require("../services/amazon/lwa");
const { fetchProfiles, upsertProfiles, attachProfileToWorkspace } = require("../services/amazon/entities");
const { queueEntitySync } = require("../jobs/workers");
const logger = require("../config/logger");
const { writeAudit } = require("./audit");

const router = express.Router();
router.use(requireAuth);

// GET /connections/amazon/init
// Returns the Amazon OAuth URL for the user to redirect to
router.get("/amazon/init", async (req, res, next) => {
  try {
    const { url, state } = buildAuthUrl(req.user.id, req.orgId);
    res.json({ url, state });
  } catch (err) {
    next(err);
  }
});

// POST /connections/amazon/callback
// Called by frontend after Amazon redirects back with ?code=...&state=...
router.post("/amazon/callback", async (req, res, next) => {
  try {
    const { code, state, workspaceId } = req.body;

    if (!code) return res.status(400).json({ error: "Missing authorization code" });
    if (!state) return res.status(400).json({ error: "Missing state parameter" });

    // Verify CSRF state
    const stateData = validateState(state);
    if (!stateData || stateData.userId !== req.user.id) {
      return res.status(400).json({ error: "Invalid or expired state. Please try connecting again." });
    }

    // Exchange code for tokens
    const tokenData = await exchangeCodeForTokens(code);

    // Save connection
    const connection = await saveConnection(tokenData, req.user.id, req.orgId, workspaceId || null);

    // Immediately fetch profiles from Amazon
    const amazonProfiles = await fetchProfiles(connection.id);
    const savedProfiles = await upsertProfiles(connection.id, amazonProfiles);

    await writeAudit({
      orgId: req.orgId,
      workspaceId: workspaceId || null,
      actorId: req.user.id,
      actorName: req.user.name,
      action: "connection.created",
      entityType: "connection",
      entityId: connection.id,
      source: "ui",
    });

    logger.info("Amazon connection established", { connectionId: connection.id, profileCount: savedProfiles.length });

    res.status(201).json({
      connection: {
        id: connection.id,
        status: "active",
        createdAt: connection.created_at,
      },
      profiles: savedProfiles.map(p => ({
        id: p.id,
        profileId: p.profile_id,
        marketplace: p.marketplace,
        countryCode: p.country_code,
        currencyCode: p.currency_code,
        accountName: p.account_name,
        accountType: p.account_type,
        isAttached: p.is_attached,
      })),
    });
  } catch (err) {
    logger.error("Amazon connection callback failed", { error: err.message });
    next(err);
  }
});

// POST /connections/:id/profiles/attach
// User selects which profiles to enable sync for
router.post("/:id/profiles/attach", async (req, res, next) => {
  try {
    const { profileIds, workspaceId } = req.body;
    if (!profileIds?.length) return res.status(400).json({ error: "profileIds required" });
    if (!workspaceId) return res.status(400).json({ error: "workspaceId required" });

    // Verify connection belongs to this org
    const { rows: [conn] } = await query(
      "SELECT id FROM amazon_connections WHERE id = $1 AND org_id = $2",
      [req.params.id, req.orgId]
    );
    if (!conn) return res.status(404).json({ error: "Connection not found" });

    const attached = [];
    for (const profileDbId of profileIds) {
      await attachProfileToWorkspace(profileDbId, workspaceId);

      // Queue initial entity sync for each attached profile
      await queueEntitySync(profileDbId, ["campaigns", "ad_groups", "keywords"], 1);
      attached.push(profileDbId);
    }

    logger.info("Profiles attached", { connectionId: req.params.id, profileIds: attached, workspaceId });

    res.json({
      attached,
      message: `${attached.length} profile(s) attached. Initial sync queued.`,
    });
  } catch (err) {
    next(err);
  }
});

// GET /connections
router.get("/", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT c.id, c.status, c.amazon_email, c.created_at, c.last_refresh_at,
              c.error_count, c.last_error,
              count(p.id) as profile_count
       FROM amazon_connections c
       LEFT JOIN amazon_profiles p ON p.connection_id = c.id
       WHERE c.org_id = $1 AND c.status != 'revoked'
       GROUP BY c.id
       ORDER BY c.created_at DESC`,
      [req.orgId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /connections/:id/profiles
router.get("/:id/profiles", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.id, p.profile_id, p.marketplace, p.country_code, p.currency_code,
              p.account_name, p.account_type, p.is_attached, p.sync_status, p.last_synced_at,
              p.workspace_id
       FROM amazon_profiles p
       JOIN amazon_connections c ON c.id = p.connection_id
       WHERE p.connection_id = $1 AND c.org_id = $2`,
      [req.params.id, req.orgId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// DELETE /connections/:id
router.delete("/:id", requireRole("owner", "admin"), async (req, res, next) => {
  try {
    const { rows: [conn] } = await query(
      "SELECT id FROM amazon_connections WHERE id = $1 AND org_id = $2",
      [req.params.id, req.orgId]
    );
    if (!conn) return res.status(404).json({ error: "Connection not found" });

    await revokeConnection(req.params.id, req.user.id);

    await writeAudit({
      orgId: req.orgId,
      actorId: req.user.id,
      actorName: req.user.name,
      action: "connection.revoked",
      entityType: "connection",
      entityId: req.params.id,
      source: "ui",
    });

    res.json({ message: "Connection revoked successfully" });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
