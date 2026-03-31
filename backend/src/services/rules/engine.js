/**
 * Rule Engine — evaluates and applies automation rules.
 *
 * Condition DSL: { field, operator, value }
 *   Fields:    acos, roas, cpc, ctr, spend, clicks, impressions, orders, daily_budget, state
 *   Operators: gt(>), lt(<), gte(>=), lte(<=), eq(=), neq(!=)
 *
 * Action DSL: { type, value? }
 *   Types: adjust_bid, set_bid, adjust_budget, set_budget, pause_campaign, enable_campaign
 *
 * Conflict-prevention layers:
 *   1. Priority — rules sorted by priority DESC; higher-priority rule claims the entity first.
 *   2. Within-run lock — once a rule claims entity+category in this execution cycle,
 *      subsequent lower-priority rules skip that entity+category.
 *   3. Cross-run cooldown (DB) — after a change is applied, the entity+category is locked
 *      for a cooldown window based on Amazon's propagation times:
 *        bid          → 1 h  (bids are auction-instant but data needs time to settle)
 *        budget       → 2 h  (Amazon propagates in 1-2 h)
 *        state_change → 2 h  (pause/enable)
 */

const { query } = require("../../db/pool");
const { put } = require("../amazon/adsClient");
const { pushKeywordUpdates, pushNegativeAsin } = require("../amazon/writeback");
const logger = require("../../config/logger");

// ─── Cooldown windows (seconds) ───────────────────────────────────────────────
const COOLDOWN_SECONDS = {
  bid:          3600,  // 1 hour
  budget:       7200,  // 2 hours
  state_change: 7200,  // 2 hours
};

// Maps action type → category used for locking
function getActionCategory(actionType) {
  switch (actionType) {
    case "adjust_bid":
    case "set_bid":
      return "bid";
    case "adjust_budget":
    case "set_budget":
      return "budget";
    case "pause_campaign":
    case "enable_campaign":
      return "state_change";
    case "add_negative_asin":
      return "other"; // Deduplication handled by DB pre-check; no cooldown lock needed
    default:
      return "other";
  }
}

// ─── Load active cooldowns for a workspace ────────────────────────────────────
async function loadCooldowns(workspaceId) {
  const { rows } = await query(
    `SELECT entity_id, action_category, locked_until, applied_by_rule_name
     FROM rule_entity_cooldowns
     WHERE workspace_id = $1 AND locked_until > NOW()`,
    [workspaceId]
  );
  // Map key: `${entityId}:${category}`
  const map = new Map();
  for (const row of rows) {
    map.set(`${row.entity_id}:${row.action_category}`, {
      lockedUntil: row.locked_until,
      byRule: row.applied_by_rule_name,
    });
  }
  return map;
}

// ─── Persist cooldown after applying a change ─────────────────────────────────
async function setCooldown(workspaceId, entityId, category, ruleId, ruleName) {
  const seconds = COOLDOWN_SECONDS[category] ?? 3600;
  await query(
    `INSERT INTO rule_entity_cooldowns
       (workspace_id, entity_id, entity_type, action_category, locked_until,
        applied_by_rule_id, applied_by_rule_name)
     VALUES ($1, $2, 'campaign', $3, NOW() + ($4 || ' seconds')::interval, $5, $6)
     ON CONFLICT (workspace_id, entity_id, action_category)
     DO UPDATE SET
       locked_until         = EXCLUDED.locked_until,
       applied_by_rule_id   = EXCLUDED.applied_by_rule_id,
       applied_by_rule_name = EXCLUDED.applied_by_rule_name,
       created_at           = NOW()`,
    [workspaceId, entityId, category, seconds, ruleId, ruleName]
  );
}

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

  // a) Load active rules — sorted by priority DESC so higher-priority rules claim entities first
  const { rows: rules } = await query(
    `SELECT r.* FROM rules r
     WHERE r.workspace_id = $1 AND r.is_active = true
     AND ($2::uuid IS NULL OR r.id = $2)
     ORDER BY r.priority DESC, r.created_at ASC`,
    [workspaceId, specificRuleId]
  );

  if (!rules.length) return { executed: 0, results: [] };

  // b) Fetch entities (campaigns) with 7-day rolling metrics
  const { rows: entities } = await query(
    `SELECT c.id, c.workspace_id, c.amazon_campaign_id, c.name, c.state, c.daily_budget,
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

  // Layer 3: load cross-run cooldowns from DB (skip only in forceDryRun / preview mode)
  const cooldowns = forceDryRun
    ? new Map()
    : await loadCooldowns(workspaceId);

  // Layer 2: within-run lock — tracks entity+category claimed in this cycle
  // key: `${entityId}:${category}` → { ruleId, ruleName }
  const claimedThisRun = new Map();

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
          const category = getActionCategory(action.type);
          const lockKey  = `${entity.id}:${category}`;

          // ── Layer 3: cross-run cooldown check ─────────────────────────────
          if (!isDryRun) {
            const cooldown = cooldowns.get(lockKey);
            if (cooldown) {
              const remaining = Math.ceil((new Date(cooldown.lockedUntil) - Date.now()) / 60000);
              logger.info("Rule action skipped — entity on cooldown", {
                ruleId: rule.id, entityId: entity.id, entityName: entity.name,
                category, lockedByRule: cooldown.byRule,
                remainingMinutes: remaining,
              });
              summary.push({
                entityName: entity.name, entityId: entity.id,
                action: action.type, applied: false,
                skipped: true,
                reason: `on cooldown (${remaining}m remaining, set by "${cooldown.byRule}")`,
              });
              continue;
            }
          }

          // ── Layer 2: within-run conflict check ────────────────────────────
          if (!isDryRun) {
            const claim = claimedThisRun.get(lockKey);
            if (claim) {
              logger.info("Rule action skipped — entity already claimed this run", {
                ruleId: rule.id, entityId: entity.id, entityName: entity.name,
                category, claimedByRule: claim.ruleName,
              });
              summary.push({
                entityName: entity.name, entityId: entity.id,
                action: action.type, applied: false,
                skipped: true,
                reason: `already modified this cycle by higher-priority rule "${claim.ruleName}"`,
              });
              continue;
            }
          }

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
            if (result.applied) {
              actionsTaken++;

              // ── Layer 2: claim entity+category for this run ───────────────
              claimedThisRun.set(lockKey, { ruleId: rule.id, ruleName: rule.name });

              // ── Layer 3: persist cooldown ─────────────────────────────────
              await setCooldown(workspaceId, entity.id, category, rule.id, rule.name)
                .catch(err => logger.warn("Failed to set cooldown", { error: err.message }));
            }

            // Audit log for each applied change
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
        priority: rule.priority ?? 50,
        entitiesEvaluated: entities.length,
        matched: matched.length, actionsTaken, actionsFailed, isDryRun, summary,
      };
      results.push(ruleResult);
      logger.info("Rule executed", {
        ruleId: rule.id, priority: rule.priority ?? 50,
        matched: matched.length, actionsTaken, isDryRun,
      });
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

    case "add_negative_asin": {
      const asinValue = String(action.value || "").trim().toUpperCase();
      if (!asinValue) throw new Error("add_negative_asin: missing ASIN value");
      oldValue = null;
      newValue = asinValue;

      if (!isDryRun) {
        // Pre-check: skip if this ASIN is already negated for this campaign
        const { rows: existing } = await query(
          `SELECT id FROM negative_targets WHERE campaign_id = $1 AND expression::text LIKE $2`,
          [entity.id, `%${asinValue}%`]
        );
        if (existing.length > 0) {
          return { oldValue: null, newValue: asinValue, applied: false };
        }

        const expression = JSON.stringify([{ type: "asinSameAs", value: asinValue }]);
        const fakeId = `rule_${entity.id.replace(/-/g, "").slice(0, 8)}_${asinValue}_${Date.now()}`;
        const { rows: [ins] } = await query(
          `INSERT INTO negative_targets
             (workspace_id, profile_id, campaign_id, amazon_neg_target_id,
              ad_type, expression, expression_type, level)
           VALUES ($1,$2,$3,$4,'SP',$5,'manual','campaign')
           ON CONFLICT (profile_id, amazon_neg_target_id) DO NOTHING
           RETURNING id`,
          [entity.workspace_id, entity.profile_id, entity.id, fakeId, expression]
        );
        if (ins) {
          pushNegativeAsin({
            localId: ins.id,
            connectionId: entity.connection_id,
            profileId: entity.amazon_profile_id?.toString(),
            marketplaceId: entity.marketplace_id,
            campaignType: entity.campaign_type,
            amazonCampaignId: entity.amazon_campaign_id,
            amazonAdGroupId: null,
            asinValue,
            level: "campaign",
          }).catch(err => logger.warn("Negative ASIN write-back (rule) failed", { error: err.message }));
        }
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
    if (updateType === "keyword_bid") {
      const { rows: kws } = await query(
        `SELECT amazon_keyword_id, bid FROM keywords
         WHERE campaign_id = $1 AND state = 'enabled' AND amazon_keyword_id IS NOT NULL`,
        [entity.id]
      );
      if (!kws.length) return;
      const kwUpdates = kws.map(k => ({
        amazonKeywordId: k.amazon_keyword_id,
        campaignType:    entity.campaign_type,
        connectionId:    entity.connection_id,
        profileId:       entity.amazon_profile_id?.toString(),
        marketplaceId:   entity.marketplace_id,
        bid:             parseFloat(k.bid),
      }));
      await pushKeywordUpdates(kwUpdates);
    }
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
