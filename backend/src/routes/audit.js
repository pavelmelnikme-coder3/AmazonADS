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

    if (entityType)           { conditions.push(`entity_type = $${pi++}`);                               params.push(entityType); }
    if (source)               { conditions.push(`source = $${pi++}`);                                    params.push(source); }
    if (actorId)              { conditions.push(`actor_id = $${pi++}`);                                   params.push(actorId); }
    if (req.query.action)     { conditions.push(`action ILIKE $${pi++}`);                                 params.push(`%${req.query.action}%`); }
    if (req.query.entityName) { conditions.push(`entity_name ILIKE $${pi++}`);                            params.push(`%${req.query.entityName}%`); }
    if (req.query.dateFrom)   { conditions.push(`created_at >= $${pi++}`);                                params.push(req.query.dateFrom); }
    if (req.query.dateTo)     { conditions.push(`created_at < $${pi++}::date + interval '1 day'`);        params.push(req.query.dateTo); }
    if (req.query.rollbackable === "true") {
      conditions.push(`before_data IS NOT NULL`);
      conditions.push(`action NOT LIKE '%.rollback'`);
      conditions.push(`entity_type IN ('keyword', 'campaign')`);
    }

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
        `SELECT id, actor_id, actor_name, actor_type, action, entity_type, entity_id, entity_name,
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

// POST /audit/:id/rollback
router.post("/:id/rollback", async (req, res, next) => {
  try {
    const { rows: [event] } = await query(
      "SELECT * FROM audit_events WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    if (!event) return res.status(404).json({ error: "Audit event not found" });
    if (!event.before_data) return res.status(400).json({ error: "No before_data — cannot rollback this event" });

    const before = typeof event.before_data === "string" ? JSON.parse(event.before_data) : event.before_data;
    let rolled_back = false;
    let message = "";

    if (event.entity_type === "keyword" &&
        (event.action === "keyword.bid_change" || event.action === "keyword.adjust_bid_pct" || event.action === "keyword.set_bid")) {
      await query(
        "UPDATE keywords SET bid = $1, updated_at = NOW() WHERE id = $2 AND workspace_id = $3",
        [before.bid, event.entity_id, req.workspaceId]
      );
      rolled_back = true;
      message = `Bid restored to ${before.bid}`;
    } else if (event.entity_type === "keyword" &&
               (event.action === "keyword.pause_keyword" || event.action === "keyword.enable_keyword" || event.action === "keyword.state_change")) {
      await query(
        "UPDATE keywords SET state = $1, updated_at = NOW() WHERE id = $2 AND workspace_id = $3",
        [before.state, event.entity_id, req.workspaceId]
      );
      rolled_back = true;
      message = `State restored to ${before.state}`;
    } else if (event.entity_type === "campaign" && event.action === "campaign.update") {
      const fields = [], vals = [];
      let pi = 1;
      if (before.state        !== undefined) { fields.push(`state = $${pi++}`);        vals.push(before.state); }
      if (before.dailyBudget  !== undefined) { fields.push(`daily_budget = $${pi++}`); vals.push(before.dailyBudget); }
      if (fields.length > 0) {
        fields.push(`updated_at = NOW()`);
        vals.push(event.entity_id, req.workspaceId);
        await query(
          `UPDATE campaigns SET ${fields.join(", ")} WHERE id = $${pi++} AND workspace_id = $${pi}`,
          vals
        );
        rolled_back = true;
        message = `Campaign restored to previous state`;
      }
    } else {
      return res.status(400).json({
        error: "Rollback not supported for this event type",
        entity_type: event.entity_type,
        action: event.action,
      });
    }

    if (rolled_back) {
      await writeAudit({
        orgId:       event.org_id,
        workspaceId: req.workspaceId,
        actorId:     req.user.id,
        actorName:   req.user.name,
        action:      `${event.action}.rollback`,
        entityType:  event.entity_type,
        entityId:    event.entity_id,
        entityName:  event.entity_name,
        beforeData:  typeof event.after_data  === "string" ? JSON.parse(event.after_data)  : event.after_data,
        afterData:   before,
        source: "ui",
      });
    }

    res.json({ ok: rolled_back, message, original_event_id: event.id });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.writeAudit = writeAudit;
