/**
 * AI Assistant Routes
 * POST /run               — queue AI analysis job
 * GET  /recommendations   — list recommendations (filterable by status)
 * POST /recommendations/:id/apply   — apply a recommendation
 * POST /recommendations/:id/dismiss — dismiss a recommendation
 * POST /recommendations/:id/preview — dry-run preview of changes
 */

const express = require("express");
const router = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const { queueAiAnalysis } = require("../jobs/workers");
const { writeAudit } = require("./audit");
const logger = require("../config/logger");

router.use(requireAuth, requireWorkspace);

// ─── POST /run — queue AI analysis ────────────────────────────────────────────
router.post("/run", async (req, res, next) => {
  try {
    const locale = req.body.locale || req.headers["x-locale"] || "en";
    logger.info("AI analysis run requested", { workspaceId: req.workspaceId, locale });
    const job = await queueAiAnalysis(req.workspaceId, locale);
    res.json({ queued: true, jobId: job.id });
  } catch (err) {
    next(err);
  }
});

// ─── GET /recommendations — list recommendations ───────────────────────────────
router.get("/recommendations", async (req, res, next) => {
  try {
    const { status, limit = 20 } = req.query;
    const conditions = ["workspace_id = $1", "expires_at > NOW()"];
    const params = [req.workspaceId];
    let pi = 2;

    if (status && status !== "all") {
      conditions.push(`status = $${pi++}`);
      params.push(status);
    }

    const { rows } = await query(
      `SELECT * FROM ai_recommendations
       WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${pi}`,
      [...params, parseInt(limit)]
    );

    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ─── POST /recommendations/:id/preview — dry-run diff ─────────────────────────
router.post("/recommendations/:id/preview", async (req, res, next) => {
  try {
    const { rows: [rec] } = await query(
      "SELECT * FROM ai_recommendations WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    if (!rec) return res.status(404).json({ error: "Recommendation not found" });

    const actions = typeof rec.actions === "string" ? JSON.parse(rec.actions) : rec.actions;
    const changes = [];

    for (const action of actions) {
      if (action.entity_type === "campaign" && action.entity_id) {
        const { rows: [entity] } = await query(
          "SELECT id, name, state, daily_budget, bidding_strategy FROM campaigns WHERE id = $1 AND workspace_id = $2",
          [action.entity_id, req.workspaceId]
        );
        if (entity) {
          for (const [field, newValue] of Object.entries(action.params || {})) {
            changes.push({
              entity_type: "campaign",
              entity_id: entity.id,
              entity_name: entity.name,
              field,
              current_value: entity[field] ?? null,
              new_value: newValue,
            });
          }
        }
      } else if (action.entity_type === "keyword" && action.entity_id) {
        const { rows: [entity] } = await query(
          "SELECT id, keyword_text, bid, state FROM keywords WHERE id = $1 AND workspace_id = $2",
          [action.entity_id, req.workspaceId]
        );
        if (entity) {
          for (const [field, newValue] of Object.entries(action.params || {})) {
            changes.push({
              entity_type: "keyword",
              entity_id: entity.id,
              entity_name: entity.keyword_text,
              field,
              current_value: entity[field] ?? null,
              new_value: newValue,
            });
          }
        }
      }
    }

    res.json({ changes });
  } catch (err) {
    next(err);
  }
});

// ─── POST /recommendations/:id/apply — execute recommendation ─────────────────
router.post("/recommendations/:id/apply", async (req, res, next) => {
  try {
    const { rows: [rec] } = await query(
      "SELECT * FROM ai_recommendations WHERE id = $1 AND workspace_id = $2 AND status = 'pending'",
      [req.params.id, req.workspaceId]
    );
    if (!rec) return res.status(404).json({ error: "Recommendation not found or already actioned" });

    const actions = typeof rec.actions === "string" ? JSON.parse(rec.actions) : rec.actions;
    const applied = [];

    for (const action of actions) {
      try {
        if (action.entity_type === "campaign" && action.entity_id) {
          const params = action.params || {};
          const sets = [];
          const vals = [action.entity_id, req.workspaceId];
          let pi = 3;

          if (params.daily_budget !== undefined) {
            sets.push(`daily_budget = $${pi++}`);
            vals.push(parseFloat(params.daily_budget));
          }
          if (params.state !== undefined) {
            sets.push(`state = $${pi++}`);
            vals.push(params.state);
          }
          if (params.bidding_strategy !== undefined) {
            sets.push(`bidding_strategy = $${pi++}`);
            vals.push(params.bidding_strategy);
          }

          if (sets.length) {
            sets.push("updated_at = NOW()");
            await query(
              `UPDATE campaigns SET ${sets.join(", ")} WHERE id = $1 AND workspace_id = $2`,
              vals
            );
            applied.push({ action_type: action.action_type, entity: action.entity_id });
          }
        } else if (action.entity_type === "keyword" && action.entity_id) {
          const params = action.params || {};
          if (params.bid !== undefined) {
            await query(
              "UPDATE keywords SET bid = $1, updated_at = NOW() WHERE id = $2 AND workspace_id = $3",
              [parseFloat(params.bid), action.entity_id, req.workspaceId]
            );
            applied.push({ action_type: action.action_type, entity: action.entity_id });
          }
        }
      } catch (actionErr) {
        logger.warn("AI apply: action failed", { error: actionErr.message, action });
      }
    }

    // Mark as applied
    await query(
      "UPDATE ai_recommendations SET status = 'applied', applied_at = NOW(), applied_by = $1 WHERE id = $2",
      [req.user.id, rec.id]
    );

    // Audit log
    await writeAudit({
      orgId: req.orgId,
      actorId: req.user.id,
      actorName: req.user.name,
      actorType: "user",
      action: "ai.recommendation.applied",
      entityType: "ai_recommendation",
      entityId: rec.id,
      entityName: rec.title,
      afterData: { actions: applied },
      source: "ai",
    });

    res.json({ applied: true, actionsExecuted: applied.length });
  } catch (err) {
    next(err);
  }
});

// ─── POST /recommendations/:id/dismiss ────────────────────────────────────────
router.post("/recommendations/:id/dismiss", async (req, res, next) => {
  try {
    const { rowCount } = await query(
      "UPDATE ai_recommendations SET status = 'dismissed', dismissed_at = NOW() WHERE id = $1 AND workspace_id = $2 AND status = 'pending'",
      [req.params.id, req.workspaceId]
    );
    if (!rowCount) return res.status(404).json({ error: "Recommendation not found or already actioned" });
    res.json({ dismissed: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
