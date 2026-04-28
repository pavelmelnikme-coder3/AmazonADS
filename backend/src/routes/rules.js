/**
 * Rules Engine Routes
 * GET    /rules                   — list with pagination
 * POST   /rules                   — create
 * PATCH  /rules/:id               — update
 * DELETE /rules/:id               — delete
 * POST   /rules/:id/run           — execute rule synchronously (dry_run flag)
 * GET    /rules/campaigns         — campaigns list for scope selector
 * GET    /rules/ad-groups         — ad-groups list (optionally filtered by campaignId)
 * GET    /rules/targets           — targets list for scope selector
 */

const express = require("express");
const router  = express.Router();
const { requireAuth, requireWorkspace } = require("../middleware/auth");
const { query } = require("../db/pool");
const { writeAudit } = require("./audit");
const { pushNegativeKeyword, pushNegativeAsin, pushKeywordUpdates } = require("../services/amazon/writeback");
const { put } = require("../services/amazon/adsClient");
const logger  = require("../config/logger");

router.use(requireAuth, requireWorkspace);

// ── Condition operators ───────────────────────────────────────────────────────
function evaluate(conditions, metrics) {
  return conditions.every(cond => {
    const val       = parseFloat(metrics[cond.metric] ?? 0);
    const threshold = parseFloat(cond.value);
    switch (cond.op) {
      case "gt":  return val >  threshold;
      case "gte": return val >= threshold;
      case "lt":  return val <  threshold;
      case "lte": return val <= threshold;
      case "eq":  return val === threshold;
      case "neq": return val !== threshold;
      default:    return false;
    }
  });
}

// ── Execute rule synchronously ────────────────────────────────────────────────
async function executeRule(rule, workspaceId, dryRun = false, actorId = null, actorName = "Rule Engine") {
  const conditions = typeof rule.conditions === "string" ? JSON.parse(rule.conditions) : rule.conditions;
  const actions    = typeof rule.actions    === "string" ? JSON.parse(rule.actions)    : rule.actions;
  const scope      = typeof rule.scope      === "string" ? JSON.parse(rule.scope)      : (rule.scope  || {});
  const safety     = typeof rule.safety     === "string" ? JSON.parse(rule.safety)     : (rule.safety || {});

  // Defense in depth: an empty conditions array makes `Array.prototype.every`
  // return true for every entity — so a rule with no conditions and a
  // pause/negative action would mass-affect EVERY keyword in scope. Reject
  // here regardless of where the rule came from (preview body, DB row, future
  // import path) so this can never happen by accident.
  if (!Array.isArray(conditions) || conditions.length === 0) {
    throw new Error("Rule must have at least one condition");
  }
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("Rule must have at least one action");
  }

  // ── Period ──────────────────────────────────────────────────────────────────
  const periodDays = parseInt(scope.period_days) || 14;
  let startDate, endDate;
  if (periodDays === 1) {
    const yesterday = new Date(Date.now() - 86400000).toISOString().split("T")[0];
    startDate = yesterday;
    endDate   = yesterday;
  } else {
    endDate   = new Date().toISOString().split("T")[0];
    startDate = new Date(Date.now() - periodDays * 86400000).toISOString().split("T")[0];
  }

  // Look up org_id once (needed for writeAudit)
  const { rows: [ws] } = await query("SELECT org_id FROM workspaces WHERE id = $1", [workspaceId]);
  const orgId = ws?.org_id || null;

  // Separate bid threshold conditions (applied in SQL WHERE) from metric conditions (post-fetch filter)
  const bidConditions    = conditions.filter(c => c.metric === "bid");
  const metricConditions = conditions.filter(c => c.metric !== "bid");

  const entityType = scope.entity_type || "keyword";
  const BID_OPS    = { gt: ">", gte: ">=", lt: "<", lte: "<=", eq: "=", neq: "!=" };

  // ── Helper: build campaign_name_contains clause ──────────────────────────────
  function addCampaignNameFilter(conds, params, piRef, alias = "c") {
    if (!scope.campaign_name_contains) return piRef;
    const names = scope.campaign_name_contains.split(",").map(s => s.trim()).filter(Boolean);
    if (!names.length) return piRef;
    const exclude = scope.campaign_name_mode === "exclude";
    const op = exclude ? "NOT ILIKE" : "ILIKE";
    const join = exclude ? " AND " : " OR ";
    if (names.length === 1) {
      conds.push(`${alias}.name ${op} $${piRef++}`);
      params.push(`%${names[0]}%`);
    } else {
      const parts = names.map(() => `${alias}.name ${op} $${piRef++}`).join(join);
      conds.push(`(${parts})`);
      params.push(...names.map(n => `%${n}%`));
    }
    return piRef;
  }

  // ── Fetch keywords ────────────────────────────────────────────────────────
  let keywords = [];
  if (entityType === "keyword") {
    const kConds  = ["k.workspace_id = $1"];
    const kParams = [workspaceId];
    let pi = 2;

    if (scope.campaign_ids?.length) {
      kConds.push(`k.campaign_id = ANY($${pi++}::uuid[])`);
      kParams.push(scope.campaign_ids);
    }
    if (scope.ad_group_ids?.length) {
      kConds.push(`k.ad_group_id = ANY($${pi++}::uuid[])`);
      kParams.push(scope.ad_group_ids);
    }
    if (scope.campaign_type) {
      kConds.push(`c.campaign_type = $${pi++}`);
      kParams.push(scope.campaign_type);
    }
    if (scope.match_types?.length) {
      kConds.push(`k.match_type = ANY($${pi++}::text[])`);
      kParams.push(scope.match_types);
    }
    if (scope.campaign_targeting_type) {
      kConds.push(`LOWER(c.targeting_type) = $${pi++}`);
      kParams.push(scope.campaign_targeting_type.toLowerCase());
    }
    pi = addCampaignNameFilter(kConds, kParams, pi);
    for (const bc of bidConditions) {
      kConds.push(`k.bid ${BID_OPS[bc.op] || ">="} $${pi++}`);
      kParams.push(parseFloat(bc.value));
    }
    kConds.push("k.state != 'archived'");

    const { rows } = await query(
      `SELECT
         k.id, k.keyword_text, k.match_type, k.state, k.bid,
         k.amazon_keyword_id,
         k.campaign_id, k.ad_group_id,
         c.name  AS campaign_name, c.campaign_type, c.amazon_campaign_id,
         ag.name AS ad_group_name, ag.amazon_ag_id AS amazon_ad_group_id,
         p.id    AS profile_db_id,
         p.profile_id  AS amazon_profile_id,
         p.connection_id,
         p.marketplace_id,
         COALESCE(SUM(m.clicks), 0)      AS clicks,
         COALESCE(SUM(m.cost),   0)      AS spend,
         COALESCE(SUM(m.sales_14d), 0)   AS sales,
         COALESCE(SUM(m.orders_14d), 0)  AS orders,
         COALESCE(SUM(m.impressions), 0) AS impressions,
         CASE WHEN COALESCE(SUM(m.sales_14d),0) > 0
              THEN SUM(m.cost)/SUM(m.sales_14d)*100 END  AS acos,
         CASE WHEN COALESCE(SUM(m.cost),0) > 0
              THEN SUM(m.sales_14d)/SUM(m.cost) END       AS roas,
         CASE WHEN COALESCE(SUM(m.impressions),0) > 0
              THEN SUM(m.clicks)::numeric/SUM(m.impressions)*100 END AS ctr,
         CASE WHEN COALESCE(SUM(m.clicks),0) > 0
              THEN SUM(m.cost)/SUM(m.clicks) END          AS cpc
       FROM keywords k
       JOIN campaigns  c  ON c.id  = k.campaign_id
       JOIN ad_groups  ag ON ag.id = k.ad_group_id
       JOIN amazon_profiles p ON p.id = c.profile_id
       LEFT JOIN fact_metrics_daily m
         ON m.amazon_id = k.amazon_keyword_id
         AND m.entity_type = 'keyword'
         AND m.date BETWEEN $${pi++} AND $${pi++}
       WHERE ${kConds.join(" AND ")}
       GROUP BY k.id, k.keyword_text, k.match_type, k.state, k.bid,
                k.amazon_keyword_id, k.campaign_id, k.ad_group_id,
                c.name, c.campaign_type, c.amazon_campaign_id,
                ag.name, ag.amazon_ag_id,
                p.id, p.profile_id, p.connection_id, p.marketplace_id`,
      [...kParams, startDate, endDate]
    );
    keywords = rows.map(r => ({ ...r, entity_type: "keyword" }));
  }

  // ── Fetch targets ─────────────────────────────────────────────────────────
  let targets = [];
  if (entityType === "product_target") {
    const tConds  = ["t.workspace_id = $1"];
    const tParams = [workspaceId];
    let tPi = 2;

    if (scope.campaign_ids?.length) {
      tConds.push(`t.campaign_id = ANY($${tPi++}::uuid[])`);
      tParams.push(scope.campaign_ids);
    }
    if (scope.ad_group_ids?.length) {
      tConds.push(`t.ad_group_id = ANY($${tPi++}::uuid[])`);
      tParams.push(scope.ad_group_ids);
    }
    if (scope.campaign_type) {
      tConds.push(`c.campaign_type = $${tPi++}`);
      tParams.push(scope.campaign_type);
    }
    tPi = addCampaignNameFilter(tConds, tParams, tPi);
    if (scope.campaign_targeting_type) {
      tConds.push(`LOWER(c.targeting_type) = $${tPi++}`);
      tParams.push(scope.campaign_targeting_type.toLowerCase());
    }
    if (scope.targeting_type) {
      const ttMap = { auto: "close-match", product: "asinSameAs", views: "views", audience: "audience" };
      const ttVal = ttMap[scope.targeting_type];
      if (ttVal) { tConds.push(`t.expression_type ILIKE $${tPi++}`); tParams.push(`%${ttVal}%`); }
    }
    if (scope.expression_type) {
      tConds.push(`t.expression_type = $${tPi++}`);
      tParams.push(scope.expression_type);
    }
    for (const bc of bidConditions) {
      tConds.push(`t.bid ${BID_OPS[bc.op] || ">="} $${tPi++}`);
      tParams.push(parseFloat(bc.value));
    }
    tConds.push("t.state != 'archived'");

    const { rows } = await query(
      `SELECT
         t.id, t.amazon_target_id, t.expression, t.expression_type,
         t.state, t.bid, t.campaign_id, t.ad_group_id, t.profile_id,
         c.name  AS campaign_name, c.campaign_type, c.amazon_campaign_id,
         ag.name AS ad_group_name, ag.amazon_ag_id AS amazon_ad_group_id,
         p.profile_id  AS amazon_profile_id,
         p.connection_id,
         p.marketplace_id,
         COALESCE(SUM(m.clicks), 0)      AS clicks,
         COALESCE(SUM(m.cost),   0)      AS spend,
         COALESCE(SUM(m.sales_14d), 0)   AS sales,
         COALESCE(SUM(m.orders_14d), 0)  AS orders,
         COALESCE(SUM(m.impressions), 0) AS impressions,
         CASE WHEN COALESCE(SUM(m.sales_14d),0) > 0
              THEN SUM(m.cost)/SUM(m.sales_14d)*100 END  AS acos,
         CASE WHEN COALESCE(SUM(m.cost),0) > 0
              THEN SUM(m.sales_14d)/SUM(m.cost) END       AS roas,
         CASE WHEN COALESCE(SUM(m.impressions),0) > 0
              THEN SUM(m.clicks)::numeric/SUM(m.impressions)*100 END AS ctr,
         CASE WHEN COALESCE(SUM(m.clicks),0) > 0
              THEN SUM(m.cost)/SUM(m.clicks) END          AS cpc
       FROM targets t
       JOIN campaigns  c  ON c.id  = t.campaign_id
       JOIN amazon_profiles p ON p.id = t.profile_id
       LEFT JOIN ad_groups ag ON ag.id = t.ad_group_id
       LEFT JOIN fact_metrics_daily m
         ON m.amazon_id = t.amazon_target_id
         AND m.entity_type = 'target'
         AND m.date BETWEEN $${tPi++} AND $${tPi++}
       WHERE ${tConds.join(" AND ")}
       GROUP BY t.id, t.amazon_target_id, t.expression, t.expression_type,
                t.state, t.bid, t.campaign_id, t.ad_group_id, t.profile_id,
                c.name, c.campaign_type, c.amazon_campaign_id,
                ag.name, ag.amazon_ag_id,
                p.profile_id, p.connection_id, p.marketplace_id`,
      [...tParams, startDate, endDate]
    );
    targets = rows.map(r => ({ ...r, entity_type: "target" }));
  }

  // ── Fetch search terms ────────────────────────────────────────────────────
  // Aggregates search_term_metrics over the period. Each entity represents one
  // (query, campaign, ad_group) combination. Synthetic state="enabled" so the
  // existing add_negative_keyword/add_negative_target handlers accept them.
  // The query text becomes the `keyword_text` so the negative-keyword writer
  // doesn't need a special branch.
  let searchTerms = [];
  if (entityType === "search_term") {
    const sConds  = ["stm.workspace_id = $1", "stm.date_start >= $2", "stm.date_end <= $3", "stm.campaign_id IS NOT NULL", "stm.ad_group_id IS NOT NULL"];
    const sParams = [workspaceId, startDate, endDate];
    let sPi = 4;

    if (scope.campaign_ids?.length) {
      sConds.push(`stm.campaign_id = ANY($${sPi++}::uuid[])`);
      sParams.push(scope.campaign_ids);
    }
    if (scope.ad_group_ids?.length) {
      sConds.push(`stm.ad_group_id = ANY($${sPi++}::uuid[])`);
      sParams.push(scope.ad_group_ids);
    }
    if (scope.campaign_type) {
      sConds.push(`c.campaign_type = $${sPi++}`);
      sParams.push(scope.campaign_type);
    }
    if (scope.match_types?.length) {
      sConds.push(`LOWER(stm.match_type) = ANY($${sPi++}::text[])`);
      sParams.push(scope.match_types.map(m => m.toLowerCase()));
    }
    if (scope.campaign_targeting_type) {
      sConds.push(`LOWER(c.targeting_type) = $${sPi++}`);
      sParams.push(scope.campaign_targeting_type.toLowerCase());
    }
    sPi = addCampaignNameFilter(sConds, sParams, sPi);

    const { rows } = await query(
      `SELECT
         MIN(stm.id::text) AS id,
         stm.query AS keyword_text,
         stm.campaign_id, stm.ad_group_id,
         stm.match_type AS source_match_type,
         c.name  AS campaign_name, c.campaign_type, c.amazon_campaign_id,
         ag.name AS ad_group_name, ag.amazon_ag_id AS amazon_ad_group_id,
         p.id    AS profile_db_id,
         p.profile_id  AS amazon_profile_id,
         p.connection_id,
         p.marketplace_id,
         'enabled'::text AS state,
         SUM(stm.clicks)      AS clicks,
         SUM(stm.spend)       AS spend,
         SUM(stm.orders)      AS orders,
         SUM(stm.sales)       AS sales,
         SUM(stm.impressions) AS impressions,
         CASE WHEN SUM(stm.sales) > 0
              THEN SUM(stm.spend)/SUM(stm.sales)*100 END AS acos,
         CASE WHEN SUM(stm.spend) > 0
              THEN SUM(stm.sales)/SUM(stm.spend) END     AS roas,
         CASE WHEN SUM(stm.impressions) > 0
              THEN SUM(stm.clicks)::numeric/SUM(stm.impressions)*100 END AS ctr,
         CASE WHEN SUM(stm.clicks) > 0
              THEN SUM(stm.spend)/SUM(stm.clicks) END    AS cpc
       FROM search_term_metrics stm
       JOIN campaigns c        ON c.id  = stm.campaign_id
       JOIN ad_groups ag       ON ag.id = stm.ad_group_id
       JOIN amazon_profiles p  ON p.id  = stm.profile_id
       WHERE ${sConds.join(" AND ")}
       GROUP BY stm.query, stm.campaign_id, stm.ad_group_id, stm.match_type,
                c.name, c.campaign_type, c.amazon_campaign_id,
                ag.name, ag.amazon_ag_id,
                p.id, p.profile_id, p.connection_id, p.marketplace_id`,
      sParams
    );
    searchTerms = rows.map(r => ({ ...r, entity_type: "search_term" }));
  }

  const entities = [...keywords, ...targets, ...searchTerms];
  const matched  = entities.filter(e => evaluate(metricConditions, e));
  const applied  = [];
  const skipped  = [];
  const errors   = [];

  // Helper: record an entity that matched conditions but cannot have the
  // action applied (e.g., already in target state, duplicate negative).
  // Reason key is i18n-resolved on the frontend so UX explanations stay close
  // to translation files. Keep keys stable — they're shown in tooltips.
  const recordSkip = (entity, action, reason) => {
    skipped.push({
      entity_id: entity.id,
      entity_type: entity.entity_type,
      keyword_text: entity.keyword_text || null,
      expression: entity.expression || null,
      campaign_name: entity.campaign_name || null,
      action: action.type,
      reason,
      metrics: {
        clicks: entity.clicks, orders: entity.orders,
        spend: entity.spend, acos: entity.acos,
      },
    });
  };

  for (const entity of matched) {
    for (const action of actions) {
      try {

        // ── pause_keyword ───────────────────────────────────────────────────
        if (action.type === "pause_keyword") {
          if (entity.entity_type !== "keyword") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "paused") { recordSkip(entity, action, "already_paused"); continue; }
          if (!dryRun) {
            await query("UPDATE keywords SET state = 'paused', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "keyword.pause_keyword", entityType: "keyword",
              entityId: entity.id, entityName: entity.keyword_text,
              beforeData: { state: entity.state }, afterData: { state: "paused" }, source: "rule",
            });
            if (entity.amazon_keyword_id && entity.connection_id) {
              pushKeywordUpdates([{
                amazonKeywordId: entity.amazon_keyword_id,
                campaignType: entity.campaign_type,
                connectionId: entity.connection_id,
                profileId: String(entity.amazon_profile_id),
                marketplaceId: entity.marketplace_id,
                state: "paused",
              }]).catch(e => logger.warn("Rule keyword pause write-back failed", { error: e.message }));
            }
          }
          applied.push({
            entity_type: entity.entity_type, entity_id: entity.id, keyword_text: entity.keyword_text,
            campaign_name: entity.campaign_name, action: "pause_keyword",
            previous_state: entity.state, new_state: "paused",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos },
          });

        // ── enable_keyword ──────────────────────────────────────────────────
        } else if (action.type === "enable_keyword") {
          if (entity.entity_type !== "keyword") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "enabled") { recordSkip(entity, action, "already_enabled"); continue; }
          if (!dryRun) {
            await query("UPDATE keywords SET state = 'enabled', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "keyword.enable_keyword", entityType: "keyword",
              entityId: entity.id, entityName: entity.keyword_text,
              beforeData: { state: entity.state }, afterData: { state: "enabled" }, source: "rule",
            });
            if (entity.amazon_keyword_id && entity.connection_id) {
              pushKeywordUpdates([{
                amazonKeywordId: entity.amazon_keyword_id,
                campaignType: entity.campaign_type,
                connectionId: entity.connection_id,
                profileId: String(entity.amazon_profile_id),
                marketplaceId: entity.marketplace_id,
                state: "enabled",
              }]).catch(e => logger.warn("Rule keyword enable write-back failed", { error: e.message }));
            }
          }
          applied.push({
            entity_type: entity.entity_type, entity_id: entity.id, keyword_text: entity.keyword_text,
            campaign_name: entity.campaign_name, action: "enable_keyword",
            previous_state: entity.state, new_state: "enabled",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders },
          });

        // ── adjust_bid_pct (keyword) ────────────────────────────────────────
        } else if (action.type === "adjust_bid_pct") {
          if (entity.entity_type !== "keyword") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          const pct        = parseFloat(action.value || 0) / 100;
          const currentBid = parseFloat(entity.bid || 0.10);
          const minBid     = parseFloat(safety.min_bid || 0.02);
          const maxBid     = parseFloat(safety.max_bid || 50);
          const newBid     = Math.round(Math.max(minBid, Math.min(maxBid, currentBid * (1 + pct))) * 100) / 100;
          if (!dryRun) {
            await query("UPDATE keywords SET bid = $1, updated_at = NOW() WHERE id = $2", [newBid, entity.id]);
            await writeAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "keyword.adjust_bid_pct", entityType: "keyword",
              entityId: entity.id, entityName: entity.keyword_text,
              beforeData: { bid: currentBid }, afterData: { bid: newBid }, source: "rule",
            });
            if (entity.amazon_keyword_id && entity.connection_id) {
              pushKeywordUpdates([{
                amazonKeywordId: entity.amazon_keyword_id,
                campaignType: entity.campaign_type,
                connectionId: entity.connection_id,
                profileId: String(entity.amazon_profile_id),
                marketplaceId: entity.marketplace_id,
                bid: newBid,
              }]).catch(e => logger.warn("Rule keyword bid write-back failed", { error: e.message }));
            }
          }
          applied.push({
            entity_type: entity.entity_type, entity_id: entity.id, keyword_text: entity.keyword_text,
            campaign_name: entity.campaign_name, action: "adjust_bid_pct",
            previous_bid: currentBid, new_bid: newBid,
            change_pct: (pct * 100).toFixed(1) + "%",
          });

        // ── set_bid (keyword) ───────────────────────────────────────────────
        } else if (action.type === "set_bid") {
          if (entity.entity_type !== "keyword") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          const newBid     = parseFloat(action.value || 0.10);
          const currentBid = parseFloat(entity.bid || 0);
          const minBid     = parseFloat(safety.min_bid || 0.02);
          const maxBid     = parseFloat(safety.max_bid || 50);
          const clampedBid = Math.round(Math.max(minBid, Math.min(maxBid, newBid)) * 100) / 100;
          if (!dryRun) {
            await query("UPDATE keywords SET bid = $1, updated_at = NOW() WHERE id = $2", [clampedBid, entity.id]);
            await writeAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "keyword.set_bid", entityType: "keyword",
              entityId: entity.id, entityName: entity.keyword_text,
              beforeData: { bid: currentBid }, afterData: { bid: clampedBid }, source: "rule",
            });
            if (entity.amazon_keyword_id && entity.connection_id) {
              pushKeywordUpdates([{
                amazonKeywordId: entity.amazon_keyword_id,
                campaignType: entity.campaign_type,
                connectionId: entity.connection_id,
                profileId: String(entity.amazon_profile_id),
                marketplaceId: entity.marketplace_id,
                bid: clampedBid,
              }]).catch(e => logger.warn("Rule keyword set_bid write-back failed", { error: e.message }));
            }
          }
          applied.push({
            entity_type: entity.entity_type, entity_id: entity.id, keyword_text: entity.keyword_text,
            campaign_name: entity.campaign_name, action: "set_bid",
            previous_bid: currentBid, new_bid: clampedBid,
          });

        // ── pause_target ────────────────────────────────────────────────────
        } else if (action.type === "pause_target") {
          if (entity.entity_type !== "target") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "paused") { recordSkip(entity, action, "already_paused"); continue; }
          if (!dryRun) {
            await query("UPDATE targets SET state = 'paused', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "target.pause", entityType: "target",
              entityId: entity.id, entityName: JSON.stringify(entity.expression),
              beforeData: { state: entity.state }, afterData: { state: "paused" }, source: "rule",
            });
            if (entity.amazon_target_id && entity.connection_id) {
              const tPath = entity.campaign_type === "sponsoredDisplay" ? "/sd/targets" : "/sp/targets";
              put({
                connectionId: entity.connection_id,
                profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id,
                path: tPath,
                data: { targets: [{ targetId: entity.amazon_target_id, state: "PAUSED" }] },
                group: "keywords",
              }).catch(e => logger.warn("Rule target pause write-back failed", { error: e.message }));
            }
          }
          applied.push({
            entity_type: entity.entity_type, entity_id: entity.id, expression: entity.expression,
            campaign_name: entity.campaign_name, action: "pause_target",
            previous_state: entity.state, new_state: "paused",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos },
          });

        // ── enable_target ───────────────────────────────────────────────────
        } else if (action.type === "enable_target") {
          if (entity.entity_type !== "target") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "enabled") { recordSkip(entity, action, "already_enabled"); continue; }
          if (!dryRun) {
            await query("UPDATE targets SET state = 'enabled', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "target.enable", entityType: "target",
              entityId: entity.id, entityName: JSON.stringify(entity.expression),
              beforeData: { state: entity.state }, afterData: { state: "enabled" }, source: "rule",
            });
            if (entity.amazon_target_id && entity.connection_id) {
              const tPath = entity.campaign_type === "sponsoredDisplay" ? "/sd/targets" : "/sp/targets";
              put({
                connectionId: entity.connection_id,
                profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id,
                path: tPath,
                data: { targets: [{ targetId: entity.amazon_target_id, state: "ENABLED" }] },
                group: "keywords",
              }).catch(e => logger.warn("Rule target enable write-back failed", { error: e.message }));
            }
          }
          applied.push({
            entity_type: entity.entity_type, entity_id: entity.id, expression: entity.expression,
            campaign_name: entity.campaign_name, action: "enable_target",
            previous_state: entity.state, new_state: "enabled",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders },
          });

        // ── adjust_target_bid_pct ───────────────────────────────────────────
        } else if (action.type === "adjust_target_bid_pct") {
          if (entity.entity_type !== "target") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          const pct        = parseFloat(action.value || 0) / 100;
          const currentBid = parseFloat(entity.bid || 0.10);
          const minBid     = parseFloat(safety.min_bid || 0.02);
          const maxBid     = parseFloat(safety.max_bid || 50);
          const newBid     = Math.round(Math.max(minBid, Math.min(maxBid, currentBid * (1 + pct))) * 100) / 100;
          if (!dryRun) {
            await query("UPDATE targets SET bid = $1, updated_at = NOW() WHERE id = $2", [newBid, entity.id]);
            await writeAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "target.adjust_bid_pct", entityType: "target",
              entityId: entity.id, entityName: JSON.stringify(entity.expression),
              beforeData: { bid: currentBid }, afterData: { bid: newBid }, source: "rule",
            });
            if (entity.amazon_target_id && entity.connection_id) {
              const tPath = entity.campaign_type === "sponsoredDisplay" ? "/sd/targets" : "/sp/targets";
              put({
                connectionId: entity.connection_id,
                profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id,
                path: tPath,
                data: { targets: [{ targetId: entity.amazon_target_id, bid: newBid }] },
                group: "keywords",
              }).catch(e => logger.warn("Rule target bid write-back failed", { error: e.message }));
            }
          }
          applied.push({
            entity_type: entity.entity_type, entity_id: entity.id, expression: entity.expression,
            campaign_name: entity.campaign_name, action: "adjust_target_bid_pct",
            previous_bid: currentBid, new_bid: newBid,
            change_pct: (pct * 100).toFixed(1) + "%",
          });

        // ── add_negative_keyword ────────────────────────────────────────────
        // action.value: "exact" | "phrase" | "both" (default: "exact")
        // Amazon requires "negativeExact" / "negativePhrase" format
        } else if (action.type === "add_negative_keyword") {
          // Allowed for keywords AND search terms — both write a negative keyword
          // using `entity.keyword_text` (which is the search term `query` for
          // search_term entities, aliased in the SELECT above).
          if (entity.entity_type !== "keyword" && entity.entity_type !== "search_term") {
            recordSkip(entity, action, "wrong_entity_type"); continue;
          }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          const negMatchTypes = action.value === "phrase" ? ["negativePhrase"]
            : action.value === "both" ? ["negativeExact", "negativePhrase"] : ["negativeExact"];

          // ASIN-shaped search terms (e.g. "b076j8j3w5") are masked ASIN queries.
          // Amazon matches these as products, not keywords — a negative KEYWORD
          // wouldn't actually exclude them. Auto-route to add_negative_target
          // (ASIN-level exclusion) which is what Amazon actually honours.
          const isAsinShaped = /^b0[a-z0-9]{8}$/i.test(entity.keyword_text || "");
          if (isAsinShaped && entity.entity_type === "search_term") {
            const asinUpper = entity.keyword_text.toUpperCase();
            const exprUpperJson = JSON.stringify([{ type: "ASIN_SAME_AS", value: asinUpper }]);

            // Dedup: if this ASIN is already a negative_target anywhere in the
            // campaign (any ad group, or campaign-level), skip — it's already
            // excluded effectively.
            const { rows: dupTgt } = await query(
              `SELECT id FROM negative_targets
               WHERE workspace_id=$1 AND campaign_id=$2
                 AND expression @> $3::jsonb`,
              [workspaceId, entity.campaign_id, exprUpperJson]
            );
            if (dupTgt.length > 0) { recordSkip(entity, action, "already_negative"); continue; }

            let insertedNtId = null;
            if (!dryRun) {
              const { rows: ntRows } = await query(
                `INSERT INTO negative_targets
                   (workspace_id, profile_id, campaign_id, ad_group_id,
                    amazon_neg_target_id, expression, expression_type, level)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
                 ON CONFLICT DO NOTHING
                 RETURNING id`,
                [workspaceId, entity.profile_db_id, entity.campaign_id, entity.ad_group_id,
                  `rule-neg-asin-${entity.id}`,
                  exprUpperJson, "asinSameAs", "ad_group"]
              );
              insertedNtId = ntRows[0]?.id || null;

              await writeAudit({
                orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
                action: "search_term.add_negative_target_auto", entityType: "search_term",
                entityId: entity.id, entityName: entity.keyword_text,
                beforeData: {},
                afterData: { added_as_negative_target: true, asin: asinUpper, level: "ad_group" },
                source: "rule",
              });

              if (insertedNtId && entity.connection_id) {
                // Reuse the existing v3 POST writer — it already uses the
                // correct uppercase ASIN_SAME_AS, ENABLED state, and updates
                // negative_targets.amazon_neg_target_id with the real Amazon ID.
                pushNegativeAsin({
                  localId: insertedNtId,
                  connectionId: entity.connection_id,
                  profileId: String(entity.amazon_profile_id),
                  marketplaceId: entity.marketplace_id,
                  campaignType: entity.campaign_type,
                  amazonCampaignId: entity.amazon_campaign_id,
                  amazonAdGroupId: entity.amazon_ad_group_id || null,
                  asinValue: asinUpper,
                  level: "ad_group",
                }).catch(e => logger.warn("Rule auto-route negative_target write-back failed",
                  { error: e.message }));
              }
            }

            applied.push({
              entity_type: entity.entity_type, entity_id: entity.id,
              keyword_text: entity.keyword_text,
              expression: [{ type: "ASIN_SAME_AS", value: asinUpper }],
              campaign_name: entity.campaign_name, action: "add_negative_target",
              auto_routed: true,
              level: "ad_group",
              metrics: { clicks: entity.clicks, orders: entity.orders, acos: entity.acos, spend: entity.spend },
            });
            continue;
          }

          for (const matchType of negMatchTypes) {
            // Normalize match_type: Amazon sync stores "negative_exact"/"negative_phrase" (snake_case)
            // but rule engine uses "negativeExact"/"negativePhrase" (camelCase) — match both
            const { rows: existing } = await query(
              `SELECT id FROM negative_keywords
               WHERE workspace_id=$1 AND campaign_id=$2
               AND LOWER(keyword_text)=LOWER($3)
               AND REPLACE(LOWER(match_type),'_','') = REPLACE(LOWER($4),'_','')`,
              [workspaceId, entity.campaign_id, entity.keyword_text, matchType]
            );
            if (existing.length > 0) { recordSkip(entity, action, "already_negative"); continue; }

            let insertedId = null;
            if (!dryRun) {
              const { rows: insRows } = await query(
                `INSERT INTO negative_keywords
                   (workspace_id, profile_id, campaign_id, ad_group_id,
                    amazon_neg_keyword_id, keyword_text, match_type, level)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'ad_group')
                 ON CONFLICT (profile_id, amazon_neg_keyword_id) DO NOTHING
                 RETURNING id`,
                [workspaceId, entity.profile_db_id, entity.campaign_id, entity.ad_group_id,
                  `rule-${entity.id}-${matchType}`,
                  entity.keyword_text, matchType.replace(/([A-Z])/g, '_$1').toLowerCase()]  // store as snake_case: negativeExact → negative_exact
              );
              insertedId = insRows[0]?.id || null;

              await writeAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
                action: "keyword.add_negative", entityType: "keyword",
                entityId: entity.id, entityName: entity.keyword_text,
                beforeData: {}, afterData: { match_type: matchType, level: "ad_group", added_as_negative: true },
                source: "rule",
              });

              if (insertedId && entity.connection_id) {
                pushNegativeKeyword({
                  localId: insertedId,
                  connectionId: entity.connection_id,
                  profileId: String(entity.amazon_profile_id),
                  marketplaceId: entity.marketplace_id,
                  campaignType: entity.campaign_type,
                  amazonCampaignId: entity.amazon_campaign_id,
                  amazonAdGroupId: entity.amazon_ad_group_id || null,
                  keywordText: entity.keyword_text,
                  matchType,
                  level: "ad_group",
                }).catch(e => logger.warn("Rule add_negative_keyword write-back failed", { error: e.message }));
              }
            }
            applied.push({
              entity_type: entity.entity_type, entity_id: entity.id, keyword_text: entity.keyword_text,
              campaign_name: entity.campaign_name, action: "add_negative_keyword",
              match_type: matchType, level: "ad_group",
              metrics: { clicks: entity.clicks, orders: entity.orders, acos: entity.acos, spend: entity.spend },
            });
          }

        // ── add_negative_target ─────────────────────────────────────────────
        } else if (action.type === "add_negative_target") {
          if (entity.entity_type !== "target") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          const exprJson = typeof entity.expression === "string"
            ? entity.expression : JSON.stringify(entity.expression);

          const { rows: existing } = await query(
            `SELECT id FROM negative_targets
             WHERE workspace_id=$1 AND campaign_id=$2 AND ad_group_id=$3 AND expression=$4::jsonb`,
            [workspaceId, entity.campaign_id, entity.ad_group_id, exprJson]
          );
          if (existing.length > 0) { recordSkip(entity, action, "already_negative"); continue; }

          let insertedNtId = null;
          if (!dryRun) {
            const { rows: ntRows } = await query(
              `INSERT INTO negative_targets
                 (workspace_id, profile_id, campaign_id, ad_group_id,
                  amazon_neg_target_id, expression, expression_type, level)
               VALUES ($1,
                 (SELECT profile_id FROM campaigns WHERE id=$2 LIMIT 1),
                 $2, $3, $4, $5::jsonb, $6, $7)
               ON CONFLICT DO NOTHING
               RETURNING id`,
              [workspaceId, entity.campaign_id, entity.ad_group_id,
                `rule-neg-${entity.id}`,
                exprJson, entity.expression_type || "asinSameAs", "ad_group"]
            );
            insertedNtId = ntRows[0]?.id || null;

            await writeAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "target.add_negative", entityType: "target",
              entityId: entity.id, entityName: JSON.stringify(entity.expression),
              beforeData: {}, afterData: { added_as_negative: true }, source: "rule",
            });

            if (insertedNtId && entity.connection_id) {
              const targetExpr = typeof entity.expression === "string"
                ? JSON.parse(entity.expression) : entity.expression;
              const ntPath = entity.campaign_type === "sponsoredDisplay"
                ? "/sd/negativeTargets" : "/sp/negativeTargets";
              put({
                connectionId: entity.connection_id,
                profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id,
                path: ntPath,
                data: { negativeTargetingClauses: [{
                  expression: targetExpr,
                  expressionType: "manual",
                  state: "enabled",
                  campaignId: entity.amazon_campaign_id,
                  ...(entity.amazon_ad_group_id ? { adGroupId: entity.amazon_ad_group_id } : {}),
                }] },
                group: "keywords",
              }).then(result => {
                const created = result?.negativeTargetingClauses?.success?.[0]
                  || result?.negativeTargetingClauses?.[0]
                  || result?.[0];
                const realId = created?.negativeTargetId || created?.targetId;
                if (realId && insertedNtId) {
                  query("UPDATE negative_targets SET amazon_neg_target_id = $1 WHERE id = $2",
                    [String(realId), insertedNtId]).catch(() => {});
                }
              }).catch(e => logger.warn("Rule add_negative_target write-back failed", { error: e.message }));
            }
          }
          applied.push({
            entity_type: entity.entity_type, entity_id: entity.id, expression: entity.expression,
            campaign_name: entity.campaign_name, action: "add_negative_target",
            metrics: { clicks: entity.clicks, orders: entity.orders, spend: entity.spend, acos: entity.acos },
          });
        }
      } catch (e) {
        errors.push({ entity_id: entity.id, error: e.message });
      }
    }
  }

  return {
    matched_count:   matched.length,
    total_evaluated: entities.length,
    entity_counts:   { keywords: keywords.length, targets: targets.length },
    applied_count:   applied.length,
    skipped_count:   skipped.length,
    dry_run:         dryRun,
    period:          { start: startDate, end: endDate, days: periodDays },
    applied,
    skipped,
    errors,
  };
}

// ── GET /rules/campaigns — MUST be before /:id to avoid param capture ─────────
router.get("/campaigns", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, name, campaign_type, state FROM campaigns
       WHERE workspace_id = $1 AND state != 'archived'
       ORDER BY name ASC LIMIT 200`,
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /rules/ad-groups — MUST be before /:id ────────────────────────────────
router.get("/ad-groups", async (req, res, next) => {
  try {
    const { campaignId, profileId: filterProfileId } = req.query;
    const cond   = ["ag.workspace_id = $1"];
    const params = [req.workspaceId];
    let pi = 2;
    if (campaignId)      { cond.push(`ag.campaign_id = $${pi++}`);  params.push(campaignId); }
    if (filterProfileId) { cond.push(`c.profile_id = $${pi++}`);    params.push(filterProfileId); }
    const { rows } = await query(
      `SELECT ag.id, ag.name, ag.campaign_id, c.name AS campaign_name
       FROM ad_groups ag JOIN campaigns c ON c.id = ag.campaign_id
       WHERE ${cond.join(" AND ")} AND ag.state != 'archived'
       ORDER BY c.name, ag.name LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /rules/targets — MUST be before /:id ──────────────────────────────────
router.get("/targets", async (req, res, next) => {
  try {
    const { campaignId } = req.query;
    const cond   = ["t.workspace_id = $1"];
    const params = [req.workspaceId];
    if (campaignId) { cond.push("t.campaign_id = $2"); params.push(campaignId); }
    const { rows } = await query(
      `SELECT t.id, t.expression, t.expression_type, t.state, t.bid,
              t.campaign_id, c.name AS campaign_name
       FROM targets t JOIN campaigns c ON c.id = t.campaign_id
       WHERE ${cond.join(" AND ")} AND t.state != 'archived'
       ORDER BY c.name, t.expression::text LIMIT 500`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

// ── GET /rules — list with pagination ────────────────────────────────────────
router.get("/", async (req, res, next) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit  || 25), 100);
    const page   = Math.max(parseInt(req.query.page   || 1), 1);
    const offset = (page - 1) * limit;

    const [{ rows }, { rows: [cnt] }] = await Promise.all([
      query(
        "SELECT * FROM rules WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3",
        [req.workspaceId, limit, offset]
      ),
      query("SELECT COUNT(*)::int AS count FROM rules WHERE workspace_id = $1", [req.workspaceId]),
    ]);

    res.json({
      data: rows,
      pagination: { total: cnt.count, page, limit, pages: Math.ceil(cnt.count / limit) },
    });
  } catch (err) { next(err); }
});

// ── POST /rules — create ──────────────────────────────────────────────────────
router.post("/", async (req, res, next) => {
  try {
    const { name, description, conditions, actions, schedule, scope, safety, dry_run } = req.body;
    if (!name || !conditions?.length || !actions?.length) {
      return res.status(400).json({ error: "name, conditions and actions required" });
    }
    const { rows: [rule] } = await query(
      `INSERT INTO rules
         (workspace_id, name, description, conditions, actions, schedule, scope, safety, dry_run, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        req.workspaceId, name, description || "",
        JSON.stringify(conditions), JSON.stringify(actions),
        schedule || "0 8 * * *",
        JSON.stringify(scope   || {}),
        JSON.stringify(safety  || { min_bid: 0.02, max_bid: 50 }),
        dry_run || false, req.user.id,
      ]
    );
    res.status(201).json(rule);
  } catch (err) { next(err); }
});

// ── PATCH /rules/:id — update ─────────────────────────────────────────────────
router.patch("/:id", async (req, res, next) => {
  try {
    const { name, description, conditions, actions, schedule, scope, safety, dry_run, is_active } = req.body;
    // If conditions/actions are explicitly provided, refuse to write empty
    // arrays — those would let executeRule treat every entity as matched.
    if (conditions !== undefined && (!Array.isArray(conditions) || conditions.length === 0)) {
      return res.status(400).json({ error: "conditions cannot be empty when provided" });
    }
    if (actions !== undefined && (!Array.isArray(actions) || actions.length === 0)) {
      return res.status(400).json({ error: "actions cannot be empty when provided" });
    }
    const { rows: [rule] } = await query(
      `UPDATE rules SET
         name        = COALESCE($1, name),
         description = COALESCE($2, description),
         conditions  = COALESCE($3::jsonb, conditions),
         actions     = COALESCE($4::jsonb, actions),
         schedule    = COALESCE($5, schedule),
         scope       = COALESCE($6::jsonb, scope),
         safety      = COALESCE($7::jsonb, safety),
         dry_run     = COALESCE($8, dry_run),
         is_active   = COALESCE($9, is_active),
         updated_at  = NOW()
       WHERE id = $10 AND workspace_id = $11
       RETURNING *`,
      [
        name, description,
        conditions ? JSON.stringify(conditions) : null,
        actions    ? JSON.stringify(actions)    : null,
        schedule,
        scope   ? JSON.stringify(scope)   : null,
        safety  ? JSON.stringify(safety)  : null,
        dry_run, is_active,
        req.params.id, req.workspaceId,
      ]
    );
    if (!rule) return res.status(404).json({ error: "Rule not found" });
    res.json(rule);
  } catch (err) { next(err); }
});

// ── DELETE /rules/:id ─────────────────────────────────────────────────────────
router.delete("/:id", async (req, res, next) => {
  try {
    await query("DELETE FROM rules WHERE id = $1 AND workspace_id = $2", [req.params.id, req.workspaceId]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /rules/preview — dry-run with form body, never persists ──────────────
// Used by the rule editor: lets users preview an UNSAVED rule (or unsaved edits
// to an existing rule) against fresh metrics. Does not write to rules,
// rule_executions, or audit_log — pure read-only evaluation.
router.post("/preview", async (req, res, next) => {
  try {
    const body = req.body || {};
    // Empty arrays are truthy — must explicitly check `.length`. Without this
    // a `{conditions: [], actions: [...]}` body would pass and the engine
    // would treat every entity as matching (Array.every on []=true).
    if (!Array.isArray(body.conditions) || body.conditions.length === 0) {
      return res.status(400).json({ error: "At least one condition is required" });
    }
    if (!Array.isArray(body.actions) || body.actions.length === 0) {
      return res.status(400).json({ error: "At least one action is required" });
    }
    const synthetic = {
      id: null,
      workspace_id: req.workspaceId,
      name: body.name || "__preview__",
      conditions: body.conditions,
      actions: body.actions,
      scope: body.scope || {},
      safety: body.safety || {},
      dry_run: true,
      is_active: false,
    };
    const result = await executeRule(synthetic, req.workspaceId, true, req.user.id, req.user.name);
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /rules/:id/run — execute synchronously ───────────────────────────────
router.post("/:id/run", async (req, res, next) => {
  try {
    const { dry_run } = req.body;
    const { rows: [rule] } = await query(
      "SELECT * FROM rules WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    if (!rule) return res.status(404).json({ error: "Rule not found" });

    const effectiveDryRun = dry_run !== undefined ? dry_run : rule.dry_run;
    const result = await executeRule(rule, req.workspaceId, effectiveDryRun, req.user.id, req.user.name);

    await query(
      "UPDATE rules SET last_run_at = NOW(), last_run_result = $1 WHERE id = $2",
      [JSON.stringify(result), req.params.id]
    );

    logger.info("Rule executed", { ruleId: rule.id, ruleName: rule.name, ...result });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /rules/:id/runs — execution history
router.get("/:id/runs", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, started_at, completed_at, dry_run, status,
              entities_evaluated, entities_matched, actions_taken, actions_failed,
              summary, error_message
       FROM rule_executions
       WHERE rule_id = $1 AND workspace_id = $2
       ORDER BY started_at DESC LIMIT 50`,
      [req.params.id, req.workspaceId]
    );
    res.json({ data: rows });
  } catch (err) { next(err); }
});

module.exports = router;
