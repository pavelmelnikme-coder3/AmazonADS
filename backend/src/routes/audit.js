const express = require("express");
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");

const router = express.Router();
router.use(requireAuth, requireWorkspace);

/**
 * Write an audit event. Can be called internally from any route.
 */
async function writeAudit({
  orgId, workspaceId, actorId, actorType = "user", actorName,
  action, entityType, entityId, entityName,
  beforeData, afterData, source = "ui", requestId
}) {
  let diff = null;
  if (beforeData && afterData) {
    diff = {};
    const keys = new Set([...Object.keys(beforeData), ...Object.keys(afterData)]);
    for (const k of keys) {
      if (beforeData[k] !== afterData[k]) {
        diff[k] = { before: beforeData[k], after: afterData[k] };
      }
    }
  }

  await query(
    `INSERT INTO audit_events
       (org_id, workspace_id, actor_id, actor_type, actor_name, action,
        entity_type, entity_id, entity_name, before_data, after_data, diff, source, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [
      orgId, workspaceId || null, actorId || null, actorType, actorName || null,
      action, entityType || null, entityId ? String(entityId) : null, entityName || null,
      beforeData ? JSON.stringify(beforeData) : null,
      afterData ? JSON.stringify(afterData) : null,
      diff ? JSON.stringify(diff) : null,
      source, requestId || null,
    ]
  );
}

// GET /audit
router.get("/", async (req, res, next) => {
  try {
    const VALID_LIMITS = [25, 50, 100, 200];
    const rawLimit = parseInt(req.query.limit);
    const limit = VALID_LIMITS.includes(rawLimit) ? rawLimit : 50;
    const { entityType, source, actorId, sortBy = "date", sortDir = "desc", page = 1 } = req.query;
    const offset = (parseInt(page) - 1) * limit;

    const conditions = ["workspace_id = $1"];
    const params = [req.workspaceId];
    let pi = 2;

    if (entityType) { conditions.push(`entity_type = $${pi++}`); params.push(entityType); }
    if (source) { conditions.push(`source = $${pi++}`); params.push(source); }
    if (actorId) { conditions.push(`actor_id = $${pi++}`); params.push(actorId); }

    const where = "WHERE " + conditions.join(" AND ");

    const allowedSort = {
      date:        "created_at",
      actor_name:  "actor_name",
      action:      "action",
      entity_type: "entity_type",
    };
    const orderField = allowedSort[sortBy] || "created_at";
    const orderDir = sortDir === "asc" ? "ASC" : "DESC";

    const [{ rows }, { rows: countRows }] = await Promise.all([
      query(
        `SELECT id, actor_name, actor_type, action, entity_type, entity_id, entity_name,
                before_data, after_data, diff, source, created_at
         FROM audit_events ${where}
         ORDER BY ${orderField} ${orderDir}
         LIMIT $${pi} OFFSET $${pi + 1}`,
        [...params, limit, offset]
      ),
      query(`SELECT COUNT(*) as total FROM audit_events ${where}`, params),
    ]);

    const total = parseInt(countRows[0].total);
    res.json({
      data: rows,
      pagination: { total, page: parseInt(page), limit, pages: Math.ceil(total / limit) },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.writeAudit = writeAudit;
