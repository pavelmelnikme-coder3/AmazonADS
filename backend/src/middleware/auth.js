const jwt = require("jsonwebtoken");
const { query } = require("../db/pool");

/**
 * Verify JWT and attach user to request.
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const token = authHeader.slice(7);
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    const { rows } = await query(
      "SELECT id, org_id, email, name, role, is_active FROM users WHERE id = $1",
      [payload.userId]
    );

    if (!rows.length || !rows[0].is_active) {
      return res.status(401).json({ error: "User not found or inactive" });
    }

    req.user = rows[0];
    req.orgId = rows[0].org_id;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired", code: "TOKEN_EXPIRED" });
    }
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({ error: "Invalid token" });
    }
    next(err);
  }
}

/**
 * Verify workspace membership and attach workspaceId to request.
 * Expects workspaceId in header, query param, or route param.
 */
async function requireWorkspace(req, res, next) {
  const workspaceId = req.headers["x-workspace-id"] || req.query.workspaceId || req.params.workspaceId;

  if (!workspaceId) {
    return res.status(400).json({ error: "Workspace ID required (x-workspace-id header or ?workspaceId query param)" });
  }

  const { rows } = await query(
    `SELECT w.id, w.org_id, w.name, wm.role as workspace_role
     FROM workspaces w
     LEFT JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $1
     WHERE w.id = $2 AND w.org_id = $3`,
    [req.user.id, workspaceId, req.orgId]
  );

  if (!rows.length) {
    return res.status(403).json({ error: "Workspace not found or access denied" });
  }

  req.workspace    = rows[0];
  req.workspaceId  = workspaceId;
  req.workspaceRole = rows[0].workspace_role || null;
  next();
}

/**
 * Role-based access check.
 * Usage: requireRole("admin", "owner")
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Authentication required" });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: `Requires role: ${roles.join(" or ")}. Your role: ${req.user.role}`,
      });
    }
    next();
  };
}

module.exports = { requireAuth, requireWorkspace, requireRole };
