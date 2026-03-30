/**
 * Strategies Routes — Algorithm Stacking / Rule Chains
 *
 * A strategy is an ordered list of rules that execute in sequence.
 * Earlier rules can affect entities that later rules then evaluate.
 *
 * GET    /strategies              — list all strategies
 * POST   /strategies              — create
 * PATCH  /strategies/:id          — update (name, description, rule_ids, is_active)
 * DELETE /strategies/:id          — delete
 * POST   /strategies/:id/run      — execute strategy (all rules in order)
 * GET    /strategies/:id/runs     — execution history
 */

const express = require("express");
const router = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const { executeRules } = require("../services/rules/engine");
const logger = require("../config/logger");

router.use(requireAuth, requireWorkspace);

// ── GET /strategies ───────────────────────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const { rows: strategies } = await query(
      `SELECT s.*,
              COALESCE(
                (SELECT json_agg(json_build_object('id', r.id, 'name', r.name, 'is_active', r.is_active)
                 ORDER BY array_position(s.rule_ids, r.id))
                 FROM rules r WHERE r.id = ANY(s.rule_ids) AND r.workspace_id = s.workspace_id),
                '[]'
              ) AS rules
       FROM strategies s
       WHERE s.workspace_id = $1
       ORDER BY s.created_at DESC`,
      [req.workspaceId]
    );
    res.json(strategies);
  } catch (err) { next(err); }
});

// ── POST /strategies ──────────────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const { name, description, rule_ids = [], is_active = true } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "name required" });

    const { rows: [s] } = await query(
      `INSERT INTO strategies (workspace_id, name, description, rule_ids, is_active)
       VALUES ($1, $2, $3, $4::uuid[], $5) RETURNING *`,
      [req.workspaceId, name.trim(), description || null, rule_ids, is_active]
    );
    res.status(201).json(s);
  } catch (err) { next(err); }
});

// ── PATCH /strategies/:id ─────────────────────────────────────────────────────
router.patch("/:id", async (req, res, next) => {
  try {
    const { name, description, rule_ids, is_active } = req.body;
    const sets = [], vals = [];
    let pi = 1;
    if (name       !== undefined) { sets.push(`name = $${pi++}`);        vals.push(name.trim()); }
    if (description !== undefined) { sets.push(`description = $${pi++}`); vals.push(description); }
    if (rule_ids   !== undefined) { sets.push(`rule_ids = $${pi++}::uuid[]`); vals.push(rule_ids); }
    if (is_active  !== undefined) { sets.push(`is_active = $${pi++}`);   vals.push(is_active); }
    if (!sets.length) return res.status(400).json({ error: "nothing to update" });

    sets.push(`updated_at = NOW()`);
    vals.push(req.params.id, req.workspaceId);

    const { rows: [s] } = await query(
      `UPDATE strategies SET ${sets.join(", ")}
       WHERE id = $${pi++} AND workspace_id = $${pi} RETURNING *`,
      vals
    );
    if (!s) return res.status(404).json({ error: "Strategy not found" });
    res.json(s);
  } catch (err) { next(err); }
});

// ── DELETE /strategies/:id ────────────────────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    const { rowCount } = await query(
      "DELETE FROM strategies WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    if (!rowCount) return res.status(404).json({ error: "Strategy not found" });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /strategies/:id/run ──────────────────────────────────────────────────
router.post("/:id/run", async (req, res, next) => {
  try {
    const { dry_run = false } = req.body;

    const { rows: [strategy] } = await query(
      "SELECT * FROM strategies WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    if (!strategy) return res.status(404).json({ error: "Strategy not found" });
    if (!strategy.rule_ids?.length) return res.status(400).json({ error: "Strategy has no rules" });

    const startedAt = new Date();
    const ruleSummaries = [];
    let totalActions = 0;
    let executionStatus = "completed";
    let errorMessage = null;

    logger.info("Strategy execution started", {
      strategyId: strategy.id,
      workspaceId: req.workspaceId,
      ruleCount: strategy.rule_ids.length,
      dryRun: dry_run,
    });

    // Execute rules in order
    for (const ruleId of strategy.rule_ids) {
      try {
        const result = await executeRules(req.workspaceId, ruleId, {
          forceDryRun: dry_run,
          saveExecution: true,
        });
        const ruleResult = result.results?.[0] || {};
        const actions = ruleResult.actionsTaken || 0;
        totalActions += actions;
        ruleSummaries.push({
          ruleId,
          name: ruleResult.name,
          actionsTaken: actions,
          entitiesMatched: ruleResult.matched || 0,
          status: "ok",
        });
      } catch (e) {
        logger.warn("Strategy: rule execution failed (non-fatal, continuing)", {
          strategyId: strategy.id, ruleId, error: e.message,
        });
        ruleSummaries.push({ ruleId, status: "error", error: e.message });
        executionStatus = "completed_with_errors";
      }
    }

    const completedAt = new Date();

    // Save strategy execution record (pass explicit timestamps so duration is correct)
    const { rows: [exec] } = await query(
      `INSERT INTO strategy_executions
         (strategy_id, workspace_id, dry_run, status, rules_run, total_actions, summary, started_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        strategy.id, req.workspaceId, dry_run, executionStatus,
        strategy.rule_ids.length, totalActions, JSON.stringify(ruleSummaries),
        startedAt, completedAt,
      ]
    );

    // Update strategy last_run
    await query(
      "UPDATE strategies SET last_run_at = NOW(), last_run_status = $1, updated_at = NOW() WHERE id = $2",
      [executionStatus, strategy.id]
    );

    logger.info("Strategy execution completed", {
      strategyId: strategy.id, executionId: exec.id,
      rulesRun: strategy.rule_ids.length, totalActions, dryRun: dry_run, status: executionStatus,
    });

    res.json({
      executionId: exec.id,
      status: executionStatus,
      rulesRun: strategy.rule_ids.length,
      totalActions,
      dryRun: dry_run,
      durationMs: completedAt - startedAt,
      summary: ruleSummaries,
    });
  } catch (err) { next(err); }
});

// ── GET /strategies/:id/runs ──────────────────────────────────────────────────
router.get("/:id/runs", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const { rows } = await query(
      `SELECT id, dry_run, status, rules_run, total_actions, summary, error_message,
              started_at, completed_at
       FROM strategy_executions
       WHERE strategy_id = $1 AND workspace_id = $2
       ORDER BY started_at DESC
       LIMIT $3`,
      [req.params.id, req.workspaceId, limit]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

module.exports = router;
