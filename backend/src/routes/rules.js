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
const { pushNegativeKeyword, pushNegativeAsin, pushKeywordUpdates, archiveNegativeKeyword, archiveNegativeTarget } = require("../services/amazon/writeback");
const { put } = require("../services/amazon/adsClient");
const logger  = require("../config/logger");
const { getRedis } = require("../config/redis");

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

  // Load campaign exemptions — campaigns globally excluded from all rules
  const { rows: exemRows } = await query(
    `SELECT campaign_id FROM campaign_exemptions
     WHERE workspace_id = $1 AND (expires_at IS NULL OR expires_at > NOW())`,
    [workspaceId]
  );
  const exemptedCampaignIds = new Set(exemRows.map(r => String(r.campaign_id)));

  // Wrap writeAudit to always attach rule identity for traceability in the audit journal
  const writeRuleAudit = (opts) => writeAudit({ ...opts, metadata: { rule_id: rule.id, rule_name: rule.name } });

  // Separate bid/budget threshold conditions (applied in SQL WHERE) from metric conditions (post-fetch filter).
  // daily_budget is only a valid SQL threshold on campaign scope; for other scopes it stays in metricConditions
  // (evaluates against entity.daily_budget which is undefined → treated as 0, effectively ignored).
  const entityType       = scope.entity_type || "keyword";
  const bidConditions    = conditions.filter(c => c.metric === "bid" || (c.metric === "daily_budget" && entityType === "campaign"));
  const metricConditions = conditions.filter(c => c.metric !== "bid" && !(c.metric === "daily_budget" && entityType === "campaign"));
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
         c.name  AS campaign_name, c.campaign_type, c.amazon_campaign_id, c.state AS campaign_state,
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
                c.name, c.campaign_type, c.amazon_campaign_id, c.state,
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
      const ttSqlMap = {
        "category":      `(t.expression->0->>'type' IN ('ASIN_CATEGORY_SAME_AS', 'asinCategorySameAs'))`,
        "asin":          `(t.expression->0->>'type' IN ('ASIN_SAME_AS', 'asinSameAs'))`,
        "auto_targeting":`(LOWER(t.expression_type) = 'auto')`,
        "audience":      `(t.expression->0->>'type' IN ('views', 'purchases', 'similarProduct'))`,
        // backward-compat aliases for rules saved before this change:
        "auto":          `(LOWER(t.expression_type) = 'auto')`,
        "product":       `(t.expression->0->>'type' IN ('ASIN_SAME_AS', 'asinSameAs'))`,
        "views":         `(t.expression->0->>'type' IN ('views', 'purchases', 'similarProduct'))`,
      };
      const ttCond = ttSqlMap[scope.targeting_type];
      if (ttCond) tConds.push(ttCond);
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
         c.name  AS campaign_name, c.campaign_type, c.amazon_campaign_id, c.state AS campaign_state,
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
                c.name, c.campaign_type, c.amazon_campaign_id, c.state,
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
    if (scope.search_term_subtype === "asin") {
      sConds.push(`stm.query ~* '^B0[A-Z0-9]{8,9}$'`);
    } else if (scope.search_term_subtype === "keyword") {
      sConds.push(`stm.query !~* '^B0[A-Z0-9]{8,9}$'`);
    }
    sPi = addCampaignNameFilter(sConds, sParams, sPi);

    const { rows } = await query(
      `SELECT
         MIN(stm.id::text) AS id,
         stm.query AS keyword_text,
         stm.campaign_id, stm.ad_group_id,
         stm.match_type AS source_match_type,
         c.name  AS campaign_name, c.campaign_type, c.amazon_campaign_id, c.state AS campaign_state,
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
                c.name, c.campaign_type, c.amazon_campaign_id, c.state,
                ag.name, ag.amazon_ag_id,
                p.id, p.profile_id, p.connection_id, p.marketplace_id`,
      sParams
    );
    searchTerms = rows.map(r => ({ ...r, entity_type: "search_term" }));
  }

  // ── Fetch ad groups ───────────────────────────────────────────────────────
  let adGroupEntities = [];
  if (entityType === "ad_group") {
    const agConds  = ["ag.workspace_id = $1"];
    const agParams = [workspaceId];
    let agPi = 2;

    if (scope.campaign_ids?.length) {
      agConds.push(`ag.campaign_id = ANY($${agPi++}::uuid[])`);
      agParams.push(scope.campaign_ids);
    }
    if (scope.ad_group_ids?.length) {
      agConds.push(`ag.id = ANY($${agPi++}::uuid[])`);
      agParams.push(scope.ad_group_ids);
    }
    if (scope.campaign_type) {
      agConds.push(`c.campaign_type = $${agPi++}`);
      agParams.push(scope.campaign_type);
    }
    if (scope.campaign_targeting_type) {
      agConds.push(`LOWER(c.targeting_type) = $${agPi++}`);
      agParams.push(scope.campaign_targeting_type.toLowerCase());
    }
    agPi = addCampaignNameFilter(agConds, agParams, agPi);
    for (const bc of bidConditions) {
      agConds.push(`ag.default_bid ${BID_OPS[bc.op] || ">="} $${agPi++}`);
      agParams.push(parseFloat(bc.value));
    }
    agConds.push("ag.state != 'archived'");

    const { rows } = await query(
      `SELECT
         ag.id, ag.amazon_ag_id, ag.name AS ad_group_name, ag.state, ag.default_bid,
         ag.campaign_id,
         c.name  AS campaign_name, c.campaign_type, c.amazon_campaign_id, c.state AS campaign_state,
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
       FROM ad_groups ag
       JOIN campaigns  c  ON c.id  = ag.campaign_id
       JOIN amazon_profiles p ON p.id = ag.profile_id
       LEFT JOIN fact_metrics_daily m
         ON m.amazon_id = ag.amazon_ag_id
         AND m.entity_type = 'ad_group'
         AND m.date BETWEEN $${agPi++} AND $${agPi++}
       WHERE ${agConds.join(" AND ")}
       GROUP BY ag.id, ag.amazon_ag_id, ag.name, ag.state, ag.default_bid,
                ag.campaign_id, c.name, c.campaign_type, c.amazon_campaign_id, c.state,
                p.id, p.profile_id, p.connection_id, p.marketplace_id`,
      [...agParams, startDate, endDate]
    );
    adGroupEntities = rows.map(r => ({ ...r, entity_type: "ad_group", keyword_text: r.ad_group_name }));
  }

  // ── Fetch campaigns ───────────────────────────────────────────────────────
  let campaignEntities = [];
  if (entityType === "campaign") {
    const cConds  = ["c.workspace_id = $1"];
    const cCampParams = [workspaceId];
    let cPi = 2;

    if (scope.campaign_ids?.length) {
      cConds.push(`c.id = ANY($${cPi++}::uuid[])`);
      cCampParams.push(scope.campaign_ids);
    }
    if (scope.campaign_type) {
      cConds.push(`c.campaign_type = $${cPi++}`);
      cCampParams.push(scope.campaign_type);
    }
    if (scope.campaign_targeting_type) {
      cConds.push(`LOWER(c.targeting_type) = $${cPi++}`);
      cCampParams.push(scope.campaign_targeting_type.toLowerCase());
    }
    cPi = addCampaignNameFilter(cConds, cCampParams, cPi);
    // "bid" conditions on campaign scope are interpreted as daily_budget thresholds
    for (const bc of bidConditions) {
      cConds.push(`c.daily_budget ${BID_OPS[bc.op] || ">="} $${cPi++}`);
      cCampParams.push(parseFloat(bc.value));
    }
    cConds.push("c.state != 'archived'");

    const { rows } = await query(
      `SELECT
         c.id, c.amazon_campaign_id, c.name AS campaign_name, c.state, c.daily_budget,
         c.campaign_type, c.targeting_type,
         c.state AS campaign_state,
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
       FROM campaigns c
       JOIN amazon_profiles p ON p.id = c.profile_id
       LEFT JOIN fact_metrics_daily m
         ON m.amazon_id = c.amazon_campaign_id
         AND m.entity_type = 'campaign'
         AND m.date BETWEEN $${cPi++} AND $${cPi++}
       WHERE ${cConds.join(" AND ")}
       GROUP BY c.id, c.amazon_campaign_id, c.name, c.state, c.daily_budget,
                c.campaign_type, c.targeting_type,
                p.id, p.profile_id, p.connection_id, p.marketplace_id`,
      [...cCampParams, startDate, endDate]
    );
    campaignEntities = rows.map(r => ({ ...r, entity_type: "campaign", keyword_text: r.campaign_name }));
  }

  const entities = [...keywords, ...targets, ...searchTerms, ...adGroupEntities, ...campaignEntities];
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

  // Split matched into exempted (skipped entirely) and processable
  let exemptedCount = 0;
  if (exemptedCampaignIds.size > 0) {
    for (const entity of matched) {
      const cid = entity.entity_type === "campaign" ? entity.id : entity.campaign_id;
      if (exemptedCampaignIds.has(String(cid))) exemptedCount++;
    }
  }

  for (const entity of matched) {
    // Skip entities belonging to globally exempted campaigns
    if (exemptedCampaignIds.size > 0) {
      const cid = entity.entity_type === "campaign" ? entity.id : entity.campaign_id;
      if (exemptedCampaignIds.has(String(cid))) continue;
    }

    for (const action of actions) {
      try {
        if (entity.entity_type !== "campaign" && entity.campaign_state && entity.campaign_state !== "enabled") {
          recordSkip(entity, action, "campaign_not_enabled"); continue;
        }

        // ── pause_keyword ───────────────────────────────────────────────────
        if (action.type === "pause_keyword") {
          if (entity.entity_type !== "keyword") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "paused") { recordSkip(entity, action, "already_paused"); continue; }
          if (!dryRun) {
            await query("UPDATE keywords SET state = 'paused', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeRuleAudit({
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
            campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "pause_keyword",
            previous_state: entity.state, new_state: "paused",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos },
          });

        // ── enable_keyword ──────────────────────────────────────────────────
        } else if (action.type === "enable_keyword") {
          if (entity.entity_type !== "keyword") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "enabled") { recordSkip(entity, action, "already_enabled"); continue; }
          if (!dryRun) {
            await query("UPDATE keywords SET state = 'enabled', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeRuleAudit({
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
            campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "enable_keyword",
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
            await writeRuleAudit({
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
            campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "adjust_bid_pct",
            previous_bid: currentBid, new_bid: newBid,
            change_pct: (pct * 100).toFixed(1) + "%",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos },
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
            await writeRuleAudit({
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
            campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "set_bid",
            previous_bid: currentBid, new_bid: clampedBid,
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos },
          });

        // ── pause_target ────────────────────────────────────────────────────
        } else if (action.type === "pause_target") {
          if (entity.entity_type !== "target") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "paused") { recordSkip(entity, action, "already_paused"); continue; }
          if (!dryRun) {
            await query("UPDATE targets SET state = 'paused', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeRuleAudit({
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
            campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "pause_target",
            previous_state: entity.state, new_state: "paused",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos },
          });

        // ── enable_target ───────────────────────────────────────────────────
        } else if (action.type === "enable_target") {
          if (entity.entity_type !== "target") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "enabled") { recordSkip(entity, action, "already_enabled"); continue; }
          if (!dryRun) {
            await query("UPDATE targets SET state = 'enabled', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeRuleAudit({
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
            campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "enable_target",
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
            await writeRuleAudit({
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
            campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "adjust_target_bid_pct",
            previous_bid: currentBid, new_bid: newBid,
            change_pct: (pct * 100).toFixed(1) + "%",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos },
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

            // Skip if ASIN is already an active positive target in the same ad group —
            // Amazon rejects negating a target you're actively bidding on.
            const { rows: activeTgt } = await query(
              `SELECT id FROM targets
               WHERE campaign_id=$1 AND ad_group_id=$2 AND state IN ('enabled','paused')
                 AND (expression @> $3::jsonb OR expression @> $4::jsonb)`,
              [entity.campaign_id, entity.ad_group_id, exprUpperJson,
               JSON.stringify([{ type: "asinSameAs", value: asinUpper }])]
            );
            if (activeTgt.length > 0) { recordSkip(entity, action, "is_active_target"); continue; }

            // Dedup: if this ASIN is already a negative_target anywhere in the
            // campaign (any ad group, or campaign-level), skip — it's already
            // excluded effectively.
            const { rows: dupTgt } = await query(
              `SELECT id FROM negative_targets
               WHERE workspace_id=$1 AND campaign_id=$2
                 AND expression @> $3::jsonb AND state = 'enabled'`,
              [workspaceId, entity.campaign_id, exprUpperJson]
            );
            if (dupTgt.length > 0) { recordSkip(entity, action, "already_negative"); continue; }

            let insertedNtId = null;
            if (!dryRun) {
              const { rows: ntRows } = await query(
                `INSERT INTO negative_targets
                   (workspace_id, profile_id, campaign_id, ad_group_id,
                    amazon_neg_target_id, expression, expression_type, level,
                    source_rule_id, source_entity_type)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
                 ON CONFLICT DO NOTHING
                 RETURNING id`,
                [workspaceId, entity.profile_db_id, entity.campaign_id, entity.ad_group_id,
                  `rule-neg-asin-${entity.id}`,
                  exprUpperJson, "asinSameAs", "ad_group",
                  rule.id, entity.entity_type]
              );
              insertedNtId = ntRows[0]?.id || null;

              await writeRuleAudit({
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
              campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name,
              action: "add_negative_target", auto_routed: true, level: "ad_group",
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
               AND REPLACE(LOWER(match_type),'_','') = REPLACE(LOWER($4),'_','')
               AND state = 'enabled'`,
              [workspaceId, entity.campaign_id, entity.keyword_text, matchType]
            );
            if (existing.length > 0) { recordSkip(entity, action, "already_negative"); continue; }

            let insertedId = null;
            if (!dryRun) {
              const { rows: insRows } = await query(
                `INSERT INTO negative_keywords
                   (workspace_id, profile_id, campaign_id, ad_group_id,
                    amazon_neg_keyword_id, keyword_text, match_type, level,
                    source_rule_id, source_entity_type)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, 'ad_group', $8, $9)
                 ON CONFLICT (profile_id, amazon_neg_keyword_id) DO NOTHING
                 RETURNING id`,
                [workspaceId, entity.profile_db_id, entity.campaign_id, entity.ad_group_id,
                  `rule-${entity.id}-${matchType}`,
                  entity.keyword_text, matchType.replace(/([A-Z])/g, '_$1').toLowerCase(),
                  rule.id, entity.entity_type]
              );
              insertedId = insRows[0]?.id || null;

              await writeRuleAudit({
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
              campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "add_negative_keyword",
              match_type: matchType, level: "ad_group",
              metrics: { clicks: entity.clicks, orders: entity.orders, acos: entity.acos, spend: entity.spend },
            });
          }

        // ── add_negative_target ─────────────────────────────────────────────
        } else if (action.type === "add_negative_target") {
          if (entity.entity_type !== "target" && entity.entity_type !== "search_term") {
            recordSkip(entity, action, "wrong_entity_type"); continue;
          }

          // search_term entities: only ASIN-shaped queries can become negative targets
          if (entity.entity_type === "search_term") {
            const isAsinShaped = /^b0[a-z0-9]{8}$/i.test(entity.keyword_text || "");
            if (!isAsinShaped) { recordSkip(entity, action, "not_asin_query"); continue; }
            const asinUpper    = entity.keyword_text.toUpperCase();
            const exprUpperJson = JSON.stringify([{ type: "ASIN_SAME_AS", value: asinUpper }]);
            const { rows: dupTgt } = await query(
              `SELECT id FROM negative_targets WHERE workspace_id=$1 AND campaign_id=$2 AND expression @> $3::jsonb AND state = 'enabled'`,
              [workspaceId, entity.campaign_id, exprUpperJson]
            );
            if (dupTgt.length > 0) { recordSkip(entity, action, "already_negative"); continue; }
            let insertedNtId = null;
            if (!dryRun) {
              const { rows: ntRows } = await query(
                `INSERT INTO negative_targets
                   (workspace_id, profile_id, campaign_id, ad_group_id,
                    amazon_neg_target_id, expression, expression_type, level,
                    source_rule_id, source_entity_type)
                 VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
                 ON CONFLICT DO NOTHING RETURNING id`,
                [workspaceId, entity.profile_db_id, entity.campaign_id, entity.ad_group_id,
                  `rule-neg-asin-st-${entity.id}`, exprUpperJson, "asinSameAs", "ad_group",
                  rule.id, entity.entity_type]
              );
              insertedNtId = ntRows[0]?.id || null;
              await writeRuleAudit({
                orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
                action: "search_term.add_negative_target", entityType: "search_term",
                entityId: entity.id, entityName: entity.keyword_text,
                beforeData: {}, afterData: { added_as_negative_target: true, asin: asinUpper },
                source: "rule",
              });
              if (insertedNtId && entity.connection_id) {
                pushNegativeAsin({
                  localId: insertedNtId, connectionId: entity.connection_id,
                  profileId: String(entity.amazon_profile_id), marketplaceId: entity.marketplace_id,
                  campaignType: entity.campaign_type, amazonCampaignId: entity.amazon_campaign_id,
                  amazonAdGroupId: entity.amazon_ad_group_id || null,
                  asinValue: asinUpper, level: "ad_group",
                }).catch(e => logger.warn("Rule add_neg_target ST write-back failed", { error: e.message }));
              }
            }
            applied.push({
              entity_type: "search_term", entity_id: entity.id,
              keyword_text: entity.keyword_text,
              expression: [{ type: "ASIN_SAME_AS", value: asinUpper }],
              campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name,
              action: "add_negative_target", auto_routed: true, level: "ad_group",
              metrics: { clicks: entity.clicks, orders: entity.orders, acos: entity.acos, spend: entity.spend },
            });
            continue;
          }

          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }

          // QUERY_HIGH/BROAD_REL_MATCHES are auto-targeting clauses — Amazon has
          // no "negative query" concept. Instead, drill into search_term_metrics
          // for this campaign/ad_group during the rule period, find ASIN queries,
          // and add each as an ASIN_SAME_AS negative target.
          const exprArrRaw = (() => {
            try { return Array.isArray(entity.expression) ? entity.expression : JSON.parse(entity.expression || "[]"); }
            catch { return []; }
          })();
          const exprType0 = (exprArrRaw[0]?.type || "").toUpperCase();
          const isQueryAutoType = exprType0 === "QUERY_BROAD_REL_MATCHES" || exprType0 === "QUERY_HIGH_REL_MATCHES";

          if (isQueryAutoType) {
            // Fetch ASIN queries with their own search-term metrics (not target-level aggregates)
            const { rows: asinTerms } = await query(
              `SELECT UPPER(stm.query)        AS asin,
                      SUM(stm.clicks)         AS st_clicks,
                      SUM(stm.spend)          AS st_spend,
                      SUM(stm.orders)         AS st_orders,
                      CASE WHEN SUM(stm.sales) > 0
                           THEN SUM(stm.spend)/SUM(stm.sales)*100 END AS st_acos
               FROM search_term_metrics stm
               WHERE stm.workspace_id = $1
                 AND stm.campaign_id  = $2
                 AND stm.ad_group_id  = $3
                 AND stm.date_start  >= $4
                 AND stm.date_end    <= $5
                 AND stm.query       ~* '^B0[A-Z0-9]{8,9}$'
               GROUP BY stm.query`,
              [workspaceId, entity.campaign_id, entity.ad_group_id, startDate, endDate]
            );
            if (!asinTerms.length) { recordSkip(entity, action, "no_asin_search_terms"); continue; }

            for (const asinRow of asinTerms) {
              const asinUpper = asinRow.asin;
              const exprUpperJson = JSON.stringify([{ type: "ASIN_SAME_AS", value: asinUpper }]);
              const { rows: dupTgt } = await query(
                `SELECT id FROM negative_targets
                 WHERE workspace_id=$1 AND campaign_id=$2 AND expression @> $3::jsonb AND state = 'enabled'`,
                [workspaceId, entity.campaign_id, exprUpperJson]
              );
              if (dupTgt.length > 0) { recordSkip(entity, action, "already_negative"); continue; }

              let insertedNtId = null;
              if (!dryRun) {
                const { rows: ntRows } = await query(
                  `INSERT INTO negative_targets
                     (workspace_id, profile_id, campaign_id, ad_group_id,
                      amazon_neg_target_id, expression, expression_type, level,
                      source_rule_id, source_entity_type)
                   VALUES ($1,
                     (SELECT profile_id FROM campaigns WHERE id=$2 LIMIT 1),
                     $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
                   ON CONFLICT DO NOTHING
                   RETURNING id`,
                  [workspaceId, entity.campaign_id, entity.ad_group_id,
                    `rule-neg-asin-qt-${entity.id}-${asinUpper}`,
                    exprUpperJson, "asinSameAs", "ad_group",
                    rule.id, entity.entity_type]
                );
                insertedNtId = ntRows[0]?.id || null;

                await writeRuleAudit({
                  orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
                  action: "target.add_negative_asin_via_query", entityType: "target",
                  entityId: entity.id, entityName: `${exprType0} → ASIN_SAME_AS:${asinUpper}`,
                  beforeData: {}, afterData: { added_as_negative_target: true, asin: asinUpper, auto_routed: true },
                  source: "rule",
                });

                if (insertedNtId && entity.connection_id) {
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
                  }).catch(e => logger.warn("Rule query-type neg_target write-back failed", { error: e.message }));
                }
              }
              applied.push({
                entity_type: "search_term",
                entity_id: entity.id,
                keyword_text: asinUpper,
                expression: [{ type: "ASIN_SAME_AS", value: asinUpper }],
                campaign_name: entity.campaign_name,
                ad_group_name: entity.ad_group_name,
                action: "add_negative_target",
                auto_routed: true, level: "ad_group",
                metrics: {
                  clicks: asinRow.st_clicks,
                  orders: asinRow.st_orders,
                  acos:   asinRow.st_acos,
                  spend:  asinRow.st_spend,
                },
              });
            }
            continue; // entity loop — query-type fully handled above
          }

          const exprJson = typeof entity.expression === "string"
            ? entity.expression : JSON.stringify(entity.expression);

          const { rows: existing } = await query(
            `SELECT id FROM negative_targets
             WHERE workspace_id=$1 AND campaign_id=$2 AND ad_group_id=$3 AND expression=$4::jsonb AND state = 'enabled'`,
            [workspaceId, entity.campaign_id, entity.ad_group_id, exprJson]
          );
          if (existing.length > 0) { recordSkip(entity, action, "already_negative"); continue; }

          let insertedNtId = null;
          if (!dryRun) {
            const { rows: ntRows } = await query(
              `INSERT INTO negative_targets
                 (workspace_id, profile_id, campaign_id, ad_group_id,
                  amazon_neg_target_id, expression, expression_type, level,
                  source_rule_id, source_entity_type)
               VALUES ($1,
                 (SELECT profile_id FROM campaigns WHERE id=$2 LIMIT 1),
                 $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
               ON CONFLICT DO NOTHING
               RETURNING id`,
              [workspaceId, entity.campaign_id, entity.ad_group_id,
                `rule-neg-${entity.id}`,
                exprJson, entity.expression_type || "asinSameAs", "ad_group",
                rule.id, entity.entity_type]
            );
            insertedNtId = ntRows[0]?.id || null;

            await writeRuleAudit({
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
            campaign_name: entity.campaign_name, ad_group_name: entity.ad_group_name, action: "add_negative_target",
            metrics: { clicks: entity.clicks, orders: entity.orders, spend: entity.spend, acos: entity.acos },
          });

        // ── pause_ad_group ──────────────────────────────────────────────────
        } else if (action.type === "pause_ad_group") {
          if (entity.entity_type !== "ad_group") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "paused") { recordSkip(entity, action, "already_paused"); continue; }
          if (!dryRun) {
            await query("UPDATE ad_groups SET state = 'paused', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "ad_group.pause", entityType: "ad_group",
              entityId: entity.id, entityName: entity.ad_group_name,
              beforeData: { state: entity.state }, afterData: { state: "paused" }, source: "rule",
            });
            if (entity.amazon_ag_id && entity.connection_id) {
              const agPath = entity.campaign_type === "sponsoredDisplay" ? "/sd/adGroups"
                           : entity.campaign_type === "sponsoredBrands"  ? "/sb/adGroups"
                           : "/sp/adGroups";
              put({ connectionId: entity.connection_id, profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id, path: agPath,
                data: { adGroups: [{ adGroupId: entity.amazon_ag_id, state: "PAUSED" }] }, group: "ad_groups",
              }).catch(e => logger.warn("Rule ad_group pause write-back failed", { error: e.message }));
            }
          }
          applied.push({ entity_type: "ad_group", entity_id: entity.id, keyword_text: entity.ad_group_name,
            campaign_name: entity.campaign_name, action: "pause_ad_group",
            previous_state: entity.state, new_state: "paused",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos } });

        // ── enable_ad_group ─────────────────────────────────────────────────
        } else if (action.type === "enable_ad_group") {
          if (entity.entity_type !== "ad_group") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "enabled") { recordSkip(entity, action, "already_enabled"); continue; }
          if (!dryRun) {
            await query("UPDATE ad_groups SET state = 'enabled', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "ad_group.enable", entityType: "ad_group",
              entityId: entity.id, entityName: entity.ad_group_name,
              beforeData: { state: entity.state }, afterData: { state: "enabled" }, source: "rule",
            });
            if (entity.amazon_ag_id && entity.connection_id) {
              const agPath = entity.campaign_type === "sponsoredDisplay" ? "/sd/adGroups"
                           : entity.campaign_type === "sponsoredBrands"  ? "/sb/adGroups"
                           : "/sp/adGroups";
              put({ connectionId: entity.connection_id, profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id, path: agPath,
                data: { adGroups: [{ adGroupId: entity.amazon_ag_id, state: "ENABLED" }] }, group: "ad_groups",
              }).catch(e => logger.warn("Rule ad_group enable write-back failed", { error: e.message }));
            }
          }
          applied.push({ entity_type: "ad_group", entity_id: entity.id, keyword_text: entity.ad_group_name,
            campaign_name: entity.campaign_name, action: "enable_ad_group",
            previous_state: entity.state, new_state: "enabled",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos } });

        // ── adjust_default_bid_pct ──────────────────────────────────────────
        } else if (action.type === "adjust_default_bid_pct") {
          if (entity.entity_type !== "ad_group") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          const pct        = parseFloat(action.value || 0) / 100;
          const currentBid = parseFloat(entity.default_bid || 0.30);
          const minBid     = parseFloat(safety.min_bid || 0.02);
          const maxBid     = parseFloat(safety.max_bid || 50);
          const newBid     = Math.round(Math.max(minBid, Math.min(maxBid, currentBid * (1 + pct))) * 100) / 100;
          if (!dryRun) {
            await query("UPDATE ad_groups SET default_bid = $1, updated_at = NOW() WHERE id = $2", [newBid, entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "ad_group.adjust_default_bid_pct", entityType: "ad_group",
              entityId: entity.id, entityName: entity.ad_group_name,
              beforeData: { default_bid: currentBid }, afterData: { default_bid: newBid }, source: "rule",
            });
            if (entity.amazon_ag_id && entity.connection_id) {
              const agPath = entity.campaign_type === "sponsoredDisplay" ? "/sd/adGroups"
                           : entity.campaign_type === "sponsoredBrands"  ? "/sb/adGroups"
                           : "/sp/adGroups";
              put({ connectionId: entity.connection_id, profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id, path: agPath,
                data: { adGroups: [{ adGroupId: entity.amazon_ag_id, defaultBid: newBid }] }, group: "ad_groups",
              }).catch(e => logger.warn("Rule ad_group bid write-back failed", { error: e.message }));
            }
          }
          applied.push({ entity_type: "ad_group", entity_id: entity.id, keyword_text: entity.ad_group_name,
            campaign_name: entity.campaign_name, action: "adjust_default_bid_pct",
            previous_bid: currentBid, new_bid: newBid, change_pct: (pct * 100).toFixed(1) + "%",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos } });

        // ── set_default_bid ─────────────────────────────────────────────────
        } else if (action.type === "set_default_bid") {
          if (entity.entity_type !== "ad_group") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          const currentBid  = parseFloat(entity.default_bid || 0);
          const minBid      = parseFloat(safety.min_bid || 0.02);
          const maxBid      = parseFloat(safety.max_bid || 50);
          const newBid      = Math.round(Math.max(minBid, Math.min(maxBid, parseFloat(action.value || 0.30))) * 100) / 100;
          if (!dryRun) {
            await query("UPDATE ad_groups SET default_bid = $1, updated_at = NOW() WHERE id = $2", [newBid, entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "ad_group.set_default_bid", entityType: "ad_group",
              entityId: entity.id, entityName: entity.ad_group_name,
              beforeData: { default_bid: currentBid }, afterData: { default_bid: newBid }, source: "rule",
            });
            if (entity.amazon_ag_id && entity.connection_id) {
              const agPath = entity.campaign_type === "sponsoredDisplay" ? "/sd/adGroups"
                           : entity.campaign_type === "sponsoredBrands"  ? "/sb/adGroups"
                           : "/sp/adGroups";
              put({ connectionId: entity.connection_id, profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id, path: agPath,
                data: { adGroups: [{ adGroupId: entity.amazon_ag_id, defaultBid: newBid }] }, group: "ad_groups",
              }).catch(e => logger.warn("Rule ad_group set_bid write-back failed", { error: e.message }));
            }
          }
          applied.push({ entity_type: "ad_group", entity_id: entity.id, keyword_text: entity.ad_group_name,
            campaign_name: entity.campaign_name, action: "set_default_bid",
            previous_bid: currentBid, new_bid: newBid,
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos } });

        // ── pause_campaign ──────────────────────────────────────────────────
        } else if (action.type === "pause_campaign") {
          if (entity.entity_type !== "campaign") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "paused") { recordSkip(entity, action, "already_paused"); continue; }
          if (!dryRun) {
            await query("UPDATE campaigns SET state = 'paused', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "campaign.pause", entityType: "campaign",
              entityId: entity.id, entityName: entity.campaign_name,
              beforeData: { state: entity.state }, afterData: { state: "paused" }, source: "rule",
            });
            if (entity.amazon_campaign_id && entity.connection_id) {
              const campPath = entity.campaign_type === "sponsoredDisplay" ? "/sd/campaigns"
                             : entity.campaign_type === "sponsoredBrands"  ? "/sb/campaigns"
                             : "/sp/campaigns";
              put({ connectionId: entity.connection_id, profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id, path: campPath,
                data: [{ campaignId: entity.amazon_campaign_id, state: "PAUSED" }], group: "campaigns",
              }).catch(e => logger.warn("Rule campaign pause write-back failed", { error: e.message }));
            }
          }
          applied.push({ entity_type: "campaign", entity_id: entity.id, keyword_text: entity.campaign_name,
            campaign_name: null, action: "pause_campaign",
            previous_state: entity.state, new_state: "paused",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos } });

        // ── enable_campaign ─────────────────────────────────────────────────
        } else if (action.type === "enable_campaign") {
          if (entity.entity_type !== "campaign") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state === "enabled") { recordSkip(entity, action, "already_enabled"); continue; }
          if (!dryRun) {
            await query("UPDATE campaigns SET state = 'enabled', updated_at = NOW() WHERE id = $1", [entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "campaign.enable", entityType: "campaign",
              entityId: entity.id, entityName: entity.campaign_name,
              beforeData: { state: entity.state }, afterData: { state: "enabled" }, source: "rule",
            });
            if (entity.amazon_campaign_id && entity.connection_id) {
              const campPath = entity.campaign_type === "sponsoredDisplay" ? "/sd/campaigns"
                             : entity.campaign_type === "sponsoredBrands"  ? "/sb/campaigns"
                             : "/sp/campaigns";
              put({ connectionId: entity.connection_id, profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id, path: campPath,
                data: [{ campaignId: entity.amazon_campaign_id, state: "ENABLED" }], group: "campaigns",
              }).catch(e => logger.warn("Rule campaign enable write-back failed", { error: e.message }));
            }
          }
          applied.push({ entity_type: "campaign", entity_id: entity.id, keyword_text: entity.campaign_name,
            campaign_name: null, action: "enable_campaign",
            previous_state: entity.state, new_state: "enabled",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos } });

        // ── adjust_budget_pct ───────────────────────────────────────────────
        } else if (action.type === "adjust_budget_pct") {
          if (entity.entity_type !== "campaign") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          const pct           = parseFloat(action.value || 0) / 100;
          const currentBudget = parseFloat(entity.daily_budget || 10);
          const newBudget     = Math.round(Math.max(1, currentBudget * (1 + pct)) * 100) / 100;
          if (!dryRun) {
            await query("UPDATE campaigns SET daily_budget = $1, updated_at = NOW() WHERE id = $2", [newBudget, entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "campaign.adjust_budget_pct", entityType: "campaign",
              entityId: entity.id, entityName: entity.campaign_name,
              beforeData: { daily_budget: currentBudget }, afterData: { daily_budget: newBudget }, source: "rule",
            });
            if (entity.amazon_campaign_id && entity.connection_id) {
              const isSB = entity.campaign_type === "sponsoredBrands";
              const isSD = entity.campaign_type === "sponsoredDisplay";
              const campPath = isSD ? "/sd/campaigns" : isSB ? "/sb/campaigns" : "/sp/campaigns";
              const budgetPayload = (isSB || isSD)
                ? { campaignId: entity.amazon_campaign_id, budget: { budget: newBudget, budgetType: "DAILY" } }
                : { campaignId: entity.amazon_campaign_id, dailyBudget: newBudget };
              put({ connectionId: entity.connection_id, profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id, path: campPath,
                data: [budgetPayload], group: "campaigns",
              }).catch(e => logger.warn("Rule campaign budget write-back failed", { error: e.message }));
            }
          }
          applied.push({ entity_type: "campaign", entity_id: entity.id, keyword_text: entity.campaign_name,
            campaign_name: null, action: "adjust_budget_pct",
            previous_budget: currentBudget, new_budget: newBudget, change_pct: (pct * 100).toFixed(1) + "%",
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos } });

        // ── set_budget ──────────────────────────────────────────────────────
        } else if (action.type === "set_budget") {
          if (entity.entity_type !== "campaign") { recordSkip(entity, action, "wrong_entity_type"); continue; }
          if (entity.state !== "enabled") { recordSkip(entity, action, "not_enabled"); continue; }
          const currentBudget = parseFloat(entity.daily_budget || 0);
          const newBudget     = Math.round(Math.max(1, parseFloat(action.value || 10)) * 100) / 100;
          if (!dryRun) {
            await query("UPDATE campaigns SET daily_budget = $1, updated_at = NOW() WHERE id = $2", [newBudget, entity.id]);
            await writeRuleAudit({
              orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
              action: "campaign.set_budget", entityType: "campaign",
              entityId: entity.id, entityName: entity.campaign_name,
              beforeData: { daily_budget: currentBudget }, afterData: { daily_budget: newBudget }, source: "rule",
            });
            if (entity.amazon_campaign_id && entity.connection_id) {
              const isSB = entity.campaign_type === "sponsoredBrands";
              const isSD = entity.campaign_type === "sponsoredDisplay";
              const campPath = isSD ? "/sd/campaigns" : isSB ? "/sb/campaigns" : "/sp/campaigns";
              const budgetPayload = (isSB || isSD)
                ? { campaignId: entity.amazon_campaign_id, budget: { budget: newBudget, budgetType: "DAILY" } }
                : { campaignId: entity.amazon_campaign_id, dailyBudget: newBudget };
              put({ connectionId: entity.connection_id, profileId: String(entity.amazon_profile_id),
                marketplace: entity.marketplace_id, path: campPath,
                data: [budgetPayload], group: "campaigns",
              }).catch(e => logger.warn("Rule campaign set_budget write-back failed", { error: e.message }));
            }
          }
          applied.push({ entity_type: "campaign", entity_id: entity.id, keyword_text: entity.campaign_name,
            campaign_name: null, action: "set_budget",
            previous_budget: currentBudget, new_budget: newBudget,
            metrics: { clicks: entity.clicks, spend: entity.spend, orders: entity.orders, acos: entity.acos } });
        }
      } catch (e) {
        errors.push({ entity_id: entity.id, error: e.message });
      }
    }
  }

  // ── Reconciliation: un-negate previously negated items whose conditions no longer hold ──
  // Only applies to negatives created by this rule (source_rule_id = rule.id).
  // For each active negative: re-evaluate the same conditions against current metrics.
  // If conditions are NOT met → the term now converts or no longer qualifies → remove negative.
  const removed = [];
  {
    const { rows: prevNegKws } = await query(
      `SELECT nk.id, nk.keyword_text, nk.campaign_id, nk.ad_group_id,
              nk.amazon_neg_keyword_id, nk.match_type, nk.level, nk.source_entity_type,
              p.profile_id AS amazon_profile_id, p.connection_id, p.marketplace_id,
              c.campaign_type, c.name AS campaign_name
       FROM negative_keywords nk
       JOIN campaigns c        ON c.id  = nk.campaign_id
       JOIN amazon_profiles p  ON p.id  = nk.profile_id
       WHERE nk.source_rule_id = $1 AND nk.workspace_id = $2 AND nk.state = 'enabled'`,
      [rule.id, workspaceId]
    );

    for (const nk of prevNegKws) {
      let m = { clicks: 0, spend: 0, orders: 0, sales: 0, impressions: 0 };
      if (nk.source_entity_type === "search_term") {
        // Campaign-level lookup — a search term that converts in ANY ad_group of this campaign
        // should not be removed, even if the original ad_group saw 0 orders.
        const { rows } = await query(
          `SELECT COALESCE(SUM(clicks),0) AS clicks, COALESCE(SUM(spend),0) AS spend,
                  COALESCE(SUM(orders),0) AS orders, COALESCE(SUM(sales),0) AS sales,
                  COALESCE(SUM(impressions),0) AS impressions
           FROM search_term_metrics
           WHERE workspace_id=$1 AND campaign_id=$2
             AND LOWER(query)=LOWER($3) AND date_start>=$4 AND date_end<=$5`,
          [workspaceId, nk.campaign_id, nk.keyword_text, startDate, endDate]
        );
        if (rows[0]) m = rows[0];
      } else {
        const { rows } = await query(
          `SELECT COALESCE(SUM(m.clicks),0) AS clicks, COALESCE(SUM(m.cost),0) AS spend,
                  COALESCE(SUM(m.orders_14d),0) AS orders, COALESCE(SUM(m.sales_14d),0) AS sales,
                  COALESCE(SUM(m.impressions),0) AS impressions
           FROM keywords k
           LEFT JOIN fact_metrics_daily m ON m.amazon_id = k.amazon_keyword_id
             AND m.entity_type = 'keyword' AND m.date BETWEEN $4 AND $5
           WHERE k.workspace_id=$1 AND k.campaign_id=$2 AND LOWER(k.keyword_text)=LOWER($3)`,
          [workspaceId, nk.campaign_id, nk.keyword_text, startDate, endDate]
        );
        if (rows[0]) m = rows[0];
      }
      if (parseFloat(m.sales) > 0) m.acos = parseFloat(m.spend) / parseFloat(m.sales) * 100;
      if (parseFloat(m.spend) > 0) m.roas = parseFloat(m.sales) / parseFloat(m.spend);
      if (parseFloat(m.impressions) > 0) m.ctr = parseFloat(m.clicks) / parseFloat(m.impressions) * 100;
      if (parseFloat(m.clicks) > 0) m.cpc = parseFloat(m.spend) / parseFloat(m.clicks);

      if (!evaluate(metricConditions, m)) {
        removed.push({
          type: "keyword", id: nk.id, keyword_text: nk.keyword_text,
          campaign_name: nk.campaign_name, action: "remove_negative_reconcile",
          metrics: { clicks: m.clicks, orders: m.orders, spend: m.spend, acos: m.acos },
        });
        if (!dryRun) {
          // Free the placeholder ID so the rule can re-negate later if needed
          const newAmazonId = nk.amazon_neg_keyword_id?.startsWith("rule-")
            ? `archived-${Date.now()}-${nk.id}` : nk.amazon_neg_keyword_id;
          await query(
            "UPDATE negative_keywords SET state='archived', amazon_neg_keyword_id=$1 WHERE id=$2",
            [newAmazonId, nk.id]
          );
          const hasRealId = !nk.amazon_neg_keyword_id?.startsWith("rule-");
          if (hasRealId && nk.connection_id) {
            archiveNegativeKeyword({
              connectionId: nk.connection_id, profileId: String(nk.amazon_profile_id),
              marketplaceId: nk.marketplace_id, campaignType: nk.campaign_type,
              level: nk.level, amazonNegKeywordId: nk.amazon_neg_keyword_id,
            }).catch(e => logger.warn("Reconcile archive neg_kw failed", { error: e.message }));
          }
          await writeRuleAudit({
            orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
            action: "keyword.remove_negative_reconcile", entityType: "keyword",
            entityId: nk.id, entityName: nk.keyword_text,
            beforeData: { state: "enabled" },
            afterData: { state: "archived", reason: "conditions_no_longer_met", metrics: m },
            source: "rule",
          });
        }
      }
    }

    const { rows: prevNegTgts } = await query(
      `SELECT nt.id, nt.expression, nt.campaign_id, nt.ad_group_id,
              nt.amazon_neg_target_id, nt.level, nt.source_entity_type,
              p.profile_id AS amazon_profile_id, p.connection_id, p.marketplace_id,
              c.campaign_type, c.name AS campaign_name
       FROM negative_targets nt
       JOIN campaigns c        ON c.id  = nt.campaign_id
       JOIN amazon_profiles p  ON p.id  = nt.profile_id
       WHERE nt.source_rule_id = $1 AND nt.workspace_id = $2 AND nt.state = 'enabled'`,
      [rule.id, workspaceId]
    );

    for (const nt of prevNegTgts) {
      let m = { clicks: 0, spend: 0, orders: 0, sales: 0, impressions: 0 };
      const exprArr = typeof nt.expression === "string"
        ? JSON.parse(nt.expression || "[]") : (nt.expression || []);
      const asinValue = exprArr.find(e =>
        e.type === "ASIN_SAME_AS" || e.type === "asinSameAs"
      )?.value;

      if (asinValue) {
        // For ALL ASIN negatives (regardless of source_entity_type): look up search_term_metrics
        // at campaign level. If this ASIN converts anywhere in the campaign → keep negative.
        const { rows } = await query(
          `SELECT COALESCE(SUM(clicks),0) AS clicks, COALESCE(SUM(spend),0) AS spend,
                  COALESCE(SUM(orders),0) AS orders, COALESCE(SUM(sales),0) AS sales,
                  COALESCE(SUM(impressions),0) AS impressions
           FROM search_term_metrics
           WHERE workspace_id=$1 AND campaign_id=$2
             AND UPPER(query)=UPPER($3) AND date_start>=$4 AND date_end<=$5`,
          [workspaceId, nt.campaign_id, asinValue, startDate, endDate]
        );
        if (rows[0]) m = rows[0];
      } else {
        // Non-ASIN negative (category, audience) — no query-level metrics available.
        // Skip reconciliation: leave these negatives in place rather than risk false removal.
        continue;
      }
      if (parseFloat(m.sales) > 0) m.acos = parseFloat(m.spend) / parseFloat(m.sales) * 100;
      if (parseFloat(m.spend) > 0) m.roas = parseFloat(m.sales) / parseFloat(m.spend);
      if (parseFloat(m.impressions) > 0) m.ctr = parseFloat(m.clicks) / parseFloat(m.impressions) * 100;
      if (parseFloat(m.clicks) > 0) m.cpc = parseFloat(m.spend) / parseFloat(m.clicks);

      if (!evaluate(metricConditions, m)) {
        removed.push({
          type: "target", id: nt.id,
          keyword_text: asinValue || JSON.stringify(exprArr),
          expression: exprArr,
          campaign_name: nt.campaign_name, action: "remove_negative_reconcile",
          metrics: { clicks: m.clicks, orders: m.orders, spend: m.spend, acos: m.acos },
        });
        if (!dryRun) {
          const newAmazonId = nt.amazon_neg_target_id?.startsWith("rule-")
            ? `archived-${Date.now()}-${nt.id}` : nt.amazon_neg_target_id;
          await query(
            "UPDATE negative_targets SET state='archived', amazon_neg_target_id=$1 WHERE id=$2",
            [newAmazonId, nt.id]
          );
          const hasRealId = !nt.amazon_neg_target_id?.startsWith("rule-");
          if (hasRealId && nt.connection_id) {
            archiveNegativeTarget({
              connectionId: nt.connection_id, profileId: String(nt.amazon_profile_id),
              marketplaceId: nt.marketplace_id, campaignType: nt.campaign_type,
              amazonNegTargetId: nt.amazon_neg_target_id,
            }).catch(e => logger.warn("Reconcile archive neg_tgt failed", { error: e.message }));
          }
          await writeRuleAudit({
            orgId, workspaceId, actorId, actorName, actorType: actorId ? "user" : "system",
            action: "target.remove_negative_reconcile", entityType: "target",
            entityId: nt.id, entityName: asinValue || JSON.stringify(exprArr),
            beforeData: { state: "enabled" },
            afterData: { state: "archived", reason: "conditions_no_longer_met", metrics: m },
            source: "rule",
          });
        }
      }
    }
  }

  return {
    matched_count:   matched.length,
    total_evaluated: entities.length,
    entity_counts:   { keywords: keywords.length, targets: targets.length, search_terms: searchTerms.length, ad_groups: adGroupEntities.length, campaigns: campaignEntities.length },
    applied_count:   applied.length,
    skipped_count:   skipped.length,
    removed_count:   removed.length,
    exempted_count:  exemptedCount,
    dry_run:         dryRun,
    period:          { start: startDate, end: endDate, days: periodDays },
    applied,
    skipped,
    removed,
    errors,
  };
}

// ── PATCH /rules/reorder — bulk sort_order update ────────────────────────────
router.patch("/reorder", async (req, res, next) => {
  try {
    const { order } = req.body; // [{ id, sort_order }]
    if (!Array.isArray(order) || !order.length) return res.status(400).json({ error: "order required" });
    await Promise.all(
      order.map(({ id, sort_order }) =>
        query("UPDATE rules SET sort_order = $1 WHERE id = $2 AND workspace_id = $3", [sort_order, id, req.workspaceId])
      )
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /rules/:id/duplicate ─────────────────────────────────────────────────
router.post("/:id/duplicate", async (req, res, next) => {
  try {
    const { rows: [src] } = await query(
      "SELECT * FROM rules WHERE id = $1 AND workspace_id = $2",
      [req.params.id, req.workspaceId]
    );
    if (!src) return res.status(404).json({ error: "Not found" });
    const { rows: [newRule] } = await query(
      `INSERT INTO rules
         (workspace_id, name, description, conditions, actions, schedule, schedule_type, run_hour, scope, safety, dry_run, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        req.workspaceId,
        "Копия: " + src.name,
        src.description || "",
        typeof src.conditions === "string" ? src.conditions : JSON.stringify(src.conditions),
        typeof src.actions    === "string" ? src.actions    : JSON.stringify(src.actions),
        src.schedule, src.schedule_type, src.run_hour ?? 8,
        typeof src.scope  === "string" ? src.scope  : JSON.stringify(src.scope  || {}),
        typeof src.safety === "string" ? src.safety : JSON.stringify(src.safety || {}),
        src.dry_run, req.user.id,
      ]
    );
    res.status(201).json(newRule);
  } catch (err) { next(err); }
});

// ── GET /rules/campaigns — MUST be before /:id to avoid param capture ─────────
router.get("/campaigns", async (req, res, next) => {
  try {
    const q = (req.query.q || "").trim();
    const params = [req.workspaceId];
    let where = "workspace_id = $1 AND state != 'archived'";
    if (q) {
      params.push(`%${q}%`);
      where += ` AND name ILIKE $${params.length}`;
    }
    const { rows } = await query(
      `SELECT id, name, campaign_type, state FROM campaigns
       WHERE ${where} ORDER BY name ASC LIMIT 200`,
      params
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

// ── Campaign Exemptions — global exclusions from all rules ───────────────────

router.get("/exemptions", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT ce.id, ce.campaign_id, ce.expires_at, ce.reason, ce.created_at,
              c.name AS campaign_name
       FROM campaign_exemptions ce
       JOIN campaigns c ON c.id = ce.campaign_id
       WHERE ce.workspace_id = $1
       ORDER BY ce.created_at DESC`,
      [req.workspaceId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

router.post("/exemptions", async (req, res, next) => {
  try {
    const { campaign_id, expires_at, reason } = req.body;
    if (!campaign_id) return res.status(400).json({ error: "campaign_id required" });
    const { rows: [row] } = await query(
      `INSERT INTO campaign_exemptions (workspace_id, campaign_id, expires_at, reason, created_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, campaign_id) DO UPDATE SET
         expires_at = EXCLUDED.expires_at,
         reason     = EXCLUDED.reason,
         created_at = NOW()
       RETURNING id`,
      [req.workspaceId, campaign_id, expires_at || null, reason || null, req.user.id]
    );
    const { rows: [full] } = await query(
      `SELECT ce.id, ce.campaign_id, ce.expires_at, ce.reason, ce.created_at,
              c.name AS campaign_name
       FROM campaign_exemptions ce JOIN campaigns c ON c.id = ce.campaign_id
       WHERE ce.id = $1`,
      [row.id]
    );
    res.json(full);
  } catch (err) { next(err); }
});

router.delete("/exemptions/:exemId", async (req, res, next) => {
  try {
    await query(
      "DELETE FROM campaign_exemptions WHERE id = $1 AND workspace_id = $2",
      [req.params.exemId, req.workspaceId]
    );
    res.json({ ok: true });
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
        "SELECT * FROM rules WHERE workspace_id = $1 AND name NOT LIKE '\\_\\_%' ORDER BY COALESCE(sort_order, 99999) ASC, created_at ASC LIMIT $2 OFFSET $3",
        [req.workspaceId, limit, offset]
      ),
      query("SELECT COUNT(*)::int AS count FROM rules WHERE workspace_id = $1 AND name NOT LIKE '\\_\\_%'", [req.workspaceId]),
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
    const { name, description, conditions, actions, schedule, schedule_type, run_hour, scope, safety, dry_run } = req.body;
    if (!name || !conditions?.length || !actions?.length) {
      return res.status(400).json({ error: "name, conditions and actions required" });
    }
    const { rows: [rule] } = await query(
      `INSERT INTO rules
         (workspace_id, name, description, conditions, actions, schedule, schedule_type, run_hour, scope, safety, dry_run, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        req.workspaceId, name, description || "",
        JSON.stringify(conditions), JSON.stringify(actions),
        schedule || "0 8 * * *",
        schedule_type || "daily",
        run_hour != null ? parseInt(run_hour) : 8,
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
    const { name, description, conditions, actions, schedule, schedule_type, run_hour, scope, safety, dry_run, is_active } = req.body;
    // If conditions/actions are explicitly provided, refuse to write empty
    // arrays — those would let executeRule treat every entity as matched.
    if (conditions !== undefined && (!Array.isArray(conditions) || conditions.length === 0)) {
      return res.status(400).json({ error: "conditions cannot be empty when provided" });
    }
    if (actions !== undefined && (!Array.isArray(actions) || actions.length === 0)) {
      return res.status(400).json({ error: "actions cannot be empty when provided" });
    }
    // Only reset next_run_at when the schedule itself changes — not on every save.
    // Without this, editing a rule name after it ran would make it execute again immediately.
    const scheduleChanged = schedule_type !== undefined || run_hour !== undefined;
    const { rows: [rule] } = await query(
      `UPDATE rules SET
         name          = COALESCE($1, name),
         description   = COALESCE($2, description),
         conditions    = COALESCE($3::jsonb, conditions),
         actions       = COALESCE($4::jsonb, actions),
         schedule      = COALESCE($5, schedule),
         schedule_type = COALESCE($6, schedule_type),
         run_hour      = COALESCE($7, run_hour),
         scope         = COALESCE($8::jsonb, scope),
         safety        = COALESCE($9::jsonb, safety),
         dry_run       = COALESCE($10, dry_run),
         is_active     = COALESCE($11, is_active),
         next_run_at   = CASE WHEN $14 THEN NULL ELSE next_run_at END,
         updated_at    = NOW()
       WHERE id = $12 AND workspace_id = $13
       RETURNING *`,
      [
        name, description,
        conditions ? JSON.stringify(conditions) : null,
        actions    ? JSON.stringify(actions)    : null,
        schedule, schedule_type,
        run_hour != null ? parseInt(run_hour) : null,
        scope   ? JSON.stringify(scope)   : null,
        safety  ? JSON.stringify(safety)  : null,
        dry_run, is_active,
        req.params.id, req.workspaceId,
        scheduleChanged,
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

    // For real (non-dry) runs: check the workspace lock so manual runs
    // can't race with the cron worker executing the same workspace's rules.
    let ownedLock = false;
    const workspaceLockKey = `rule_exec_lock:${req.workspaceId}`;
    const manualLockKey    = `rule_exec_lock:manual:${req.params.id}`;
    if (!effectiveDryRun) {
      const redis = getRedis();
      // Reject if the automated worker already holds the workspace lock.
      const existing = await redis.get(workspaceLockKey);
      if (existing) {
        return res.status(409).json({
          error: "rule_locked",
          message: "Another rule execution is already in progress for this workspace. Please try again in a moment.",
        });
      }
      // Acquire per-rule lock to prevent duplicate manual clicks.
      const acquired = await redis.set(manualLockKey, req.user.id, "NX", "EX", 120);
      if (!acquired) {
        return res.status(409).json({
          error: "rule_locked",
          message: "This rule is already running. Please wait for it to finish.",
        });
      }
      ownedLock = true;
    }

    let result;
    try {
      result = await executeRule(rule, req.workspaceId, effectiveDryRun, req.user.id, req.user.name);
    } finally {
      if (ownedLock) {
        const redis = getRedis();
        const current = await redis.get(manualLockKey);
        if (current === req.user.id) await redis.del(manualLockKey);
      }
    }

    const nextRunAt = effectiveDryRun ? null : computeNextRun(rule.schedule_type, rule.run_hour);
    await query(
      effectiveDryRun
        ? "UPDATE rules SET last_run_result = $1 WHERE id = $2"
        : "UPDATE rules SET last_run_at = NOW(), last_run_result = $1, next_run_at = $3 WHERE id = $2",
      effectiveDryRun
        ? [JSON.stringify(result), req.params.id]
        : [JSON.stringify(result), req.params.id, nextRunAt]
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

// ── Schedule helpers ──────────────────────────────────────────────────────────
const FREQ_DAYS = { daily: 1, every_2_days: 2, every_3_days: 3, weekly: 7, monthly: 30 };

function computeNextRun(scheduleType, runHour) {
  const days = FREQ_DAYS[scheduleType] ?? 1;
  const hour = (runHour != null && runHour >= 0 && runHour <= 23) ? parseInt(runHour) : 8;
  const next = new Date();
  next.setUTCDate(next.getUTCDate() + days);
  next.setUTCHours(hour, 0, 0, 0);
  return next;
}

// Called by the RULE_EXECUTION worker — runs all keyword/target rules
// that are due for this workspace and advances next_run_at.
async function executeAllDueRules(workspaceId) {
  const { rows: rules } = await query(
    `SELECT * FROM rules
     WHERE workspace_id = $1 AND is_active = TRUE
       AND name NOT LIKE '\\_\\_%'
       AND (next_run_at IS NULL OR next_run_at <= NOW())
     ORDER BY COALESCE(sort_order, 99999) ASC, created_at ASC`,
    [workspaceId]
  );
  const results = [];
  for (const rule of rules) {
    try {
      const result = await executeRule(rule, workspaceId, rule.dry_run, null, "Rule Engine");
      const nextRunAt = computeNextRun(rule.schedule_type, rule.run_hour);
      await query(
        rule.dry_run
          ? "UPDATE rules SET last_run_result = $1, next_run_at = $2 WHERE id = $3"
          : "UPDATE rules SET last_run_at = NOW(), last_run_result = $1, next_run_at = $2 WHERE id = $3",
        [JSON.stringify(result), nextRunAt, rule.id]
      );
      results.push({ ruleId: rule.id, ruleName: rule.name, ...result });
    } catch (e) {
      logger.error("executeAllDueRules: rule failed", { ruleId: rule.id, error: e.message });
    }
  }
  return { workspaceId, rules_executed: results.length, results };
}

module.exports = router;
module.exports.executeAllDueRules = executeAllDueRules;
