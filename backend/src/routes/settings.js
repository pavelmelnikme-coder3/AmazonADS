const express = require("express");
const bcrypt = require("bcryptjs");
const { query } = require("../db/pool");
const { requireAuth, requireWorkspace } = require("../middleware/auth");

const router = express.Router();
router.use(requireAuth, requireWorkspace);

// ─── Permission system ────────────────────────────────────────────────────────
const PERMS = {
  owner:       ["read","write","invite","remove","manage_roles","delete_workspace","manage_billing"],
  admin:       ["read","write","invite","remove","manage_roles"],
  analyst:     ["read","write"],
  media_buyer: ["read","write"],
  ai_operator: ["read","write"],
  read_only:   ["read"],
};
const can = (userRole, action) => (PERMS[userRole] || []).includes(action);

function requirePerm(action) {
  return (req, res, next) => {
    const role = req.workspaceRole;
    if (!role) return res.status(403).json({ error: "Not a workspace member" });
    if (!can(role, action)) return res.status(403).json({ error: `Requires permission: ${action}`, yourRole: role });
    next();
  };
}

// ─── Workspace settings ───────────────────────────────────────────────────────
router.get("/workspace", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT w.*, o.name as org_name, o.plan, o.slug
       FROM workspaces w JOIN organizations o ON o.id = w.org_id
       WHERE w.id = $1`,
      [req.workspaceId]
    );
    if (!rows.length) return res.status(404).json({ error: "Workspace not found" });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

router.patch("/workspace", requirePerm("write"), async (req, res, next) => {
  try {
    const { name, description, settings } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Workspace name is required" });
    const { rows: [ws] } = await query(
      `UPDATE workspaces SET name=$1, description=$2, settings=$3, updated_at=NOW()
       WHERE id=$4 RETURNING *`,
      [name.trim(), description || null, JSON.stringify(settings || {}), req.workspaceId]
    );
    res.json(ws);
  } catch (err) { next(err); }
});

// ─── Team members ─────────────────────────────────────────────────────────────
router.get("/members", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.role as org_role, u.last_login_at, u.created_at,
              wm.role as workspace_role, u.is_active
       FROM workspace_members wm
       JOIN users u ON u.id = wm.user_id
       WHERE wm.workspace_id = $1
       ORDER BY wm.role, u.name`,
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/members/invite", requirePerm("invite"), async (req, res, next) => {
  try {
    const { email, name, workspace_role } = req.body;

    // Validate email
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Valid email is required" });
    }
    // Validate role (cannot invite as owner)
    const VALID_ROLES = ["admin","analyst","media_buyer","ai_operator","read_only"];
    if (!VALID_ROLES.includes(workspace_role)) {
      return res.status(400).json({ error: `workspace_role must be one of: ${VALID_ROLES.join(", ")}` });
    }

    // Check if already a workspace member
    const { rows: existing } = await query(
      `SELECT u.id FROM users u
       JOIN workspace_members wm ON wm.user_id = u.id
       WHERE u.email = $1 AND wm.workspace_id = $2`,
      [email.toLowerCase(), req.workspaceId]
    );
    if (existing.length) return res.status(409).json({ error: "User is already a member of this workspace" });

    // Check if user exists in org
    const { rows: existingUsers } = await query(
      "SELECT id FROM users WHERE email = $1 AND org_id = $2",
      [email.toLowerCase(), req.orgId]
    );

    let userId, isNewUser;
    if (existingUsers.length) {
      userId = existingUsers[0].id;
      isNewUser = false;
    } else {
      // Create user with temp password, they'll need to reset
      const tempHash = await bcrypt.hash(Math.random().toString(36) + Date.now(), 10);
      const { rows: [newUser] } = await query(
        `INSERT INTO users (org_id, email, password_hash, name, role)
         VALUES ($1, $2, $3, $4, 'analyst') RETURNING id`,
        [req.orgId, email.toLowerCase(), tempHash, name || email.split("@")[0]]
      );
      userId = newUser.id;
      isNewUser = true;
      // In production, send invite email. For now, log it.
      console.log(`[INVITE] New user created: ${email}, invite link would be sent here`);
    }

    await query(
      "INSERT INTO workspace_members (workspace_id, user_id, role, invited_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [req.workspaceId, userId, workspace_role, req.user.id]
    );

    res.status(201).json({ invited: true, user_id: userId, isNewUser });
  } catch (err) { next(err); }
});

router.patch("/members/:userId/role", requirePerm("manage_roles"), async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { role } = req.body;

    const VALID_ROLES = ["admin","analyst","media_buyer","ai_operator","read_only"];
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: "Invalid role. Cannot assign owner role." });
    }

    // Check target member exists and isn't owner
    const { rows: [member] } = await query(
      "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
      [req.workspaceId, userId]
    );
    if (!member) return res.status(404).json({ error: "Member not found" });
    if (member.role === "owner") return res.status(403).json({ error: "Cannot change the owner's role" });

    await query(
      "UPDATE workspace_members SET role=$1 WHERE workspace_id=$2 AND user_id=$3",
      [role, req.workspaceId, userId]
    );
    res.json({ ok: true, role });
  } catch (err) { next(err); }
});

router.delete("/members/:userId", requirePerm("remove"), async (req, res, next) => {
  try {
    const { userId } = req.params;

    if (userId === req.user.id) return res.status(400).json({ error: "Cannot remove yourself" });

    const { rows: [member] } = await query(
      "SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
      [req.workspaceId, userId]
    );
    if (!member) return res.status(404).json({ error: "Member not found" });
    if (member.role === "owner") return res.status(403).json({ error: "Cannot remove the workspace owner" });

    await query(
      "DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2",
      [req.workspaceId, userId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Profile ──────────────────────────────────────────────────────────────────
router.get("/profile", async (req, res, next) => {
  try {
    const { rows: [user] } = await query(
      "SELECT id, name, email, role, last_login_at, created_at, avatar_url, timezone, locale FROM users WHERE id=$1",
      [req.user.id]
    );
    res.json(user);
  } catch (err) { next(err); }
});

router.patch("/profile", async (req, res, next) => {
  try {
    const { name, email } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Name is required" });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "Valid email is required" });
    }
    // Check email uniqueness
    const { rows: clash } = await query(
      "SELECT id FROM users WHERE email=$1 AND id != $2",
      [email.toLowerCase(), req.user.id]
    );
    if (clash.length) return res.status(409).json({ error: "Email already in use" });

    const { rows: [user] } = await query(
      `UPDATE users SET name=$1, email=$2, updated_at=NOW()
       WHERE id=$3 RETURNING id, name, email, role, last_login_at`,
      [name.trim(), email.toLowerCase(), req.user.id]
    );
    res.json(user);
  } catch (err) { next(err); }
});

router.patch("/profile/password", async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;
    if (!new_password || new_password.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }

    const { rows: [user] } = await query(
      "SELECT password_hash FROM users WHERE id=$1",
      [req.user.id]
    );
    const valid = await bcrypt.compare(current_password, user.password_hash);
    if (!valid) return res.status(400).json({ error: "Current password is incorrect" });

    const hash = await bcrypt.hash(new_password, 12);
    await query("UPDATE users SET password_hash=$1, updated_at=NOW() WHERE id=$2", [hash, req.user.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Notifications ────────────────────────────────────────────────────────────
const DEFAULT_NOTIFS = {
  email_alerts: true, email_weekly_report: true, email_ai_summary: false,
  alert_acos: true, alert_budget: true, alert_roas: true, alert_zero_spend: false,
};

router.get("/notifications", async (req, res, next) => {
  try {
    const { rows: [ws] } = await query(
      "SELECT settings FROM workspaces WHERE id=$1",
      [req.workspaceId]
    );
    const settings = typeof ws.settings === "string" ? JSON.parse(ws.settings) : (ws.settings || {});
    res.json({ ...DEFAULT_NOTIFS, ...(settings.notifications || {}) });
  } catch (err) { next(err); }
});

router.patch("/notifications", async (req, res, next) => {
  try {
    await query(
      `UPDATE workspaces SET settings = jsonb_set(COALESCE(settings, '{}'), '{notifications}', $1::jsonb), updated_at=NOW()
       WHERE id=$2`,
      [JSON.stringify(req.body), req.workspaceId]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ─── Danger zone ──────────────────────────────────────────────────────────────
router.delete("/workspace", requirePerm("delete_workspace"), async (req, res, next) => {
  try {
    await query(
      "UPDATE workspaces SET is_active=false, updated_at=NOW() WHERE id=$1",
      [req.workspaceId]
    );
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

module.exports = router;
