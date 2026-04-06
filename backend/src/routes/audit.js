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
      conditions.push(`action NOT LIKE '%.rollback'`);
      conditions.push(`(
        (before_data IS NOT NULL AND entity_type IN ('keyword', 'campaign', 'target'))
        OR (action = 'keyword.negative_added' AND entity_type IN ('negative_keyword', 'negative_target'))
        OR (action IN ('keyword.add_negative', 'target.add_negative') AND entity_type IN ('keyword', 'target'))
        OR (action = 'rule.add_negative_asin' AND entity_type = 'campaign')
      )`);
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

// GET /audit/entity/:entityId — last N audit events for a specific entity (for inline history popup)
router.get("/entity/:entityId", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const { rows } = await query(
      `SELECT id, actor_name, actor_type, action, before_data, after_data, diff, source, created_at
       FROM audit_events
       WHERE workspace_id = $1 AND entity_id = $2
       ORDER BY created_at DESC
       LIMIT $3`,
      [req.workspaceId, req.params.entityId, limit]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// POST /audit/:id/rollback
router.post("/:id/rollback", async (req, res, next) => {
  try {
    const { rows: [event] } = await query(
      "SELECT * FROM audit_events WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    if (!event) return res.status(404).json({ error: "Audit event not found" });
    // Negative additions don't have before_data (they're pure inserts), but are still rollbackable
    const isNegativeAddition = event.action === "keyword.negative_added" &&
      (event.entity_type === "negative_keyword" || event.entity_type === "negative_target");

    if (!event.before_data && !isNegativeAddition) {
      return res.status(400).json({ error: "No before_data — cannot rollback this event" });
    }

    const before = event.before_data
      ? (typeof event.before_data === "string" ? JSON.parse(event.before_data) : event.before_data)
      : null;
    let rolled_back = false;
    let message = "";

    if (isNegativeAddition && event.entity_type === "negative_keyword") {
      // ── Rollback: delete negative keyword from local DB ──
      const { rowCount } = await query(
        "DELETE FROM negative_keywords WHERE id = $1 AND workspace_id = $2",
        [event.entity_id, req.workspaceId]
      );
      if (rowCount > 0) {
        rolled_back = true;
        message = `Negative keyword "${event.entity_name}" removed. Note: if already synced to Amazon, remove it there manually or run Entity Sync after archiving on Amazon.`;
      } else {
        return res.status(404).json({ error: "Negative keyword not found — may have already been removed or synced with a different ID" });
      }

    } else if (isNegativeAddition && event.entity_type === "negative_target") {
      // ── Rollback: delete negative ASIN target from local DB ──
      const { rowCount } = await query(
        "DELETE FROM negative_targets WHERE id = $1 AND workspace_id = $2",
        [event.entity_id, req.workspaceId]
      );
      if (rowCount > 0) {
        rolled_back = true;
        message = `Negative ASIN target "${event.entity_name}" removed. Note: if already synced to Amazon, remove it there manually or run Entity Sync after archiving on Amazon.`;
      } else {
        return res.status(404).json({ error: "Negative ASIN target not found — may have already been removed or synced with a different ID" });
      }

    } else if (event.entity_type === "keyword" &&
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
    } else if (event.entity_type === "target" &&
               (event.action === "target.pause" || event.action === "target.enable")) {
      // ── Rollback: restore target state ──
      await query(
        "UPDATE targets SET state = $1, updated_at = NOW() WHERE id = $2 AND workspace_id = $3",
        [before.state, event.entity_id, req.workspaceId]
      );
      rolled_back = true;
      message = `Target state restored to ${before.state}`;

    } else if (event.entity_type === "target" && event.action === "target.adjust_bid_pct") {
      // ── Rollback: restore target bid ──
      await query(
        "UPDATE targets SET bid = $1, updated_at = NOW() WHERE id = $2 AND workspace_id = $3",
        [before.bid, event.entity_id, req.workspaceId]
      );
      rolled_back = true;
      message = `Target bid restored to ${before.bid}`;

    } else if (event.entity_type === "keyword" && event.action === "keyword.add_negative") {
      // ── Rollback: delete the negative keyword that was added by rule ──
      const afterData = typeof event.after_data === "string" ? JSON.parse(event.after_data) : event.after_data;
      const { rowCount } = await query(
        `DELETE FROM negative_keywords
         WHERE workspace_id = $1
           AND campaign_id = (SELECT campaign_id FROM keywords WHERE id = $2 LIMIT 1)
           AND LOWER(keyword_text) = LOWER($3)
           AND match_type = $4`,
        [req.workspaceId, event.entity_id, event.entity_name, afterData?.match_type]
      );
      if (rowCount > 0) {
        rolled_back = true;
        message = `Negative keyword "${event.entity_name}" removed. Note: if already synced to Amazon, remove it there manually.`;
      } else {
        return res.status(404).json({ error: "Negative keyword not found — may have already been removed" });
      }

    } else if (event.entity_type === "target" && event.action === "target.add_negative") {
      // ── Rollback: delete the negative target that was added by rule ──
      const { rowCount } = await query(
        `DELETE FROM negative_targets
         WHERE workspace_id = $1
           AND campaign_id = (SELECT campaign_id FROM targets WHERE id = $2 LIMIT 1)
           AND expression = (SELECT expression FROM targets WHERE id = $2 LIMIT 1)`,
        [req.workspaceId, event.entity_id]
      );
      if (rowCount > 0) {
        rolled_back = true;
        message = `Negative target removed. Note: if already synced to Amazon, remove it there manually.`;
      } else {
        return res.status(404).json({ error: "Negative target not found — may have already been removed" });
      }

    } else if (event.entity_type === "campaign" && event.action === "rule.add_negative_asin") {
      // ── Rollback: delete negative ASIN added by rule engine ──
      const afterData = typeof event.after_data === "string" ? JSON.parse(event.after_data) : event.after_data;
      const asin = afterData?.asin;
      if (!asin) return res.status(400).json({ error: "No ASIN in audit record — cannot rollback" });
      const { rowCount } = await query(
        `DELETE FROM negative_targets
         WHERE workspace_id = $1 AND campaign_id = $2
           AND expression @> $3::jsonb`,
        [req.workspaceId, event.entity_id,
         JSON.stringify([{ type: "asinSameAs", value: asin }])]
      );
      if (rowCount > 0) {
        rolled_back = true;
        message = `Negative ASIN ${asin} removed from campaign. Note: if already synced to Amazon, remove it there manually.`;
      } else {
        return res.status(404).json({ error: "Negative ASIN not found — may have already been removed" });
      }

    } else if (event.entity_type === "campaign" &&
               (event.action === "rule.pause_campaign" || event.action === "rule.enable_campaign")) {
      // ── Rollback: restore campaign state changed by rule engine ──
      const stateToRestore = before?.value ?? before?.state;
      if (!stateToRestore) return res.status(400).json({ error: "No state in audit before_data" });
      await query(
        "UPDATE campaigns SET state = $1, updated_at = NOW() WHERE id = $2 AND workspace_id = $3",
        [stateToRestore, event.entity_id, req.workspaceId]
      );
      rolled_back = true;
      message = `Campaign state restored to ${stateToRestore}`;

    } else if (event.entity_type === "campaign" &&
               (event.action === "rule.adjust_budget" || event.action === "rule.set_budget")) {
      // ── Rollback: restore campaign budget changed by rule engine ──
      const budgetToRestore = before?.value ?? before?.dailyBudget;
      if (budgetToRestore === undefined) return res.status(400).json({ error: "No budget in audit before_data" });
      await query(
        "UPDATE campaigns SET daily_budget = $1, updated_at = NOW() WHERE id = $2 AND workspace_id = $3",
        [budgetToRestore, event.entity_id, req.workspaceId]
      );
      rolled_back = true;
      message = `Campaign budget restored to ${budgetToRestore}`;

    } else if (event.entity_type === "campaign" &&
               (event.action === "rule.adjust_bid" || event.action === "rule.set_bid")) {
      // ── Rollback: restore keyword bids changed by rule engine (all enabled kws in campaign) ──
      const bidToRestore = before?.value;
      if (bidToRestore === undefined) return res.status(400).json({ error: "No bid in audit before_data" });
      await query(
        "UPDATE keywords SET bid = $1, updated_at = NOW() WHERE campaign_id = $2 AND state = 'enabled'",
        [bidToRestore, event.entity_id]
      );
      rolled_back = true;
      message = `Keywords bid restored to ~${bidToRestore} (was average before rule ran)`;

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
      const afterData = typeof event.after_data === "string" ? JSON.parse(event.after_data) : event.after_data;
      await writeAudit({
        orgId:       event.org_id,
        workspaceId: req.workspaceId,
        actorId:     req.user.id,
        actorName:   req.user.name,
        action:      `${event.action}.rollback`,
        entityType:  event.entity_type,
        entityId:    event.entity_id,
        entityName:  event.entity_name,
        // For negative additions: before=what existed (after_data), after=deleted (null)
        // For bid/state changes: before=after_data, after=before_data (restored value)
        beforeData:  afterData,
        afterData:   before,
        source: "ui",
      });
    }

    res.json({ ok: rolled_back, message, original_event_id: event.id });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.writeAudit = writeAudit;
