/**
 * Rule Engine — evaluates and applies automation rules.
 *
 * Condition DSL: { field, operator, value }
 *   Fields:    acos, roas, cpc, ctr, spend, clicks, impressions, orders, daily_budget, state
 *   Operators: gt(>), lt(<), gte(>=), lte(<=), eq(=), neq(!=)
 *
 * Action DSL: { type, value? }
 *   Types: adjust_bid, set_bid, adjust_budget, set_budget, pause_campaign, enable_campaign
 */

const { query } = require("../../db/pool");
const { put } = require("../amazon/adsClient");
const logger = require("../../config/logger");

// ─── Main entry point ─────────────────────────────────────────────────────────
/**
 * @param {string} workspaceId
 * @param {string|null} specificRuleId  — if set, only run this rule
 * @param {object} options
 * @param {boolean} options.forceDryRun   — override rule.dry_run; no changes applied
 * @param {boolean} options.saveExecution — persist rule_executions row (default true)
 */
async function executeRules(workspaceId, specificRuleId = null, options = {}) {
  const { forceDryRun = false, saveExecution = true } = options;

  // a) Load active rules
  const { rows: rules } = await query(
    `SELECT r.* FROM rules r
     WHERE r.workspace_id = $1 AND r.is_active = true
     AND ($2::uuid IS NULL OR r.id = $2)`,
    [workspaceId, specificRuleId]
  );

  if (!rules.length) return { executed: 0, results: [] };

  // b) Fetch entities (campaigns) with 7-day rolling metrics
  const { rows: entities } = await query(
    `SELECT c.id, c.amazon_campaign_id, c.name, c.state, c.daily_budget,
       c.campaign_type, c.profile_id,
       p.profile_id  AS amazon_profile_id,
       p.marketplace_id,
       p.connection_id,
       COALESCE(AVG(f.acos_14d),    0) AS acos,
       COALESCE(AVG(f.roas_14d),    0) AS roas,
       COALESCE(AVG(f.cpc),         0) AS cpc,
       COALESCE(AVG(f.ctr),         0) AS ctr,
       COALESCE(SUM(f.cost),        0) AS spend,
       COALESCE(SUM(f.clicks),      0) AS clicks,
       COALESCE(SUM(f.impressions), 0) AS impressions,
       COALESCE(SUM(f.orders_14d),  0) AS orders
     FROM campaigns c
     JOIN amazon_profiles p ON p.id = c.profile_id
     LEFT JOIN fact_metrics_daily f
       ON f.entity_id = c.id AND f.date >= NOW() - INTERVAL '7 days'
     WHERE c.workspace_id = $1 AND c.state != 'archived'
     GROUP BY c.id, p.profile_id, p.marketplace_id, p.connection_id`,
    [workspaceId]
  );

  const results = [];

  for (const rule of rules) {
    const startedAt = new Date();
    let executionId = null;

    try {
      const conditions = parseJSON(rule.conditions) || [];
      const actions    = parseJSON(rule.actions)    || [];
      const safety     = parseJSON(rule.safety)     || {};
      const isDryRun   = forceDryRun || rule.dry_run;

      // Create execution record
      if (saveExecution) {
        const { rows: [exec] } = await query(
          `INSERT INTO rule_executions (rule_id, workspace_id, entities_evaluated, dry_run, status)
           VALUES ($1, $2, $3, $4, 'running') RETURNING id`,
          [rule.id, workspaceId, entities.length, isDryRun]
        );
        executionId = exec.id;
      }

      // c) Evaluate conditions (AND logic)
      const condArr = Array.isArray(conditions) ? conditions : [conditions];
      const actArr  = Array.isArray(actions)    ? actions    : [actions];
      const matched = entities.filter((e) => evaluateConditions(e, condArr));

      const summary      = [];
      let actionsTaken   = 0;
      let actionsFailed  = 0;

      // d/e) Apply actions to matched entities
      for (const entity of matched) {
        for (const action of actArr) {
          try {
            const result = await applyAction(action, entity, safety, isDryRun);
            summary.push({
              entityName: entity.name,
              entityId:   entity.id,
              action:     action.type,
              oldValue:   result.oldValue,
              newValue:   result.newValue,
              applied:    result.applied,
            });
            if (result.applied) actionsTaken++;

            // f) Audit log for each applied change
            if (result.applied && !isDryRun) {
              await query(
                `INSERT INTO audit_events
                   (org_id, workspace_id, actor_type, actor_name, action,
                    entity_type, entity_id, entity_name, before_data, after_data, source)
                 SELECT w.org_id, $1, 'system', 'rule-engine', $2,
                        'campaign', $3, $4, $5::jsonb, $6::jsonb, 'system'
                 FROM workspaces w WHERE w.id = $1`,
                [
                  workspaceId,
                  `rule.${action.type}`,
                  entity.id,
                  entity.name,
                  JSON.stringify({ value: result.oldValue }),
                  JSON.stringify({ value: result.newValue }),
                ]
              );
            }
          } catch (e) {
            logger.error("Action apply failed", {
              ruleId: rule.id, entityId: entity.id, action: action.type, error: e.message,
            });
            summary.push({
              entityName: entity.name, entityId: entity.id,
              action: action.type, error: e.message, applied: false,
            });
            actionsFailed++;
          }
        }
      }

      const completedAt = new Date();

      // f) Update execution record
      if (saveExecution && executionId) {
        await query(
          `UPDATE rule_executions SET
             completed_at = $1, entities_matched = $2, actions_taken = $3,
             actions_failed = $4, summary = $5, status = 'success'
           WHERE id = $6`,
          [completedAt, matched.length, actionsTaken, actionsFailed,
           JSON.stringify(summary), executionId]
        );
      }

      // g) Update rule stats
      if (saveExecution) {
        await query(
          `UPDATE rules SET
             last_run_at = NOW(), last_run_status = 'success',
             run_count = COALESCE(run_count, 0) + 1
           WHERE id = $1`,
          [rule.id]
        );
      }

      const ruleResult = {
        ruleId: rule.id, name: rule.name,
        entitiesEvaluated: entities.length,
        matched: matched.length, actionsTaken, actionsFailed, isDryRun, summary,
      };
      results.push(ruleResult);
      logger.info("Rule executed", { ruleId: rule.id, matched: matched.length, actionsTaken, isDryRun });
    } catch (e) {
      logger.error("Rule execution failed", { ruleId: rule.id, error: e.message });

      if (saveExecution) {
        if (executionId) {
          await query(
            `UPDATE rule_executions SET status = 'error', error_message = $1, completed_at = NOW() WHERE id = $2`,
            [e.message, executionId]
          ).catch(() => {});
        }
        await query(
          `UPDATE rules SET last_run_at = NOW(), last_run_status = 'error' WHERE id = $1`,
          [rule.id]
        ).catch(() => {});
      }
    }
  }

  return { executed: rules.length, results };
}

// ─── c) Condition evaluator ───────────────────────────────────────────────────
function evaluateConditions(entity, conditions) {
  return conditions.every(({ field, operator, value }) => {
    const entityVal = parseFloat(entity[field] ?? 0);
    switch (operator) {
      case "gt":  return entityVal >  value;
      case "lt":  return entityVal <  value;
      case "gte": return entityVal >= value;
      case "lte": return entityVal <= value;
      case "eq":  return entityVal === value;
      case "neq": return entityVal !== value;
      default:    return false;
    }
  });
}

// ─── d) Action applier ────────────────────────────────────────────────────────
async function applyAction(action, entity, safety, isDryRun) {
  const {
    max_change_pct = 20,
    min_bid    = 0.02, max_bid    = 50,
    min_budget = 1,    max_budget = 10000,
  } = safety || {};

  let oldValue, newValue;

  switch (action.type) {
    case "adjust_bid": {
      const { rows } = await query(
        `SELECT COALESCE(AVG(bid), 0.30) AS avg_bid FROM keywords WHERE campaign_id = $1 AND state = 'enabled'`,
        [entity.id]
      );
      oldValue = parseFloat(rows[0].avg_bid);
      const pct = Math.min(Math.abs(action.value), max_change_pct) * Math.sign(action.value);
      newValue = clamp(oldValue * (1 + pct / 100), min_bid, max_bid);
      if (!isDryRun) {
        await query(
          `UPDATE keywords SET bid = $1, updated_at = NOW() WHERE campaign_id = $2 AND state = 'enabled'`,
          [newValue, entity.id]
        );
        await tryApiUpdate(entity, "keyword_bid", newValue);
      }
      break;
    }

    case "set_bid": {
      const { rows } = await query(
        `SELECT COALESCE(AVG(bid), 0) AS avg_bid FROM keywords WHERE campaign_id = $1 AND state = 'enabled'`,
        [entity.id]
      );
      oldValue = parseFloat(rows[0].avg_bid);
      newValue = clamp(action.value, min_bid, max_bid);
      if (!isDryRun) {
        await query(
          `UPDATE keywords SET bid = $1, updated_at = NOW() WHERE campaign_id = $2 AND state = 'enabled'`,
          [newValue, entity.id]
        );
        await tryApiUpdate(entity, "keyword_bid", newValue);
      }
      break;
    }

    case "adjust_budget": {
      oldValue = parseFloat(entity.daily_budget || 0);
      const pct = Math.min(Math.abs(action.value), max_change_pct) * Math.sign(action.value);
      newValue = clamp(oldValue * (1 + pct / 100), min_budget, max_budget);
      if (!isDryRun) {
        await query(
          `UPDATE campaigns SET daily_budget = $1, updated_at = NOW() WHERE id = $2`,
          [newValue, entity.id]
        );
        await tryApiUpdate(entity, "campaign_budget", newValue);
      }
      break;
    }

    case "set_budget": {
      oldValue = parseFloat(entity.daily_budget || 0);
      newValue = clamp(action.value, min_budget, max_budget);
      if (!isDryRun) {
        await query(
          `UPDATE campaigns SET daily_budget = $1, updated_at = NOW() WHERE id = $2`,
          [newValue, entity.id]
        );
        await tryApiUpdate(entity, "campaign_budget", newValue);
      }
      break;
    }

    case "pause_campaign": {
      oldValue = entity.state;
      newValue = "paused";
      if (!isDryRun) {
        await query(
          `UPDATE campaigns SET state = 'paused', updated_at = NOW() WHERE id = $1`,
          [entity.id]
        );
        await tryApiUpdate(entity, "campaign_state", "paused");
      }
      break;
    }

    case "enable_campaign": {
      oldValue = entity.state;
      newValue = "enabled";
      if (!isDryRun) {
        await query(
          `UPDATE campaigns SET state = 'enabled', updated_at = NOW() WHERE id = $1`,
          [entity.id]
        );
        await tryApiUpdate(entity, "campaign_state", "enabled");
      }
      break;
    }

    default:
      throw new Error(`Unknown action type: ${action.type}`);
  }

  return { oldValue, newValue, applied: !isDryRun };
}

// ─── Amazon API update (non-fatal on error) ───────────────────────────────────
async function tryApiUpdate(entity, updateType, newValue) {
  try {
    if (!entity.connection_id || !entity.amazon_profile_id) return;

    if (updateType === "campaign_state" || updateType === "campaign_budget") {
      const campaignUpdate = { campaignId: entity.amazon_campaign_id };
      if (updateType === "campaign_state")  campaignUpdate.state       = newValue;
      if (updateType === "campaign_budget") campaignUpdate.dailyBudget = newValue;

      const path =
        entity.campaign_type === "sponsoredProducts" ? "/sp/campaigns" :
        entity.campaign_type === "sponsoredBrands"   ? "/sb/campaigns" :
        "/sd/campaigns";

      await put({
        connectionId: entity.connection_id,
        profileId:    entity.amazon_profile_id.toString(),
        marketplace:  entity.marketplace_id,
        path,
        data:         { campaigns: [campaignUpdate] },
        group:        "campaigns",
      });
    }
    // Note: keyword bid sync via Amazon API requires keyword-level IDs; local DB update is sufficient for now
  } catch (e) {
    logger.warn("Amazon API update failed (non-fatal, local DB updated)", {
      error: e.message, updateType,
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

function parseJSON(val) {
  if (!val) return null;
  if (typeof val === "string") {
    try { return JSON.parse(val); } catch { return null; }
  }
  return val;
}

module.exports = { executeRules, evaluateConditions };
