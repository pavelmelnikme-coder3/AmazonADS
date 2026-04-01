const crypto = require("crypto");
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { body, validationResult } = require("express-validator");
const { query } = require("../db/pool");
const { requireAuth } = require("../middleware/auth");
const { sendPasswordResetEmail } = require("../services/email");

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

const router = express.Router();

function generateTokens(userId) {
  const accessToken = jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: "7d" });
  return { accessToken };
}

// POST /auth/register — disabled, invite-only
router.post("/register", (req, res) => {
  res.status(403).json({ error: "Registration is closed. Contact an administrator to receive an invitation." });
});

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

// POST /auth/forgot-password
router.post("/forgot-password",
  [body("email").isEmail().normalizeEmail()],
  async (req, res, next) => {
    // Always return the same response to prevent user enumeration
    const SAFE_RESPONSE = { message: "If that email is registered, a reset link has been sent." };

    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.json(SAFE_RESPONSE);

    try {
      const { email } = req.body;
      const { rows: [user] } = await query(
        "SELECT id, email, name FROM users WHERE email = $1 AND is_active = true",
        [email]
      );

      if (!user) return res.json(SAFE_RESPONSE); // no hint that email doesn't exist

      // Invalidate any existing tokens for this user
      await query("DELETE FROM password_reset_tokens WHERE user_id = $1", [user.id]);

      // Generate a cryptographically secure token
      const rawToken   = crypto.randomBytes(32).toString("hex"); // 64-char hex
      const tokenHash  = hashToken(rawToken);
      const expiresAt  = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await query(
        "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
        [user.id, tokenHash, expiresAt]
      );

      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
      const resetUrl = `${frontendUrl}/reset-password/${rawToken}`;

      try {
        await sendPasswordResetEmail({ to: user.email, resetUrl });
      } catch (emailErr) {
        // Log but don't expose email failures — token is created, admin can resend manually
        const logger = require("../config/logger");
        logger.error("Password reset email failed", { userId: user.id, error: emailErr.message });
      }

      res.json(SAFE_RESPONSE);
    } catch (err) { next(err); }
  }
);

// POST /auth/reset-password/:token
router.post("/reset-password/:token",
  [body("password").isLength({ min: 8 })],
  async (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: "Password must be at least 8 characters" });

    try {
      const tokenHash = hashToken(req.params.token);

      const { rows: [record] } = await query(
        `SELECT prt.*, u.id as uid
         FROM password_reset_tokens prt
         JOIN users u ON u.id = prt.user_id
         WHERE prt.token_hash = $1`,
        [tokenHash]
      );

      if (!record)                            return res.status(400).json({ error: "Invalid or expired reset link." });
      if (record.used_at)                     return res.status(400).json({ error: "This reset link has already been used." });
      if (new Date(record.expires_at) < new Date()) return res.status(400).json({ error: "This reset link has expired. Please request a new one." });

      const { password } = req.body;
      const hash = await bcrypt.hash(password, 12);

      await query("UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2", [hash, record.user_id]);
      await query("UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1", [record.id]);

      res.json({ message: "Password updated successfully. You can now log in." });
    } catch (err) { next(err); }
  }
);

module.exports = router;
