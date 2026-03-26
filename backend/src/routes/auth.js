const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { body, validationResult } = require("express-validator");
const { query } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function generateTokens(userId) {
  const accessToken = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "7d" });
  return { accessToken };
}

// POST /auth/register
router.post(
  "/register",
  [
    body("email").isEmail().normalizeEmail(),
    body("password").isLength({ min: 8 }),
    body("name").trim().isLength({ min: 2 }),
    body("orgName").trim().isLength({ min: 2 }),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { email, password, name, orgName } = req.body;

      // Check existing user
      const existing = await query("SELECT id FROM users WHERE email = $1", [email]);
      if (existing.rows.length) {
        return res.status(409).json({ error: "Email already registered" });
      }

      const passwordHash = await bcrypt.hash(password, 12);
      const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + Date.now().toString(36);

      // Create org, user, default workspace in one transaction
      const { rows: [org] } = await query(
        "INSERT INTO organizations(name, slug, plan) VALUES($1, $2, 'trial') RETURNING id",
        [orgName, slug]
      );

      const { rows: [user] } = await query(
        "INSERT INTO users(org_id, email, password_hash, name, role) VALUES($1,$2,$3,$4,'owner') RETURNING id, email, name, role, org_id",
        [org.id, email, passwordHash, name]
      );

      const { rows: [workspace] } = await query(
        "INSERT INTO workspaces(org_id, name, created_by) VALUES($1, $2, $3) RETURNING id, name",
        [org.id, `${orgName} - Main`, user.id]
      );

      await query(
        "INSERT INTO workspace_members(workspace_id, user_id, role) VALUES($1,$2,'owner')",
        [workspace.id, user.id]
      );

      const tokens = generateTokens(user.id);
      res.status(201).json({ ...tokens, user, workspace });
    } catch (err) {
      next(err);
    }
  }
);

// POST /auth/login
router.post(
  "/login",
  [
    body("email").isEmail().normalizeEmail(),
    body("password").notEmpty(),
  ],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    try {
      const { email, password } = req.body;

      const { rows } = await query(
        "SELECT id, org_id, email, password_hash, name, role, is_active, settings FROM users WHERE email = $1",
        [email]
      );

      const user = rows[0];
      if (!user || !user.is_active) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return res.status(401).json({ error: "Invalid credentials" });

      await query("UPDATE users SET last_login_at = NOW() WHERE id = $1", [user.id]);

      // Get workspaces for this user
      const { rows: workspaces } = await query(
        `SELECT w.id, w.name, wm.role as workspace_role
         FROM workspaces w
         JOIN workspace_members wm ON wm.workspace_id = w.id
         WHERE wm.user_id = $1 ORDER BY w.created_at`,
        [user.id]
      );

      const tokens = generateTokens(user.id);
      res.json({
        ...tokens,
        user: { id: user.id, email: user.email, name: user.name, role: user.role, orgId: user.org_id, settings: user.settings || {} },
        workspaces,
      });
    } catch (err) {
      next(err);
    }
  }
);

// GET /auth/me
router.get("/me", requireAuth, async (req, res) => {
  const { rows: workspaces } = await query(
    `SELECT w.id, w.name, wm.role as workspace_role
     FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.user_id = $1`,
    [req.user.id]
  );

  res.json({ user: { ...req.user, settings: req.user.settings || {} }, workspaces });
});

// GET /auth/invite/:token — get invite info
router.get("/invite/:token", async (req, res, next) => {
  try {
    const { rows: [inv] } = await query(
      `SELECT wi.*, w.name as workspace_name, u.name as inviter_name
       FROM workspace_invitations wi
       JOIN workspaces w ON w.id = wi.workspace_id
       LEFT JOIN users u ON u.id = wi.invited_by
       WHERE wi.token = $1`,
      [req.params.token]
    );
    if (!inv) return res.status(404).json({ error: "Invitation not found or expired" });
    if (inv.accepted_at) return res.status(410).json({ error: "Invitation already accepted" });
    if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: "Invitation has expired" });

    res.json({
      email: inv.email,
      workspace_name: inv.workspace_name,
      inviter_name: inv.inviter_name,
      role: inv.role,
      is_new_user: inv.is_new_user,
    });
  } catch (err) { next(err); }
});

// POST /auth/accept-invite/:token — accept invitation
router.post("/accept-invite/:token", async (req, res, next) => {
  try {
    const { password } = req.body;

    const { rows: [inv] } = await query(
      `SELECT wi.*, w.name as workspace_name
       FROM workspace_invitations wi
       JOIN workspaces w ON w.id = wi.workspace_id
       WHERE wi.token = $1`,
      [req.params.token]
    );
    if (!inv) return res.status(404).json({ error: "Invitation not found" });
    if (inv.accepted_at) return res.status(410).json({ error: "Invitation already accepted" });
    if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: "Invitation has expired" });

    // New users must set a password
    if (inv.is_new_user) {
      if (!password || password.length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters" });
      }
      const hash = await bcrypt.hash(password, 12);
      await query("UPDATE users SET password_hash=$1, is_active=true, updated_at=NOW() WHERE id=$2", [hash, inv.user_id]);
    }

    // Add to workspace (for new users — first time; for existing — idempotent)
    await query(
      "INSERT INTO workspace_members (workspace_id, user_id, role, invited_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [inv.workspace_id, inv.user_id, inv.role, inv.invited_by]
    );

    // Mark invitation as accepted
    await query("UPDATE workspace_invitations SET accepted_at=NOW() WHERE id=$1", [inv.id]);
    await query("UPDATE users SET last_login_at=NOW() WHERE id=$1", [inv.user_id]);

    // Return JWT so user is auto-logged in
    const { rows: [user] } = await query(
      "SELECT id, org_id, email, name, role, settings FROM users WHERE id=$1",
      [inv.user_id]
    );
    const { rows: workspaces } = await query(
      `SELECT w.id, w.name, wm.role as workspace_role
       FROM workspaces w JOIN workspace_members wm ON wm.workspace_id = w.id
       WHERE wm.user_id = $1 ORDER BY w.created_at`,
      [inv.user_id]
    );

    const tokens = generateTokens(user.id);
    res.json({
      ...tokens,
      user: { id: user.id, email: user.email, name: user.name, role: user.role, orgId: user.org_id, settings: user.settings || {} },
      workspaces,
    });
  } catch (err) { next(err); }
});

// PATCH /auth/me — update user settings
router.patch("/me", requireAuth, async (req, res, next) => {
  try {
    const { settings } = req.body;
    if (!settings || typeof settings !== "object") {
      return res.status(400).json({ error: "settings object required" });
    }
    const { rows: [user] } = await query(
      `UPDATE users
       SET settings = settings || $1::jsonb, updated_at = NOW()
       WHERE id = $2
       RETURNING id, email, name, role, settings`,
      [JSON.stringify(settings), req.user.id]
    );
    res.json({ user });
  } catch (err) { next(err); }
});

module.exports = router;
